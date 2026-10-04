import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { buildSeed } from "./seed";
import {
  addDateDays,
  buildRetro,
  readiness,
  surchargeBracket,
  nowIso,
} from "./domain";
import type {
  AnomalyKind,
  AuditAction,
  AuditEntry,
  AuditTone,
  Batch,
  BatchSnapshot,
  FeeStandard,
  PersistedState,
  PriceFiling,
  ReceiptInput,
  ReceiptOutcome,
  TargetKind,
} from "./types";

const STORAGE_KEY = "dfwlfront-9-surcharge-batch-v1";

function load(): PersistedState {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as PersistedState;
      if (parsed.version === 1) return parsed;
    } catch {
      /* 数据损坏时回到种子，保证演示可用 */
    }
  }
  return buildSeed();
}

const seqId = (kind: "BA" | "FB" | "PC" | "YC" | "SJ", n: number) =>
  `${kind}-${String(n).padStart(4, "0")}`;

export const useBatchStore = defineStore("surchargeBatch", () => {
  const state = ref<PersistedState>(load());

  function persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.value));
  }

  function log(
    actor: string,
    action: AuditAction,
    detail: string,
    batchId: string | null,
    tone: AuditTone
  ) {
    state.value.seq.audit += 1;
    const entry: AuditEntry = {
      id: seqId("SJ", state.value.seq.audit),
      ts: nowIso(),
      actor,
      action,
      batchId,
      detail,
      tone,
    };
    state.value.audit = [entry, ...state.value.audit];
  }

  function nextBusinessId(kind: "filing" | "standard" | "batch" | "anomaly"): string {
    state.value.seq[kind] += 1;
    const n = state.value.seq[kind];
    const prefix = { filing: "BA", standard: "FB", batch: "PC", anomaly: "YC" }[kind];
    return `${prefix}-${n}`;
  }

  const batches = computed(() => state.value.batches);
  const currentBatch = computed(
    () => state.value.batches.find((b) => b.id === state.value.currentBatchId) ?? null
  );
  const selectedBatch = computed(
    () => state.value.batches.find((b) => b.id === state.value.selectedBatchId) ?? state.value.batches[0]
  );
  const activeFiling = computed(() => state.value.filings.find((f) => f.status === "active") ?? null);
  const currentStandard = computed(
    () => state.value.standards.find((s) => s.status === "current") ?? null
  );

  function byId(id: string): Batch | undefined {
    return state.value.batches.find((b) => b.id === id);
  }

  // —— 视图选择（总览/详情/审计读同一份 state）——
  function setTab(tab: PersistedState["activeTab"]) {
    state.value.activeTab = tab;
    persist();
  }
  function selectBatch(id: string) {
    state.value.selectedBatchId = id;
    persist();
  }
  function setOperator(name: string) {
    state.value.activeOperator = name;
    persist();
  }

  function addAnomaly(b: Batch, kind: AnomalyKind, refCode: string, detail: string) {
    state.value.seq.anomaly += 1;
    b.anomalies.unshift({
      id: seqId("YC", state.value.seq.anomaly),
      at: nowIso(),
      kind,
      ref: refCode,
      batchId: b.id,
      detail,
      resolved: false,
      resolvedAt: null,
    });
  }

  // ① 备案价变化：未确认（未生效）批次立即失效重算；已生效班次保留当时快照。
  function filePrice(input: {
    fuelPrice: number;
    effectiveDate: string;
    operator: string;
    note: string;
  }): { ok: true; batchId: string } | { ok: false; message: string } {
    if (!Number.isFinite(input.fuelPrice) || input.fuelPrice <= 0)
      return { ok: false, message: "请输入有效的92号汽油备案价" };
    if (!input.effectiveDate) return { ok: false, message: "请选择拟生效日期" };

    const operator = input.operator.trim() || "运营员";
    const bracket = surchargeBracket(input.fuelPrice);

    // 未生效批次一律失效重算；effective 批次快照保留，不动
    const liveBatches = state.value.batches.filter(
      (b) => b.status !== "effective" && b.status !== "invalidated"
    );
    // 补档窗口以上一版标准生效日为起点（在状态翻历史之前取）
    const prevStandard = state.value.standards.find((s) => s.status === "current");
    const windowStart = prevStandard?.effectiveDate ?? addDateDays(-30);
    const prevSurcharge = prevStandard?.surcharge ?? bracket.surcharge;

    const filingId = nextBusinessId("filing");
    const standardId = nextBusinessId("standard");
    const batchId = nextBusinessId("batch");

    const filing: PriceFiling = {
      id: filingId,
      fuelPrice: input.fuelPrice,
      filedAt: nowIso(),
      filedBy: operator,
      effectiveDate: input.effectiveDate,
      note: input.note || "—",
      status: "active",
    };
    state.value.filings.forEach((f) => {
      if (f.status === "active") f.status = "superseded";
    });
    state.value.filings = [filing, ...state.value.filings];

    const standard: FeeStandard = {
      id: standardId,
      filingId,
      fuelPrice: input.fuelPrice,
      surcharge: bracket.surcharge,
      bracketLabel: bracket.label,
      effectiveDate: input.effectiveDate,
      status: "current",
    };
    state.value.standards.forEach((s) => {
      if (s.status === "current") s.status = "history";
    });
    state.value.standards = [standard, ...state.value.standards];

    const snapshot: BatchSnapshot = {
      filingId,
      standardId,
      fuelPrice: input.fuelPrice,
      surcharge: bracket.surcharge,
      bracketLabel: bracket.label,
      effectiveDate: input.effectiveDate,
      computedAt: nowIso(),
    };

    const batch: Batch = {
      id: batchId,
      snapshot,
      status: "pending",
      createdAt: nowIso(),
      createdBy: operator,
      replacesBatchId: null,
      supersededByBatchId: null,
      publishHolder: null,
      publishClaimedAt: null,
      publishedAt: null,
      attempts: 0,
      effectiveAt: null,
      switchedBy: null,
      meters: state.value.meters.map((m) => ({
        deviceNo: m.deviceNo,
        vehicleNo: m.vehicleNo,
        batchId,
        state: "pending",
        online: true,
        snapshotSurcharge: bracket.surcharge,
        receiptNo: null,
        reportedSurcharge: null,
        ackedAt: null,
        anomalyReason: null,
      })),
      posters: state.value.posters.map((p) => ({
        code: p.code,
        name: p.name,
        batchId,
        state: "pending",
        online: true,
        snapshotSurcharge: bracket.surcharge,
        receiptNo: null,
        reportedSurcharge: null,
        ackedAt: null,
        anomalyReason: null,
      })),
      retro: buildRetro(windowStart, input.effectiveDate, prevSurcharge, state.value.shiftLedger),
      anomalies: [],
    };
    state.value.batches = [batch, ...state.value.batches];
    state.value.selectedBatchId = batchId;

    log(operator, "filing", `92号汽油备案价 ${input.fuelPrice.toFixed(2)} 元/升，拟生效日 ${input.effectiveDate}`, null, "info");
    log("系统", "standard", `联动分档：${bracket.label}（${standardId}）`, null, "info");
    log("系统", "batch_created", `生成完整批次 ${batchId}：计价器${batch.meters.length}台、告示${batch.posters.length}处，快照附加费 ${bracket.surcharge} 元`, batchId, "info");

    for (const old of liveBatches) {
      old.status = "invalidated";
      old.supersededByBatchId = batchId;
      old.publishHolder = null;
      batch.replacesBatchId = old.id; // 记录最近一条承接链
      log("系统", "invalidated", `批次 ${old.id} 尚未确认，备案版本变更，立即失效并由 ${batchId} 重算`, old.id, "warning");
    }

    persist();
    return { ok: true, batchId };
  }

  // ② 发布：两名运营员只放行先到者（持锁），失败后从完整批次重试
  function claimPublish(batchId: string, operator: string): { ok: boolean; message: string } {
    const b = byId(batchId);
    if (!b) return { ok: false, message: "批次不存在" };
    if (b.status === "publishing" && b.publishHolder !== null && b.publishHolder !== operator) {
      log(operator, "publish_rejected", `并发发布被拒：${b.publishHolder} 已持锁，只放行先到者`, batchId, "danger");
      persist();
      return { ok: false, message: `发布锁已被「${b.publishHolder}」持有，您的请求未放行` };
    }
    if (b.status !== "pending" && b.status !== "failed" && b.status !== "publishing")
      return { ok: false, message: `当前状态不可发布：${b.status}` };

    b.status = "publishing";
    b.publishHolder = operator;
    b.publishClaimedAt = nowIso();
    log(operator, "publish_claimed", `${operator} 抢到发布锁`, batchId, "warning");
    persist();
    return { ok: true, message: "已持锁，正在向全部计价器和告示下发…" };
  }

  function deliverPublish(batchId: string, operator: string): { ok: boolean; message: string } {
    const b = byId(batchId);
    if (!b || b.status !== "publishing" || b.publishHolder !== operator)
      return { ok: false, message: "未持锁或批次状态已变化" };
    const std = state.value.standards.find((s) => s.id === b.snapshot.standardId);
    // 下发时再核对完整批次：标准已翻历史（备案又变了）→ 回到完整批次重试
    if (!std || std.status === "history") {
      // 下发时再核对完整批次：版本已变 → 回到完整批次重试
      b.status = "failed";
      b.attempts += 1;
      b.publishHolder = null;
      log(operator, "publish_failed", `下发核对发现备案版本已更新，发布失败；批次 ${batchId} 回到完整批次重试`, batchId, "danger");
      persist();
      return { ok: false, message: "下发核对失败：备案版本已更新，请从完整批次重试" };
    }
    b.status = "collecting";
    b.attempts += 1;
    b.publishedAt = nowIso();
    b.publishHolder = null;
    const targets = b.meters.length + b.posters.length;
    log(operator, "publish_delivered", `完整批次下发完成，共 ${targets} 个目标，进入回传核对`, batchId, "success");
    persist();
    return { ok: true, message: `已向 ${targets} 个目标下发，等待回传` };
  }

  // 模拟下发失败（演示“失败后从完整批次重试”）
  function failPublish(batchId: string, operator: string, reason: string) {
    const b = byId(batchId);
    if (!b || b.status !== "publishing") return;
    b.status = "failed";
    b.attempts += 1;
    b.publishHolder = null;
    log(operator, "publish_failed", `下发失败：${reason}；完整批次保留，可重试`, batchId, "danger");
    persist();
  }

  function releaseLock(batchId: string) {
    const b = byId(batchId);
    if (!b || b.status !== "publishing") return;
    b.status = "pending";
    log(b.publishHolder ?? "系统", "publish_rejected", "放弃发布锁，批次回到待发布", batchId, "warning");
    b.publishHolder = null;
    b.publishClaimedAt = null;
    persist();
  }

  // ③ 计价器离线/回连：离线留待回传
  function setOffline(batchId: string, kind: TargetKind, code: string, offline: boolean) {
    const b = byId(batchId);
    if (!b || (b.status !== "collecting" && b.status !== "review")) return;
    const target =
      kind === "meter" ? b.meters.find((m) => m.deviceNo === code) : b.posters.find((p) => p.code === code);
    if (!target || target.state === "acked") return;
    target.online = !offline;
    if (offline && target.state === "pending") target.state = "offline";
    if (!offline && target.state === "offline") target.state = "pending";
    log("系统", offline ? "device_offline" : "device_online", `${kind === "meter" ? "计价器" : "告示"} ${code} ${offline ? "离线，下发/回传挂起，留待回连" : "回连，可按设备号+批次号补回回执"}`, batchId, offline ? "warning" : "info");
    persist();
  }

  // ④ 回连后回执：按设备号+批次号核对，重复回执不重复计入；异常单列
  function receiveReceipt(input: ReceiptInput, operator: string): ReceiptOutcome {
    const actor = operator || "系统";
    const b = byId(input.batchId);

    // 花名册先认设备号
    const onRoster =
      input.kind === "meter"
        ? state.value.meters.some((m) => m.deviceNo === input.code)
        : state.value.posters.some((p) => p.code === input.code);
    if (!onRoster) {
      log("系统", "anomaly", `${input.kind === "meter" ? "计价器" : "告示"} ${input.code} 不在花名册，回执拒收单列`, input.batchId, "danger");
      return { outcome: "anomaly", message: `未知${input.kind === "meter" ? "设备号" : "告示编号"}：${input.code}，已列异常` };
    }
    if (!b) {
      log("系统", "anomaly", `${input.code} 回执批次号 ${input.batchId} 不存在：设备号+批次号核对不符`, input.batchId, "danger");
      return { outcome: "anomaly", message: "批次号不存在，已列异常" };
    }

    const result = (() => {
      if (b.status === "invalidated")
        return { kind: "stale" as const, target: null };
      if (b.status === "effective" || b.status === "history_snapshot")
        return { kind: "post_effective" as const, target: null };
      const target =
        input.kind === "meter"
          ? b.meters.find((m) => m.deviceNo === input.code) ?? null
          : b.posters.find((p) => p.code === input.code) ?? null;
      if (!target) return { kind: "wrong_batch" as const, target: null };
      if (target.state === "acked" && target.receiptNo === input.receiptNo)
        return { kind: "duplicate" as const, target };
      if (target.state === "acked")
        return { kind: "duplicate" as const, target }; // 同设备再次回执：不重复计入
      if (!target.online) return { kind: "offline" as const, target };
      if (input.surcharge !== b.snapshot.surcharge)
        return { kind: "mismatch" as const, target };
      return { kind: "ok" as const, target };
    })();

    switch (result.kind) {
      case "stale":
        addAnomaly(b, "stale_batch", input.code, `回执回到已失效批次 ${b.id}（备案版本已重算），拒收不计入`);
        log("系统", "anomaly", `${input.code} 回执指向已失效批次，按新批次重发`, b.id, "warning");
        persist();
        return { outcome: "anomaly", message: "该批次已失效重算，回执已单列异常" };
      case "post_effective":
        addAnomaly(b, "post_effective", input.code, `批次已生效后收到回执（回执号 ${input.receiptNo}）：单列留存，不改写已生效结果`);
        log("系统", "anomaly", `${input.code} 在批次生效后回传：不改写已生效结果，仅列异常`, b.id, "warning");
        persist();
        return { outcome: "anomaly", message: "批次已生效，回执单列但不改写结果" };
      case "wrong_batch":
        addAnomaly(b, "wrong_batch", input.code, `${input.kind === "meter" ? "计价器" : "告示"}不属于批次 ${b.id}：设备号+批次号核对不符`);
        log("系统", "anomaly", `${input.code} 与批次号 ${b.id} 不匹配，回执单列`, b.id, "danger");
        persist();
        return { outcome: "anomaly", message: "设备号与批次号不匹配，已列异常" };
      case "duplicate":
        log("系统", "receipt_duplicate", `${input.code} 重复回执（${input.receiptNo}），幂等忽略，不重复计入`, b.id, "info");
        persist();
        return { outcome: "duplicate", message: "重复回执，已忽略（不重复计入）" };
      case "offline": {
        const t = result.target!;
        if (t.state === "pending") t.state = "offline";
        log("系统", "receipt_held_offline", `${input.code} 仍离线，回执暂挂，待回连后核对`, b.id, "warning");
        persist();
        return { outcome: "held", message: "设备离线，回执留待回连后核对" };
      }
      case "mismatch": {
        const t = result.target!;
        t.state = "anomaly";
        t.anomalyReason = `回执附加费 ${input.surcharge} 元 ≠ 快照 ${b.snapshot.surcharge} 元`;
        addAnomaly(b, "surcharge_mismatch", input.code, t.anomalyReason);
        log("系统", "anomaly", `${input.code} 回执附加费 ${input.surcharge} 与快照 ${b.snapshot.surcharge} 不一致，单列异常`, b.id, "danger");
        persist();
        return { outcome: "anomaly", message: "附加费与批次快照不一致，已列异常设备" };
      }
      case "ok": {
        const t = result.target!;
        t.state = "acked";
        t.online = true;
        t.receiptNo = input.receiptNo;
        t.reportedSurcharge = input.surcharge;
        t.ackedAt = nowIso();
        t.anomalyReason = null;
        // 同一设备此前的未处理异常随一致回执关闭
        for (const a of b.anomalies) {
          if (!a.resolved && a.ref === input.code) {
            a.resolved = true;
            a.resolvedAt = nowIso();
          }
        }
        log(actor, "receipt_acked", `${input.code} 回执一致：附加费 ${input.surcharge} 元（${input.receiptNo}）`, b.id, "success");
        persist();
        return { outcome: "acked", message: `${input.code} 已回执一致` };
      }
    }
  }

  function resolveAnomaly(batchId: string, anomalyId: string, note: string) {
    const b = byId(batchId);
    const a = b?.anomalies.find((x) => x.id === anomalyId);
    if (!a || a.resolved) return;
    if (b!.status === "effective" || b!.status === "history_snapshot") {
      log("系统", "anomaly_resolved", `异常 ${anomalyId} 属已生效批次，只可备注，不能改写结果，操作驳回`, batchId, "danger");
      persist();
      return;
    }
    a.resolved = true;
    a.resolvedAt = nowIso();
    log(state.value.activeOperator, "anomaly_resolved", `异常 ${a.ref} 已核对关闭：${note || "人工核对一致"}`, batchId, "info");
    persist();
  }

  // ⑤ 旧附加费按生效日补档：补全台账班次；补不全停在待核
  function fillLedgerDate(date: string) {
    if (!date || state.value.shiftLedger.includes(date)) return;
    state.value.shiftLedger = [...state.value.shiftLedger, date].sort();
    for (const b of state.value.batches) {
      const item = b.retro.find((r) => r.shiftDate === date && r.status === "missing");
      if (item) {
        item.ledger = true;
        item.status = "filled";
        log(state.value.activeOperator, "retro_filled", `补齐 ${date} 班次台账，旧附加费按生效日补档 ${item.surcharge} 元`, b.id, "success");
      }
    }
    persist();
  }

  // ⑥ 全部计价器和告示回传一致后才切换附加费
  function trySwitch(batchId: string, operator: string): { ok: boolean; message: string } {
    const b = byId(batchId);
    if (!b) return { ok: false, message: "批次不存在" };
    if (b.status !== "collecting" && b.status !== "review")
      return { ok: false, message: "仅回传中/待核批次可尝试切换" };
    const r = readiness(b);

    if (r.retroMissing > 0) {
      b.status = "review";
      log(operator, "review_hold", `历史班次旧附加费补档缺 ${r.retroMissing} 天，批次停在待核，不切换`, batchId, "warning");
      persist();
      return { ok: false, message: `补档不全（缺 ${r.retroMissing} 天），停在待核` };
    }
    if (!r.allConsistent) {
      log(operator, "switch_blocked", `切换被阻断：已回执 ${r.acked}/${r.total}，离线 ${r.offline}，待回传 ${r.pending}，异常 ${r.openAnomalies}`, batchId, "danger");
      persist();
      return {
        ok: false,
        message: `未全部一致：${r.acked}/${r.total} 已回执，离线 ${r.offline}，异常 ${r.openAnomalies}`,
      };
    }

    // 原子切换：新批生效快照冻结，旧批转历史（快照保留）；旧标准/备案归档
    b.status = "effective";
    b.effectiveAt = nowIso();
    b.switchedBy = operator;
    for (const old of state.value.batches) {
      if (old.id !== b.id && old.status === "effective") old.status = "history_snapshot";
    }
    state.value.currentBatchId = b.id;
    state.value.filings.forEach((f) => {
      if (f.id === b.snapshot.filingId) f.status = "active";
      else if (f.status === "active") f.status = "superseded";
    });
    state.value.standards.forEach((s) => {
      if (s.id === b.snapshot.standardId) s.status = "current";
      else if (s.status === "current") s.status = "history";
    });
    log(
      operator,
      "switched",
      `全部 ${r.total} 个目标回传一致，附加费切换为 ${b.snapshot.surcharge} 元/次；批次快照冻结，原标准快照保留于历史批次`,
      batchId,
      "success"
    );
    persist();
    return { ok: true, message: `已切换附加费为 ${b.snapshot.surcharge} 元/次，快照冻结` };
  }

  function resetAll() {
    state.value = buildSeed();
    persist();
  }

  return {
    state,
    batches,
    currentBatch,
    selectedBatch,
    activeFiling,
    currentStandard,
    byId,
    setTab,
    selectBatch,
    setOperator,
    filePrice,
    claimPublish,
    deliverPublish,
    failPublish,
    releaseLock,
    setOffline,
    receiveReceipt,
    resolveAnomaly,
    fillLedgerDate,
    trySwitch,
    resetAll,
  };
});
