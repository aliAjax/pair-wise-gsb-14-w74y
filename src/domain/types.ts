// 出租车燃油附加费联动执行批次 —— 领域事件与状态类型

export const METER_IDS = ["M-01", "M-02", "M-03", "M-04", "M-05"] as const;
export const NOTICE_IDS = ["N-01", "N-02"] as const;
export type DeviceKind = "meter" | "notice";

export type BatchStatus = "pending" | "active" | "superseded" | "retired";
export type BackfillStatus = "none" | "open" | "held" | "done";
export type BackfillEntryStatus = "filled" | "held";

export type Event =
  | { type: "FilingRecorded"; id: string; fuelPrice: number; surcharge: number; effectiveDate: string; operator: string; note: string; retroactive: boolean }
  | { type: "BatchCreated"; id: string; filingId: string; fuelPrice: number; surcharge: number; effectiveDate: string; replacedBatchId: string | null }
  | { type: "BatchInvalidated"; batchId: string; supersededBy: string; reason: string }
  | { type: "ReceiptAccepted"; batchId: string; deviceId: string; deviceKind: DeviceKind; receiptId: string; at: string }
  | { type: "ReceiptRejected"; batchId: string; deviceId: string; receiptId: string; reason: string; at: string }
  | { type: "DeviceQuarantined"; batchId: string; deviceId: string; reason: string; at: string }
  | { type: "DeviceReinstated"; batchId: string; deviceId: string; at: string }
  | { type: "PublishClaimed"; batchId: string; operatorId: string; claimId: string }
  | { type: "PublishRejected"; batchId: string; operatorId: string; reason: string }
  | { type: "PublishFailed"; batchId: string; operatorId: string; claimId: string; reason: string }
  | { type: "BatchActivated"; batchId: string; snapshotFilingId: string; snapshotPrice: number; snapshotSurcharge: number; at: string }
  | { type: "ShiftSettled"; shiftId: string; batchId: string; snapshotFilingId: string; snapshotSurcharge: number; at: string }
  | { type: "LegacyShiftImported"; shiftId: string; date: string; surcharge: number | null; sourceFilingId: string | null }
  | { type: "ShiftRejected"; reason: string; at: string }
  | { type: "BackfillOpened"; batchId: string; missingDates: string[] }
  | { type: "BackfillEntrySupplied"; batchId: string; date: string; surcharge: number; sourceFilingId: string }
  | { type: "BackfillHeld"; batchId: string; date: string; reason: string };

export interface StampedEvent {
  seq: number;
  at: string;
  event: Event;
}

export interface ReceiptRec {
  receiptId: string;
  at: string;
}

export interface Batch {
  id: string;
  filingId: string;
  fuelPrice: number;
  surcharge: number;
  effectiveDate: string;
  status: BatchStatus;
  received: Record<string, ReceiptRec>;
  quarantined: Record<string, { reason: string; at: string }>;
  publishClaim: { operatorId: string; claimId: string } | null;
  activatedAt: string | null;
}

export interface Filing {
  id: string;
  fuelPrice: number;
  surcharge: number;
  effectiveDate: string;
  operator: string;
  note: string;
  createdAt: string;
  retroactive: boolean;
}

export interface Shift {
  id: string;
  batchId: string;
  snapshotFilingId: string;
  snapshotSurcharge: number | null;
  settledAt: string;
  legacy?: boolean;
}

export interface AnomalyRec {
  seq: number;
  batchId: string;
  deviceId: string;
  reason: string;
  at: string;
}

export interface BackfillEntry {
  date: string;
  status: BackfillEntryStatus;
  surcharge?: number;
  sourceFilingId?: string;
  reason?: string;
}

export interface Backfill {
  batchId: string;
  status: BackfillStatus;
  entries: BackfillEntry[];
}

export interface State {
  seq: number;
  filings: Filing[];
  batches: Batch[];
  shifts: Shift[];
  anomalies: AnomalyRec[];
  backfill: Backfill | null;
}

export interface Outcome {
  ok: boolean;
  events: Event[];
  error?: string;
}
