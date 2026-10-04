<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { useBatchStore } from "./store";
import type { BatchView } from "./domain/engine";
import type { BackfillEntry } from "./domain/types";

const store = useBatchStore();

const tabs = [
  { key: "overview", label: "总览" },
  { key: "detail", label: "批次详情" },
  { key: "shift", label: "班次与补档" },
  { key: "audit", label: "审计" }
] as const;
type TabKey = (typeof tabs)[number]["key"];
const tab = ref<TabKey>("overview");

// 三个页签读取的是同一个 model.conclusion 对象 —— 总览、详情、审计同一结论
const conclusion = computed(() => store.model.conclusion);

const statusLabel: Record<string, string> = {
  pending: "待确认",
  active: "已生效",
  retired: "已停用（旧快照保留）",
  superseded: "已失效（已重算）"
};

// ------------------------------------------------------------ 备案登记
const today = new Date().toISOString().slice(0, 10);
const filingForm = reactive({
  fuelPrice: 7.9,
  surcharge: 2,
  effectiveDate: today,
  operator: "运营员甲",
  note: "",
  retroactive: false
});

function submitFiling() {
  store.registerFiling({ ...filingForm });
}

// ------------------------------------------------------------ 批次详情
const pendingBatch = computed<BatchView | null>(() => conclusion.value.pendingBatch);
const activeBatch = computed<BatchView | null>(() => conclusion.value.activeBatch);
const publishOperator = ref("运营员甲");

type DeviceRow = { id: string; kind: "计价器" | "告示"; state: "received" | "quarantined" | "offline"; receipt?: string };
function deviceRows(b: BatchView | null): DeviceRow[] {
  if (!b) return [];
  const rows: DeviceRow[] = [];
  for (const id of store.meterIds) {
    rows.push(classify(b, id, "计价器"));
  }
  for (const id of store.noticeIds) {
    rows.push(classify(b, id, "告示"));
  }
  return rows;
}
function classify(b: BatchView, id: string, kind: "计价器" | "告示"): DeviceRow {
  if (b.quarantined[id]) return { id, kind, state: "quarantined" };
  const r = b.received[id];
  if (r) return { id, kind, state: "received", receipt: r.receiptId };
  return { id, kind, state: "offline" };
}

const demoDevice = ref("M-03");
const totalDevices = store.meterIds.length + store.noticeIds.length;

function progress(b: BatchView | null) {
  if (!b) return 0;
  return Math.round((b.readiness.receivedCount / b.readiness.totalExpected) * 100);
}

// ------------------------------------------------------------ 补档
function heldEntries(): BackfillEntry[] {
  const bf = store.model.conclusion.backfill ?? store.state.backfill;
  if (!bf) return [];
  return bf.entries.filter((e) => e.status === "held");
}
function filledEntries(): BackfillEntry[] {
  const bf = store.state.backfill;
  if (!bf) return [];
  return bf.entries.filter((e) => e.status === "filled");
}

