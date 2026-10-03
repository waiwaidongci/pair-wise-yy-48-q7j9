/**
 * 协同草稿引擎：把设备台账、因果规则和审阅批次组织成可续作的协同草稿。
 *
 * 模型：每个标签页的修改都打包成带批次号的「批次」追加到共享日志（localStorage），
 * 各窗口折叠同一份日志得到一致状态。批次携带因果向量 seen，
 * 不冲突的字段自动合并；同一规则同一字段被两个窗口同时改过时保留两版，
 * 形成待裁决冲突，由审阅人选择版本后写回。写入失败的批次留在待写箱，
 * 按原批次号重试（批次号是幂等键，对端去重）。恢复（回放日志 + 清空待写箱）
 * 完成前不允许发布基线。
 */

export type DeviceType = '感烟探测器' | '感温探测器' | '手动报警按钮' | '输入模块' | '输出模块' | '排烟风机' | '防火卷帘' | '消防广播' | '电梯'
export type Device = { id: string; name: string; type: DeviceType; floor: string; zone: string; address: string }
export type Rule = {
  id: string
  triggerId: string
  actionId: string
  delay: number
  interlock: string
  priority: 1 | 2 | 3
  suppression: string
  enabled: boolean
}

export const seedDevices: Device[] = [
  { id: 'D-01-01', name: '一层大厅感烟 01', type: '感烟探测器', floor: '1F', zone: 'A 区', address: '1-A-01-01' },
  { id: 'D-01-02', name: '一层大厅感烟 02', type: '感烟探测器', floor: '1F', zone: 'A 区', address: '1-A-01-02' },
  { id: 'D-01-11', name: '一层东侧手报', type: '手动报警按钮', floor: '1F', zone: 'A 区', address: '1-A-02-01' },
  { id: 'A-01-01', name: '一层排烟风机 PF-1', type: '排烟风机', floor: '1F', zone: 'A 区', address: '1-F-01-01' },
  { id: 'A-01-02', name: '中庭防火卷帘 01', type: '防火卷帘', floor: '1F', zone: '中庭', address: '1-R-01-01' },
  { id: 'A-01-03', name: '一层消防广播', type: '消防广播', floor: '1F', zone: 'A 区', address: '1-B-01-01' },
  { id: 'D-02-01', name: '二层机房感温 01', type: '感温探测器', floor: '2F', zone: 'B 区', address: '2-B-01-01' },
  { id: 'D-02-02', name: '二层机房感烟 01', type: '感烟探测器', floor: '2F', zone: 'B 区', address: '2-B-01-02' },
  { id: 'A-02-01', name: '二层排烟风机 PF-2', type: '排烟风机', floor: '2F', zone: 'B 区', address: '2-F-01-01' },
  { id: 'A-02-02', name: '1 号客梯归位', type: '电梯', floor: '2F', zone: 'B 区', address: '2-L-01-01' },
]

export const seedRules: Rule[] = [
  { id: 'R-001', triggerId: 'D-01-01', actionId: 'A-01-01', delay: 0, interlock: '卷帘全开后启动', priority: 1, suppression: '无', enabled: true },
  { id: 'R-002', triggerId: 'D-01-01', actionId: 'A-01-03', delay: 5, interlock: '无', priority: 2, suppression: '手动广播优先', enabled: true },
  { id: 'R-003', triggerId: 'D-01-02', actionId: 'A-01-02', delay: 0, interlock: '排烟风机运行', priority: 1, suppression: '无', enabled: true },
  { id: 'R-004', triggerId: 'D-01-11', actionId: 'A-01-03', delay: 3, interlock: '无', priority: 1, suppression: '无', enabled: true },
  { id: 'R-005', triggerId: 'D-02-01', actionId: 'A-02-01', delay: 0, interlock: '防火阀开启反馈', priority: 1, suppression: '无', enabled: true },
  { id: 'R-006', triggerId: 'D-02-01', actionId: 'A-02-02', delay: 10, interlock: '轿厢无人确认', priority: 2, suppression: '消防电梯模式', enabled: true },
  { id: 'R-007', triggerId: 'D-02-02', actionId: 'A-01-01', delay: 0, interlock: '无', priority: 3, suppression: '无', enabled: false },
  { id: 'R-008', triggerId: 'D-01-01', actionId: 'A-02-02', delay: 0, interlock: '无', priority: 1, suppression: '无', enabled: true },
]

