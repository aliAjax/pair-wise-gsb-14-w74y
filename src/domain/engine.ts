// 执行批次核心：命令 -> 事件（追加），事件折叠为唯一状态；总览/详情/审计同源读取
import {
  METER_IDS,
  NOTICE_IDS,
  type AnomalyRec,
  type Backfill,
  type BackfillEntry,
  type Batch,
  type DeviceKind,
  type Event,
  type Filing,
  type Outcome,
  type Shift,
  type StampedEvent,
  type State
} from "./types";

export { METER_IDS, NOTICE_IDS };
export type { DeviceKind };

/** 设备回执校验码：批次与设备一致才会通过 */
export function checksum(batchId: string, deviceId: string): string {
  let h = 0;
  const s = `${batchId}|${deviceId}`;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0");
}

export class DomainError extends Error {}

// ---------------------------------------------------------------- 事件追加/折叠

export function initialState(): State {
  return { seq: 0, filings: [], batches: [], shifts: [], anomalies: [], backfill: null };
}

export function stampEvents(events: Event[], state: State, now: string): { state: State; stamped: StampedEvent[] } {
  let next = state;
  const stamped: StampedEvent[] = [];
  for (const raw of events) {
    // 命令内未指定时间的事件统一以提交时刻落账（如回传到达、生效、结算时刻）
    const event: Event = "at" in raw && !(raw as { at?: string }).at ? { ...(raw as object), at: now } as Event : raw;
    const item: StampedEvent = { seq: next.seq + 1, at: now, event };
    stamped.push(item);
    next = applyEvent(next, item);
  }
  return { state: next, stamped };
}

export function fold(log: StampedEvent[], base: State = initialState()): State {
  return log.reduce((s, e) => applyEvent(s, e), base);
}

function lastId(state: State, prefix: string, kind: "filing" | "batch" | "claim" | "shift"): string {
  let n = 0;
  const scan: string[] = [];
  if (kind === "filing") scan.push(...state.filings.map((f) => f.id));
  if (kind === "batch") scan.push(...state.batches.map((b) => b.id));
  if (kind === "shift") scan.push(...state.shifts.map((s) => s.id));
  if (kind === "claim") {
    scan.push(...state.batches.filter((b) => b.publishClaim).map((b) => b.publishClaim!.claimId));
  }
  for (const id of scan) {
    const m = id.match(/(\d+)$/);
    if (m && id.startsWith(prefix)) n = Math.max(n, parseInt(m[1], 10));
  }
  return `${prefix}${String(n + 1).padStart(3, "0")}`;
}

function findBatch(state: State, batchId: string): Batch | undefined {
  return state.batches.find((b) => b.id === batchId);
}

