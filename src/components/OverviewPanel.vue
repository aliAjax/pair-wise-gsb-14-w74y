<script setup lang="ts">
import { computed, reactive } from "vue";
import {
  NAlert,
  NButton,
  NInput,
  NInputNumber,
  NSelect,
  NTag,
  useMessage,
} from "naive-ui";
import { useBatchStore } from "../store";
import {
  addDateDays,
  ANOMALY_META,
  BATCH_STATUS_META,
  batchConclusion,
  formatDate,
  readiness,
  surchargeBracket,
} from "../domain";
import type { Batch } from "../types";

const store = useBatchStore();
const message = useMessage();

const operators = ["运营员甲", "运营员乙"];
const operatorOptions = operators.map((o) => ({ label: o, value: o }));

const form = reactive({
  fuelPrice: 8.58,
  effectiveDate: addDateDays(1),
  operator: store.state.activeOperator,
  note: "",
});

const preview = computed(() => surchargeBracket(form.fuelPrice));

const current = computed(() => store.currentBatch);
const pendingBatches = computed(() =>
  store.batches.filter((b) => b.status !== "effective" && b.status !== "history_snapshot" && b.status !== "invalidated")
);
const invalidatedBatches = computed(() => store.batches.filter((b) => b.status === "invalidated"));
const openAnomalies = computed(() =>
  store.batches.reduce(
    (n, b) =>
      n +
      (b.status === "effective" || b.status === "history_snapshot"
        ? 0
        : b.anomalies.filter((a) => !a.resolved).length),
    0
  )
);
const waitingAcks = computed(() =>
  pendingBatches.value.reduce((n, b) => n + readiness(b).pending + readiness(b).offline, 0)
);
const offlineCount = computed(() =>
  pendingBatches.value.reduce((n, b) => n + readiness(b).offline, 0)
);

function submitFiling() {
  const res = store.filePrice({
    fuelPrice: form.fuelPrice,
    effectiveDate: form.effectiveDate,
    operator: form.operator,
    note: form.note,
  });
  if (res.ok) {
    message.success(`备案已记账，重算批次 ${res.batchId}：未确认批次已失效，附加费将为 ${preview.value.surcharge} 元/次`);
    store.setTab("detail");
    form.note = "";
  } else {
    message.error(res.message);
  }
}

function openBatch(b: Batch) {
  store.selectBatch(b.id);
  store.setTab("detail");
}

const toneType = (tone: string) =>
  (({ info: "info", success: "success", warning: "warning", error: "error", default: "default" } as const)[tone as "info"] ?? "default");
</script>

<template>
  <div class="overview">
    <NAlert v-if="current" type="success" class="hero" :bordered="false">
      <div class="hero-title">
        当前执行：附加费 <strong>{{ current.snapshot.surcharge }} 元/次</strong>
        <NTag size="small" type="success" round>{{ current.id }}</NTag>
      </div>
      <div class="hero-sub">
        92号汽油备案价 {{ current.snapshot.fuelPrice.toFixed(2) }} 元/升 · 生效日
        {{ current.snapshot.effectiveDate }} · {{ current.snapshot.bracketLabel }}
      </div>
    </NAlert>

    <section class="metrics">
      <article class="metric">
        <span>在途批次</span>
        <strong>{{ pendingBatches.length }}</strong>
        <small>待发布/回传/待核</small>
      </article>
      <article class="metric">
        <span>待回传目标</span>
        <strong>{{ waitingAcks }}</strong>
        <small>其中离线 {{ offlineCount }} 台</small>
      </article>
      <article class="metric">
        <span>未处理异常</span>
        <strong :class="{ bad: openAnomalies > 0 }">{{ openAnomalies }}</strong>
        <small>单列，不改写已生效结果</small>
      </article>
      <article class="metric">
        <span>已失效重算</span>
        <strong>{{ invalidatedBatches.length }}</strong>
        <small>备案一改即作废</small>
      </article>
      <article class="metric">
        <span>历史生效快照</span>
        <strong>{{ store.batches.filter((b) => b.status === 'effective' || b.status === 'history_snapshot').length }}</strong>
        <small>按当时标准保留</small>
      </article>
    </section>

    <div class="two-col">
      <form class="panel filing" @submit.prevent="submitFiling">
        <h2>92号汽油备案价变更</h2>
        <p class="panel-hint">备案一旦变更：未确认批次立即失效重算，已生效班次保留当时快照。</p>
        <label class="field">
          <span>备案价（元/升）</span>
          <NInputNumber v-model:value="form.fuelPrice" :min="3" :max="20" :step="0.01" :precision="2" class="full" />
        </label>
        <div class="preview">
          联动预判：<NTag size="small" type="info">{{ preview.label }}</NTag>
        </div>
        <label class="field">
          <span>拟生效日期</span>
          <NInput v-model:value="form.effectiveDate" type="date" />
        </label>
        <label class="field">
          <span>备案运营员</span>
          <NSelect v-model:value="form.operator" :options="operatorOptions" />
        </label>
        <label class="field">
          <span>备案说明</span>
          <NInput v-model:value="form.note" type="textarea" placeholder="例如：发改委月度调价备案" />
        </label>
        <NButton type="primary" block attr-type="submit">记账并重算执行批次</NButton>
      </form>

      <section class="panel">
        <div class="toolbar">
          <h2>批次执行链</h2>
        </div>
        <div class="record-grid">
          <article v-for="b in store.batches" :key="b.id" class="record batch-card" @click="openBatch(b)">
            <div class="record-head">
              <p class="record-title">
                {{ b.id }}
                <NTag v-if="b.id === store.state.currentBatchId" size="small" type="success" round>当前</NTag>
              </p>
              <NTag :type="BATCH_STATUS_META[b.status].tag as any">{{ BATCH_STATUS_META[b.status].label }}</NTag>
            </div>
            <div class="details">
              <span>备案价：{{ b.snapshot.fuelPrice.toFixed(2) }} 元</span>
              <span>附加费快照：{{ b.snapshot.surcharge }} 元/次</span>
              <span>生效日：{{ formatDate(b.snapshot.effectiveDate) }}</span>
              <span>回传：{{ readiness(b).acked }}/{{ readiness(b).total }}</span>
            </div>
            <NAlert :type="toneType(batchConclusion(b, store.state.currentBatchId).tone)" :show-icon="false" :bordered="false" class="conclusion">
              {{ batchConclusion(b, store.state.currentBatchId).title }}
            </NAlert>
            <div v-if="b.anomalies.filter((a) => !a.resolved).length" class="anomaly-chips">
              <NTag v-for="a in b.anomalies.filter((x) => !x.resolved).slice(0, 3)" :key="a.id" size="small" type="warning">
                {{ a.ref }} · {{ ANOMALY_META[a.kind] }}
              </NTag>
            </div>
          </article>
        </div>
      </section>
    </div>
  </div>
</template>
