import type {
  AuditEntry,
  Batch,
  PersistedState,
  PriceFiling,
  FeeStandard,
  MeterTarget,
  PosterTarget,
} from "./types";
import { buildRetro } from "./domain";

const rosterMeters = [
  { deviceNo: "JY-1001", vehicleNo: "京B·1001" },
  { deviceNo: "JY-1002", vehicleNo: "京B·1002" },
  { deviceNo: "JY-1003", vehicleNo: "京B·1003" },
  { deviceNo: "JY-1004", vehicleNo: "京B·1004" },
  { deviceNo: "JY-1005", vehicleNo: "京B·1005" },
  { deviceNo: "JY-1006", vehicleNo: "京B·1006" },
];

const rosterPosters = [
  { code: "GS-D01", name: "北京站东出租车扬招点" },
  { code: "GS-D02", name: "西站北广场候客通道" },
  { code: "GS-D03", name: "南站地下出租站" },
];

const t = (h: number, m = 0) => `2026-10-04T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00+08:00`;

function metersFor(
  batchId: string,
  surcharge: number,
  acked: string[],
  offline: string[]
): MeterTarget[] {
  return rosterMeters.map((m) => {
    const isAcked = acked.includes(m.deviceNo);
    const isOffline = offline.includes(m.deviceNo);
    return {
      deviceNo: m.deviceNo,
      vehicleNo: m.vehicleNo,
      batchId,
      state: isAcked ? "acked" : isOffline ? "offline" : "pending",
      online: !isOffline,
      snapshotSurcharge: surcharge,
      receiptNo: isAcked ? `R-${m.deviceNo}-${batchId}` : null,
      reportedSurcharge: isAcked ? surcharge : null,
      ackedAt: isAcked ? t(9, 20) : null,
      anomalyReason: null,
    };
  });
}

function postersFor(
  batchId: string,
  surcharge: number,
  acked: string[],
  offline: string[] = []
): PosterTarget[] {
  return rosterPosters.map((p) => {
    const isAcked = acked.includes(p.code);
    const isOffline = offline.includes(p.code);
    return {
      code: p.code,
      name: p.name,
      batchId,
      state: isAcked ? "acked" : isOffline ? "offline" : "pending",
      online: !isOffline,
      snapshotSurcharge: surcharge,
      receiptNo: isAcked ? `R-${p.code}-${batchId}` : null,
      reportedSurcharge: isAcked ? surcharge : null,
      ackedAt: isAcked ? t(9, 25) : null,
      anomalyReason: null,
    };
  });
}