function applyEvent(state: State, stamped: StampedEvent): State {
  const e = stamped.event;
  const seq = stamped.seq;
  const at = stamped.at;
  const s: State = {
    ...state,
    filings: state.filings,
    batches: state.batches,
    shifts: state.shifts,
    anomalies: state.anomalies,
    backfill: state.backfill
  };

  switch (e.type) {
    case "FilingRecorded": {
      const filing: Filing = {
        id: e.id,
        fuelPrice: e.fuelPrice,
        surcharge: e.surcharge,
        effectiveDate: e.effectiveDate,
        operator: e.operator,
        note: e.note,
        createdAt: at,
        retroactive: e.retroactive
      };
      s.filings = [...s.filings, filing];
      break;
    }
    case "BatchCreated": {
      s.batches = [
        ...s.batches,
        {
          id: e.id,
          filingId: e.filingId,
          fuelPrice: e.fuelPrice,
          surcharge: e.surcharge,
          effectiveDate: e.effectiveDate,
          status: "pending",
          received: {},
          quarantined: {},
          publishClaim: null,
          activatedAt: null
        }
      ];
      break;
    }
    case "BatchInvalidated": {
      s.batches = s.batches.map((b) =>
        b.id === e.batchId
          ? { ...b, status: "superseded", received: {}, quarantined: {}, publishClaim: null }
          : b
      );
      break;
    }
    case "ReceiptAccepted": {
      s.batches = s.batches.map((b) =>
        b.id === e.batchId
          ? { ...b, received: { ...b.received, [e.deviceId]: { receiptId: e.receiptId, at: e.at } } }
          : b
      );
      break;
    }
    case "ReceiptRejected":
      // 驳回只入审计，不改批次计数
      break;
    case "DeviceQuarantined": {
      // 异常单列：在已回事实上叠加隔离标记，不抹掉回执证据
      s.batches = s.batches.map((b) =>
        b.id === e.batchId
          ? { ...b, quarantined: { ...b.quarantined, [e.deviceId]: { reason: e.reason, at: e.at } } }
          : b
      );
      const rec: AnomalyRec = { seq, batchId: e.batchId, deviceId: e.deviceId, reason: e.reason, at: e.at };
      s.anomalies = [...s.anomalies, rec];
      break;
    }
    case "DeviceReinstated": {
      s.batches = s.batches.map((b) => {
        if (b.id !== e.batchId) return b;
        const q = { ...b.quarantined };
        delete q[e.deviceId];
        return { ...b, quarantined: q };
      });
      break;
    }
    case "PublishClaimed": {
      s.batches = s.batches.map((b) =>
        b.id === e.batchId ? { ...b, publishClaim: { operatorId: e.operatorId, claimId: e.claimId } } : b
      );
      break;
    }
    case "PublishRejected":
      break;
    case "PublishFailed": {
      s.batches = s.batches.map((b) => (b.id === e.batchId ? { ...b, publishClaim: null } : b));
      break;
    }
    case "BatchActivated": {
      // 新标准切换生效：原已生效批次转为 retired，其回执与快照保留（已结算班次继续引用）
      s.batches = s.batches.map((b) => {
        if (b.id === e.batchId) return { ...b, status: "active", activatedAt: e.at, publishClaim: null };
        if (b.status === "active") return { ...b, status: "retired" };
        return b;
      });
      break;
    }
    case "ShiftSettled": {
      const shift: Shift = {
        id: e.shiftId,
        batchId: e.batchId,
        snapshotFilingId: e.snapshotFilingId,
        snapshotSurcharge: e.snapshotSurcharge,
        settledAt: e.at
      };
      s.shifts = [...s.shifts, shift];
      break;
    }
    case "LegacyShiftImported": {
      // 历史迁移班次：生效日已有标准则直接带快照，否则等待按生效日补档
      const legacy: Shift = {
        id: e.shiftId,
        batchId: e.sourceFilingId ?? "",
        snapshotFilingId: e.sourceFilingId ?? "",
        snapshotSurcharge: e.surcharge,
        settledAt: e.date.length === 10 ? `${e.date}T12:00:00.000Z` : e.date,
        legacy: true
      };
      s.shifts = [...s.shifts, legacy];
      break;
    }
    case "ShiftRejected":
      break;
    case "BackfillOpened": {
      const heldDates = new Set(e.missingDates);
      const kept = s.backfill ? s.backfill.entries.filter((en) => en.status === "filled") : [];
      const entries: BackfillEntry[] = [...kept];
      for (const date of e.missingDates) {
        if (!entries.some((en) => en.date === date)) {
          entries.push({ date, status: "held", reason: "生效当日无有效附加费标准" });
        }
      }
      s.backfill = {
        batchId: e.batchId,
        status: entries.some((en) => en.status === "held") ? "held" : "done",
        entries: entries.sort((a, b) => (a.date < b.date ? -1 : 1))
      };
      break;
    }
    case "BackfillEntrySupplied": {
      if (s.backfill) {
        const entries: BackfillEntry[] = s.backfill.entries.map((en) =>
          en.date === e.date
            ? { date: en.date, status: "filled", surcharge: e.surcharge, sourceFilingId: e.sourceFilingId }
            : en
        );
        s.backfill = { ...s.backfill, entries, status: entries.some((en) => en.status === "held") ? "held" : "done" };
      }
      // 同日迁移班次按生效日拿到补录快照
      s.shifts = s.shifts.map((sh) =>
        sh.legacy && sh.snapshotSurcharge === null && sh.settledAt.slice(0, 10) === e.date
          ? { ...sh, snapshotSurcharge: e.surcharge, snapshotFilingId: e.sourceFilingId, batchId: e.sourceFilingId }
          : sh
      );
      break;
    }
    case "BackfillHeld": {
      if (s.backfill) {
        s.backfill = {
          ...s.backfill,
          status: "held",
          entries: s.backfill.entries.map((en) =>
            en.date === e.date ? { ...en, status: "held", reason: e.reason } : en
          )
        };
      }
      break;
    }
  }
  s.seq = seq;
  return s;
}

