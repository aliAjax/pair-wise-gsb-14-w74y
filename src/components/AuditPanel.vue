<script setup lang="ts">
import { computed, ref } from "vue";
import { NAlert, NButton, NInput, NSelect, NTag } from "naive-ui";
import { useBatchStore } from "../store";
import {
  AUDIT_ACTION_LABELS,
  BATCH_STATUS_META,
  batchConclusion,
  formatDateTime,
} from "../domain";
import type { AuditTone } from "../types";

const store = useBatchStore();

const keyword = ref("");
const actionFilter = ref<string | null>(null);
const batchFilter = ref<string | null>(null);

const actionOptions = Object.entries(AUDIT_ACTION_LABELS).map(([value, label]) => ({ label, value }));
const batchOptions = computed(() =>
  store.batches.map((b) => ({
    label: `${b.id}（${BATCH_STATUS_META[b.status].label}）`,
    value: b.id,
  }))
);

const toneTag: Record<AuditTone, string> = {
  info: "info",
  success: "success",
  warning: "warning",
  danger: "error",
};

const rows = computed(() => {
  const kw = keyword.value.trim();
  return store.state.audit.filter((e) => {
    if (actionFilter.value && e.action !== actionFilter.value) return false;
    if (batchFilter.value && e.batchId !== batchFilter.value) return false;
    if (kw && !`${e.detail}${e.actor}${e.id}${e.batchId ?? ""}`.includes(kw)) return false;
    return true;
  });
});

// 审计页顶部读取的“结论”与总览/详情完全同源（同一函数、同一批数据，不另算口径）
const conclusions = computed(() =>
  store.batches.slice(0, 4).map((b) => ({ id: b.id, c: batchConclusion(b, store.state.currentBatchId) }))
);

function resetData() {
  if (confirm("恢复为演示种子数据？当前 localStorage 中的操作将被清空。")) {
    store.resetAll();
  }
}
</script>

<template>
  <div class="audit-view">
    <section class="panel">
      <h2>各批次当前结论（与总览/详情同源）</h2>
      <div class="audit-conclusions">
        <NAlert
          v-for="item in conclusions"
          :key="item.id"
          :type="(({ info: 'info', success: 'success', warning: 'warning', error: 'error', default: 'default' } as const)[item.c.tone] ?? 'default')"
          :bordered="false"
          class="conclusion"
        >
          <NTag size="tiny" style="margin-right: 6px">{{ item.id }}</NTag>
          {{ item.c.title }}
        </NAlert>
      </div>
    </section>

    <section class="panel">
      <div class="toolbar">
        <h2>审计流水（只追加，不改写）</h2>
        <NButton size="small" secondary @click="resetData">恢复演示数据</NButton>
      </div>
      <div class="audit-filters">
        <NInput v-model:value="keyword" placeholder="搜索明细 / 操作人 / 回执 / 批次" clearable style="max-width: 280px" />
        <NSelect v-model:value="actionFilter" :options="actionOptions" placeholder="动作类型" clearable style="width: 170px" />
        <NSelect v-model:value="batchFilter" :options="batchOptions" placeholder="批次号" clearable style="width: 240px" />
        <span class="muted small">共 {{ rows.length }} 条</span>
      </div>
      <table class="grid-table audit-table">
        <thead>
          <tr><th style="width: 165px">时间</th><th style="width: 110px">操作人</th><th style="width: 120px">动作</th><th style="width: 150px">批次</th><th>明细</th></tr>
        </thead>
        <tbody>
          <tr v-for="e in rows" :key="e.id">
            <td class="small">{{ formatDateTime(e.ts) }}</td>
            <td>{{ e.actor }}</td>
            <td><NTag size="small" :type="toneTag[e.tone] as any">{{ AUDIT_ACTION_LABELS[e.action] ?? e.action }}</NTag></td>
            <td>
              <NButton v-if="e.batchId" text type="primary" size="small" @click="store.selectBatch(e.batchId!); store.setTab('detail')">
                {{ e.batchId }}
              </NButton>
              <span v-else class="muted">—</span>
            </td>
            <td class="small">{{ e.detail }}</td>
          </tr>
          <tr v-if="rows.length === 0">
            <td colspan="5" class="empty">无匹配审计记录</td>
          </tr>
        </tbody>
      </table>
    </section>
  </div>
</template>
