// @vitest-environment jsdom
/**
 * 店铺层集成测试：两个 Pinia 实例模拟两个标签页，共享一份 localStorage，
 * 通过手动派发 storage 事件模拟跨页同步。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { LEGACY_KEY, LOG_KEY } from './collab'
import { useLinkageStore } from './linkage'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function notifyPeers() {
  window.dispatchEvent(new StorageEvent('storage', { key: LOG_KEY }))
}

async function sync() {
  await sleep(300) // 等待自动保存防抖 + 写入
  notifyPeers()
  await sleep(20)
}

function createTab(tabId: string) {
  ;(window as unknown as { __fireLinkageTabId?: string }).__fireLinkageTabId = tabId
  setActivePinia(createPinia())
  return useLinkageStore()
}

beforeEach(() => {
  window.localStorage.clear()
  window.sessionStorage.clear()
})

describe('双标签页协同（店铺层）', () => {
  it('两个窗口同时编辑：不冲突字段自动合并，同字段保留两版，裁决后交付放行', async () => {
    const a = createTab('tab-a')
    const b = createTab('tab-b')
    await sync()

    // 并发编辑同一规则的不同字段 → 自动合并
    a.updateRule('R-001', { delay: 7 })
    b.updateRule('R-001', { interlock: '泵启动反馈' })
    await sync()

    for (const store of [a, b]) {
      const rule = store.rules.find((item) => item.id === 'R-001')!
      expect(rule.delay).toBe(7)
      expect(rule.interlock).toBe('泵启动反馈')
      expect(store.conflicts).toHaveLength(0)
    }

    // 并发编辑同一字段 → 保留两版，交付被拦截
    a.updateRule('R-002', { delay: 8 })
    b.updateRule('R-002', { delay: 20 })
    await sync()

    for (const store of [a, b]) {
      expect(store.conflictViews).toHaveLength(1)
      expect(store.conflictViews[0].id).toBe('R-002')
      expect(store.canExport).toBe(false)
      expect(store.canLock).toBe(false)
      expect(store.deliveryBlockers.some((item) => item.includes('未裁决'))).toBe(true)
    }

    // 审阅人在 B 窗口裁决采用 A 的版本 → 冲突清除，交付放行
    b.resolveConflict(b.conflictViews[0].key, 'tab-a')
    await sync()
    for (const store of [a, b]) {
      expect(store.conflicts).toHaveLength(0)
      expect(store.rules.find((item) => item.id === 'R-002')!.delay).toBe(8)
    }
  })

  it('审阅通过后修改关联规则：结论失效挡住交付包，重新确认后放行', async () => {
    const a = createTab('tab-a')
    await sync()

    a.acceptChange('CH-02')
    await sync()
    expect(a.staleChangeIds).toEqual([])

    a.updateRule('R-006', { delay: 12 })
    await sync()
    expect(a.staleChangeIds).toEqual(['CH-02'])
    expect(a.canExport).toBe(false)
    expect(a.deliveryBlockers.some((item) => item.includes('失效'))).toBe(true)

    a.acceptChange('CH-02')
    await sync()
    expect(a.staleChangeIds).toEqual([])
  })

  it('写入失败演练：批次按原批次号重试，恢复前不能发布基线', async () => {
    const a = createTab('tab-a')
    await sync()

    a.writeFailureSimulated = true
    a.updateRule('R-004', { delay: 6 })
    await sleep(400)
    expect(a.writeError).toBeTruthy()
    expect(a.syncReady).toBe(false)
    expect(a.canLock).toBe(false)
    const pendingIds = a.outbox.map((batch) => batch.id)
    expect(pendingIds).toHaveLength(1)

    a.writeFailureSimulated = false
    a.retryNow()
    await sync()
    expect(a.writeError).toBeNull()
    expect(a.syncReady).toBe(true)
    expect(a.rules.find((item) => item.id === 'R-004')!.delay).toBe(6)
    // 重试沿用原批次号：日志中该批次只出现一次
    const log = JSON.parse(window.localStorage.getItem(LOG_KEY)!) as { batches: { id: string }[] }
    expect(log.batches.filter((batch) => batch.id === pendingIds[0])).toHaveLength(1)
  })

  it('旧稿升级：v1 草稿迁移后保留版本与审阅状态，可继续协同编辑', async () => {
    window.localStorage.setItem(LEGACY_KEY, JSON.stringify({
      devices: [{ id: 'D-09-01', name: '旧稿探测器', type: '感烟探测器', floor: '9F', zone: 'Z 区', address: '9-Z-01-01' }],
      rules: [{ id: 'R-101', triggerId: 'D-09-01', actionId: 'D-09-01', delay: 1, interlock: '无', priority: 2, suppression: '无', enabled: true }],
      revision: 12,
      locked: false,
      acceptedChanges: ['CH-01'],
    }))
    const a = createTab('tab-a')
    await sync()

    expect(a.revision).toBe(12)
    expect(a.rules.map((item) => item.id)).toEqual(['R-101'])
    expect(a.entityMeta('rule', 'R-101')?.originLabel).toBe('旧稿迁移')
    expect(a.entityMeta('rule', 'R-101')?.batchId).toBe('legacy#0')
    expect(a.acceptedChanges).toEqual(['CH-01'])

    // 续作：迁移后的草稿可以继续编辑并正常递增版本
    a.updateRule('R-101', { delay: 4 })
    await sync()
    expect(a.rules.find((item) => item.id === 'R-101')!.delay).toBe(4)
    expect(a.revision).toBe(13)
  })

  it('联调清单跨窗口同步', async () => {
    const a = createTab('tab-a')
    const b = createTab('tab-b')
    await sync()

    expect(b.checklist.filter((item) => item.done)).toHaveLength(2)
    a.toggleChecklist('跨区联动完成现场确认', true)
    await sync()
    expect(b.checklist.find((item) => item.title === '跨区联动完成现场确认')!.done).toBe(true)
  })
})