// ---------------------------------------------------------------- 领域命令

export interface RegisterFilingInput {
  fuelPrice: number;
  surcharge: number;
  effectiveDate: string;
  operator: string;
  note?: string;
  retroactive?: boolean;
}

/** 备案登记：
 *  - 常规备案：未确认批次立即失效，按新版本重算新批次；
 *  - 旧标准补档登记（retroactive）：只补生效日历史，不产生也不取代执行批次。
 *  两种登记都会尝试补齐/打开旧附加费补档（归属于当前待确认批次）。 */
export function cmdRegisterFiling(state: State, input: RegisterFilingInput): Outcome {
  if (!Number.isFinite(input.fuelPrice) || input.fuelPrice <= 0) {
    return { ok: false, events: [], error: "备案价必须为正数" };
  }
  if (!Number.isFinite(input.surcharge) || input.surcharge < 0) {
    return { ok: false, events: [], error: "附加费标准不能为负" };
  }
  if (!input.effectiveDate) return { ok: false, events: [], error: "缺少生效日期" };
  if (!input.operator) return { ok: false, events: [], error: "缺少运营员" };

  const events: Event[] = [];
  const filingId = lastId(state, "F-", "filing");
  events.push({
    type: "FilingRecorded",
    id: filingId,
    fuelPrice: input.fuelPrice,
    surcharge: input.surcharge,
    effectiveDate: input.effectiveDate,
    operator: input.operator,
    note: input.note ?? "",
    retroactive: !!input.retroactive
  });

  let owner = "";
  const pending = state.batches.find((b) => b.status === "pending");

  if (!input.retroactive) {
    const batchId = lastId(state, "B-", "batch");
    owner = batchId;
    events.push({
      type: "BatchCreated",
      id: batchId,
      filingId,
      fuelPrice: input.fuelPrice,
      surcharge: input.surcharge,
      effectiveDate: input.effectiveDate,
      replacedBatchId: pending ? pending.id : null
    });
    if (pending) {
      events.push({ type: "BatchInvalidated", batchId: pending.id, supersededBy: batchId, reason: "备案版本变化，未确认批次立即失效重算" });
    }
  } else {
    // 补档登记不触动执行批次；补档挂在现有待确认批次上
    owner = pending ? pending.id : "";
  }

  appendBackfillEvents(events, state, filingId, input, owner);
  return { ok: true, events };
}

/** 计算本次备案后的补档事件：仍缺的日期重新挂起，能按生效日补上的立即补录 */
function appendBackfillEvents(events: Event[], state: State, filingId: string, input: RegisterFilingInput, ownerBatchId: string) {
  if (!ownerBatchId) return;
  const projected: State = {
    ...state,
    filings: [
      ...state.filings,
      { id: filingId, fuelPrice: input.fuelPrice, surcharge: input.surcharge, effectiveDate: input.effectiveDate, operator: input.operator, note: input.note ?? "", createdAt: "", retroactive: !!input.retroactive }
    ]
  };
  const known = new Set((state.backfill?.entries ?? []).map((en) => en.date));
  const heldDates = new Set<string>(state.backfill?.entries.filter((en) => en.status === "held").map((en) => en.date) ?? []);
  // 尚未进入补档台账的迁移缺档班次
  for (const shift of state.shifts) {
    if (shift.snapshotSurcharge !== null) continue;
    const day = shift.settledAt.slice(0, 10);
    if (!known.has(day)) heldDates.add(day);
  }

  const stillHeld: string[] = [];
  const fills: Event[] = [];
  for (const date of [...heldDates].sort()) {
    const std = standardAt(projected, date);
    if (std) fills.push({ type: "BackfillEntrySupplied", batchId: ownerBatchId, date, surcharge: std.surcharge, sourceFilingId: std.filingId });
    else stillHeld.push(date);
  }
  if (stillHeld.length) events.push({ type: "BackfillOpened", batchId: ownerBatchId, missingDates: stillHeld });
  events.push(...fills);
}

