import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  CHANGE_WATCH_RULES,
  CHECKLIST_ITEMS,
  CollabSession,
  LOG_KEY,
  seedDevices,
  seedRules,
  suggestRuleId,
  type CollabSnapshot,
  type Device,
  type DeviceType,
  type EntityKind,
  type Op,
  type Rule,
} from './collab'

export { seedDevices, seedRules }
export type { Device, DeviceType, Rule }

export type Validation = { id: string; severity: '错误' | '警告'; ruleIds: string[]; title: string; detail: string; suggestion: string }

export type ConflictFieldView = { field: string; base: unknown; values: { tab: string; label: string; value: unknown }[] }
export type ConflictView = {
  key: string
  kind: EntityKind
  id: string
  createdAt: number
  fields: ConflictFieldView[]
  tabs: { tab: string; label: string }[]
}

const TAB_ID_KEY = 'fire-linkage-tab-id'

function ensureTabId(): string {
  // 测试钩子：集成测试用来模拟两个标签页
  const forced = (window as unknown as { __fireLinkageTabId?: string }).__fireLinkageTabId
  if (forced) return forced
  let id = window.sessionStorage.getItem(TAB_ID_KEY)
  if (!id) {
    id = `tab-${Math.random().toString(36).slice(2, 8)}`
    window.sessionStorage.setItem(TAB_ID_KEY, id)
  }
  return id
}