export const BASE_REVISION = 8
export const LOG_KEY = 'fire-linkage-collab-v2'
export const LEGACY_KEY = 'fire-linkage-draft-v1'
const PRESENCE_KEY = `${LOG_KEY}-presence`
const TABS_KEY = `${LOG_KEY}-tabs`
const outboxKey = (tab: string) => `${LOG_KEY}-outbox-${tab}`

/** 审阅变更与矩阵规则的关联：验收后这些规则或其关联设备再被修改，结论即失效 */
export const CHANGE_WATCH_RULES: Record<string, string[]> = {
  'CH-01': ['R-005'],
  'CH-02': ['R-006'],
  'CH-03': ['R-007'],
}

export const CHECKLIST_ITEMS: { title: string; owner: string }[] = [
  { title: '设备地址与竣工图一致', owner: '消防电专业' },
  { title: '所有报警点完成单点调试', owner: '调试组' },
  { title: '跨区联动完成现场确认', owner: '消防审阅人' },
  { title: '互锁反馈时长完成测试', owner: '暖通专业' },
  { title: '签字交付包完成哈希校验', owner: '项目负责人' },
]

export type EntityKind = 'device' | 'rule'

export type Op =
  | { type: 'device.add'; device: Device }
  | { type: 'device.set'; id: string; field: keyof Device; value: unknown }
  | { type: 'device.restore'; id: string; values: Device }
  | { type: 'rule.add'; rule: Rule }
  | { type: 'rule.set'; id: string; field: keyof Rule; value: unknown }
  | { type: 'rule.restore'; id: string; values: Rule }
  | { type: 'review.accept'; changeId: string; ruleIds: string[] }
  | { type: 'review.check'; item: string; done: boolean }
  | { type: 'baseline.lock' }
  | { type: 'baseline.unlock' }

export type BatchKind = 'seed' | 'migration' | 'edit' | 'review' | 'resolve' | 'baseline'

export type Batch = {
  /** 批次号：`窗口#序号`，写入失败重试时保持不变，对端按它去重（幂等键） */
  id: string
  tab: string
  seq: number
  at: number
  kind: BatchKind
  /** 因果向量：本批次已观测到的各窗口最大批次序号 */
  seen: Record<string, number>
  /** 仅 seed/migration：旧稿的版本来源 */
  baseRevision?: number
  ops: Op[]
}

export type EntityMeta = {
  origin: 'seed' | 'legacy' | 'collab'
  createdBy: string
  updatedBy: string
  updatedAt: number
  /** 最近一次写入的批次号（版本来源） */
  batchId: string
}

export type FieldConflict = {
  /** 分叉前的原始值 */
  base: unknown
  /** 各窗口保存的版本值：tabId -> value */
  values: Record<string, unknown>
  /** 卷入冲突的批次号 */
  batches: string[]
}

export type EntityConflict = {
  key: string
  kind: EntityKind
  id: string
  fields: Record<string, FieldConflict>
  createdAt: number
}

export type AcceptedRecord = {
  changeId: string
  by: string
  at: number
  /** 结论依据：规则 + 关联设备 */
  watched: string[]
  /** 验收时各依据实体所在的批次号 */
  basis: Record<string, string>
}

export type ChecklistMark = { done: boolean; by: string; at: number }

export type BatchSummary = { id: string; tab: string; kind: BatchKind; at: number; ops: number }

export type Materialized = {
  devices: Device[]
  rules: Rule[]
  deviceMeta: Record<string, EntityMeta>
  ruleMeta: Record<string, EntityMeta>
  conflicts: EntityConflict[]
  accepted: Record<string, AcceptedRecord>
  staleChangeIds: string[]
  checklist: Record<string, ChecklistMark>
  locked: false | { by: string; at: number }
  revision: number
  coverage: Record<string, number>
  recentBatches: BatchSummary[]
}

// ---------------------------------------------------------------------------
// 日志折叠（确定性归并：所有窗口折叠同一份日志得到同一份状态）
// ---------------------------------------------------------------------------

