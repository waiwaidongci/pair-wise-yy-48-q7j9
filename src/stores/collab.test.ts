// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  CHANGE_WATCH_RULES,
  CollabSession,
  LEGACY_KEY,
  LOG_KEY,
  fold,
  seedRules,
  type Batch,
  type KVLike,
  type Op,
} from './collab'

function memoryStorage(): KVLike & { dump: Map<string, string> } {
  const dump = new Map<string, string>()
  return {
    dump,
    getItem: (key) => dump.get(key) ?? null,
    setItem: (key, value) => void dump.set(key, value),
    removeItem: (key) => void dump.delete(key),
  }
}

function manualScheduler() {
  const tasks: (() => void)[] = []
  return {
    tasks,
    schedule: (fn: () => void) => void tasks.push(fn),
    runAll() {
      while (tasks.length) tasks.shift()?.()
    },
  }
}

type SessionOptions = { failWrites?: () => boolean }

function makeSession(storage: KVLike, tabId: string, options: SessionOptions = {}) {
  const scheduler = manualScheduler()
  const session = new CollabSession({
    storage,
    tabId,
    autoFlush: false,
    schedule: scheduler.schedule,
    failWrites: options.failWrites,
  })
  session.recover()
  return { session, scheduler }
}

const rule = (sessions: CollabSession, id: string) => sessions.snapshot().state.rules.find((item) => item.id === id)

