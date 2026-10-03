<script setup lang="ts">
import { computed } from 'vue'
import { useLinkageStore } from '../stores/linkage'

const store = useLinkageStore()

const changes = [
  { id: 'CH-01', title: 'PF-2 增加防火阀开启反馈互锁', source: '暖通专业', oldValue: '互锁：无', newValue: '互锁：防火阀开启反馈', risk: '低' },
  { id: 'CH-02', title: '电梯归位延时由 0 秒调整至 10 秒', source: '电梯专业', oldValue: '延时：0s', newValue: '延时：10s', risk: '中' },
  { id: 'CH-03', title: '机房感烟联动 1F 排烟风机', source: '智能化专业', oldValue: '无关系', newValue: 'R-007 / 当前停用', risk: '高' },
]

const FIELD_LABELS: Record<string, string> = {
  name: '设备名称', type: '设备类型', floor: '楼层', zone: '防火分区', address: '回路地址',
  triggerId: '触发点位', actionId: '动作点位', delay: '延时(s)', interlock: '互锁条件',
  priority: '优先级', suppression: '抑制条件', enabled: '启用状态',
}

const acceptedMap = computed(() => new Map(store.acceptedRecords.map((record) => [record.changeId, record])))

function fieldLabel(field: string) {
  return FIELD_LABELS[field] ?? field
}

function fmt(value: unknown): string {
  if (value === undefined || value === null) return '—'
  if (typeof value === 'boolean') return value ? '启用' : '停用'
  return String(value)
}

function fmtTime(at: number) {
  return new Date(at).toLocaleTimeString('zh-CN', { hour12: false })
}

