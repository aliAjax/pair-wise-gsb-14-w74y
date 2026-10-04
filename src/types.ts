// 出租车燃油附加费联动批次：领域模型
// 油价备案、附加费标准、计价器下发、乘客告示各自记账，再由“执行批次”串成一条链。

export type BatchStatus =
  | "pending" // 待发布：完整批次已生成，等待运营员发布
  | "publishing" // 发布锁定中：先到者持锁
  | "collecting" // 已下发、回传中
  | "failed" // 发布失败：从完整批次重试
  | "review" // 待核：历史补档补不全
  | "effective" // 已生效：快照冻结（当前执行）
  | "history_snapshot" // 历史生效批次：快照保留
  | "invalidated"; // 未确认即被新备案价作废，已重算

export type TargetState = "pending" | "offline" | "acked" | "anomaly";

export type TargetKind = "meter" | "poster";

export type FilingStatus = "active" | "superseded";
export type StandardStatus = "pending" | "current" | "history";

export interface PriceFiling {
  id: string;
  fuelPrice: number; // 92号汽油备案价（元/升）
  filedAt: string;
  filedBy: string;
  effectiveDate: string; // 附加费拟生效日 yyyy-MM-dd
  note: string;
  status: FilingStatus;
}

export interface FeeStandard {
  id: string;
  filingId: string; // 与备案版本一一对应
  fuelPrice: number;
  surcharge: number; // 联动附加费（元/次）
  bracketLabel: string;
  effectiveDate: string;
  status: StandardStatus;
}

export interface MeterTarget {
  deviceNo: string;
  vehicleNo: string;
  batchId: string;
  state: TargetState;
  online: boolean;
  snapshotSurcharge: number; // 下发时冻结的附加费标准
  receiptNo: string | null;
  reportedSurcharge: number | null;
  ackedAt: string | null;
  anomalyReason: string | null;
}

export interface PosterTarget {
  code: string;
  name: string;
  batchId: string;
  state: TargetState;
  online: boolean;
  snapshotSurcharge: number;
  receiptNo: string | null;
  reportedSurcharge: number | null;
  ackedAt: string | null;
  anomalyReason: string | null;
}

export interface RetroItem {
  shiftDate: string; // 历史班次日期
  surcharge: number; // 按生效日补档的旧附加费
  ledger: boolean; // 运营台账是否有该班次数据
  status: "filled" | "missing";
}

export type AnomalyKind =
  | "unknown_device" // 设备号不在花名册
  | "wrong_batch" // 设备号+批次号对不上
  | "surcharge_mismatch" // 回执附加费与批次快照不一致
  | "stale_batch" // 回执回到已失效批次
  | "post_effective"; // 生效后到达：单列但不改写已生效结果

export interface AnomalyRecord {
  id: string;
  at: string;
  kind: AnomalyKind;
  ref: string; // 设备号/告示编号
  batchId: string;
  detail: string;
  resolved: boolean;
  resolvedAt: string | null;
}

export interface BatchSnapshot {
  filingId: string;
  standardId: string;
  fuelPrice: number;
  surcharge: number;
  bracketLabel: string;
  effectiveDate: string;
  computedAt: string;
}

export interface Batch {
  id: string;
  snapshot: BatchSnapshot;
  status: BatchStatus;
  createdAt: string;
  createdBy: string;
  replacesBatchId: string | null; // 失效重算链
  supersededByBatchId: string | null;
  publishHolder: string | null;
  publishClaimedAt: string | null;
  publishedAt: string | null;
  attempts: number;
  effectiveAt: string | null;
  switchedBy: string | null;
  meters: MeterTarget[];
  posters: PosterTarget[];
  retro: RetroItem[];
  anomalies: AnomalyRecord[];
}

export interface RosterMeter {
  deviceNo: string;
  vehicleNo: string;
}
export interface RosterPoster {
  code: string;
  name: string;
}

export type AuditTone = "info" | "success" | "warning" | "danger";

export type AuditAction =
  | "filing"
  | "standard"
  | "batch_created"
  | "invalidated"
  | "publish_claimed"
  | "publish_rejected"
  | "publish_delivered"
  | "publish_failed"
  | "receipt_acked"
  | "receipt_duplicate"
  | "receipt_held_offline"
  | "anomaly"
  | "anomaly_resolved"
  | "device_offline"
  | "device_online"
  | "review_hold"
  | "retro_filled"
  | "switch_blocked"
  | "switched";

export interface AuditEntry {
  id: string;
  ts: string;
  actor: string;
  action: AuditAction;
  batchId: string | null;
  detail: string;
  tone: AuditTone;
}

export interface PersistedState {
  version: 1;
  seq: { filing: number; standard: number; batch: number; anomaly: number; audit: number };
  activeOperator: string;
  activeTab: "overview" | "detail" | "audit";
  selectedBatchId: string;
  meters: RosterMeter[];
  posters: RosterPoster[];
  shiftLedger: string[];
  filings: PriceFiling[];
  standards: FeeStandard[];
  batches: Batch[];
  currentBatchId: string;
  audit: AuditEntry[];
}

export interface ReceiptInput {
  kind: TargetKind;
  code: string;
  batchId: string;
  receiptNo: string;
  surcharge: number;
}

export type ReceiptOutcome =
  | { outcome: "acked"; message: string }
  | { outcome: "duplicate"; message: string }
  | { outcome: "held"; message: string }
  | { outcome: "anomaly"; message: string };