type EntityState<T extends { id: string }> = {
  value: T
  createdBatch: string
  /** 字段 -> 最后写入它的批次号 */
  stamps: Record<string, string>
  /** 字段 -> 上一次覆盖写之前的值（冲突时作为原始值） */
  prior: Record<string, unknown>
  lastBatch: string
  meta: EntityMeta
}

function parseBatchId(id: string): { tab: string; seq: number } {
  const index = id.lastIndexOf('#')
  return { tab: id.slice(0, index), seq: Number(id.slice(index + 1)) }
}

/** batchId 是否被 seen 向量覆盖（即写入方在落笔前已经看到过它） */
function covers(seen: Record<string, number>, batchId: string): boolean {
  const { tab, seq } = parseBatchId(batchId)
  return (seen[tab] ?? -1) >= seq
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function makeEntity<T extends { id: string }>(value: T, batch: Batch): EntityState<T> {
  const stamps: Record<string, string> = {}
  for (const key of Object.keys(value)) if (key !== 'id') stamps[key] = batch.id
  return {
    value: structuredClone(value),
    createdBatch: batch.id,
    stamps,
    prior: {},
    lastBatch: batch.id,
    meta: {
      origin: batch.kind === 'seed' ? 'seed' : batch.kind === 'migration' ? 'legacy' : 'collab',
      createdBy: batch.tab,
      updatedBy: batch.tab,
      updatedAt: batch.at,
      batchId: batch.id,
    },
  }
}

function touch<T extends { id: string }>(entity: EntityState<T>, batch: Batch) {
  entity.lastBatch = batch.id
  entity.meta.updatedBy = batch.tab
  entity.meta.updatedAt = batch.at
  entity.meta.batchId = batch.id
}

/** 建议下一个规则编号；并发新增撞号时由折叠层确定性改号 */
export function suggestRuleId(existing: string[]): string {
  let max = 0
  for (const id of existing) {
    const match = /^R-(\d+)$/.exec(id)
    if (match) max = Math.max(max, Number(match[1]))
  }
  let candidate = max + 1
  let id = `R-${String(candidate).padStart(3, '0')}`
  while (existing.includes(id)) {
    candidate += 1
    id = `R-${String(candidate).padStart(3, '0')}`
  }
  return id
}

export function fold(batches: Batch[]): Materialized {
  const devices = new Map<string, EntityState<Device>>()
  const rules = new Map<string, EntityState<Rule>>()
  /** 并发新增撞号的改号映射：`${tab}:${原id}` -> 实际id */
  const ruleAlias = new Map<string, string>()
  const conflicts = new Map<string, EntityConflict>()
  const accepted: Record<string, AcceptedRecord> = {}
  const checklist: Record<string, ChecklistMark> = {}
  const coverage: Record<string, number> = {}
  const applied: Batch[] = []
  const appliedIds = new Set<string>()
  let locked: Materialized['locked'] = false
  let baseRevision = 0

  function upsertConflict(kind: EntityKind, id: string, field: string, currentValue: unknown, currentBatch: string | undefined, incomingValue: unknown, batch: Batch, priorValue: unknown) {
    const key = `${kind}:${id}`
    let conflict = conflicts.get(key)
    if (!conflict) {
      conflict = { key, kind, id, fields: {}, createdAt: batch.at }
      conflicts.set(key, conflict)
    }
    let entry = conflict.fields[field]
    if (!entry) {
      entry = { base: priorValue !== undefined ? priorValue : currentValue, values: {}, batches: [] }
      if (currentBatch) {
        entry.values[parseBatchId(currentBatch).tab] = currentValue
        entry.batches.push(currentBatch)
      }
      conflict.fields[field] = entry
    }
    entry.values[batch.tab] = incomingValue
    if (!entry.batches.includes(batch.id)) entry.batches.push(batch.id)
  }

  function applySet<T extends { id: string }>(entity: EntityState<T>, kind: EntityKind, field: string, value: unknown, batch: Batch) {
    const record = entity.value as Record<string, unknown>
    const currentBatch = entity.stamps[field]
    const currentValue = record[field]
    if (currentBatch && !covers(batch.seen, currentBatch)) {
      // 并发写同一字段：值相同直接并入，值不同保留两版待审阅人裁决
      if (!sameValue(currentValue, value)) {
        upsertConflict(kind, entity.value.id, field, currentValue, currentBatch, value, batch, entity.prior[field])
      }
      return
    }
    entity.prior[field] = currentValue
    record[field] = value
    entity.stamps[field] = batch.id
    touch(entity, batch)
    // 因果在后的写入若覆盖了卷入冲突的全部批次，相当于裁决了该字段
    const conflict = conflicts.get(`${kind}:${entity.value.id}`)
    const entry = conflict?.fields[field]
    if (conflict && entry) {
      if (entry.batches.every((id) => covers(batch.seen, id))) {
        delete conflict.fields[field]
        if (Object.keys(conflict.fields).length === 0) conflicts.delete(conflict.key)
      } else {
        entry.values[batch.tab] = value
      }
    }
  }

  function resolveRuleId(tab: string, id: string): string {
    return ruleAlias.get(`${tab}:${id}`) ?? id
  }

  function addRule(rule: Rule, batch: Batch) {
    let id = rule.id
    const existing = rules.get(id)
    if (existing) {
      if (covers(batch.seen, existing.createdBatch)) {
        // 已知存在：按字段合并
        for (const key of Object.keys(rule)) if (key !== 'id') applySet(existing, 'rule', key, (rule as unknown as Record<string, unknown>)[key], batch)
        return
      }
      // 并发新增撞号：确定性改号，后续引用经别名表改写
      id = suggestRuleId([...rules.keys()])
      ruleAlias.set(`${batch.tab}:${rule.id}`, id)
    }
    rules.set(id, makeEntity({ ...rule, id }, batch))
  }

  function addDevice(device: Device, batch: Batch) {
    const existing = devices.get(device.id)
    if (existing) {
      // 设备编号有语义，撞号不改号，按字段合并（并发同字段仍会入冲突）
      for (const key of Object.keys(device)) if (key !== 'id') applySet(existing, 'device', key, (device as unknown as Record<string, unknown>)[key], batch)
      return
    }
    devices.set(device.id, makeEntity(device, batch))
  }

  function lookup(watched: string): EntityState<Device> | EntityState<Rule> | undefined {
    const [kind, id] = watched.split(':')
    return kind === 'rule' ? rules.get(id) : devices.get(id)
  }

  for (const batch of batches) {
    // 幂等：重试的批次号已应用过就跳过
    if (appliedIds.has(batch.id)) continue
    appliedIds.add(batch.id)
    applied.push(batch)
    if (batch.baseRevision !== undefined) baseRevision = batch.baseRevision
    const own = parseBatchId(batch.id)
    coverage[own.tab] = Math.max(coverage[own.tab] ?? -1, own.seq)
    for (const [tab, seq] of Object.entries(batch.seen)) coverage[tab] = Math.max(coverage[tab] ?? -1, seq)

    for (const op of batch.ops) {
      switch (op.type) {
        case 'device.add':
          addDevice(op.device, batch)
          break
        case 'device.set': {
          const entity = devices.get(op.id)
          if (entity) applySet(entity, 'device', op.field, op.value, batch)
          break
        }
        case 'device.restore': {
          const entity = devices.get(op.id)
          if (entity) for (const key of Object.keys(op.values)) if (key !== 'id') applySet(entity, 'device', key, (op.values as unknown as Record<string, unknown>)[key], batch)
          break
        }
        case 'rule.add':
          addRule(op.rule, batch)
          break
        case 'rule.set': {
          const entity = rules.get(resolveRuleId(batch.tab, op.id))
          if (entity) applySet(entity, 'rule', op.field, op.value, batch)
          break
        }
        case 'rule.restore': {
          const entity = rules.get(resolveRuleId(batch.tab, op.id))
          if (entity) for (const key of Object.keys(op.values)) if (key !== 'id') applySet(entity, 'rule', key, (op.values as unknown as Record<string, unknown>)[key], batch)
          break
        }
        case 'review.accept': {
          const watched = new Set<string>()
          for (const ruleId of op.ruleIds) {
            const id = resolveRuleId(batch.tab, ruleId)
            watched.add(`rule:${id}`)
            const rule = rules.get(id)
            if (rule) {
              watched.add(`device:${rule.value.triggerId}`)
              watched.add(`device:${rule.value.actionId}`)
            }
          }
          const basis: Record<string, string> = {}
          for (const key of watched) {
            const entity = lookup(key)
            basis[key] = entity ? entity.lastBatch : 'missing'
          }
          accepted[op.changeId] = { changeId: op.changeId, by: batch.tab, at: batch.at, watched: [...watched], basis }
          break
        }
        case 'review.check':
          checklist[op.item] = { done: op.done, by: batch.tab, at: batch.at }
          break
        case 'baseline.lock':
          locked = { by: batch.tab, at: batch.at }
          break
        case 'baseline.unlock':
          locked = false
          break
      }
    }
  }

  // 结论失效重算：验收依据（规则或其关联设备）在验收后又被写过，结论即失效
  const staleChangeIds = Object.values(accepted)
    .filter((record) => record.watched.some((key) => {
      const entity = lookup(key)
      return !entity || entity.lastBatch !== record.basis[key]
    }))
    .map((record) => record.changeId)

  const toMeta = <T extends { id: string }>(table: Map<string, EntityState<T>>) =>
    Object.fromEntries([...table.entries()].map(([id, entity]) => [id, entity.meta]))

  return {
    devices: [...devices.values()].map((entity) => structuredClone(entity.value)),
    rules: [...rules.values()].map((entity) => structuredClone(entity.value)),
    deviceMeta: toMeta(devices),
    ruleMeta: toMeta(rules),
    conflicts: [...conflicts.values()],
    accepted,
    staleChangeIds,
    checklist,
    locked,
    revision: baseRevision + applied.filter((batch) => batch.kind !== 'seed' && batch.kind !== 'migration').length,
    coverage,
    recentBatches: applied.slice(-8).map((batch) => ({ id: batch.id, tab: batch.tab, kind: batch.kind, at: batch.at, ops: batch.ops.length })),
  }
}

// ---------------------------------------------------------------------------
// 存储与迁移
// ---------------------------------------------------------------------------

export type KVLike = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem?(key: string): void
}