/** 某日生效标准：按生效日期不晚于该日、最新备案（以生效日为准，不以登记先后为准） */
export function standardAt(state: State, day: string): { surcharge: number; filingId: string } | null {
  const candidates = state.filings
    .filter((f) => f.effectiveDate <= day)
    .sort((a, b) => (a.effectiveDate < b.effectiveDate ? 1 : a.effectiveDate > b.effectiveDate ? -1 : 0));
  const f = candidates[0];
  return f ? { surcharge: f.surcharge, filingId: f.id } : null;
}

export interface ReceiptInput {
  batchId: string;
  deviceId: string;
  receiptId: string;
  checksumValue: string;
  deviceKind: DeviceKind;
}

/** 计价器/告示回连回传：按设备号+批次号核对，重复回执不重复计入，异常单列 */
export function cmdAcceptReceipt(state: State, input: ReceiptInput): Outcome {
  const events: Event[] = [];
  const batch = findBatch(state, input.batchId);
  if (!batch) {
    return {
      ok: false,
      events: [
        { type: "ReceiptRejected", batchId: input.batchId, deviceId: input.deviceId, receiptId: input.receiptId, reason: "批次不存在", at: "" }
      ],
      error: "批次不存在"
    };
  }
  if (batch.status !== "pending") {
    const word = batch.status === "active" ? "已生效" : batch.status === "retired" ? "已停用" : "已失效";
    return {
      ok: false,
      events: [
        { type: "ReceiptRejected", batchId: batch.id, deviceId: input.deviceId, receiptId: input.receiptId, reason: `批次${word}，不能改写结果`, at: "" }
      ],
      error: `批次${word}，不能改写结果`
    };
  }
  const known = [...METER_IDS, ...NOTICE_IDS].includes(input.deviceId as never);
  if (!known) {
    events.push({ type: "DeviceQuarantined", batchId: batch.id, deviceId: input.deviceId, reason: "未知设备号", at: "" });
    return { ok: false, events, error: "未知设备号，列入异常设备" };
  }
  const expect = checksum(batch.id, input.deviceId);
  if (input.checksumValue !== expect) {
    events.push({
      type: "DeviceQuarantined",
      batchId: batch.id,
      deviceId: input.deviceId,
      reason: `校验码不符（回传${input.checksumValue || "空"}，应为${expect}）`,
      at: ""
    });
    return { ok: false, events, error: "批次号/设备号核对不符，列入异常设备" };
  }
  const prior = batch.received[input.deviceId];
  if (prior) {
    if (prior.receiptId === input.receiptId) {
      // 同回执重发：幂等，不重复计入
      events.push({ type: "ReceiptRejected", batchId: batch.id, deviceId: input.deviceId, receiptId: input.receiptId, reason: "重复回执，不重复计入", at: "" });
      return { ok: true, events };
    }
    events.push({ type: "DeviceQuarantined", batchId: batch.id, deviceId: input.deviceId, reason: "同设备不同回执，疑似重放", at: "" });
    return { ok: false, events, error: "同设备不同回执，列入异常设备" };
  }
  events.push({
    type: "ReceiptAccepted",
    batchId: batch.id,
    deviceId: input.deviceId,
    deviceKind: input.deviceKind,
    receiptId: input.receiptId,
    at: ""
  });
  return { ok: true, events };
}

