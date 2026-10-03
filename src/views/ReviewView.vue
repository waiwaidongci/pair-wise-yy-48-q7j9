<script setup lang="ts">
import { computed, ref } from 'vue'
import { useLinkageStore } from '../stores/linkage'

const store = useLinkageStore()
const exportBlockers = ref<string[]>([])

const changes = [
  { id: 'CH-01', title: 'PF-2 增加防火阀开启反馈互锁', source: '暖通专业', oldValue: '互锁：无', newValue: '互锁：防火阀开启反馈', risk: '低' },
  { id: 'CH-02', title: '电梯归位延时由 0 秒调整至 10 秒', source: '电梯专业', oldValue: '延时：0s', newValue: '延时：10s', risk: '中' },
  { id: 'CH-03', title: '机房感烟联动 1F 排烟风机', source: '智能化专业', oldValue: '无关系', newValue: 'R-007 / 当前停用', risk: '高' },
]

const errorCount = computed(() => store.validations.filter((item) => item.severity === '错误').length)
const warningCount = computed(() => store.validations.filter((item) => item.severity === '警告').length)

const invalidatedApproved = computed(() =>
  store.approvedConclusions.filter((c) => store.invalidatedConclusionIds.includes(c.id)).map((c) => ({
    ...c,
    stillPresent: store.validations.some((v) => v.id === c.id),
  })),
)

const lockBlockers = computed(() => {
  const blockers: string[] = []
  if (store.recoveryState !== 'ready') blockers.push('协同草稿仍在恢复中，暂不能发布基线')
  if (errorCount.value > 0) blockers.push(`${errorCount.value} 个阻断错误未清除`)
  if (!store.checklistDone) blockers.push('联调清单未全部完成')
  if (store.pendingConflicts.length > 0) blockers.push(`${store.pendingConflicts.length} 项协同冲突未裁决`)
  if (store.invalidReferences.length > 0) blockers.push(`${store.invalidReferences.length} 处失效引用`)
  if (store.conclusionsNeedReview.length > 0) blockers.push(`${store.conclusionsNeedReview.length} 项结论失效待重算`)
  return blockers
})

function accept(id: string) {
  store.acceptChange(id)
}

function resolve(conflictId: string, value: unknown) {
  store.resolveConflict(conflictId, value)
}

function entityLabel(entityType: string, entityId: string): string {
  if (entityType === 'rule') return entityId
  const d = store.devices.find((item) => item.id === entityId)
  return d ? `${entityId} ${d.name}` : entityId
}