function fmtTime(at: string) {
  return at.replace("T", " ").replace(".000Z", " UTC");
}
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">城市出租车 · 92号汽油备案价联动</p>
          <h1>燃油附加费执行批次</h1>
          <p class="subtitle">
            备案价变化即重算未确认批次；计价器与乘客告示全部回传一致后才切换附加费；
            已生效班次保留当时快照，异常设备单列且不得改写已生效结果。
          </p>
        </div>
        <div class="top-actions">
          <button class="secondary" type="button" @click="store.resetSeed()">恢复演示基线</button>
        </div>
      </header>

      <!-- 唯一结论横幅：总览/详情/审计引用同一对象 -->
      <section class="conclusion" :class="conclusion.canSwitch ? 'is-ready' : 'is-blocked'">
        <div class="conclusion-head">
          <span class="dot" />
          <strong>系统结论（总览、详情、审计同源）</strong>
        </div>
        <p>{{ conclusion.verdict }}</p>
        <div class="conclusion-chips">
          <span>生效批次：{{ conclusion.activeBatch ? conclusion.activeBatch.id : "无" }}</span>
          <span>待确认批次：{{ conclusion.pendingBatch ? conclusion.pendingBatch.id : "无" }}</span>
          <span>缺计价器回执：{{ conclusion.pendingMetersMissing }}</span>
          <span>缺告示回执：{{ conclusion.pendingNoticesMissing }}</span>
          <span>异常设备：{{ conclusion.anomalyCount }}</span>
          <span v-if="conclusion.backfill" class="chip-warn">补档：{{ conclusion.backfill.status === "held" ? "停在待核" : "进行中" }}</span>
        </div>
      </section>

      <p v-if="store.lastError" class="flash flash-bad">{{ store.lastError }}</p>
      <p v-if="store.lastInfo" class="flash flash-ok">{{ store.lastInfo }}</p>

      <nav class="tabs">
        <button
          v-for="t in tabs"
          :key="t.key"
          type="button"
          :class="{ active: tab === t.key }"
          @click="tab = t.key"
        >
          {{ t.label }}
        </button>
      </nav>

      <!-- ============================== 总览 ============================== -->
      <section v-if="tab === 'overview'" class="tab-body">
        <section class="metrics">
          <article class="metric">
            <span>当前生效附加费</span>
            <strong>{{ conclusion.activeBatch ? conclusion.activeBatch.surcharge + " 元/次" : "—" }}</strong>
            <small v-if="conclusion.activeBatch">
              备案 {{ conclusion.activeBatch.fuelPrice }} 元/L · 快照 {{ conclusion.activeBatch.filingId }}
            </small>
          </article>
          <article class="metric">
            <span>待确认批次</span>
            <strong>{{ conclusion.pendingBatch ? conclusion.pendingBatch.id : "无" }}</strong>
            <small v-if="conclusion.pendingBatch">
              目标附加费 {{ conclusion.pendingBatch.surcharge }} 元/次
            </small>
          </article>
          <article class="metric">
            <span>回传一致进度</span>
            <strong v-if="conclusion.pendingBatch">
              {{ conclusion.pendingBatch.readiness.receivedCount }}/{{ totalDevices }}
            </strong>
            <strong v-else>—</strong>
            <small v-if="conclusion.pendingBatch">全部一致才允许切换</small>
          </article>
          <article class="metric">
            <span>异常设备（累计）</span>
            <strong :class="{ 'num-warn': conclusion.anomalyCount > 0 }">{{ conclusion.anomalyCount }}</strong>
            <small>单列，不改写已生效结果</small>
          </article>
        </section>

        <div class="two-col">
          <form class="panel" @submit.prevent="submitFiling">
            <h2>92号汽油备案登记</h2>
            <p class="panel-hint">登记新版本后，未确认批次立即失效并按新备案重算；已生效班次不受影响。</p>
            <div class="form-grid">
              <label>备案价（元/L）
                <input v-model.number="filingForm.fuelPrice" type="number" step="0.01" min="0.01" required />
              </label>
              <label>附加费标准（元/次）
                <input v-model.number="filingForm.surcharge" type="number" step="0.5" min="0" required />
              </label>
              <label>生效日期
                <input v-model="filingForm.effectiveDate" type="date" required />
              </label>
              <label>运营员
                <select v-model="filingForm.operator">
                  <option>运营员甲</option>
                  <option>运营员乙</option>
                </select>
              </label>
              <label class="wide">说明
                <input v-model="filingForm.note" placeholder="如：10月调价 / 旧标准补档" />
              </label>
              <label class="check wide">
                <input v-model="filingForm.retroactive" type="checkbox" />
                旧附加费补档登记（按生效日补历史，补不全停在待核）
              </label>
            </div>
            <button type="submit">登记备案并重算批次</button>
          </form>

          <section class="panel">
            <h2>批次总览</h2>
            <div v-for="b in store.model.batches" :key="b.id" class="batch-card" :class="`st-${b.status}`">
              <div class="batch-card-head">
                <strong>{{ b.id }}</strong>
                <span class="status" :class="`st-${b.status}`">{{ statusLabel[b.status] }}</span>
              </div>
              <p class="batch-line">备案 {{ b.filingId }} · {{ b.fuelPrice }} 元/L → 附加费 {{ b.surcharge }} 元/次</p>
              <p class="batch-line">生效日 {{ b.effectiveDate }}</p>
              <template v-if="b.status === 'pending'">
                <div class="prog-track"><div class="prog-fill" :style="{ width: progress(b) + '%' }" /></div>
                <p class="batch-line">回传 {{ b.readiness.receivedCount }}/{{ b.readiness.totalExpected }} · 异常 {{ b.readiness.quarantined.length }}</p>
                <ul v-if="!b.readiness.ready" class="blockers">
                  <li v-for="(msg, i) in b.readiness.blockers" :key="i">⛔ {{ msg }}</li>
                </ul>
                <p v-else class="ready-line">✅ 全部计价器和告示回传一致，满足切换条件</p>
              </template>
              <p v-else-if="b.status === 'active'" class="batch-line snap">
                已于 {{ fmtTime(b.activatedAt!) }} 生效，快照固化；后续备案变更不影响本批次。
              </p>
            </div>
          </section>
        </div>

        <section class="panel">
          <h2>异常设备（单列）</h2>
          <div v-if="store.model.anomalies.length === 0" class="empty">暂无异常设备</div>
          <table v-else class="data-table">
            <thead><tr><th>批次</th><th>设备号</th><th>原因</th><th>时间</th></tr></thead>
            <tbody>
              <tr v-for="(a, i) in store.model.anomalies" :key="i">
                <td>{{ a.batchId }}</td>
                <td>{{ a.deviceId }}</td>
                <td>{{ a.reason }}</td>
                <td>{{ fmtTime(a.at) }}</td>
              </tr>
            </tbody>
          </table>
        </section>
      </section>

      <!-- ============================== 批次详情 ============================== -->
      <section v-if="tab === 'detail'" class="tab-body">
        <div class="two-col">
          <section class="panel" :class="{ 'panel-muted': !pendingBatch }">
            <h2>待确认批次：{{ pendingBatch ? pendingBatch.id : "无" }}</h2>
            <template v-if="pendingBatch">
              <p class="panel-hint">
                备案 {{ pendingBatch.filingId }}：{{ pendingBatch.fuelPrice }} 元/L →
                附加费 {{ pendingBatch.surcharge }} 元/次，计划生效日 {{ pendingBatch.effectiveDate }}
              </p>

              <h3>设备回传核对（按设备号 + 批次号）</h3>
              <table class="data-table">
                <thead><tr><th>设备</th><th>类型</th><th>状态</th><th>回执</th><th>操作</th></tr></thead>
                <tbody>
                  <tr v-for="row in deviceRows(pendingBatch)" :key="row.id">
                    <td>{{ row.id }}</td>
                    <td>{{ row.kind }}</td>
                    <td>
                      <span v-if="row.state === 'received'" class="tag-state ok">已回传一致</span>
                      <span v-else-if="row.state === 'quarantined'" class="tag-state bad">异常单列</span>
                      <span v-else class="tag-state off">离线待回传</span>
                    </td>
                    <td class="mono">{{ row.receipt || "—" }}</td>
                    <td class="cell-actions">
                      <button v-if="row.state === 'offline'" type="button" @click="store.deviceReconnect(pendingBatch.id, row.id)">回连回传</button>
                      <button v-if="row.state === 'received'" class="secondary" type="button" @click="store.resendSameReceipt(pendingBatch.id, row.id)">重发同回执</button>
                      <button v-if="row.state !== 'quarantined'" class="secondary" type="button" @click="store.sendTamperedReceipt(pendingBatch.id, row.id)">模拟批次号不符</button>
                      <button v-if="row.state === 'quarantined'" class="secondary" type="button" @click="store.reinstate(pendingBatch.id, row.id)">移出异常（修正后）</button>
                    </td>
                  </tr>
                </tbody>
              </table>

              <div class="demo-bar">
                <label>批量演示设备：
                  <select v-model="demoDevice">
                    <option v-for="id in [...store.meterIds, ...store.noticeIds]" :key="id">{{ id }}</option>
                  </select>
                </label>
              </div>

              <h3>发布（两名运营员只放行先到者）</h3>
              <div class="publish-box">
                <label>运营员：
                  <select v-model="publishOperator">
                    <option>运营员甲</option>
                    <option>运营员乙</option>
                  </select>
                </label>
                <button class="secondary" type="button" @click="store.claimPublish(pendingBatch.id, publishOperator)">
                  抢占发布权
                </button>
                <button type="button" :disabled="!conclusion.canSwitch" @click="store.publish(pendingBatch.id, publishOperator)">
                  持锁发布（切换附加费）
                </button>
                <button class="danger" type="button" @click="store.publish(pendingBatch.id, publishOperator, true)">
                  模拟发布失败（释放锁，完整批次重试）
                </button>
              </div>
              <p class="panel-hint">
                演示先到者：先选一名运营员「抢占发布权」，再切换另一名抢占会被拒；
                发布失败后锁释放，任何运营员都可重新抢占并从完整批次重试。
              </p>
              <p v-if="pendingBatch.publishClaim" class="lock-line">
                🔒 发布锁：{{ pendingBatch.publishClaim.operatorId }}（{{ pendingBatch.publishClaim.claimId }}）持有中
              </p>
              <p v-if="!conclusion.canSwitch" class="panel-hint">
                未满足切换条件：{{ pendingBatch.readiness.blockers.join("；") }}
              </p>
            </template>
            <p v-else class="empty">当前没有待确认批次。登记新备案后会自动创建。</p>
          </section>

          <section class="panel" :class="{ 'panel-muted': !activeBatch }">
            <h2>已生效批次：{{ activeBatch ? activeBatch.id : "无" }}</h2>
            <template v-if="activeBatch">
              <p class="panel-hint">本结果为生效时快照，只读，任何回传/异常处理都不得改写。</p>
              <ul class="snapshot">
                <li>快照备案：{{ activeBatch.filingId }}</li>
                <li>快照备案价：{{ activeBatch.fuelPrice }} 元/L</li>
                <li>快照附加费：<strong>{{ activeBatch.surcharge }} 元/次</strong></li>
                <li>生效时间：{{ fmtTime(activeBatch.activatedAt!) }}</li>
                <li>回传设备数：{{ Object.keys(activeBatch.received).length }}（生效后冻结）</li>
              </ul>
              <p class="readonly-note">🔒 已生效班次继续按此快照计费；新版备案只影响后续批次。</p>
            </template>
            <p v-else class="empty">尚无已生效批次。</p>

            <h2 v-if="store.model.batches.filter((b) => b.status === 'superseded' || b.status === 'retired').length">历史批次</h2>
            <div
              v-for="b in store.model.batches.filter((x) => x.status === 'superseded' || x.status === 'retired')"
              :key="b.id"
              class="batch-card"
              :class="b.status === 'retired' ? 'st-retired' : 'st-superseded'"
            >
              <div class="batch-card-head">
                <strong>{{ b.id }}</strong>
                <span class="status" :class="b.status === 'retired' ? 'st-retired' : 'st-superseded'">
                  {{ b.status === "retired" ? "已停用（旧快照保留）" : "已失效重算" }}
                </span>
              </div>
              <p class="batch-line">
                <template v-if="b.status === 'retired'">
                  原附加费 {{ b.surcharge }} 元/次；被新标准替代后停用，已结算班次仍按其快照计费。
                </template>
                <template v-else>
                  原目标附加费 {{ b.surcharge }} 元/次；备案版本变化后未刷完即作废，回执计数已清空不沿用。
                </template>
              </p>
            </div>
          </section>
        </div>
      </section>

      <!-- ============================== 班次与补档 ============================== -->
      <section v-if="tab === 'shift'" class="tab-body">
        <div class="two-col">
          <section class="panel">
            <h2>班次结算（保留当时快照）</h2>
            <p class="panel-hint">班次按结算时刻已生效批次的快照附加费计费；之后备案价再变，已结算结果不变。</p>
            <div class="publish-box">
              <button type="button" :disabled="!activeBatch" @click="store.settleShift()">结算一个新班次</button>
              <button class="secondary" type="button" @click="store.importLegacyShift('2026-05-10')">
                迁移一张无附加费记录的历史班次（5月）
              </button>
            </div>
            <table class="data-table">
              <thead><tr><th>班次</th><th>依据批次</th><th>快照备案</th><th>附加费</th><th>结算时间</th></tr></thead>
              <tbody>
                <tr v-for="s in store.model.shifts" :key="s.id">
                  <td>
                    {{ s.id }}
                    <span v-if="s.legacy" class="tag-state bad">历史迁移·缺档</span>
                  </td>
                  <td>{{ s.batchId || "—" }}</td>
                  <td class="mono">{{ s.snapshotFilingId || "—" }}</td>
                  <td>
                    <strong v-if="s.snapshotSurcharge !== null">{{ s.snapshotSurcharge }} 元/次</strong>
                    <span v-else class="tag-state bad">待补档</span>
                  </td>
                  <td>{{ fmtTime(s.settledAt) }}</td>
                </tr>
              </tbody>
            </table>
            <p v-if="store.model.shifts.length === 0" class="empty">尚无结算班次</p>
          </section>

          <section class="panel">
            <h2>旧附加费补档（按生效日）</h2>
            <p class="panel-hint">
              新备案登记时会回查历史班次的生效日标准：能补则补，补不全停在「待核」，并阻断附加费切换。
            </p>
            <template v-if="store.state.backfill">
              <p class="backfill-state">
                补档状态：
                <span :class="store.state.backfill.status === 'held' ? 'tag-state bad' : store.state.backfill.status === 'done' ? 'tag-state ok' : 'tag-state off'">
                  {{ { open: "进行中", held: "待核（补不全）", done: "已补全" }[store.state.backfill.status] }}
                </span>
                <span class="mono"> · 归属批次 {{ store.state.backfill.batchId }}</span>
              </p>
              <table class="data-table">
                <thead><tr><th>生效日</th><th>状态</th><th>补录标准</th><th>操作</th></tr></thead>
                <tbody>
                  <tr v-for="en in store.state.backfill.entries" :key="en.date">
                    <td>{{ en.date }}</td>
                    <td>
                      <span :class="en.status === 'held' ? 'tag-state bad' : 'tag-state ok'">
                        {{ en.status === "held" ? "待核" : "已补" }}
                      </span>
                      <div v-if="en.reason" class="cell-sub">{{ en.reason }}</div>
                    </td>
                    <td>
                      <template v-if="en.status === 'filled'">{{ en.surcharge }} 元/次 <span class="mono">({{ en.sourceFilingId }})</span></template>
                      <template v-else>—</template>
                    </td>
                    <td class="cell-actions">
                      <button v-if="en.status === 'held'" class="secondary" type="button" @click="store.supplyBackfill(en.date)">按生效日补录</button>
                    </td>
                  </tr>
                </tbody>
              </table>
              <p v-if="heldEntries().length" class="panel-hint">
                提示：先在「总览」登记一张生效日不晚于 {{ heldEntries()[0].date }} 的旧标准备案，再点补录；
                若当日仍无标准，将继续停在待核。
              </p>
              <button v-if="heldEntries().length" class="secondary" type="button" @click="store.supplyAllBackfill()">尝试一键补全</button>
              <p v-if="filledEntries().length && !heldEntries().length" class="ready-line">✅ 已全部补齐，切换阻断解除</p>
            </template>
            <p v-else class="empty">暂无补档任务</p>
          </section>
        </div>
      </section>

      <!-- ============================== 审计 ============================== -->
      <section v-if="tab === 'audit'" class="tab-body">
        <section class="panel">
          <h2>审计流水（与总览、详情同一结论）</h2>
          <p class="panel-hint">所有命令只追加事件、不覆盖历史；顶部结论即由下列流水折叠得到。</p>
          <table class="data-table audit-table">
            <thead><tr><th>#</th><th>时间</th><th>事件</th><th>明细</th></tr></thead>
            <tbody>
              <tr v-for="item in store.model.audit" :key="item.seq">
                <td class="mono">{{ item.seq }}</td>
                <td class="nowrap">{{ fmtTime(item.at) }}</td>
                <td><span class="tag-state" :class="`tone-${store.auditTone(item.event)}`">{{ store.auditTitle(item.event) }}</span></td>
                <td>{{ store.auditDetail(item.event) }}</td>
              </tr>
            </tbody>
          </table>
        </section>
      </section>
    </div>
  </main>
</template>