type LogDoc = { schema: 2; batches: Batch[] }

function readJson<T>(storage: KVLike, key: string, fallback: T): T {
  try {
    const raw = storage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function readLog(storage: KVLike): LogDoc {
  const doc = readJson<LogDoc | null>(storage, LOG_KEY, null)
  return doc && Array.isArray(doc.batches) ? doc : { schema: 2, batches: [] }
}

/**
 * 确保共享日志存在：没有 v2 日志时，把 v1 旧稿整体迁移成一个迁移批次，
 * 为每条设备/规则补齐版本来源（origin=legacy、保留旧 revision、记录迁移批次号）。
 */
function ensureLog(storage: KVLike, now: () => number): LogDoc {
  const existing = readJson<LogDoc | null>(storage, LOG_KEY, null)
  if (existing && Array.isArray(existing.batches)) return existing

  const legacy = readJson<{
    devices?: Device[]
    rules?: Rule[]
    revision?: number
    locked?: boolean
    acceptedChanges?: string[]
  } | null>(storage, LEGACY_KEY, null)

  let batch: Batch
  if (legacy && Array.isArray(legacy.devices) && Array.isArray(legacy.rules)) {
    batch = {
      id: 'legacy#0',
      tab: 'legacy',
      seq: 0,
      at: now(),
      kind: 'migration',
      seen: {},
      baseRevision: typeof legacy.revision === 'number' ? legacy.revision : BASE_REVISION,
      ops: [
        ...legacy.devices.map((device): Op => ({ type: 'device.add', device })),
        ...legacy.rules.map((rule): Op => ({ type: 'rule.add', rule })),
        ...(legacy.acceptedChanges ?? []).map((changeId): Op => ({ type: 'review.accept', changeId, ruleIds: CHANGE_WATCH_RULES[changeId] ?? [] })),
        ...(legacy.locked ? [{ type: 'baseline.lock' } as Op] : []),
      ],
    }
  } else {
    batch = {
      id: 'seed#0',
      tab: 'seed',
      seq: 0,
      at: now(),
      kind: 'seed',
      seen: {},
      baseRevision: BASE_REVISION,
      ops: [
        ...seedDevices.map((device): Op => ({ type: 'device.add', device })),
        ...seedRules.map((rule): Op => ({ type: 'rule.add', rule })),
        { type: 'review.accept', changeId: 'CH-01', ruleIds: CHANGE_WATCH_RULES['CH-01'] },
        { type: 'review.check', item: CHECKLIST_ITEMS[0].title, done: true },
        { type: 'review.check', item: CHECKLIST_ITEMS[1].title, done: true },
      ],
    }
  }
  const doc: LogDoc = { schema: 2, batches: [batch] }
  try {
    storage.setItem(LOG_KEY, JSON.stringify(doc))
  } catch {
    // 写入失败不阻塞启动，恢复流程会带着待写箱继续重试
  }
  return doc
}

// ---------------------------------------------------------------------------
// 会话：一个标签页一个会话，负责提交批次、写日志、失败重试、在线状态
// ---------------------------------------------------------------------------

export type PeerInfo = { tab: string; label: string; at: number }

export type CollabSnapshot = {
  state: Materialized
  tabId: string
  tabLabel: string
  labels: Record<string, string>
  /** 恢复完成：日志已回放且崩溃前遗留的待写箱已补写 */
  recovered: boolean
  /** 可以发布基线：恢复完成且当前没有未写入共享日志的批次 */
  syncReady: boolean
  outbox: Batch[]
  writeError: string | null
  peers: PeerInfo[]
}

export type CollabSessionOptions = {
  storage: KVLike
  tabId: string
  now?: () => number
  /** 注入写入故障（演练重试路径） */
  failWrites?: () => boolean
  autoFlush?: boolean
  schedule?: (fn: () => void, ms: number) => void
}

export class CollabSession {
  readonly tabId: string
  tabLabel = '本窗口'
  private storage: KVLike
  private now: () => number
  private failWrites?: () => boolean
  private autoFlush: boolean
  private schedule: (fn: () => void, ms: number) => void
  private state: Materialized = fold([])
  private outbox: Batch[] = []
  private seq = 0
  private recovered = false
  private writeError: string | null = null
  private retryDelay = 400
  private currentFlush: Promise<void> | null = null
  private flushAgain = false
  private labels: Record<string, string> = {}
  private peers: PeerInfo[] = []
  private listeners = new Set<(snap: CollabSnapshot) => void>()

  constructor(options: CollabSessionOptions) {
    this.storage = options.storage
    this.tabId = options.tabId
    this.now = options.now ?? (() => Date.now())
    this.failWrites = options.failWrites
    this.autoFlush = options.autoFlush ?? true
    this.schedule = options.schedule ?? ((fn, ms) => { setTimeout(fn, ms) })
  }

  /** 恢复：迁移/播种日志 → 读回崩溃前未写出的批次 → 回放 → 按原批次号补写 */
  recover() {
    ensureLog(this.storage, this.now)
    this.outbox = readJson<Batch[]>(this.storage, outboxKey(this.tabId), []).filter((batch) => batch && typeof batch.id === 'string')
    this.refold()
    const ownSeq = this.state.coverage[this.tabId] ?? -1
    const pendingSeq = this.outbox.reduce((max, batch) => Math.max(max, batch.seq), -1)
    this.seq = Math.max(ownSeq, pendingSeq) + 1
    this.registerTab()
    this.emit()
    void this.flush()
  }

  /** 各窗口继续保存：先入待写箱并乐观生效，再异步写入共享日志 */
  submit(ops: Op[], kind: BatchKind = 'edit'): Batch {
    const batch: Batch = {
      id: `${this.tabId}#${this.seq}`,
      tab: this.tabId,
      seq: this.seq,
      at: this.now(),
      kind,
      seen: { ...this.state.coverage },
      ops,
    }
    this.seq += 1
    this.outbox.push(batch)
    this.persistOutbox()
    this.refold()
    this.emit()
    if (this.autoFlush) this.schedule(() => void this.flush(), 200)
    return batch
  }

  /** 把待写箱追加进共享日志；失败时保留原批次号，退避后重试。可 await 至本批写完 */
  async flush(): Promise<void> {
    if (this.currentFlush) {
      this.flushAgain = true
      return this.currentFlush
    }
    const run = this.flushLoop()
    this.currentFlush = run
    try {
      await run
    } finally {
      this.currentFlush = null
      if (this.flushAgain) {
        this.flushAgain = false
        void this.flush()
      }
    }
  }

  private async flushLoop() {
    do {
      this.flushAgain = false
      await this.flushOnce()
    } while (this.flushAgain)
  }

  private async flushOnce() {
    while (this.outbox.length > 0) {
      try {
        await this.withLock(() => {
          const doc = readLog(this.storage)
          const known = new Set(doc.batches.map((batch) => batch.id))
          const fresh = this.outbox.filter((batch) => !known.has(batch.id))
          if (fresh.length > 0) {
            if (this.failWrites?.()) throw new Error('共享存储写入失败（模拟故障）')
            doc.batches.push(...fresh)
            this.storage.setItem(LOG_KEY, JSON.stringify(doc))
          }
          this.outbox = []
          this.persistOutbox()
        })
        this.writeError = null
        this.retryDelay = 400
      } catch (error) {
        // 批次不出待写箱、批次号不变，退避后按原批次号重试
        this.writeError = error instanceof Error ? error.message : String(error)
        this.schedule(() => void this.flush(), this.retryDelay)
        this.retryDelay = Math.min(this.retryDelay * 2, 5000)
        break
      }
    }
    if (this.outbox.length === 0 && !this.recovered) this.recovered = true
    this.refold()
    this.emit()
  }

  /** 其他窗口写入后重放日志（storage 事件驱动） */
  reload() {
    this.registerTab()
    this.refold()
    this.emit()
  }

  heartbeat() {
    const all = readJson<Record<string, { label: string; at: number }>>(this.storage, PRESENCE_KEY, {})
    all[this.tabId] = { label: this.tabLabel, at: this.now() }
    try {
      this.storage.setItem(PRESENCE_KEY, JSON.stringify(all))
    } catch {
      // 在线状态失败不影响主流程
    }
    const now = this.now()
    this.peers = Object.entries(all)
      .filter(([tab, peer]) => tab !== this.tabId && now - peer.at < 10_000)
      .map(([tab, peer]) => ({ tab, label: this.labels[tab] ?? peer.label, at: peer.at }))
    this.emit()
  }

  subscribe(listener: (snap: CollabSnapshot) => void): () => void {
    this.listeners.add(listener)
    listener(this.snapshot())
    return () => this.listeners.delete(listener)
  }

  snapshot(): CollabSnapshot {
    return {
      state: this.state,
      tabId: this.tabId,
      tabLabel: this.tabLabel,
      labels: this.labels,
      recovered: this.recovered,
      syncReady: this.recovered && this.outbox.length === 0,
      outbox: [...this.outbox],
      writeError: this.writeError,
      peers: this.peers,
    }
  }

  private refold() {
    const doc = readLog(this.storage)
    this.state = fold([...doc.batches, ...this.outbox])
  }

  private persistOutbox() {
    try {
      this.storage.setItem(outboxKey(this.tabId), JSON.stringify(this.outbox))
    } catch {
      // 待写箱落盘失败不阻塞编辑，内存中的批次仍会参与重试
    }
  }

  private registerTab() {
    const registry = readJson<Record<string, string>>(this.storage, TABS_KEY, {})
    if (!registry[this.tabId]) {
      const letter = String.fromCharCode(65 + Object.keys(registry).length)
      registry[this.tabId] = `窗口 ${letter}`
      try {
        this.storage.setItem(TABS_KEY, JSON.stringify(registry))
      } catch {
        // 标签注册失败不影响主流程
      }
    }
    this.labels = { seed: '初始数据', legacy: '旧稿迁移', ...registry }
    this.tabLabel = this.labels[this.tabId] ?? '本窗口'
  }

  private emit() {
    const snap = this.snapshot()
    for (const listener of this.listeners) listener(snap)
  }

  private async withLock<T>(fn: () => T): Promise<T> {
    const locks = (globalThis as { navigator?: { locks?: { request?: (name: string, fn: () => T) => Promise<T> } } }).navigator?.locks
    if (locks?.request) return locks.request(LOG_KEY, fn)
    return fn()
  }
}