export function buildSeed(): PersistedState {
  // 旧备案：7.62 元 → 附加费 1 元，批次已生效，快照保留
  const filing1: PriceFiling = {
    id: "BA-20260905-001",
    fuelPrice: 7.62,
    filedAt: "2026-09-04T10:00:00+08:00",
    filedBy: "运营员甲",
    effectiveDate: "2026-09-05",
    note: "92号汽油月度备案",
    status: "superseded",
  };
  const standard1: FeeStandard = {
    id: "FB-20260905-001",
    filingId: filing1.id,
    fuelPrice: 7.62,
    surcharge: 1,
    bracketLabel: "7.50（含）-8.00元，附加费1元",
    effectiveDate: "2026-09-05",
    status: "history",
  };

  // 新备案：8.13 元 → 附加费 1.5 元，批次回传中
  const filing2: PriceFiling = {
    id: "BA-20261004-002",
    fuelPrice: 8.13,
    filedAt: t(8, 30),
    filedBy: "运营员甲",
    effectiveDate: "2026-10-05",
    note: "92号汽油调价备案",
    status: "active",
  };
  const standard2: FeeStandard = {
    id: "FB-20261004-002",
    filingId: filing2.id,
    fuelPrice: 8.13,
    surcharge: 1.5,
    bracketLabel: "8.00（含）-8.50元，附加费1.5元",
    effectiveDate: "2026-10-05",
    status: "current",
  };

  // 运营台账：9/5-10/3，缺 9/12（用于演示“补不全停在待核”）
  const shiftLedger: string[] = [];
  for (let i = 0; i < 29; i++) {
    const d = new Date("2026-09-05T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + i);
    const iso = d.toISOString().slice(0, 10);
    if (iso !== "2026-09-12") shiftLedger.push(iso);
  }

  const b1: Batch = {
    id: "PC-20260905-001",
    snapshot: {
      filingId: filing1.id,
      standardId: standard1.id,
      fuelPrice: 7.62,
      surcharge: 1,
      bracketLabel: standard1.bracketLabel,
      effectiveDate: "2026-09-05",
      computedAt: "2026-09-04T10:20:00+08:00",
    },
    status: "effective",
    createdAt: "2026-09-04T10:20:00+08:00",
    createdBy: "运营员甲",
    replacesBatchId: null,
    supersededByBatchId: null,
    publishHolder: null,
    publishClaimedAt: null,
    publishedAt: "2026-09-04T11:00:00+08:00",
    attempts: 1,
    effectiveAt: "2026-09-05T00:00:00+08:00",
    switchedBy: "运营员甲",
    meters: metersFor("PC-20260905-001", 1, rosterMeters.map((m) => m.deviceNo), []),
    posters: postersFor("PC-20260905-001", 1, rosterPosters.map((p) => p.code)),
    retro: [],
    anomalies: [
      {
        id: "YC-0001",
        at: "2026-09-06T15:10:00+08:00",
        kind: "post_effective",
        ref: "JY-1003",
        batchId: "PC-20260905-001",
        detail: "计价器长离线，生效次日才回连；回执与旧快照一致，单列留存，不改写已生效结果。",
        resolved: false,
        resolvedAt: null,
      },
    ],
  };

  const b2: Batch = {
    id: "PC-20261004-002",
    snapshot: {
      filingId: filing2.id,
      standardId: standard2.id,
      fuelPrice: 8.13,
      surcharge: 1.5,
      bracketLabel: standard2.bracketLabel,
      effectiveDate: "2026-10-05",
      computedAt: t(8, 40),
    },
    status: "collecting",
    createdAt: t(8, 40),
    createdBy: "运营员甲",
    replacesBatchId: null,
    supersededByBatchId: null,
    publishHolder: null,
    publishClaimedAt: null,
    publishedAt: t(9),
    attempts: 1,
    effectiveAt: null,
    switchedBy: null,
    meters: metersFor("PC-20261004-002", 1.5, ["JY-1001", "JY-1002", "JY-1004", "JY-1006"], ["JY-1003", "JY-1005"]),
    posters: postersFor("PC-20261004-002", 1.5, ["GS-D01", "GS-D02"], []),
    // 补档窗口：上一标准生效日 9/5 → 拟生效日前一天（今天封顶），仅 9/12 台账缺失
    retro: buildRetro("2026-09-05", "2026-10-05", 1, shiftLedger),
    anomalies: [],
  };

  const audit: AuditEntry[] = [
    { id: "SJ-0001", ts: "2026-09-04T10:00:00+08:00", actor: "运营员甲", action: "filing", batchId: null, detail: "92号汽油备案价 7.62 元/升，拟生效日 2026-09-05", tone: "info" },
    { id: "SJ-0002", ts: "2026-09-04T10:05:00+08:00", actor: "系统", action: "standard", batchId: null, detail: "联动分档：7.50-8.00 元，附加费 1 元/次（FB-20260905-001）", tone: "info" },
    { id: "SJ-0003", ts: "2026-09-04T10:20:00+08:00", actor: "系统", action: "batch_created", batchId: "PC-20260905-001", detail: "生成完整批次，计价器6台、告示3处，快照附加费 1 元", tone: "info" },
    { id: "SJ-0004", ts: "2026-09-04T11:00:00+08:00", actor: "运营员甲", action: "publish_delivered", batchId: "PC-20260905-001", detail: "发布持锁成功，9 个目标全部下发", tone: "success" },
    { id: "SJ-0005", ts: "2026-09-04T16:00:00+08:00", actor: "系统", action: "receipt_acked", batchId: "PC-20260905-001", detail: "9/9 台回传一致（重复回执已按回执号幂等忽略）", tone: "success" },
    { id: "SJ-0006", ts: "2026-09-05T00:00:00+08:00", actor: "运营员甲", action: "switched", batchId: "PC-20260905-001", detail: "全部一致，切换附加费为 1 元/次，快照冻结", tone: "success" },
    { id: "SJ-0007", ts: "2026-09-06T15:10:00+08:00", actor: "系统", action: "anomaly", batchId: "PC-20260905-001", detail: "JY-1003 生效后回执到达：单列异常，不改写已生效结果", tone: "warning" },
    { id: "SJ-0008", ts: t(8, 30), actor: "运营员甲", action: "filing", batchId: null, detail: "92号汽油备案价 8.13 元/升，拟生效日 2026-10-05", tone: "info" },
    { id: "SJ-0009", ts: t(8, 35), actor: "系统", action: "standard", batchId: null, detail: "联动分档：8.00-8.50 元，附加费 1.5 元/次（FB-20261004-002）", tone: "info" },
    { id: "SJ-0010", ts: t(8, 40), actor: "系统", action: "batch_created", batchId: "PC-20261004-002", detail: "生成完整批次，计价器6台、告示3处，快照附加费 1.5 元", tone: "info" },
    { id: "SJ-0011", ts: t(9, 0), actor: "运营员甲", action: "publish_delivered", batchId: "PC-20261004-002", detail: "发布持锁成功，9 个目标全部下发；运营员乙的并发发布已被拒绝", tone: "success" },
    { id: "SJ-0012", ts: t(9, 20), actor: "系统", action: "receipt_acked", batchId: "PC-20261004-002", detail: "JY-1001/1002/1004/1006 回传附加费 1.5 元一致", tone: "success" },
    { id: "SJ-0013", ts: t(9, 25), actor: "系统", action: "receipt_acked", batchId: "PC-20261004-002", detail: "GS-D01/GS-D02 告示回执一致", tone: "success" },
    { id: "SJ-0014", ts: t(9, 30), actor: "系统", action: "device_offline", batchId: "PC-20261004-002", detail: "JY-1003、JY-1005 离线，下发挂起，留待回连后核对", tone: "warning" },
  ];

  return {
    version: 1,
    seq: { filing: 2, standard: 2, batch: 2, anomaly: 1, audit: 14 },
    activeOperator: "运营员甲",
    activeTab: "overview",
    selectedBatchId: "PC-20261004-002",
    meters: rosterMeters,
    posters: rosterPosters,
    shiftLedger,
    filings: [filing2, filing1],
    standards: [standard2, standard1],
    batches: [b2, b1],
    currentBatchId: "PC-20260905-001",
    audit,
  };
}