describe('协同草稿引擎', () => {
  it('不冲突的字段自动合并：两个窗口同时改同一规则的不同字段', async () => {
    const storage = memoryStorage()
    const a = makeSession(storage, 'tab-a')
    const b = makeSession(storage, 'tab-b')

    a.session.submit([{ type: 'rule.set', id: 'R-001', field: 'delay', value: 7 }])
    // B 在未看到 A 的批次时改另一个字段（并发）
    b.session.submit([{ type: 'rule.set', id: 'R-001', field: 'interlock', value: '泵启动反馈' }])
    await a.session.flush()
    await b.session.flush()
    a.session.reload()
    b.session.reload()

    for (const session of [a.session, b.session]) {
      const target = rule(session, 'R-001')
      expect(target?.delay).toBe(7)
      expect(target?.interlock).toBe('泵启动反馈')
      expect(session.snapshot().state.conflicts).toHaveLength(0)
    }
  })

  it('同一规则同一字段两边都改过：保留两版待裁决，裁决后两端一致', async () => {
    const storage = memoryStorage()
    const a = makeSession(storage, 'tab-a')
    const b = makeSession(storage, 'tab-b')

    a.session.submit([{ type: 'rule.set', id: 'R-002', field: 'delay', value: 8 }])
    b.session.submit([{ type: 'rule.set', id: 'R-002', field: 'delay', value: 20 }])
    await a.session.flush()
    await b.session.flush()
    a.session.reload()
    b.session.reload()

    for (const session of [a.session, b.session]) {
      const state = session.snapshot().state
      // 生效值停在日志中靠前的版本，分叉前的原始值与两版都留在冲突记录里
      expect(state.rules.find((item) => item.id === 'R-002')?.delay).toBe(8)
      const conflict = state.conflicts.find((item) => item.id === 'R-002')
      expect(conflict).toBeDefined()
      expect(conflict?.fields.delay.base).toBe(5)
      expect(conflict?.fields.delay.values).toEqual({ 'tab-a': 8, 'tab-b': 20 })
    }

    // 审阅人在 B 窗口裁决：采用 A 的版本，整版写回
    const current = rule(b.session, 'R-002')!
    b.session.submit([{ type: 'rule.restore', id: 'R-002', values: { ...current, delay: 8 } }], 'resolve')
    await b.session.flush()
    a.session.reload()

    for (const session of [a.session, b.session]) {
      expect(rule(session, 'R-002')?.delay).toBe(8)
      expect(session.snapshot().state.conflicts).toHaveLength(0)
    }
  })

  it('因果在后的普通编辑不算冲突：看到对方批次后再改直接覆盖', async () => {
    const storage = memoryStorage()
    const a = makeSession(storage, 'tab-a')
    const b = makeSession(storage, 'tab-b')

    a.session.submit([{ type: 'rule.set', id: 'R-003', field: 'priority', value: 3 }])
    await a.session.flush()
    b.session.reload() // B 先看到 A 的批次
    b.session.submit([{ type: 'rule.set', id: 'R-003', field: 'priority', value: 1 }])
    await b.session.flush()
    a.session.reload()

    expect(rule(a.session, 'R-003')?.priority).toBe(1)
    expect(a.session.snapshot().state.conflicts).toHaveLength(0)
  })

  it('旧稿升级：迁移 v1 草稿并补齐版本来源', () => {
    const storage = memoryStorage()
    storage.setItem(LEGACY_KEY, JSON.stringify({
      devices: [{ id: 'D-09-01', name: '旧稿探测器', type: '感烟探测器', floor: '9F', zone: 'Z 区', address: '9-Z-01-01' }],
      rules: [{ id: 'R-101', triggerId: 'D-09-01', actionId: 'D-09-01', delay: 1, interlock: '无', priority: 2, suppression: '无', enabled: true }],
      revision: 12,
      locked: true,
      acceptedChanges: ['CH-01'],
    }))

    const { session } = makeSession(storage, 'tab-a')
    const state = session.snapshot().state
    expect(state.devices.map((item) => item.id)).toEqual(['D-09-01'])
    expect(state.rules.map((item) => item.id)).toEqual(['R-101'])
    // 版本来源：保留旧 revision，来源标记为旧稿迁移
    expect(state.revision).toBe(12)
    expect(state.ruleMeta['R-101'].origin).toBe('legacy')
    expect(state.ruleMeta['R-101'].batchId).toBe('legacy#0')
    expect(state.deviceMeta['D-09-01'].origin).toBe('legacy')
    expect(state.locked).toBeTruthy()
    expect(Object.keys(state.accepted)).toEqual(['CH-01'])
  })

  it('写入失败后按原批次号重试，日志里只出现一次', async () => {
    const storage = memoryStorage()
    let failing = true
    const { session, scheduler } = makeSession(storage, 'tab-a', { failWrites: () => failing })

    const batch = session.submit([{ type: 'rule.set', id: 'R-004', field: 'delay', value: 6 }])
    const originalId = batch.id
    await session.flush()
    expect(session.snapshot().writeError).toBeTruthy()
    // 有待写批次时发布闸门关闭
    expect(session.snapshot().syncReady).toBe(false)
    expect(session.snapshot().outbox.map((item) => item.id)).toEqual([originalId])

    // 自动重试仍然失败，批次号不变
    failing = true
    scheduler.runAll()
    await Promise.resolve()
    expect(session.snapshot().outbox.map((item) => item.id)).toEqual([originalId])

    failing = false
    await session.flush()
    expect(session.snapshot().outbox).toHaveLength(0)
    expect(session.snapshot().syncReady).toBe(true)
    const log = JSON.parse(storage.getItem(LOG_KEY)!) as { batches: Batch[] }
    expect(log.batches.filter((item) => item.id === originalId)).toHaveLength(1)
    expect(rule(session, 'R-004')?.delay).toBe(6)
  })

  it('崩溃重启后从待写箱恢复，沿用原批次号补写', async () => {
    const storage = memoryStorage()
    let failing = true
    const first = makeSession(storage, 'tab-a', { failWrites: () => failing })
    const batch = first.session.submit([{ type: 'rule.set', id: 'R-008', field: 'enabled', value: false }])
    await first.session.flush()
    expect(first.session.snapshot().outbox).toHaveLength(1)

    // 模拟标签页崩溃重启：新会话、同一 tabId、同一存储
    failing = true
    const second = makeSession(storage, 'tab-a', { failWrites: () => failing })
    expect(second.session.snapshot().outbox.map((item) => item.id)).toEqual([batch.id])
    expect(second.session.snapshot().recovered).toBe(false)

    failing = false
    await second.session.flush()
    expect(second.session.snapshot().recovered).toBe(true)
    const log = JSON.parse(storage.getItem(LOG_KEY)!) as { batches: Batch[] }
    expect(log.batches.filter((item) => item.id === batch.id)).toHaveLength(1)
    // 新批次号不与补写批次冲突
    const next = second.session.submit([{ type: 'rule.set', id: 'R-008', field: 'enabled', value: true }])
    expect(next.id).not.toBe(batch.id)
  })

  it('折叠幂等：同一批次重复出现只应用一次', () => {
    const batch: Batch = {
      id: 'tab-a#0',
      tab: 'tab-a',
      seq: 0,
      at: 1,
      kind: 'edit',
      seen: { seed: 0 },
      ops: [{ type: 'rule.set', id: 'R-001', field: 'delay', value: 9 }],
    }
    const seed: Batch = {
      id: 'seed#0',
      tab: 'seed',
      seq: 0,
      at: 0,
      kind: 'seed',
      seen: {},
      baseRevision: 8,
      ops: seedRules.map((item): Op => ({ type: 'rule.add', rule: item })),
    }
    const state = fold([seed, batch, batch])
    expect(state.rules.find((item) => item.id === 'R-001')?.delay).toBe(9)
    expect(state.revision).toBe(9) // 重复批次不计入版本号
  })

  it('审阅通过后修改关联规则或设备：结论失效，重新确认后恢复', () => {
    const storage = memoryStorage()
    const { session } = makeSession(storage, 'tab-a')

    session.submit([{ type: 'review.accept', changeId: 'CH-02', ruleIds: CHANGE_WATCH_RULES['CH-02'] }], 'review')
    expect(session.snapshot().state.staleChangeIds).toEqual([])

    // 修改关联规则 R-006 → CH-02 结论失效
    session.submit([{ type: 'rule.set', id: 'R-006', field: 'delay', value: 12 }])
    expect(session.snapshot().state.staleChangeIds).toEqual(['CH-02'])

    // 重新确认（重算依据）→ 恢复有效
    session.submit([{ type: 'review.accept', changeId: 'CH-02', ruleIds: CHANGE_WATCH_RULES['CH-02'] }], 'review')
    expect(session.snapshot().state.staleChangeIds).toEqual([])

    // 修改 R-006 的动作设备 A-02-02 → 仅 CH-02 失效
    session.submit([{ type: 'device.set', id: 'A-02-02', field: 'address', value: '2-L-01-09' }])
    expect(session.snapshot().state.staleChangeIds).toEqual(['CH-02'])

    // 修改 D-02-01（R-005 与 R-006 共同的触发点位）→ CH-01、CH-02 一起失效
    session.submit([{ type: 'device.set', id: 'D-02-01', field: 'address', value: '2-B-01-09' }])
    expect(session.snapshot().state.staleChangeIds).toEqual(['CH-01', 'CH-02'])
  })

  it('并发新增规则撞号：确定性改号，两端结果一致', async () => {
    const storage = memoryStorage()
    const a = makeSession(storage, 'tab-a')
    const b = makeSession(storage, 'tab-b')
    const base = seedRules[0]

    a.session.submit([{ type: 'rule.add', rule: { ...base, id: 'R-009', interlock: 'A 窗口新增' } }])
    b.session.submit([{ type: 'rule.add', rule: { ...base, id: 'R-009', interlock: 'B 窗口新增' } }])
    await a.session.flush()
    await b.session.flush()
    a.session.reload()
    b.session.reload()

    const idsA = a.session.snapshot().state.rules.map((item) => item.id)
    const idsB = b.session.snapshot().state.rules.map((item) => item.id)
    expect(idsA).toEqual(idsB)
    expect(idsA).toContain('R-009')
    expect(idsA).toContain('R-010')
    const interlocks = a.session.snapshot().state.rules.filter((item) => item.id === 'R-009' || item.id === 'R-010').map((item) => item.interlock)
    expect(interlocks.sort()).toEqual(['A 窗口新增', 'B 窗口新增'])
  })

  it('联调清单与签字锁定也是协同数据', async () => {
    const storage = memoryStorage()
    const a = makeSession(storage, 'tab-a')
    const b = makeSession(storage, 'tab-b')

    a.session.submit([{ type: 'review.check', item: '跨区联动完成现场确认', done: true }], 'review')
    await a.session.flush()
    b.session.reload()
    expect(b.session.snapshot().state.checklist['跨区联动完成现场确认'].done).toBe(true)

    b.session.submit([{ type: 'baseline.lock' }], 'baseline')
    await b.session.flush()
    a.session.reload()
    const locked = a.session.snapshot().state.locked
    expect(locked).toBeTruthy()
    expect(locked && locked.by).toBe('tab-b')

    a.session.submit([{ type: 'baseline.unlock' }], 'baseline')
    await a.session.flush()
    b.session.reload()
    expect(b.session.snapshot().state.locked).toBe(false)
  })

  it('版本号随协同批次递增，且两端一致', async () => {
    const storage = memoryStorage()
    const a = makeSession(storage, 'tab-a')
    const b = makeSession(storage, 'tab-b')
    const before = a.session.snapshot().state.revision

    a.session.submit([{ type: 'rule.set', id: 'R-001', field: 'delay', value: 3 }])
    await a.session.flush()
    b.session.submit([{ type: 'rule.set', id: 'R-002', field: 'delay', value: 4 }])
    await b.session.flush()
    a.session.reload()
    b.session.reload()

    expect(a.session.snapshot().state.revision).toBe(before + 2)
    expect(b.session.snapshot().state.revision).toBe(before + 2)
  })
})
