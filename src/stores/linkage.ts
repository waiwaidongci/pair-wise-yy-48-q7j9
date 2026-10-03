import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'

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
export type Validation = { id: string; severity: '错误' | '警告'; ruleIds: string[]; title: string; detail: string; suggestion: string }

// ---- 协同草稿相关类型 ----
export type VersionSource = 'seed' | 'migrated-v1' | 'resumed' | 'remote'
export type RecoveryState = 'recovering' | 'ready'
export type WriteState = 'idle' | 'writing' | 'retrying' | 'failed'

export type FieldMeta = { base: unknown; updatedAt: number; updatedBy: string }

export type FieldChange = { key: string; base: unknown; value: unknown; resolvesConflict?: string }
export type EntityOp =
  | { kind: 'upsert'; entityType: 'device' | 'rule'; id: string; value: Device | Rule }
  | { kind: 'delete'; entityType: 'device' | 'rule'; id: string }

export type WriteBatch = {
  batchId: string
  opId: string
  source: { tabId: string; tabName: string }
  at: number
  fields: FieldChange[]
  entityOps: EntityOp[]
  acceptedChanges: string[]
}

export type ConflictVersion = { value: unknown; by: string; byName: string; at: number; batchId: string }
export type FieldConflict = {
  id: string
  entityType: 'device' | 'rule'
  entityId: string
  field: string
  base: unknown
  versions: ConflictVersion[]
  status: 'pending' | 'resolved'
  resolvedValue?: unknown
  resolvedAt?: number
}

export type ApprovedConclusion = {
  id: string
  title: string
  severity: '错误' | '警告'
  refs: string[]
  approvedAt: number
}

export type DraftSnapshot = {
  schemaVersion: 2
  versionSource: VersionSource
  draftId: string
  revision: number
  locked: boolean
  devices: Device[]
  rules: Rule[]
  acceptedChanges: string[]
  fieldMeta: Record<string, FieldMeta>
  conflicts: FieldConflict[]
  approvedConclusions: ApprovedConclusion[]
  changedSinceApproval: string[]
  appliedOpIds: string[]
  lastOpId: string
  updatedAt: number
  updatedBy: string
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

// ---- 存储键 ----
const SNAPSHOT_KEY = 'fire-linkage-draft-v2'
const OPS_KEY = 'fire-linkage-ops-v1'
const LEGACY_KEY = 'fire-linkage-draft-v1'

// ---- 工具函数 ----
function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function entityKeys(entityType: 'device' | 'rule', entity: Device | Rule): string[] {
  return Object.keys(entity).filter((k) => k !== 'id').map((k) => `${entityType}:${entity.id}:${k}`)
}

function parseKey(key: string): { entityType: 'device' | 'rule' | 'meta'; entityId: string; field: string } {
  if (key.startsWith('meta:')) return { entityType: 'meta', entityId: '', field: key.slice(5) }
  const [entityType, entityId, ...rest] = key.split(':')
  return { entityType: entityType as 'device' | 'rule', entityId, field: rest.join(':') }
}

function buildFieldMeta(entityType: 'device' | 'rule', entities: (Device | Rule)[], updatedBy: string): Record<string, FieldMeta> {
  const meta: Record<string, FieldMeta> = {}
  for (const entity of entities) {
    for (const k of entityKeys(entityType, entity)) {
      const field = k.split(':').slice(2).join(':')
      meta[k] = { base: (entity as Record<string, unknown>)[field], updatedAt: 0, updatedBy }
    }
  }
  return meta
}

function buildSeedSnapshot(): DraftSnapshot {
  const devices = structuredClone(seedDevices)
  const rules = structuredClone(seedRules)
  const fieldMeta: Record<string, FieldMeta> = {
    ...buildFieldMeta('device', devices, 'seed'),
    ...buildFieldMeta('rule', rules, 'seed'),
    'meta:revision': { base: 8, updatedAt: 0, updatedBy: 'seed' },
    'meta:locked': { base: false, updatedAt: 0, updatedBy: 'seed' },
  }
  return {
    schemaVersion: 2,
    versionSource: 'seed',
    draftId: uuid(),
    revision: 8,
    locked: false,
    devices,
    rules,
    acceptedChanges: ['CH-01'],
    fieldMeta,
    conflicts: [],
    approvedConclusions: [],
    changedSinceApproval: [],
    appliedOpIds: [],
    lastOpId: '',
    updatedAt: 0,
    updatedBy: 'seed',
  }
}

function migrateV1(raw: Record<string, unknown>): DraftSnapshot {
  const devices = (raw.devices as Device[]) ?? structuredClone(seedDevices)
  const rules = (raw.rules as Rule[]) ?? structuredClone(seedRules)
  const revision = (raw.revision as number) ?? 8
  const locked = (raw.locked as boolean) ?? false
  const acceptedChanges = (raw.acceptedChanges as string[]) ?? ['CH-01']
  // 补齐版本来源：旧稿没有 fieldMeta，这里以迁移时刻的值作为三方合并基线
  const fieldMeta: Record<string, FieldMeta> = {
    ...buildFieldMeta('device', devices, 'migrated-v1'),
    ...buildFieldMeta('rule', rules, 'migrated-v1'),
    'meta:revision': { base: revision, updatedAt: 0, updatedBy: 'migrated-v1' },
    'meta:locked': { base: locked, updatedAt: 0, updatedBy: 'migrated-v1' },
  }
  return {
    schemaVersion: 2,
    versionSource: 'migrated-v1',
    draftId: uuid(),
    revision,
    locked,
    devices,
    rules,
    acceptedChanges,
    fieldMeta,
    conflicts: [],
    approvedConclusions: [],
    changedSinceApproval: [],
    appliedOpIds: [],
    lastOpId: '',
    updatedAt: 0,
    updatedBy: 'migrated-v1',
  }
}

function readSnapshot(): DraftSnapshot | null {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY)
    if (!raw) return null
    const snap = JSON.parse(raw) as DraftSnapshot
    if (snap.schemaVersion !== 2) return null
    return snap
  } catch {
    return null
  }
}