function exportPackage() {
  const blockers: string[] = []
  if (store.recoveryState !== 'ready') blockers.push('协同草稿仍在恢复中，不能发布交付包')
  if (store.pendingConflicts.length > 0) blockers.push(`${store.pendingConflicts.length} 项未裁决冲突`)
  if (store.invalidReferences.length > 0) blockers.push(`${store.invalidReferences.length} 处失效引用`)
  if (!store.canExport && blockers.length === 0) blockers.push('交付包被未知原因挡住')
  if (blockers.length) {
    exportBlockers.value = blockers
    return
  }
  exportBlockers.value = []
  const payload = JSON.stringify({
    revision: store.revision,
    devices: store.devices,
    rules: store.rules,
    validations: store.validations,
    acceptedChanges: store.acceptedChanges,
    conflicts: store.conflicts,
    approvedConclusions: store.approvedConclusions,
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
      <div><p class="eyebrow">REVIEW & SIGN-OFF / 审阅签字</p><h1>版本差异、联调清单与锁定</h1><p class="muted">多个专业提交后只接受经过审阅的变更，锁定后配置成为只读基线。</p></div>
      <div class="actions">
        <v-btn variant="outlined" prepend-icon="mdi-download" @click="exportPackage">导出交付包</v-btn>
        <v-btn v-if="!store.locked" color="primary" prepend-icon="mdi-lock-outline" :disabled="!store.canLock" @click="store.lockBaseline">签字锁定</v-btn>
        <v-btn v-else color="warning" variant="outlined" @click="store.unlock">解锁修订</v-btn>
      </div>
    </div>

    <v-alert v-if="store.recoveryState !== 'ready'" type="info" variant="tonal" class="mb-3" icon="mdi-database-sync-outline">
      正在恢复协同草稿（合并离线期间的字段级变更），恢复完成前不能发布基线或导出交付包…
      <v-progress-linear indeterminate color="primary" class="mt-2" />
    </v-alert>

    <v-alert v-if="exportBlockers.length" type="error" variant="tonal" class="mb-3" icon="mdi-block-helper">
      <strong>交付包被挡住：</strong>
      <ul class="blocker-list"><li v-for="(b, i) in exportBlockers" :key="i">{{ b }}</li></ul>
    </v-alert>

    <v-alert v-if="!store.canLock && store.recoveryState === 'ready' && !store.locked" type="warning" variant="tonal" class="mb-3">
      <strong>暂不能签字锁定：</strong>
      <ul class="blocker-list"><li v-for="(b, i) in lockBlockers" :key="i">{{ b }}</li></ul>
    </v-alert>

    <v-alert v-if="store.locked" type="success" variant="tonal" class="mb-3">当前版本 R{{ store.revision }} 已签字锁定，任何修改都会生成新的修订草稿。</v-alert>

    <!-- 协同冲突裁决 -->
    <section v-if="store.pendingConflicts.length" class="panel conflict-panel">
      <div class="panel-head">
        <h3>协同冲突裁决</h3>
        <v-chip size="small" color="error" variant="tonal">{{ store.pendingConflicts.length }} 项未裁决</v-chip>
      </div>
      <p class="conflict-hint">两个窗口都改过同一字段，已保留两版。请选择一版作为裁决结果，裁决后各窗口自动收敛到同一值。</p>
      <div v-for="conflict in store.pendingConflicts" :key="conflict.id" class="conflict-item">
        <div class="conflict-head">
          <v-chip size="x-small" variant="outlined">{{ conflict.entityType === 'rule' ? '规则' : '设备' }} · {{ entityLabel(conflict.entityType, conflict.entityId) }} · {{ conflict.field }}</v-chip>
          <span class="muted">基线值：<code>{{ String(conflict.base) }}</code></span>
        </div>
        <div class="versions">
          <div v-for="(version, idx) in conflict.versions" :key="idx" class="version-card">
            <div class="version-meta">
              <v-chip size="x-small" :color="idx === 0 ? 'primary' : 'secondary'" variant="tonal">{{ version.byName }}</v-chip>
              <span class="muted">{{ new Date(version.at).toLocaleTimeString('zh-CN') }}</span>
            </div>
            <div class="version-value"><code>{{ String(version.value) }}</code></div>
            <v-btn size="small" variant="tonal" color="primary" @click="resolve(conflict.id, version.value)">采用此版</v-btn>
          </div>
        </div>
      </div>
    </section>

    <!-- 失效引用 -->
    <section v-if="store.invalidReferences.length" class="panel invalid-panel">
      <div class="panel-head">
        <h3>失效引用</h3>
        <v-chip size="small" color="error" variant="tonal">{{ store.invalidReferences.length }} 处</v-chip>
      </div>
      <p class="conflict-hint">以下规则引用了不存在的设备，交付包会被挡住。请在矩阵中改指到有效设备，或删除该规则。</p>
      <div class="invalid-list">
        <div v-for="(ref, i) in store.invalidReferences" :key="i" class="invalid-item">
          <v-icon icon="mdi-link-variant-off" color="error" />
          <span>规则 <code>{{ ref.ruleId }}</code> 的 <code>{{ ref.field }}</code> 指向不存在的设备 <code>{{ ref.deviceId }}</code></span>
        </div>
      </div>
    </section>

    <!-- 失效基线结论 -->
    <section v-if="invalidatedApproved.length" class="panel stale-panel">
      <div class="panel-head">
        <h3>失效基线结论</h3>
        <v-chip size="small" color="warning" variant="tonal">{{ invalidatedApproved.length }} 项待重算确认</v-chip>
      </div>
      <p class="conflict-hint">签字基线所依据的结论在设备或规则被修改后已失效，系统已重新计算。重新锁定后这些结论才会作为新基线。</p>
      <div class="invalid-list">
        <div v-for="c in invalidatedApproved" :key="c.id" class="invalid-item">
          <v-icon :icon="c.stillPresent ? 'mdi-alert-rhombus-outline' : 'mdi-check-circle-outline'" :color="c.stillPresent ? 'warning' : 'success'" />
          <span><strong>{{ c.title }}</strong><v-chip size="x-small" :color="c.stillPresent ? 'warning' : 'success'" variant="tonal" class="ml-2">{{ c.stillPresent ? '仍存在' : '已重算解决' }}</v-chip></span>
        </div>
      </div>
    </section>

    <div class="review-grid">
      <section class="panel">
        <div class="panel-head"><h3>矩阵校验结果</h3><v-chip size="small" color="error" variant="tonal">{{ store.validations.length }} 项</v-chip></div>
        <div class="validation-list">
          <article v-for="item in store.validations" :key="item.id" :class="[item.severity, { invalidated: store.invalidatedConclusionIds.includes(item.id), new: store.newConclusionIds.includes(item.id) }]">
            <v-icon :icon="item.severity === '错误' ? 'mdi-close-octagon-outline' : 'mdi-alert-outline'" />
            <div>
              <strong>{{ item.title }}</strong>
              <v-chip v-if="store.invalidatedConclusionIds.includes(item.id)" size="x-small" color="warning" variant="tonal" class="ml-2">失效重算</v-chip>
              <v-chip v-else-if="store.newConclusionIds.includes(item.id)" size="x-small" color="info" variant="tonal" class="ml-2">新增待审</v-chip>
              <p>{{ item.detail }}</p><small>建议：{{ item.suggestion }}</small>
            </div>
            <v-btn size="small" variant="text" @click="$router.push('/matrix')">定位</v-btn>
          </article>
          <div v-if="store.validations.length === 0" class="empty-validation"><v-icon icon="mdi-check-decagram" size="38" color="success" /><strong>矩阵校验通过</strong><span>未发现遗漏、重复、矛盾或跨区冲突。</span></div>
        </div>
      </section>

      <aside>
        <section class="panel">
          <div class="panel-head"><h3>联调清单</h3><span class="muted">{{ store.checklist.filter((item) => item.done).length }}/{{ store.checklist.length }}</span></div>
          <div class="checklist">
            <v-checkbox v-for="item in store.checklist" :key="item.title" v-model="item.done" :label="item.title" :hint="item.owner" persistent-hint density="compact" />
          </div>
        </section>
      </aside>
    </div>

    <section class="panel change-panel">
      <div class="panel-head"><h3>专业提交版本差异</h3><span class="muted">可逐项接受</span></div>
      <v-table>
        <thead><tr><th>变更</th><th>来源</th><th>原始值</th><th>提交值</th><th>风险</th><th>决定</th></tr></thead>
        <tbody>
          <tr v-for="change in changes" :key="change.id">
            <td><strong>{{ change.id }}</strong><br />{{ change.title }}</td>
            <td>{{ change.source }}</td>
            <td class="old">{{ change.oldValue }}</td>
            <td class="new">{{ change.newValue }}</td>
            <td><v-chip size="small" :color="change.risk === '高' ? 'error' : change.risk === '中' ? 'warning' : 'success'" variant="tonal">{{ change.risk }}</v-chip></td>
            <td><v-btn v-if="!store.acceptedChanges.includes(change.id)" size="small" color="primary" variant="tonal" @click="accept(change.id)">接受变更</v-btn><v-chip v-else color="success" variant="tonal" prepend-icon="mdi-check">已接受</v-chip></td>
          </tr>
        </tbody>
      </v-table>
    </section>
  </section>
</template>

<style scoped>
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
.blocker-list { margin: 6px 0 0; padding-left: 20px; }
.blocker-list li { margin: 2px 0; }
.conflict-panel { margin-bottom: 14px; border-color: #e3b23c; }
.conflict-hint { margin: 0 16px 12px; color: #7a6a3a; font-size: 12px; }
.conflict-item { margin: 0 16px 14px; padding: 12px; border: 1px solid #f0e2b8; border-radius: 8px; background: #fffdf5; }
.conflict-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.conflict-head code { color: #a33a2a; }
.versions { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
.version-card { display: grid; gap: 8px; padding: 10px; border: 1px solid #e4e7e7; border-radius: 8px; background: white; }
.version-meta { display: flex; align-items: center; gap: 8px; }
.version-value code { font-size: 14px; color: #265e66; font-weight: 700; }
.invalid-panel { margin-bottom: 14px; border-color: #d98a7a; }
.stale-panel { margin-bottom: 14px; border-color: #e3b23c; }
.invalid-list { padding: 0 16px 14px; }
.invalid-item { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid #f0e0dc; font-size: 13px; }
.invalid-item code { color: #a33a2a; }
.review-grid { display: grid; grid-template-columns: minmax(0,1fr) 350px; gap: 14px; margin-bottom: 14px; }
.validation-list { padding: 8px 16px 16px; }
.validation-list article { display: grid; grid-template-columns: 28px 1fr auto; gap: 10px; padding: 13px 0; border-bottom: 1px solid #edf0f0; }
.validation-list article.error { color: #b13d2c; }
.validation-list article.warning { color: #b87b22; }
.validation-list article.invalidated { background: #fff8e6; }
.validation-list article.new { background: #eef6fb; }
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
.ml-2 { margin-left: 6px; }
@media (max-width: 1000px) { .review-grid { grid-template-columns: 1fr; } }
</style>