/** 异常设备恢复（不允许作用于已生效批次） */
export function cmdReinstate(state: State, batchId: string, deviceId: string): Outcome {
  const batch = findBatch(state, batchId);
  if (!batch) return { ok: false, events: [], error: "批次不存在" };
  if (batch.status !== "pending") {
    return { ok: false, events: [], error: "已生效/已停用批次为只读结果，不能改写" };
  }
  if (!batch.quarantined[deviceId]) return { ok: false, events: [], error: "该设备不在异常名单" };
  return { ok: true, events: [{ type: "DeviceReinstated", batchId, deviceId, at: "" }] };
}

export interface PublishInput {
  batchId: string;
  operatorId: string;
  simulateFailure?: boolean;
}

/** 发布抢占：两名运营员只放行先到者。锁仅在发布完成/失败时释放 */
export function cmdClaimPublish(state: State, input: PublishInput): Outcome {
  const batch = findBatch(state, input.batchId);
  if (!batch) return { ok: false, events: [], error: "批次不存在" };
  if (batch.status !== "pending") {
    return {
      ok: false,
      events: [{ type: "PublishRejected", batchId: input.batchId, operatorId: input.operatorId, reason: `批次${batch.status === "active" ? "已生效" : batch.status === "retired" ? "已停用" : "已失效"}` }],
      error: "批次不可发布"
    };
  }
  if (batch.publishClaim) {
    if (batch.publishClaim.operatorId === input.operatorId) {
      return { ok: true, events: [] }; // 已是持锁人，幂等
    }
    return {
      ok: false,
      events: [{ type: "PublishRejected", batchId: batch.id, operatorId: input.operatorId, reason: `发布权已被运营员 ${batch.publishClaim.operatorId} 先取得` }],
      error: "只放行先到者"
    };
  }
  const claimId = lastId(state, "C-", "claim");
  return {
    ok: true,
    events: [{ type: "PublishClaimed", batchId: batch.id, operatorId: input.operatorId, claimId }]
  };
}

/** 发布：必须由持锁的先到运营员执行；失败不保留锁，从完整批次重试；全部一致且补档完成才切换 */
export function cmdPublish(state: State, input: PublishInput): Outcome {
  const batch = findBatch(state, input.batchId);
  if (!batch) return { ok: false, events: [], error: "批次不存在" };
  if (batch.status !== "pending") {
    return {
      ok: false,
      events: [{ type: "PublishRejected", batchId: input.batchId, operatorId: input.operatorId, reason: `批次${batch.status === "active" ? "已生效" : batch.status === "retired" ? "已停用" : "已失效"}` }],
      error: "批次不可发布"
    };
  }

  const events: Event[] = [];
  let claim = batch.publishClaim;
  if (!claim) {
    // 未显式抢占时，首个调用者即先到者（原子抢占）
    claim = { operatorId: input.operatorId, claimId: lastId(state, "C-", "claim") };
    events.push({ type: "PublishClaimed", batchId: batch.id, operatorId: input.operatorId, claimId: claim.claimId });
  } else if (claim.operatorId !== input.operatorId) {
    return {
      ok: false,
      events: [{ type: "PublishRejected", batchId: batch.id, operatorId: input.operatorId, reason: `发布权已被运营员 ${claim.operatorId} 先取得` }],
      error: "只放行先到者"
    };
  }

  if (input.simulateFailure) {
    events.push({ type: "PublishFailed", batchId: batch.id, operatorId: input.operatorId, claimId: claim.claimId, reason: "下发通道失败，锁释放，需从完整批次重试" });
    return { ok: false, events, error: "发布失败，可从完整批次重试" };
  }

  const readiness = readinessOf(state, batch.id);
  if (!readiness.ready) {
    events.push({ type: "PublishFailed", batchId: batch.id, operatorId: input.operatorId, claimId: claim.claimId, reason: `切换条件未满足：${readiness.blockers.join("；")}` });
    return { ok: false, events, error: readiness.blockers.join("；") };
  }

  events.push({
    type: "BatchActivated",
    batchId: batch.id,
    snapshotFilingId: batch.filingId,
    snapshotPrice: batch.fuelPrice,
    snapshotSurcharge: batch.surcharge,
    at: ""
  });
  return { ok: true, events };
}

