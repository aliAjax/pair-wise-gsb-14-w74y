<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
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
  ANOMALY_META,
  BATCH_STATUS_META,
  batchConclusion,
  formatDate,
  formatDateTime,
  readiness,
  targetLabel,
} from "../domain";
import type { Batch, TargetKind } from "../types";

const store = useBatchStore();
const message = useMessage();

const operators = ["运营员甲", "运营员乙"];
const operatorOptions = operators.map((o) => ({ label: o, value: o }));

const batch = computed<Batch | undefined>(() => store.byId(store.state.selectedBatchId));

const r = computed(() => (batch.value ? readiness(batch.value) : null));
const conclusion = computed(() =>
  batch.value ? batchConclusion(batch.value, store.state.currentBatchId) : null
);

const batchOptions = computed(() =>
  store.batches.map((b) => ({
    label: `${b.id}（${BATCH_STATUS_META[b.status].label} · ${b.snapshot.surcharge}元）`,
    value: b.id,
  }))
);

// —— 发布控制（先到者持锁，失败从完整批次重试）——
function claim() {
  if (!batch.value) return;
  const res = store.claimPublish(batch.value.id, store.state.activeOperator);
  res.ok ? message.success(res.message) : message.warning(res.message);
}
function deliver() {
  if (!batch.value) return;
  const res = store.deliverPublish(batch.value.id, store.state.activeOperator);
  res.ok ? message.success(res.message) : message.error(res.message);
}
function failDelivery() {
  if (!batch.value) return;
  store.failPublish(batch.value.id, store.state.activeOperator, "下发通道超时，部分计价器未应答");
  message.error("已模拟下发失败：完整批次保留，可重新发布");
}
function release() {
  if (!batch.value) return;
  store.releaseLock(batch.value.id);
  message.info("已释放发布锁");
}

// —— 回执录入 ——
const receipt = reactive({
  kind: "meter" as TargetKind,
  code: "JY-1003",
  batchId: "",
  receiptNo: "",
  surcharge: 1.5,
});

watch(
  batch,
  (b) => {
    if (b) {
      receipt.batchId = b.id;
      receipt.surcharge = b.snapshot.surcharge;
      receipt.receiptNo = `R-${receipt.code}-${b.id}`;
    }
  },
  { immediate: true }
);

const codeOptions = computed(() => {
  const roster = receipt.kind === "meter" ? store.state.meters : store.state.posters;
  const list = roster.map((x) => ({
    label: "deviceNo" in x ? `${x.deviceNo} / ${x.vehicleNo}` : `${x.code} / ${x.name}`,
    value: "deviceNo" in x ? x.deviceNo : x.code,
  }));
  return list;
});

watch(
  () => receipt.code,
  (code) => {
    if (batch.value) receipt.receiptNo = `R-${code}-${batch.value.id}`;
  }
);

function sendReceipt() {
  if (!receipt.code || !receipt.batchId) {
    message.warning("请填写设备号和批次号");
    return;
  }
  const res = store.receiveReceipt(
    {
      kind: receipt.kind,
      code: receipt.code,
      batchId: receipt.batchId.trim(),
      receiptNo: receipt.receiptNo.trim() || `R-${receipt.code}-${Date.now()}`,
      surcharge: receipt.surcharge,
    },
    store.state.activeOperator
  );
  if (res.outcome === "acked") message.success(res.message);
  else if (res.outcome === "duplicate") message.info(res.message);
  else if (res.outcome === "held") message.warning(res.message);
  else message.error(res.message);
}

function toggleOnline(kind: TargetKind, code: string, offline: boolean) {
  if (!batch.value) return;
  store.setOffline(batch.value.id, kind, code, offline);
  message.info(offline ? `${code} 已置离线，回传挂起` : `${code} 已回连，可补回回执`);
}

// —— 补档 ——
const ledgerDate = ref("2026-09-12");
function fillLedger() {
  if (!ledgerDate.value) return;
  store.fillLedgerDate(ledgerDate.value);
  message.success(`${ledgerDate.value} 班次台账已补齐，旧附加费按生效日补档`);
}