function exportPackage() {
  if (!store.canExport) return
  const payload = JSON.stringify({
    revision: store.revision,
    exportedAt: new Date().toISOString(),
    exportedBy: store.tabLabel,
    devices: store.devices,
    rules: store.rules,
    validations: store.validations,
    acceptedChanges: store.acceptedRecords,
    checklist: store.checklist,
    provenance: Object.fromEntries(store.rules.map((rule) => [rule.id, store.entityMeta('rule', rule.id)])),
    recentBatches: store.recentBatches,
  }, null, 2)
  const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `消防联动交付包-R${store.revision}.json`
  link.click()
  URL.revokeObjectURL(url)
}
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div><p class="eyebrow">REVIEW & SIGN-OFF / 审阅签字</p><h1>冲突裁决、联调清单与锁定</h1><p class="muted">多窗口协同编辑的草稿在此汇合：裁决冲突、确认失效结论，全部清零后才能签字锁定。</p></div>
      <div class="actions">
        <v-btn variant="outlined" prepend-icon="mdi-download" :disabled="!store.canExport" @click="exportPackage">导出交付包</v-btn>
        <v-btn v-if="!store.locked" color="primary" prepend-icon="mdi-lock-outline" :disabled="!store.canLock" @click="store.lockBaseline">签字锁定</v-btn>
        <v-btn v-else color="warning" variant="outlined" @click="store.unlock">解锁修订</v-btn>
      </div>
    </div>

    <v-alert v-if="store.deliveryBlockers.length && !store.locked" type="warning" variant="tonal" class="mb-3">
      <strong>交付包已被拦截，请先处理：</strong>
      <ul class="blocker-list"><li v-for="item in store.deliveryBlockers" :key="item">{{ item }}</li></ul>
    </v-alert>
    <v-alert v-else-if="!store.canLock && !store.locked" type="warning" variant="tonal" class="mb-3">签字前需清除所有错误规则并完成联调清单。</v-alert>
    <v-alert v-if="store.locked" type="success" variant="tonal" class="mb-3">当前版本 R{{ store.revision }} 已签字锁定，任何修改都会生成新的修订草稿。</v-alert>

    <section v-if="store.conflictViews.length" class="panel conflict-panel">
      <div class="panel-head">
        <h3>协同冲突裁决</h3>
        <v-chip size="small" color="error" variant="tonal">{{ store.conflictViews.length }} 个待裁决</v-chip>
      </div>
      <article v-for="conflict in store.conflictViews" :key="conflict.key" class="conflict-card">
        <header>
          <strong>{{ conflict.kind === 'rule' ? '规则' : '设备' }} {{ conflict.id }}</strong>
          <span class="muted">{{ conflict.tabs.map((tab) => tab.label).join(' 与 ') }} 同时修改，两版都已保留</span>
          <span class="muted">冲突发生于 {{ fmtTime(conflict.createdAt) }}</span>
        </header>
        <v-table density="compact">
          <thead>
            <tr><th>字段</th><th>原始值（分叉前）</th><th v-for="tab in conflict.tabs" :key="tab.tab">{{ tab.label }} 保存的版本</th></tr>
          </thead>
          <tbody>
            <tr v-for="field in conflict.fields" :key="field.field">
              <td>{{ fieldLabel(field.field) }}</td>
              <td class="base">{{ fmt(field.base) }}</td>
              <td v-for="tab in conflict.tabs" :key="tab.tab" class="variant">
                {{ fmt(field.values.find((item) => item.tab === tab.tab)?.value) }}
              </td>
            </tr>
          </tbody>
        </v-table>
        <footer>
          <v-btn
            v-for="tab in conflict.tabs"
            :key="tab.tab"
            size="small"
            color="primary"
            variant="tonal"
            @click="store.resolveConflict(conflict.key, tab.tab)"
          >采用{{ tab.label }}版本</v-btn>
          <v-btn size="small" variant="text" @click="store.resolveConflict(conflict.key, 'base')">恢复原始值</v-btn>
        </footer>
      </article>
    </section>

    <div class="review-grid">
      <section class="panel">
        <div class="panel-head"><h3>矩阵校验结果</h3><v-chip size="small" color="error" variant="tonal">{{ store.validations.length }} 项</v-chip></div>
        <div class="validation-list">
          <article v-for="item in store.validations" :key="item.id" :class="item.severity">
            <v-icon :icon="item.severity === '错误' ? 'mdi-close-octagon-outline' : 'mdi-alert-outline'" />
            <div><strong>{{ item.title }}</strong><p>{{ item.detail }}</p><small>建议：{{ item.suggestion }}</small></div>
            <v-btn size="small" variant="text" @click="$router.push('/matrix')">定位</v-btn>
          </article>
          <div v-if="store.validations.length === 0" class="empty-validation"><v-icon icon="mdi-check-decagram" size="38" color="success" /><strong>矩阵校验通过</strong><span>未发现遗漏、重复、矛盾或跨区冲突。</span></div>
        </div>
      </section>

      <aside>
        <section class="panel">
          <div class="panel-head"><h3>联调清单</h3><span class="muted">{{ store.checklist.filter((item) => item.done).length }}/{{ store.checklist.length }}</span></div>
          <div class="checklist">
            <v-checkbox
              v-for="item in store.checklist"
              :key="item.title"
              :model-value="item.done"
              :label="item.title"
              :hint="item.owner"
              persistent-hint
              density="compact"
              @update:model-value="store.toggleChecklist(item.title, Boolean($event))"
            />
          </div>
        </section>

        <section class="panel sync-panel">
          <div class="panel-head"><h3>协同写入状态</h3><v-chip size="small" :color="store.syncReady ? 'success' : 'warning'" variant="tonal">{{ store.syncReady ? '已同步' : '待恢复' }}</v-chip></div>
          <div class="sync-body">
            <div class="sync-row"><span>本窗口</span><strong>{{ store.tabLabel }}</strong></div>
            <div class="sync-row"><span>联调窗口</span><strong>{{ store.peers.length ? `${store.peers.length + 1} 个在线` : '仅本窗口' }}</strong></div>
            <div class="sync-row"><span>待写入批次</span><strong :class="{ warn: store.outbox.length }">{{ store.outbox.length ? store.outbox.map((batch) => batch.id).join('、') : '无' }}</strong></div>
            <v-alert v-if="store.writeError" type="error" variant="tonal" density="compact" class="my-2">
              {{ store.writeError }}，按原批次号自动重试中
              <v-btn size="x-small" variant="text" @click="store.retryNow">立即重试</v-btn>
            </v-alert>
            <v-switch
              :model-value="store.writeFailureSimulated"
              label="模拟共享存储写入失败（演练重试）"
              color="warning"
              density="compact"
              hide-details
              @update:model-value="store.writeFailureSimulated = Boolean($event)"
            />
            <div class="batch-log">
              <div v-for="batch in [...store.recentBatches].reverse()" :key="batch.id" class="batch-row">
                <span class="mono">{{ batch.id }}</span>
                <span>{{ batch.tabLabel }} · {{ batch.ops }} 项操作</span>
                <v-chip v-if="batch.pending" size="x-small" color="warning" variant="tonal">待写入</v-chip>
                <small v-else>{{ fmtTime(batch.at) }}</small>
              </div>
            </div>
          </div>
        </section>
      </aside>
    </div>

    <section class="panel change-panel">
      <div class="panel-head"><h3>专业提交版本差异</h3><span class="muted">验收后关联规则/设备再被修改，结论会失效需重新确认</span></div>
      <v-table>
        <thead><tr><th>变更</th><th>来源</th><th>原始值</th><th>提交值</th><th>风险</th><th>决定</th></tr></thead>
        <tbody>
          <tr v-for="change in changes" :key="change.id" :class="{ 'row-stale': acceptedMap.get(change.id)?.stale }">
            <td><strong>{{ change.id }}</strong><br />{{ change.title }}</td>
            <td>{{ change.source }}</td>
            <td class="old">{{ change.oldValue }}</td>
            <td class="new">{{ change.newValue }}</td>
            <td><v-chip size="small" :color="change.risk === '高' ? 'error' : change.risk === '中' ? 'warning' : 'success'" variant="tonal">{{ change.risk }}</v-chip></td>
            <td>
              <template v-if="acceptedMap.get(change.id)">
                <div v-if="acceptedMap.get(change.id)!.stale" class="stale-cell">
                  <v-chip size="small" color="warning" variant="tonal" prepend-icon="mdi-refresh">已失效</v-chip>
                  <v-btn size="small" color="primary" variant="tonal" @click="store.acceptChange(change.id)">重新确认</v-btn>
                </div>
                <v-chip v-else color="success" variant="tonal" prepend-icon="mdi-check">已接受 · {{ acceptedMap.get(change.id)!.byLabel }}</v-chip>
              </template>
              <v-btn v-else size="small" color="primary" variant="tonal" @click="store.acceptChange(change.id)">接受变更</v-btn>
            </td>
          </tr>
        </tbody>
      </v-table>
    </section>
  </section>