/** 班次结算：已生效班次保留当时快照，不受后续备案变更影响 */
export function cmdSettleShift(state: State): Outcome {
  const active = state.batches.find((b) => b.status === "active");
  if (!active || !active.activatedAt) {
    return { ok: false, events: [{ type: "ShiftRejected", reason: "无已生效附加费，班次无法结算", at: "" }], error: "无已生效附加费" };
  }
  const shiftId = lastId(state, "S-", "shift");
  return {
    ok: true,
    events: [
      {
        type: "ShiftSettled",
        shiftId,
        batchId: active.id,
        snapshotFilingId: active.filingId,
        snapshotSurcharge: active.surcharge,
        at: ""
      }
    ]
  };
}

/** 历史系统迁移班次：生效日有标准则直接补录，否则进入补档待核 */
export function cmdImportLegacyShift(state: State, date: string): Outcome {
  if (!date) return { ok: false, events: [], error: "缺少班次日期" };
  const shiftId = lastId(state, "S-", "shift");
  const std = standardAt(state, date);
  const events: Event[] = [
    { type: "LegacyShiftImported", shiftId, date, surcharge: std ? std.surcharge : null, sourceFilingId: std ? std.filingId : null }
  ];
  // 当天若有待确认批次且无标准，立即挂入其补档并阻断切换
  const pending = state.batches.find((b) => b.status === "pending");
  if (pending && !std) {
    const prev = state.backfill?.entries.filter((e) => e.status === "held").map((e) => e.date) ?? [];
    events.push({ type: "BackfillOpened", batchId: pending.id, missingDates: [date, ...prev] });
  }
  return { ok: true, events };
}

/** 补档补录：补不全（无生效日标准）则停在待核 */
export function cmdSupplyBackfillEntry(state: State, date: string): Outcome {
  const bf = state.backfill;
  if (!bf) return { ok: false, events: [], error: "没有进行中的补档" };
  const entry = bf.entries.find((en) => en.date === date && en.status === "held");
  if (!entry) return { ok: false, events: [], error: "该日期无需补档" };
  const standard = standardAt(state, date);
  if (!standard) {
    return { ok: true, events: [{ type: "BackfillHeld", batchId: bf.batchId, date, reason: "生效日补不全：当日无有效附加费标准，停在待核" }] };
  }
  return {
    ok: true,
    events: [{ type: "BackfillEntrySupplied", batchId: bf.batchId, date, surcharge: standard.surcharge, sourceFilingId: standard.filingId }]
  };
}

// ---------------------------------------------------------------- 读取模型（唯一结论）

export interface Readiness {
  totalExpected: number;
  receivedCount: number;
  missingMeters: string[];
  missingNotices: string[];
  quarantined: string[];
  backfillBlocked: boolean;
  ready: boolean;
  blockers: string[];
}

export function readinessOf(state: State, batchId: string): Readiness {
  const batch = findBatch(state, batchId);
  const totalExpected = METER_IDS.length + NOTICE_IDS.length;
  const blockers: string[] = [];
  if (!batch) {
    return { totalExpected, receivedCount: 0, missingMeters: [...METER_IDS], missingNotices: [...NOTICE_IDS], quarantined: [], backfillBlocked: false, ready: false, blockers: ["批次不存在"] };
  }
  const got = new Set(Object.keys(batch.received));
  const missingMeters = METER_IDS.filter((id) => !got.has(id));
  const missingNotices = NOTICE_IDS.filter((id) => !got.has(id));
  const quarantined = Object.keys(batch.quarantined);
  const backfillBlocked = !!state.backfill && state.backfill.status !== "done";

  if (missingMeters.length) blockers.push(`计价器未全部回传（缺 ${missingMeters.join("、")}）`);
  if (missingNotices.length) blockers.push(`乘客告示未全部回传（缺 ${missingNotices.join("、")}）`);
  if (quarantined.length) blockers.push(`存在异常设备 ${quarantined.join("、")}`);
  if (backfillBlocked) blockers.push(state.backfill!.status === "held" ? "旧附加费补档停在待核" : "旧附加费补档未完成");

  return {
    totalExpected,
    receivedCount: got.size,
    missingMeters,
    missingNotices,
    quarantined,
    backfillBlocked,
    ready: blockers.length === 0,
    blockers
  };
}