// —— 异常 ——
function resolveAnomaly(id: string) {
  if (!batch.value) return;
  if (isFrozen.value) {
    message.error("已生效批次的异常只能备注留存，不能改写结果");
    return;
  }
  store.resolveAnomaly(batch.value.id, id, "人工核对回执一致");
  message.success("异常已核对关闭");
}

// —— 切换 ——
function doSwitch() {
  if (!batch.value) return;
  const res = store.trySwitch(batch.value.id, store.state.activeOperator);
  res.ok ? message.success(res.message) : message.warning(res.message);
}

const targetTagType: Record<string, string> = {
  pending: "default",
  offline: "warning",
  acked: "success",
  anomaly: "error",
};
const toneType = (tone: string) =>
  (({ info: "info", success: "success", warning: "warning", error: "error", default: "default" } as const)[tone as "info"] ?? "default");

const missingRetro = computed(() => batch.value?.retro.filter((x) => x.status === "missing") ?? []);
const filledRetro = computed(() => batch.value?.retro.filter((x) => x.status === "filled") ?? []);
const isFrozen = computed(() => batch.value?.status === "effective" || batch.value?.status === "history_snapshot");
</script>

<template>
  <div v-if="batch" class="detail">
    <div class="toolbar detail-bar">
      <NSelect :value="batch.id" :options="batchOptions" style="max-width: 460px" @update:value="store.selectBatch($event)" />
      <div class="operator-box">
        <span class="muted">当前操作人</span>
        <NSelect
          :value="store.state.activeOperator"
          :options="operatorOptions"
          style="width: 150px"
          @update:value="store.setOperator($event)"
        />
      </div>
    </div>

    <NAlert :type="toneType(conclusion!.tone)" class="conclusion-alert" :bordered="false">
      <strong>{{ conclusion!.title }}</strong>
      <div class="muted">{{ conclusion!.detail }}</div>
    </NAlert>

    <!-- 快照 -->
    <section class="panel">
      <h2>批次快照 <span class="muted small">{{ batch.id }}</span></h2>
      <div class="snapshot-grid">
        <div><span>92号备案价</span><strong>{{ batch.snapshot.fuelPrice.toFixed(2) }} 元/升</strong></div>
        <div><span>附加费标准</span><strong>{{ batch.snapshot.surcharge }} 元/次</strong></div>
        <div><span>分档</span><strong class="small">{{ batch.snapshot.bracketLabel }}</strong></div>
        <div><span>生效日</span><strong>{{ batch.snapshot.effectiveDate }}</strong></div>
        <div><span>备案/标准号</span><strong class="small">{{ batch.snapshot.filingId }}<br />{{ batch.snapshot.standardId }}</strong></div>
        <div><span>状态</span><NTag :type="BATCH_STATUS_META[batch.status].tag as any">{{ BATCH_STATUS_META[batch.status].label }}</NTag></div>
      </div>
      <div v-if="isFrozen" class="frozen-note">
        已于 {{ formatDateTime(batch.effectiveAt) }} 由 {{ batch.switchedBy }} 切换，快照冻结；之后到达的回执仅列异常，不改写本结果。
      </div>
      <div v-if="batch.status === 'invalidated' && batch.supersededByBatchId" class="frozen-note">
        未确认即被备案变更作废，重算承接批次：<NButton text type="primary" @click="store.selectBatch(batch.supersededByBatchId!)">{{ batch.supersededByBatchId }}</NButton>
      </div>
    </section>

    <!-- 发布 -->
    <section v-if="['pending', 'publishing', 'failed', 'collecting', 'review'].includes(batch.status)" class="panel">
      <h2>发布与下发</h2>
      <div class="publish-row">
        <template v-if="batch.status === 'pending' || batch.status === 'failed'">
          <NButton type="primary" @click="claim">
            {{ batch.status === 'failed' ? `从完整批次重试（已尝试 ${batch.attempts} 次）` : "发布本批次" }}
          </NButton>
          <span class="muted small">两名运营员并发时只放行先到者，可切换右上角操作人验证。</span>
        </template>
        <template v-else-if="batch.status === 'publishing'">
          <NTag type="warning" size="large">持锁：{{ batch.publishHolder }}（{{ formatDateTime(batch.publishClaimedAt) }}）</NTag>
          <NButton type="primary" :disabled="batch.publishHolder !== store.state.activeOperator" @click="deliver">确认下发全部目标</NButton>
          <NButton type="error" ghost :disabled="batch.publishHolder !== store.state.activeOperator" @click="failDelivery">模拟下发失败</NButton>
          <NButton :disabled="batch.publishHolder !== store.state.activeOperator" @click="release">释放锁</NButton>
          <span v-if="batch.publishHolder !== store.state.activeOperator" class="muted small">非持锁人只能查看，操作被禁用</span>
        </template>
        <template v-else>
          <NButton type="primary" @click="doSwitch">尝试切换附加费</NButton>
          <span class="muted small">
            已回执 {{ r?.acked }}/{{ r?.total }} · 离线 {{ r?.offline }} · 待回传 {{ r?.pending }} · 异常 {{ r?.openAnomalies }}
            · 补档缺 {{ r?.retroMissing }} 天（未满足时点击可查看阻断原因）
          </span>
        </template>
      </div>
    </section>

    <!-- 回执录入 -->
    <section v-if="batch.status === 'collecting' || batch.status === 'review'" class="panel">
      <h2>回连回执核对</h2>
      <p class="panel-hint">按设备号 + 批次号核对：重复回执不重复计入；设备离线则挂起；附加费与快照不符即列异常设备。</p>
      <div class="receipt-form">
        <label class="field">
          <span>类型</span>
          <NSelect v-model:value="receipt.kind" :options="[{ label: '计价器', value: 'meter' }, { label: '乘客告示', value: 'poster' }]" />
        </label>
        <label class="field">
          <span>设备号 / 告示编号</span>
          <NSelect v-model:value="receipt.code" filterable tag :options="codeOptions" />
        </label>
        <label class="field">
          <span>批次号</span>
          <NInput v-model:value="receipt.batchId" placeholder="设备上报的批次号" />
        </label>
        <label class="field">
          <span>回执号</span>
          <NInput v-model:value="receipt.receiptNo" />
        </label>
        <label class="field">
          <span>回执附加费（元/次）</span>
          <NInputNumber v-model:value="receipt.surcharge" :step="0.5" :precision="2" class="full" />
        </label>
        <div class="receipt-action">
          <NButton type="primary" @click="sendReceipt">提交回执</NButton>
        </div>
      </div>
    </section>

    <!-- 目标表 -->
    <section class="panel">
      <h2>计价器（{{ batch.meters.length }} 台）</h2>
      <table class="grid-table">
        <thead>
          <tr><th>设备号</th><th>车辆</th><th>状态</th><th>在线</th><th>快照/回执附加费</th><th>回执号</th><th>回执时间</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="m in batch.meters" :key="m.deviceNo" :class="{ 'row-anomaly': m.state === 'anomaly' }">
            <td>{{ m.deviceNo }}</td>
            <td>{{ m.vehicleNo }}</td>
            <td><NTag size="small" :type="targetTagType[m.state] as any">{{ targetLabel(m.state) }}</NTag></td>
            <td>{{ m.online ? "在线" : "离线" }}</td>
            <td>{{ m.snapshotSurcharge }} / {{ m.reportedSurcharge ?? "—" }}</td>
            <td class="small muted">{{ m.receiptNo ?? "—" }}</td>
            <td class="small">{{ formatDateTime(m.ackedAt) }}</td>
            <td>
              <template v-if="(batch.status === 'collecting' || batch.status === 'review') && m.state !== 'acked'">
                <NButton size="tiny" v-if="m.online" @click="toggleOnline('meter', m.deviceNo, true)">置离线</NButton>
                <NButton size="tiny" type="primary" v-else ghost @click="toggleOnline('meter', m.deviceNo, false)">回连</NButton>
              </template>
              <span v-else-if="m.state === 'acked'" class="muted small">已冻结</span>
            </td>
          </tr>
        </tbody>
      </table>

      <h2 style="margin-top: 18px">乘客告示（{{ batch.posters.length }} 处）</h2>
      <table class="grid-table">
        <thead>
          <tr><th>告示编号</th><th>点位</th><th>状态</th><th>在线</th><th>快照/回执附加费</th><th>回执号</th><th>回执时间</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="p in batch.posters" :key="p.code" :class="{ 'row-anomaly': p.state === 'anomaly' }">
            <td>{{ p.code }}</td>
            <td>{{ p.name }}</td>
            <td><NTag size="small" :type="targetTagType[p.state] as any">{{ targetLabel(p.state) }}</NTag></td>
            <td>{{ p.online ? "在线" : "离线" }}</td>
            <td>{{ p.snapshotSurcharge }} / {{ p.reportedSurcharge ?? "—" }}</td>
            <td class="small muted">{{ p.receiptNo ?? "—" }}</td>
            <td class="small">{{ formatDateTime(p.ackedAt) }}</td>
            <td>
              <template v-if="(batch.status === 'collecting' || batch.status === 'review') && p.state !== 'acked'">
                <NButton size="tiny" v-if="p.online" @click="toggleOnline('poster', p.code, true)">置离线</NButton>
                <NButton size="tiny" type="primary" v-else ghost @click="toggleOnline('poster', p.code, false)">回连</NButton>
              </template>
              <span v-else-if="p.state === 'acked'" class="muted small">已冻结</span>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- 异常设备单列 -->
    <section class="panel">
      <h2>异常设备 / 回执单列 <span class="muted small">（不改写已生效结果）</span></h2>
      <div v-if="batch.anomalies.length === 0" class="empty">暂无异常</div>
      <table v-else class="grid-table">
        <thead>
          <tr><th>时间</th><th>对象</th><th>类型</th><th>说明</th><th>状态</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="a in batch.anomalies" :key="a.id" :class="{ resolved: a.resolved }">
            <td class="small">{{ formatDateTime(a.at) }}</td>
            <td>{{ a.ref }}</td>
            <td><NTag size="small" :type="a.resolved ? 'default' : 'error'">{{ ANOMALY_META[a.kind] }}</NTag></td>
            <td class="small">{{ a.detail }}</td>
            <td>{{ a.resolved ? `已关闭 ${formatDate(a.resolvedAt)}` : "未处理" }}</td>
            <td>
              <NButton size="tiny" :disabled="a.resolved || isFrozen" @click="resolveAnomaly(a.id)">
                核对关闭
              </NButton>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- 历史补档 -->
    <section v-if="batch.retro.length" class="panel">
      <h2>旧附加费按生效日补档</h2>
      <div class="retro-head">
        <span class="muted small">共 {{ batch.retro.length }} 个历史班次，已补 {{ filledRetro.length }}，缺 {{ missingRetro.length }}。补不全则停在待核，不允许切换。</span>
        <div class="retro-fill">
          <NInput v-model:value="ledgerDate" type="date" style="width: 160px" />
          <NButton :disabled="!missingRetro.some((x) => x.shiftDate === ledgerDate)" @click="fillLedger">补齐该班次台账</NButton>
        </div>
      </div>
      <div class="retro-chips">
        <NTag v-for="item in batch.retro" :key="item.shiftDate" size="small" :type="item.status === 'filled' ? 'success' : 'error'" class="retro-chip">
          {{ item.shiftDate.slice(5) }} · {{ item.surcharge }}元
        </NTag>
      </div>
    </section>
  </div>
</template>