</template>

<style scoped>
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
.blocker-list { margin: 6px 0 0; padding-left: 18px; }
.review-grid { display: grid; grid-template-columns: minmax(0,1fr) 350px; gap: 14px; margin-bottom: 14px; }
.review-grid aside { display: grid; gap: 14px; align-content: start; }
.validation-list { padding: 8px 16px 16px; }
.validation-list article { display: grid; grid-template-columns: 28px 1fr auto; gap: 10px; padding: 13px 0; border-bottom: 1px solid #edf0f0; }
.validation-list article.error { color: #b13d2c; }
.validation-list article.warning { color: #b87b22; }
.validation-list strong { font-size: 13px; }
.validation-list p { margin: 5px 0; color: #59676d; font-size: 12px; line-height: 1.5; }
.validation-list small { color: #7f8b90; }
.empty-validation { display: grid; justify-items: center; gap: 7px; padding: 42px; color: #3d7b63; }
.empty-validation span { color: #748086; font-size: 12px; }
.checklist { padding: 10px 14px 16px; }
.change-panel { overflow-x: auto; }
.change-panel :deep(table) { min-width: 850px; }
.old { color: #a54b35; }
.new { color: #2e755e; font-weight: 700; }
.row-stale { background: #fff8ec; }
.stale-cell { display: flex; align-items: center; gap: 8px; }
.conflict-panel { margin-bottom: 14px; }
.conflict-card { padding: 14px 16px; border-bottom: 1px solid #edf0f0; }
.conflict-card:last-child { border-bottom: 0; }
.conflict-card header { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 8px; }
.conflict-card header strong { font-size: 14px; }
.conflict-card header .muted { font-size: 12px; }
.conflict-card td.base { color: #7f8b90; }
.conflict-card td.variant { color: #2e5e75; font-weight: 600; }
.conflict-card footer { display: flex; gap: 8px; margin-top: 10px; }
.sync-panel .sync-body { padding: 12px 16px 16px; display: grid; gap: 8px; }
.sync-row { display: flex; justify-content: space-between; gap: 10px; font-size: 12px; color: #68767d; }
.sync-row strong { color: #2d3f46; font-weight: 600; text-align: right; }
.sync-row strong.warn { color: #b87b22; }
.batch-log { margin-top: 6px; border-top: 1px dashed #e0e5e5; padding-top: 8px; display: grid; gap: 6px; }
.batch-row { display: flex; align-items: center; gap: 8px; font-size: 11px; color: #68767d; }
.batch-row .mono { font-family: ui-monospace, monospace; color: #267078; font-weight: 700; }
.batch-row small { margin-left: auto; color: #93a1a6; }
@media (max-width: 1000px) { .review-grid { grid-template-columns: 1fr; } }
</style>