export interface BatchView extends Batch {
  readiness: Readiness;
}

export interface Conclusion {
  activeBatch: BatchView | null;
  pendingBatch: BatchView | null;
  canSwitch: boolean;
  backfill: Backfill | null;
  anomalyCount: number;
  pendingMetersMissing: number;
  pendingNoticesMissing: number;
  verdict: string;
}

export interface Model {
  state: State;
  filings: Filing[];
  batches: BatchView[];
  shifts: Shift[];
  anomalies: AnomalyRec[];
  conclusion: Conclusion;
  audit: StampedEvent[];
}

function viewOf(state: State, b: Batch): BatchView {
  return { ...b, readiness: readinessOf(state, b.id) };
}

/** 总览、详情、审计共用的唯一结论 */
export function buildModel(state: State, log: StampedEvent[]): Model {
  const batches = state.batches.map((b) => viewOf(state, b));
  const activeBatch = batches.find((b) => b.status === "active") ?? null;
  const pendingBatch = batches.find((b) => b.status === "pending") ?? null;
  const backfill = state.backfill && state.backfill.status !== "done" ? state.backfill : null;

  const parts: string[] = [];
  if (activeBatch) parts.push(`当前附加费 ${activeBatch.surcharge} 元/次（${activeBatch.id} 快照生效）`);
  else parts.push("当前无生效附加费");
  if (pendingBatch) {
    const r = pendingBatch.readiness;
    parts.push(r.ready ? `批次 ${pendingBatch.id} 已满足切换条件，可发布` : `批次 ${pendingBatch.id} 不可切换：${r.blockers.join("；")}`);
  } else {
    parts.push("无待确认批次");
  }
  if (backfill) parts.push(backfill.status === "held" ? "补档停在待核" : "补档进行中");

  return {
    state,
    filings: [...state.filings].reverse(),
    batches: [...batches].reverse(),
    shifts: [...state.shifts].reverse(),
    anomalies: [...state.anomalies].reverse(),
    conclusion: {
      activeBatch,
      pendingBatch,
      canSwitch: !!pendingBatch && pendingBatch.readiness.ready,
      backfill,
      anomalyCount: state.anomalies.length,
      pendingMetersMissing: pendingBatch ? pendingBatch.readiness.missingMeters.length : 0,
      pendingNoticesMissing: pendingBatch ? pendingBatch.readiness.missingNotices.length : 0,
      verdict: parts.join("；")
    },
    audit: [...log].reverse()
  };
}

// ---------------------------------------------------------------- 审计文案

export function auditTitle(e: Event): string {
  switch (e.type) {
    case "FilingRecorded":
      return e.retroactive ? "92号汽油备案价登记（补档用旧标准）" : "92号汽油备案价登记";
    case "BatchCreated":
      return "执行批次创建";
    case "BatchInvalidated":
      return "未确认批次失效重算";
    case "ReceiptAccepted":
      return e.deviceKind === "meter" ? "计价器回传核对一致" : "乘客告示回传核对一致";
    case "ReceiptRejected":
      return "回执驳回";
    case "DeviceQuarantined":
      return "异常设备单列";
    case "DeviceReinstated":
      return "异常设备恢复";
    case "PublishClaimed":
      return "发布权抢占（先到者）";
    case "PublishRejected":
      return "发布被拒（后到者）";
    case "PublishFailed":
      return "发布失败（锁释放，可完整重试）";
    case "BatchActivated":
      return "附加费切换生效（快照固化）";
    case "ShiftSettled":
      return "班次结算（保留当时快照）";
    case "LegacyShiftImported":
      return "历史班次迁移（缺附加费记录）";
    case "ShiftRejected":
      return "班次结算驳回";
    case "BackfillOpened":
      return "旧附加费补档开启";
    case "BackfillEntrySupplied":
      return "补档按生效日补录";
    case "BackfillHeld":
      return "补档停在待核";
  }
}