function readOpLog(): { ops: WriteBatch[]; lastOpId: string } {
  try {
    const raw = localStorage.getItem(OPS_KEY)
    if (!raw) return { ops: [], lastOpId: '' }
    const parsed = JSON.parse(raw) as { ops: WriteBatch[]; lastOpId: string }
    return { ops: parsed.ops ?? [], lastOpId: parsed.lastOpId ?? '' }
  } catch {
    return { ops: [], lastOpId: '' }
  }
}

function conclusionRefs(v: Validation, rules: Rule[]): string[] {
  const refs = new Set<string>()
  for (const rid of v.ruleIds) {
    refs.add(`rule:${rid}`)
    const r = rules.find((x) => x.id === rid)
    if (r) {
      refs.add(`device:${r.triggerId}`)
      refs.add(`device:${r.actionId}`)
    }
  }
  if (v.id.startsWith('missing-')) refs.add(`device:${v.id.slice('missing-'.length)}`)
  return [...refs]
}

export const useLinkageStore = defineStore('linkage', () => {
  // ---- 标签页身份（用于冲突来源与版本来源） ----
  const tabId = sessionStorage.getItem('fire-linkage-tab-id') || uuid()
  const tabName = sessionStorage.getItem('fire-linkage-tab-name') || `窗口-${Math.random().toString(36).slice(2, 6)}`
  sessionStorage.setItem('fire-linkage-tab-id', tabId)
  sessionStorage.setItem('fire-linkage-tab-name', tabName)

  // ---- 核心数据 ----
  const devices = ref<Device[]>([])
  const rules = ref<Rule[]>([])
  const revision = ref(8)
  const locked = ref(false)
  const acceptedChanges = ref<string[]>(['CH-01'])
  const selectedRuleIds = ref<string[]>([])

  // ---- 协同草稿状态 ----
  const fieldMeta = reactive<Record<string, FieldMeta>>({})
  const conflicts = ref<FieldConflict[]>([])
  const approvedConclusions = ref<ApprovedConclusion[]>([])
  const changedSinceApproval = ref<string[]>([])
  const appliedOpIds = ref<string[]>([])
  const lastOpId = ref('')
  const draftId = ref('')
  const versionSource = ref<VersionSource>('seed')
  const knownTabs = reactive<Record<string, string>>({ [tabId]: tabName })

  // ---- 恢复与写入管线状态 ----
  const recoveryState = ref<RecoveryState>('recovering')
  const writeState = ref<WriteState>('idle')
  const lastBatchId = ref<string | null>(null)
  const retryCount = ref(0)
  const writeError = ref<string | null>(null)
  const lastBatch = ref<WriteBatch | null>(null)

  // ---- 联调清单 ----
  const checklist = ref([
    { done: true, title: '设备地址与竣工图一致', owner: '消防电专业' },
    { done: true, title: '所有报警点完成单点调试', owner: '调试组' },
    { done: false, title: '跨区联动完成现场确认', owner: '消防审阅人' },
    { done: false, title: '互锁反馈时长完成测试', owner: '暖通专业' },
    { done: false, title: '签字交付包完成哈希校验', owner: '项目负责人' },
  ])

  // ---- 校验结论 ----
  const validations = computed<Validation[]>(() => {
    const result: Validation[] = []
    const triggers = devices.value.filter((device) => ['感烟探测器', '感温探测器', '手动报警按钮', '输入模块'].includes(device.type))
    for (const trigger of triggers) {
      const enabled = rules.value.filter((rule) => rule.triggerId === trigger.id && rule.enabled)
      if (enabled.length === 0) {
        result.push({ id: `missing-${trigger.id}`, severity: '错误', ruleIds: [], title: `${trigger.name} 缺少联动动作`, detail: '报警点未配置任何启用的因果规则。', suggestion: '至少配置广播、排烟或疏散相关动作。' })
      }
      const actionCount = new Map<string, number>()
      enabled.forEach((rule) => actionCount.set(rule.actionId, (actionCount.get(rule.actionId) ?? 0) + 1))
      actionCount.forEach((count, actionId) => {
        if (count > 1) result.push({ id: `duplicate-${trigger.id}-${actionId}`, severity: '警告', ruleIds: enabled.filter((rule) => rule.actionId === actionId).map((rule) => rule.id), title: `${trigger.name} 存在重复动作`, detail: `同一个动作 ${actionId} 被重复配置 ${count} 次。`, suggestion: '合并规则或明确主备关系。' })
      })
    }
    rules.value.filter((rule) => rule.enabled).forEach((rule) => {
      const trigger = devices.value.find((device) => device.id === rule.triggerId)
      const action = devices.value.find((device) => device.id === rule.actionId)
      if (trigger && action && trigger.zone !== action.zone && rule.suppression === '无') {
        result.push({ id: `cross-${rule.id}`, severity: '警告', ruleIds: [rule.id], title: `${rule.id} 跨区联动未配置抑制`, detail: `${trigger.zone} 报警将直接触发 ${action.zone} 动作。`, suggestion: '确认疏散边界并增加分区确认或抑制条件。' })
      }
      if (rule.interlock && rule.delay > 5 && rule.priority === 1) {
        result.push({ id: `contradiction-${rule.id}`, severity: '错误', ruleIds: [rule.id], title: `${rule.id} 互锁与高优先级延时冲突`, detail: '一级优先规则在互锁未明确反馈前延时超过 5 秒。', suggestion: '缩短延时或改为反馈后触发。' })
      }
    })
    return result
  })

  // ---- 协同派生状态 ----
  const pendingConflicts = computed(() => conflicts.value.filter((c) => c.status === 'pending'))

  const invalidReferences = computed(() => {
    const refs: { ruleId: string; field: 'triggerId' | 'actionId'; deviceId: string }[] = []
    for (const rule of rules.value) {
      if (!devices.value.some((d) => d.id === rule.triggerId)) refs.push({ ruleId: rule.id, field: 'triggerId', deviceId: rule.triggerId })
      if (!devices.value.some((d) => d.id === rule.actionId)) refs.push({ ruleId: rule.id, field: 'actionId', deviceId: rule.actionId })
    }
    return refs
  })

  const invalidatedConclusionIds = computed(() => {
    if (approvedConclusions.value.length === 0) return []
    const changed = new Set(changedSinceApproval.value)
    return approvedConclusions.value.filter((c) => c.refs.some((r) => changed.has(r))).map((c) => c.id)
  })

  const newConclusionIds = computed(() => {
    // 从未锁定过（无已批准基线）时，当前结论不算“新增待审”，不影响首次锁定
    if (approvedConclusions.value.length === 0) return []
    const approved = new Set(approvedConclusions.value.map((c) => c.id))
    return validations.value.filter((v) => !approved.has(v.id)).map((v) => v.id)
  })

  const conclusionsNeedReview = computed(() =>
    validations.value.filter((v) => invalidatedConclusionIds.value.includes(v.id) || newConclusionIds.value.includes(v.id)),
  )

  const checklistDone = computed(() => checklist.value.every((item) => item.done))

  const canLock = computed(() =>
    recoveryState.value === 'ready' &&
    validations.value.filter((v) => v.severity === '错误').length === 0 &&
    checklistDone.value &&
    pendingConflicts.value.length === 0 &&
    invalidReferences.value.length === 0 &&
    conclusionsNeedReview.value.length === 0,
  )

  const canExport = computed(() =>
    recoveryState.value === 'ready' &&
    pendingConflicts.value.length === 0 &&
    invalidReferences.value.length === 0,
  )

  // ---- 草稿装载与迁移 ----
  function loadSnapshot(snap: DraftSnapshot, source: VersionSource) {
    versionSource.value = source
    draftId.value = snap.draftId
    revision.value = snap.revision
    locked.value = snap.locked
    devices.value = snap.devices
    rules.value = snap.rules
    acceptedChanges.value = [...snap.acceptedChanges]
    Object.keys(fieldMeta).forEach((k) => delete fieldMeta[k])
    Object.assign(fieldMeta, snap.fieldMeta)
    conflicts.value = snap.conflicts ?? []
    approvedConclusions.value = snap.approvedConclusions ?? []
    changedSinceApproval.value = [...(snap.changedSinceApproval ?? [])]
    appliedOpIds.value = [...(snap.appliedOpIds ?? [])]
    lastOpId.value = snap.lastOpId ?? ''
    if (!fieldMeta['meta:revision']) fieldMeta['meta:revision'] = { base: snap.revision, updatedAt: 0, updatedBy: source }
    if (!fieldMeta['meta:locked']) fieldMeta['meta:locked'] = { base: snap.locked, updatedAt: 0, updatedBy: source }
  }

  function init() {
    const existing = readSnapshot()
    if (existing) {
      loadSnapshot(existing, 'resumed')
    } else {
      const legacyRaw = localStorage.getItem(LEGACY_KEY)
      if (legacyRaw) {
        try {
          const snap = migrateV1(JSON.parse(legacyRaw) as Record<string, unknown>)
          loadSnapshot(snap, 'migrated-v1')
          localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snap))
        } catch {
          const snap = buildSeedSnapshot()
          loadSnapshot(snap, 'seed')
          localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snap))
        }
      } else {
        const snap = buildSeedSnapshot()
        loadSnapshot(snap, 'seed')
        localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snap))
      }
    }
    replayOps()
    // 模拟恢复过程：恢复完成前不允许发布基线 / 导出交付包
    window.setTimeout(() => {
      recoveryState.value = 'ready'
    }, 800)
  }

  // ---- 操作日志重放（跨标签页协同） ----
  function replayOps() {
    const log = readOpLog()
    let merged = false
    for (const batch of log.ops) {
      if (appliedOpIds.value.includes(batch.opId)) continue
      mergeRemoteBatch(batch)
      appliedOpIds.value.push(batch.opId)
      lastOpId.value = batch.opId
      merged = true
    }
    if (merged) persistSnapshot()
  }

  function onStorage(e: StorageEvent) {
    if (e.key === OPS_KEY) replayOps()
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('storage', onStorage)
  }

  // ---- 三方合并：字段级 ----
  function mergeField(change: FieldChange, batch: WriteBatch) {
    const { entityType, entityId, field } = parseKey(change.key)
    if (entityType === 'meta') {
      mergeMetaField(change, batch)
      return
    }
    const list = entityType === 'device' ? devices.value : rules.value
    const entity = list.find((e) => e.id === entityId) as Record<string, unknown> | undefined
    if (!entity) return
    const meta = fieldMeta[change.key]
    const base = meta?.base ?? change.base
    const localValue = entity[field]
    const localChanged = !deepEqual(localValue, base)
    const remoteChanged = !deepEqual(change.value, change.base)

    if (change.resolvesConflict) {
      const conflict = conflicts.value.find((c) => c.id === change.resolvesConflict)
      if (conflict && conflict.status === 'pending') {
        entity[field] = change.value
        if (meta) {
          meta.base = change.value
          meta.updatedAt = batch.at
          meta.updatedBy = batch.source.tabId
        }
        conflict.status = 'resolved'
        conflict.resolvedValue = change.value
        conflict.resolvedAt = batch.at
      }
      return
    }

    if (!localChanged && !remoteChanged) return
    if (!localChanged && remoteChanged) {
      entity[field] = change.value
      if (meta) {
        meta.base = change.value
        meta.updatedAt = batch.at
        meta.updatedBy = batch.source.tabId
      }
      markChanged(entityType, entityId)
      return
    }
    if (localChanged && !remoteChanged) return
    // 两边都改了同一字段
    if (deepEqual(localValue, change.value)) {
      if (meta) {
        meta.base = change.value
        meta.updatedAt = batch.at
        meta.updatedBy = batch.source.tabId
      }
      return
    }
    addConflict(change, batch, entityType, entityId, field, base, localValue)
    markChanged(entityType, entityId)
  }

  function mergeMetaField(change: FieldChange, batch: WriteBatch) {
    const field = parseKey(change.key).field
    if (field === 'revision') {
      const next = Math.max(revision.value, change.value as number)
      revision.value = next
      fieldMeta['meta:revision'] = { base: next, updatedAt: batch.at, updatedBy: batch.source.tabId }
    } else if (field === 'locked') {
      const meta = fieldMeta['meta:locked']
      const base = meta?.base ?? change.base
      const localChanged = locked.value !== base
      const remoteChanged = (change.value as boolean) !== change.base
      if (!localChanged && remoteChanged) {
        locked.value = change.value as boolean
        fieldMeta['meta:locked'] = { base: change.value as boolean, updatedAt: batch.at, updatedBy: batch.source.tabId }
      }
      // 本地已改则保留本地状态，不被远端盖掉
    }
  }

  function addConflict(change: FieldChange, batch: WriteBatch, entityType: 'device' | 'rule', entityId: string, field: string, base: unknown, localValue: unknown) {
    let conflict = conflicts.value.find((c) => c.entityType === entityType && c.entityId === entityId && c.field === field && c.status === 'pending')
    const localMeta = fieldMeta[change.key]
    const localVersion: ConflictVersion = {
      value: localValue,
      by: localMeta?.updatedBy ?? 'unknown',
      byName: knownTabs[localMeta?.updatedBy ?? ''] ?? localMeta?.updatedBy ?? 'unknown',
      at: localMeta?.updatedAt ?? 0,
      batchId: '',
    }
    const remoteVersion: ConflictVersion = { value: change.value, by: batch.source.tabId, byName: batch.source.tabName, at: batch.at, batchId: batch.batchId }
    if (!conflict) {
      conflict = { id: `CF-${uuid()}`, entityType, entityId, field, base, versions: [localVersion, remoteVersion], status: 'pending' }
      conflicts.value.push(conflict)
    } else {
      if (!conflict.versions.some((v) => deepEqual(v.value, localValue))) conflict.versions.push(localVersion)
      if (!conflict.versions.some((v) => deepEqual(v.value, change.value))) conflict.versions.push(remoteVersion)
    }
  }

  function mergeEntityOp(op: EntityOp, batch: WriteBatch) {
    if (op.kind === 'upsert') {
      const list = op.entityType === 'device' ? devices.value : rules.value
      if (list.some((e) => e.id === op.id)) return
      list.push(op.value as never)
      for (const k of entityKeys(op.entityType, op.value)) {
        const field = k.split(':').slice(2).join(':')
        fieldMeta[k] = { base: (op.value as Record<string, unknown>)[field], updatedAt: batch.at, updatedBy: batch.source.tabId }
      }
      markChanged(op.entityType, op.id)
    } else if (op.kind === 'delete') {
      const list = op.entityType === 'device' ? devices.value : rules.value
      const idx = list.findIndex((e) => e.id === op.id)
      if (idx >= 0) list.splice(idx, 1)
      for (const k of Object.keys(fieldMeta)) {
        if (k.startsWith(`${op.entityType}:${op.id}:`)) delete fieldMeta[k]
      }
      markChanged(op.entityType, op.id)
    }
  }

  function mergeRemoteBatch(batch: WriteBatch) {
    knownTabs[batch.source.tabId] = batch.source.tabName
    for (const change of batch.fields) mergeField(change, batch)
    for (const op of batch.entityOps) mergeEntityOp(op, batch)
    for (const cid of batch.acceptedChanges) {
      if (!acceptedChanges.value.includes(cid)) acceptedChanges.value.push(cid)
    }
    recomputeInvalidations()
  }

  // ---- 本地写入：先应用，再走带重试的持久化 ----
  function makeBatch(fields: FieldChange[] = [], entityOps: EntityOp[] = [], acceptedChanges: string[] = []): WriteBatch {
    return {
      batchId: `B-${Date.now().toString().slice(-6)}-${Math.random().toString(36).slice(2, 6)}`,
      opId: `op-${uuid()}`,
      source: { tabId, tabName },
      at: Date.now(),
      fields,
      entityOps,
      acceptedChanges,
    }
  }

  function applyLocalBatch(batch: WriteBatch) {
    knownTabs[tabId] = tabName
    for (const change of batch.fields) {
      const { entityType, entityId, field } = parseKey(change.key)
      if (entityType === 'meta') {
        if (field === 'revision') revision.value = change.value as number
        else if (field === 'locked') locked.value = change.value as boolean
        fieldMeta[change.key] = { base: change.base, updatedAt: batch.at, updatedBy: tabId }
        continue
      }
      const list = entityType === 'device' ? devices.value : rules.value
      const entity = list.find((e) => e.id === entityId) as Record<string, unknown> | undefined
      if (!entity) continue
      entity[field] = change.value
      const meta = fieldMeta[change.key]
      if (meta) {
        meta.updatedAt = batch.at
        meta.updatedBy = tabId
      } else {
        fieldMeta[change.key] = { base: change.base, updatedAt: batch.at, updatedBy: tabId }
      }
      if (change.resolvesConflict) {
        const conflict = conflicts.value.find((c) => c.id === change.resolvesConflict)
        if (conflict && conflict.status === 'pending') {
          conflict.status = 'resolved'
          conflict.resolvedValue = change.value
          conflict.resolvedAt = batch.at
        }
      }
      markChanged(entityType, entityId)
    }
    for (const op of batch.entityOps) {
      if (op.kind === 'upsert') {
        const list = op.entityType === 'device' ? devices.value : rules.value
        if (!list.some((e) => e.id === op.id)) {
          list.push(op.value as never)
          for (const k of entityKeys(op.entityType, op.value)) {
            const f = k.split(':').slice(2).join(':')
            fieldMeta[k] = { base: (op.value as Record<string, unknown>)[f], updatedAt: batch.at, updatedBy: tabId }
          }
        }
        markChanged(op.entityType, op.id)
      } else if (op.kind === 'delete') {
        const list = op.entityType === 'device' ? devices.value : rules.value
        const idx = list.findIndex((e) => e.id === op.id)
        if (idx >= 0) list.splice(idx, 1)
        for (const k of Object.keys(fieldMeta)) {
          if (k.startsWith(`${op.entityType}:${op.id}:`)) delete fieldMeta[k]
        }
        markChanged(op.entityType, op.id)
      }
    }
    for (const cid of batch.acceptedChanges) {
      if (!acceptedChanges.value.includes(cid)) acceptedChanges.value.push(cid)
    }
    appliedOpIds.value.push(batch.opId)
    lastOpId.value = batch.opId
    recomputeInvalidations()
  }

  function markChanged(entityType: string, entityId: string) {
    const key = `${entityType}:${entityId}`
    if (!changedSinceApproval.value.includes(key)) changedSinceApproval.value.push(key)
  }

  function recomputeInvalidations() {
    // invalidatedConclusionIds 是 computed，这里仅触发响应式依赖更新
    void invalidatedConclusionIds.value
  }

  // ---- 持久化：失败后按原批次号重试 ----
  function persistSnapshot() {
    const snap: DraftSnapshot = {
      schemaVersion: 2,
      versionSource: versionSource.value,
      draftId: draftId.value,
      revision: revision.value,
      locked: locked.value,
      devices: devices.value,
      rules: rules.value,
      acceptedChanges: [...acceptedChanges.value],
      fieldMeta: { ...fieldMeta },
      conflicts: conflicts.value,
      approvedConclusions: approvedConclusions.value,
      changedSinceApproval: [...changedSinceApproval.value],
      appliedOpIds: [...appliedOpIds.value],
      lastOpId: lastOpId.value,
      updatedAt: Date.now(),
      updatedBy: tabId,
    }
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snap))
  }

  function appendOpToLog(batch: WriteBatch) {
    const log = readOpLog()
    if (!log.ops.some((o) => o.opId === batch.opId)) log.ops.push(batch)
    log.ops = log.ops.slice(-120)
    log.lastOpId = batch.opId
    localStorage.setItem(OPS_KEY, JSON.stringify(log))
  }

  async function simulateWrite(batch: WriteBatch, attempt: number): Promise<void> {
    await new Promise((r) => window.setTimeout(r, 120))
    // 首次写入模拟失败，重试按原批次号成功
    if (attempt === 1 && Math.random() < 0.4) {
      throw new Error('simulated write failure')
    }
    appendOpToLog(batch)
    persistSnapshot()
  }

  async function persistBatch(batch: WriteBatch) {
    lastBatch.value = batch
    lastBatchId.value = batch.batchId
    writeState.value = 'writing'
    writeError.value = null
    const maxAttempts = 3
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await simulateWrite(batch, attempt)
        writeState.value = 'idle'
        retryCount.value = 0
        return
      } catch {
        if (attempt < maxAttempts) {
          writeState.value = 'retrying'
          retryCount.value = attempt
          await new Promise((r) => window.setTimeout(r, 350 * attempt))
          // 重试沿用同一批次号 batch.batchId，服务端据此幂等去重
        } else {
          writeState.value = 'failed'
          retryCount.value = maxAttempts
          writeError.value = `批次 ${batch.batchId} 写入失败，已重试 ${maxAttempts} 次仍未成功，可手动按原批次号重试。`
        }
      }
    }
  }

  function retryLastWrite() {
    if (lastBatch.value) void persistBatch(lastBatch.value)
  }

  // ---- 实体与规则操作（走协同管线） ----
  function updateRule(id: string, patch: Partial<Rule>) {
    if (locked.value) return
    const rule = rules.value.find((item) => item.id === id)
    if (!rule) return
    const changes: FieldChange[] = Object.entries(patch).map(([k, v]) => {
      const key = `rule:${id}:${k}`
      const meta = fieldMeta[key]
      return { key, base: meta?.base ?? (rule as Record<string, unknown>)[k], value: v }
    })
    const batch = makeBatch(changes)
    applyLocalBatch(batch)
    void persistBatch(batch)
  }

  function addRule() {
    if (locked.value) return
    const id = `R-${uuid()}`
    const rule: Rule = {
      id,
      triggerId: devices.value[0]?.id ?? '',
      actionId: devices.value.at(-1)?.id ?? '',
      delay: 0,
      interlock: '无',
      priority: 2,
      suppression: '无',
      enabled: true,
    }
    const batch = makeBatch([], [{ kind: 'upsert', entityType: 'rule', id, value: rule }])
    applyLocalBatch(batch)
    void persistBatch(batch)
  }

  function batchUpdate(patch: Partial<Rule>) {
    if (locked.value) return
    const changes: FieldChange[] = []
    for (const id of selectedRuleIds.value) {
      const rule = rules.value.find((item) => item.id === id)
      if (!rule) continue
      for (const [k, v] of Object.entries(patch)) {
        const key = `rule:${id}:${k}`
        const meta = fieldMeta[key]
        changes.push({ key, base: meta?.base ?? (rule as Record<string, unknown>)[k], value: v })
      }
    }
    const batch = makeBatch(changes)
    applyLocalBatch(batch)
    void persistBatch(batch)
  }

  function toggleSelected(enabled: boolean) {
    batchUpdate({ enabled })
  }

  function addDevice(form: Device) {
    if (locked.value) return
    const batch = makeBatch([], [{ kind: 'upsert', entityType: 'device', id: form.id, value: { ...form } }])
    applyLocalBatch(batch)
    void persistBatch(batch)
  }

  function deleteDevice(id: string) {
    if (locked.value) return
    const batch = makeBatch([], [{ kind: 'delete', entityType: 'device', id }])
    applyLocalBatch(batch)
    void persistBatch(batch)
  }

  function acceptChange(id: string) {
    if (acceptedChanges.value.includes(id)) return
    const batch = makeBatch([], [], [id])
    applyLocalBatch(batch)
    void persistBatch(batch)
  }

  // ---- 冲突裁决 ----
  function resolveConflict(conflictId: string, chosenValue: unknown) {
    const conflict = conflicts.value.find((c) => c.id === conflictId)
    if (!conflict || conflict.status !== 'pending') return
    const key = `${conflict.entityType}:${conflict.entityId}:${conflict.field}`
    const batch = makeBatch([{ key, base: conflict.base, value: chosenValue, resolvesConflict: conflictId }])
    applyLocalBatch(batch)
    void persistBatch(batch)
  }

  function conflictsForEntity(entityType: string, entityId: string): FieldConflict[] {
    return conflicts.value.filter((c) => c.entityType === entityType && c.entityId === entityId && c.status === 'pending')
  }

  // ---- 基线锁定 / 解锁 ----
  function lockBaseline() {
    if (recoveryState.value !== 'ready') return
    if (!canLock.value) return
    approvedConclusions.value = validations.value.map((v) => ({
      id: v.id,
      title: v.title,
      severity: v.severity,
      refs: conclusionRefs(v, rules.value),
      approvedAt: Date.now(),
    }))
    changedSinceApproval.value = []
    const newRevision = revision.value + 1
    const changes: FieldChange[] = [
      { key: 'meta:locked', base: fieldMeta['meta:locked']?.base ?? false, value: true },
      { key: 'meta:revision', base: fieldMeta['meta:revision']?.base ?? revision.value, value: newRevision },
    ]
    const batch = makeBatch(changes)
    applyLocalBatch(batch)
    void persistBatch(batch)
  }

  function unlock() {
    const changes: FieldChange[] = [{ key: 'meta:locked', base: fieldMeta['meta:locked']?.base ?? true, value: false }]
    const batch = makeBatch(changes)
    applyLocalBatch(batch)
    void persistBatch(batch)
  }

  // 启动恢复
  init()

  return {
    // 身份
    tabId,
    tabName,
    knownTabs,
    // 核心数据
    devices,
    rules,
    revision,
    locked,
    acceptedChanges,
    selectedRuleIds,
    checklist,
    // 协同状态
    fieldMeta,
    conflicts,
    pendingConflicts,
    approvedConclusions,
    changedSinceApproval,
    invalidatedConclusionIds,
    newConclusionIds,
    conclusionsNeedReview,
    invalidReferences,
    draftId,
    versionSource,
    // 恢复与写入
    recoveryState,
    writeState,
    lastBatchId,
    retryCount,
    writeError,
    retryLastWrite,
    // 校验与门禁
    validations,
    checklistDone,
    canLock,
    canExport,
    // 操作
    replayOps,
    updateRule,
    addRule,
    batchUpdate,
    toggleSelected,
    addDevice,
    deleteDevice,
    acceptChange,
    resolveConflict,
    conflictsForEntity,
    lockBaseline,
    unlock,
  }
})