export const useLinkageStore = defineStore('linkage', () => {
  const writeFailureSimulated = ref(false)
  const session = new CollabSession({
    storage: window.localStorage,
    tabId: ensureTabId(),
    failWrites: () => writeFailureSimulated.value,
  })
  session.recover()

  const snap = ref<CollabSnapshot>(session.snapshot())
  session.subscribe((next) => {
    snap.value = next
  })

  window.addEventListener('storage', (event) => {
    if (event.key && event.key.startsWith(LOG_KEY)) session.reload()
  })
  session.heartbeat()
  window.setInterval(() => session.heartbeat(), 4000)

  const state = computed(() => snap.value.state)
  const devices = computed(() => state.value.devices)
  const rules = computed(() => state.value.rules)
  const revision = computed(() => state.value.revision)
  const locked = computed(() => state.value.locked !== false)
  const lockedInfo = computed(() => state.value.locked)
  const acceptedChanges = computed(() => Object.keys(state.value.accepted))
  const staleChangeIds = computed(() => state.value.staleChangeIds)
  const conflicts = computed(() => state.value.conflicts)
  const selectedRuleIds = ref<string[]>([])
  const recovered = computed(() => snap.value.recovered)
  const syncReady = computed(() => snap.value.syncReady)
  const outbox = computed(() => snap.value.outbox)
  const writeError = computed(() => snap.value.writeError)
  const peers = computed(() => snap.value.peers)
  const tabLabel = computed(() => snap.value.tabLabel)
  const labels = computed(() => snap.value.labels)

  const checklist = computed(() =>
    CHECKLIST_ITEMS.map((item) => ({
      ...item,
      done: state.value.checklist[item.title]?.done ?? false,
      by: state.value.checklist[item.title]?.by,
    })),
  )

  function tabLabelOf(tab: string): string {
    return labels.value[tab] ?? tab
  }

  const validations = computed<Validation[]>(() => {
    const result: Validation[] = []
    const byId = new Map(devices.value.map((device) => [device.id, device]))
    // 失效引用：规则指向的触发/动作设备不在台账中
    for (const rule of rules.value) {
      if (!byId.has(rule.triggerId)) {
        result.push({ id: `dangling-trigger-${rule.id}`, severity: '错误', ruleIds: [rule.id], title: `${rule.id} 触发点位引用失效`, detail: `规则引用的触发设备 ${rule.triggerId} 不在设备台账中。`, suggestion: '恢复设备台账或删除该规则后再交付。' })
      }
      if (!byId.has(rule.actionId)) {
        result.push({ id: `dangling-action-${rule.id}`, severity: '错误', ruleIds: [rule.id], title: `${rule.id} 动作点位引用失效`, detail: `规则引用的动作设备 ${rule.actionId} 不在设备台账中。`, suggestion: '恢复设备台账或删除该规则后再交付。' })
      }
    }
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
      const trigger = byId.get(rule.triggerId)
      const action = byId.get(rule.actionId)
      if (trigger && action && trigger.zone !== action.zone && rule.suppression === '无') {
        result.push({ id: `cross-${rule.id}`, severity: '警告', ruleIds: [rule.id], title: `${rule.id} 跨区联动未配置抑制`, detail: `${trigger.zone} 报警将直接触发 ${action.zone} 动作。`, suggestion: '确认疏散边界并增加分区确认或抑制条件。' })
      }
      if (rule.interlock && rule.interlock !== '无' && rule.delay > 5 && rule.priority === 1) {
        result.push({ id: `contradiction-${rule.id}`, severity: '错误', ruleIds: [rule.id], title: `${rule.id} 互锁与高优先级延时冲突`, detail: '一级优先规则在互锁未明确反馈前延时超过 5 秒。', suggestion: '缩短延时或改为反馈后触发。' })
      }
    })
    return result
  })

  const errorCount = computed(() => validations.value.filter((item) => item.severity === '错误').length)

  /** 待裁决冲突（带上各窗口标签，供审阅人裁决） */
  const conflictViews = computed<ConflictView[]>(() =>
    conflicts.value.map((conflict) => {
      const tabs = new Map<string, { tab: string; label: string }>()
      const fields = Object.entries(conflict.fields).map(([field, entry]) => {
        const values = Object.entries(entry.values).map(([tab, value]) => {
          tabs.set(tab, { tab, label: tabLabelOf(tab) })
          return { tab, label: tabLabelOf(tab), value }
        })
        return { field, base: entry.base, values }
      })
      return { key: conflict.key, kind: conflict.kind, id: conflict.id, createdAt: conflict.createdAt, fields, tabs: [...tabs.values()] }
    }),
  )

  const conflictRuleIds = computed(() => new Set(conflicts.value.filter((item) => item.kind === 'rule').map((item) => item.id)))

  /** 交付拦截原因：未裁决冲突、失效结论、失效引用、未恢复完成都会挡住交付包 */
  const deliveryBlockers = computed<string[]>(() => {
    const list: string[] = []
    if (!recovered.value) list.push('协同草稿尚未恢复完成，不能拿半份结果发布基线')
    if (outbox.value.length > 0) list.push(`${outbox.value.length} 个批次（${outbox.value.map((batch) => batch.id).join('、')}）尚未写入共享存储`)
    if (writeError.value) list.push(`批次写入失败：${writeError.value}，正在按原批次号重试`)
    if (conflicts.value.length > 0) list.push(`${conflicts.value.length} 条规则/设备存在未裁决的协同冲突`)
    if (staleChangeIds.value.length > 0) list.push(`${staleChangeIds.value.length} 项已接受变更（${staleChangeIds.value.join('、')}）的依据已失效，需重新确认`)
    const dangling = validations.value.filter((item) => item.id.startsWith('dangling')).length
    if (dangling > 0) list.push(`${dangling} 条规则引用失效设备`)
    return list
  })

  const checklistDone = computed(() => checklist.value.every((item) => item.done))
  const canLock = computed(() => deliveryBlockers.value.length === 0 && errorCount.value === 0 && checklistDone.value)
  const canExport = computed(() => syncReady.value && !writeError.value && conflicts.value.length === 0 && staleChangeIds.value.length === 0)

  const acceptedRecords = computed(() =>
    Object.values(state.value.accepted).map((record) => ({
      ...record,
      byLabel: tabLabelOf(record.by),
      stale: staleChangeIds.value.includes(record.changeId),
    })),
  )

  const recentBatches = computed(() => {
    const pending = new Set(outbox.value.map((batch) => batch.id))
    return state.value.recentBatches.map((batch) => ({ ...batch, pending: pending.has(batch.id), tabLabel: tabLabelOf(batch.tab) }))
  })

  /** 版本来源：实体来自初始数据 / 旧稿迁移 / 协同编辑，以及最近写入它的批次 */
  function entityMeta(kind: EntityKind, id: string) {
    const meta = kind === 'rule' ? state.value.ruleMeta[id] : state.value.deviceMeta[id]
    if (!meta) return null
    const originLabel = meta.origin === 'legacy' ? '旧稿迁移' : meta.origin === 'seed' ? '初始数据' : '协同编辑'
    return { ...meta, originLabel, updatedByLabel: tabLabelOf(meta.updatedBy), createdByLabel: tabLabelOf(meta.createdBy) }
  }

  function updateRule(id: string, patch: Partial<Rule>) {
    if (locked.value) return
    const ops: Op[] = Object.entries(patch).map(([field, value]) => ({ type: 'rule.set', id, field: field as keyof Rule, value }))
    if (ops.length > 0) session.submit(ops, 'edit')
  }

  function addRule() {
    if (locked.value) return
    const rule: Rule = {
      id: suggestRuleId(rules.value.map((item) => item.id)),
      triggerId: devices.value[0]?.id ?? '',
      actionId: devices.value.at(-1)?.id ?? '',
      delay: 0,
      interlock: '无',
      priority: 2,
      suppression: '无',
      enabled: true,
    }
    session.submit([{ type: 'rule.add', rule }], 'edit')
  }

  function addDevice(device: Device) {
    if (locked.value) return
    session.submit([{ type: 'device.add', device }], 'edit')
  }

  function batchUpdate(patch: Partial<Rule>) {
    if (locked.value) return
    const ops: Op[] = []
    for (const id of selectedRuleIds.value) {
      for (const [field, value] of Object.entries(patch)) ops.push({ type: 'rule.set', id, field: field as keyof Rule, value })
    }
    if (ops.length > 0) session.submit(ops, 'edit')
  }

  function toggleSelected(enabled: boolean) {
    batchUpdate({ enabled })
  }

  function acceptChange(changeId: string) {
    session.submit([{ type: 'review.accept', changeId, ruleIds: CHANGE_WATCH_RULES[changeId] ?? [] }], 'review')
  }

  function toggleChecklist(title: string, done: boolean) {
    session.submit([{ type: 'review.check', item: title, done }], 'review')
  }

  /** 审阅人裁决冲突：采用某个窗口的版本，或恢复分叉前的原始值 */
  function resolveConflict(key: string, choice: string) {
    const conflict = conflicts.value.find((item) => item.key === key)
    if (!conflict) return
    const current = conflict.kind === 'rule' ? rules.value.find((item) => item.id === conflict.id) : devices.value.find((item) => item.id === conflict.id)
    if (!current) return
    const values = { ...current } as Record<string, unknown>
    for (const [field, entry] of Object.entries(conflict.fields)) {
      values[field] = choice === 'base' ? entry.base : (entry.values[choice] !== undefined ? entry.values[choice] : entry.base)
    }
    const op: Op = conflict.kind === 'rule'
      ? { type: 'rule.restore', id: conflict.id, values: values as unknown as Rule }
      : { type: 'device.restore', id: conflict.id, values: values as unknown as Device }
    session.submit([op], 'resolve')
  }

  async function lockBaseline() {
    // 先把在途批次写入共享日志，再校验发布闸门
    await session.flush()
    if (!canLock.value) return
    session.submit([{ type: 'baseline.lock' }], 'baseline')
    await session.flush()
  }

  function unlock() {
    session.submit([{ type: 'baseline.unlock' }], 'baseline')
  }

  function retryNow() {
    void session.flush()
  }

  return {
    devices,
    rules,
    revision,
    locked,
    lockedInfo,
    acceptedChanges,
    acceptedRecords,
    staleChangeIds,
    selectedRuleIds,
    validations,
    errorCount,
    checklist,
    conflicts,
    conflictViews,
    conflictRuleIds,
    deliveryBlockers,
    canLock,
    canExport,
    recovered,
    syncReady,
    outbox,
    writeError,
    peers,
    tabLabel,
    recentBatches,
    writeFailureSimulated,
    entityMeta,
    updateRule,
    addRule,
    addDevice,
    batchUpdate,
    toggleSelected,
    acceptChange,
    toggleChecklist,
    resolveConflict,
    lockBaseline,
    unlock,
    retryNow,
  }
})