export function auditDetail(e: Event): string {
  switch (e.type) {
    case "FilingRecorded":
      return `${e.id}：备案价 ${e.fuelPrice} 元/L，附加费 ${e.surcharge} 元/次，生效日 ${e.effectiveDate}，运营员 ${e.operator}${e.note ? `，${e.note}` : ""}`;
    case "BatchCreated":
      return `${e.id} 基于备案 ${e.filingId}（${e.surcharge} 元/次，生效日 ${e.effectiveDate}）${e.replacedBatchId ? `，取代未确认批次 ${e.replacedBatchId}` : ""}`;
    case "BatchInvalidated":
      return `${e.batchId} -> ${e.supersededBy}：${e.reason}`;
    case "ReceiptAccepted":
      return `批次 ${e.batchId} 设备 ${e.deviceId} 回执 ${e.receiptId}`;
    case "ReceiptRejected":
      return `批次 ${e.batchId} 设备 ${e.deviceId}：${e.reason}`;
    case "DeviceQuarantined":
      return `批次 ${e.batchId} 设备 ${e.deviceId}：${e.reason}`;
    case "DeviceReinstated":
      return `批次 ${e.batchId} 设备 ${e.deviceId} 移出异常名单`;
    case "PublishClaimed":
      return `批次 ${e.batchId}：运营员 ${e.operatorId} 取得 ${e.claimId}`;
    case "PublishRejected":
      return `批次 ${e.batchId}：运营员 ${e.operatorId}，${e.reason}`;
    case "PublishFailed":
      return `批次 ${e.batchId}：${e.reason}`;
    case "BatchActivated":
      return `批次 ${e.batchId} 生效，快照 ${e.snapshotFilingId} / ${e.snapshotSurcharge} 元/次`;
    case "ShiftSettled":
      return `${e.shiftId} 按批次 ${e.batchId} 快照 ${e.snapshotFilingId}（${e.snapshotSurcharge} 元/次）结算`;
    case "LegacyShiftImported":
      return e.surcharge !== null
        ? `${e.shiftId}：${e.date} 班次自旧系统迁入，生效日标准 ${e.surcharge} 元/次（${e.sourceFilingId}）`
        : `${e.shiftId}：${e.date} 班次自旧系统迁入，生效日附加费待补`;
    case "ShiftRejected":
      return e.reason;
    case "BackfillOpened":
      return `批次 ${e.batchId}：待补日期 ${e.missingDates.join("、")}`;
    case "BackfillEntrySupplied":
      return `批次 ${e.batchId}：${e.date} 补为 ${e.surcharge} 元/次（来源 ${e.sourceFilingId}）`;
    case "BackfillHeld":
      return `批次 ${e.batchId}：${e.date} ${e.reason}`;
  }
}

export function auditTone(e: Event): "ok" | "warn" | "bad" | "plain" {
  if (e.type === "ReceiptAccepted" || e.type === "BatchActivated" || e.type === "ShiftSettled" ||
      e.type === "BackfillEntrySupplied" || e.type === "FilingRecorded" || e.type === "BatchCreated") return "ok";
  if (e.type === "DeviceQuarantined" || e.type === "BackfillHeld" || e.type === "BackfillOpened" ||
      e.type === "LegacyShiftImported") return "warn";
  if (e.type === "PublishRejected" || e.type === "PublishFailed" || e.type === "ReceiptRejected" ||
      e.type === "BatchInvalidated" || e.type === "ShiftRejected") return "bad";
  return "plain";
}
