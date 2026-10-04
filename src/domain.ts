// 纯领域规则：不碰 store、不碰 DOM，结论只从同一套数据推导。
import type {
  AnomalyKind,
  Batch,
  BatchSnapshot,
  BatchStatus,
  TargetState,
} from "./types";

// 演示用“业务今天”：所有相对日期（生效日默认值、历史补档窗口）以此为准，保证样例稳定。
export const TODAY_ISO = "2026-10-04";
export const today = () => new Date(`${TODAY_ISO}T09:00:00+08:00`);

export function nowIso(): string {
  return new Date().toISOString();
}

export function shiftDays(dateIso: string, days: number): string {
  const d = new Date(`${dateIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function addDateDays(days: number): string {
  return shiftDays(TODAY_ISO, days);
}

export function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return iso.slice(0, 10);
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  return iso.replace("T", " ").slice(0, 19);
}

// 92号汽油备案价 -> 燃油附加费联动阶梯（分档各记一份标准）
export function surchargeBracket(price: number): { surcharge: number; label: string } {
  if (price < 7.5) return { surcharge: 0, label: "低于7.50元，不收取附加费" };
  if (price < 8.0) return { surcharge: 1, label: "7.50（含）-8.00元，附加费1元" };
  if (price < 8.5) return { surcharge: 1.5, label: "8.00（含）-8.50元，附加费1.5元" };
  if (price < 9.0) return { surcharge: 2, label: "8.50（含）-9.00元，附加费2元" };
  return { surcharge: 2.5, label: "9.00元及以上，附加费2.5元" };
}

export function surchargeFor(price: number): number {
  return surchargeBracket(price).surcharge;
}

export function sameVersion(s: BatchSnapshot, other: BatchSnapshot): boolean {
  return (
    s.filingId === other.filingId &&
    s.standardId === other.standardId &&
    s.fuelPrice === other.fuelPrice &&
    s.surcharge === other.surcharge
  );
}

export function targetLabel(state: TargetState): string {
  return { pending: "待回传", offline: "离线挂起", acked: "已回执一致", anomaly: "异常" }[state];
}

export const BATCH_STATUS_META: Record<BatchStatus, { label: string; tag: string }> = {
  pending: { label: "待发布", tag: "default" },
  publishing: { label: "发布锁定中", tag: "warning" },
  collecting: { label: "回传中", tag: "info" },
  failed: { label: "发布失败", tag: "error" },
  review: { label: "待核", tag: "warning" },
  effective: { label: "已生效", tag: "success" },
  history_snapshot: { label: "历史快照", tag: "default" },
  invalidated: { label: "已失效重算", tag: "default" },
};

export const ANOMALY_META: Record<AnomalyKind, string> = {
  unknown_device: "设备号不在花名册",
  wrong_batch: "设备号+批次号核对不符",
  surcharge_mismatch: "回执附加费与快照不一致",
  stale_batch: "回执回到已失效批次",
  post_effective: "生效后到达（不改写）",
};

export const AUDIT_ACTION_LABELS: Record<string, string> = {
  filing: "油价备案",
  standard: "附加费标准",
  batch_created: "批次生成",
  invalidated: "失效重算",
  publish_claimed: "发布持锁",
  publish_rejected: "发布被拒/放锁",
  publish_delivered: "下发完成",
  publish_failed: "发布失败",
  receipt_acked: "回执一致",
  receipt_duplicate: "重复回执",
  receipt_held_offline: "离线挂起",
  anomaly: "异常登记",
  anomaly_resolved: "异常关闭",
  device_offline: "设备离线",
  device_online: "设备回连",
  review_hold: "停在待核",
  retro_filled: "补档补齐",
  switch_blocked: "切换阻断",
  switched: "切换生效",
};

// 历史班次补档：窗口为“上一标准生效日 → 本次生效日-1”，旧附加费按各班次生效日标准补档；
// 运营台账缺该班次数据则补不全→待核。
export function buildRetro(
  windowStart: string,
  effectiveDate: string,
  surcharge: number,
  ledger: string[],
  todayIso: string = TODAY_ISO
) {
  // 班次只可能发生到“昨天”为止（今天班次未结束），未来日期不参与补档
  const rawEnd = shiftDays(effectiveDate, -1);
  const yesterday = shiftDays(todayIso, -1);
  const end = rawEnd < yesterday ? rawEnd : yesterday;
  const items: { shiftDate: string; surcharge: number; ledger: boolean; status: "filled" | "missing" }[] = [];
  for (let d = windowStart; d <= end; d = shiftDays(d, 1)) {
    const hasLedger = ledger.includes(d);
    items.push({
      shiftDate: d,
      surcharge, // 样例窗口内旧标准同为1元/次
      ledger: hasLedger,
      status: hasLedger ? "filled" : "missing",
    });
  }
  return items;
}

export interface Readiness {
  total: number;
  acked: number;
  pending: number;
  offline: number;
  allConsistent: boolean;
  openAnomalies: number;
  retroMissing: number;
  ready: boolean;
}

export function readiness(b: Batch): Readiness {
  const targets = [...b.meters, ...b.posters];
  const acked = targets.filter((t) => t.state === "acked").length;
  const offline = targets.filter((t) => t.state === "offline").length;
  const pending = targets.filter((t) => t.state === "pending").length;
  const consistent = targets
    .filter((t) => t.state === "acked")
    .every((t) => t.reportedSurcharge === b.snapshot.surcharge);
  const openAnomalies = b.anomalies.filter((a) => !a.resolved).length;
  const retroMissing = b.retro.filter((r) => r.status === "missing").length;
  const allConsistent = acked === targets.length && consistent && openAnomalies === 0;
  return {
    total: targets.length,
    acked,
    pending,
    offline,
    allConsistent,
    openAnomalies,
    retroMissing,
    ready: allConsistent && retroMissing === 0,
  };
}

export interface Conclusion {
  title: string;
  detail: string;
  tone: "info" | "success" | "warning" | "error" | "default";
}

// 总览、详情、审计读取同一结论：只认这一个函数。
export function batchConclusion(b: Batch, currentBatchId: string): Conclusion {
  const r = readiness(b);
  switch (b.status) {
    case "effective":
      return {
        title: `当前生效附加费 ${b.snapshot.surcharge} 元/次（快照冻结）`,
        detail: `备案价 ${b.snapshot.fuelPrice.toFixed(2)} 元 · 生效日 ${b.snapshot.effectiveDate} · ${formatDateTime(b.effectiveAt)} 切换；生效后到达的回执只列异常，不改写结果。`,
        tone: "success",
      };
    case "history_snapshot":
      return {
        title: `历史生效批次：附加费 ${b.snapshot.surcharge} 元/次（快照保留）`,
        detail: `生效日 ${b.snapshot.effectiveDate}，保留当时快照；当前执行批次为 ${currentBatchId}，本批结果不再被改写。`,
        tone: "default",
      };
    case "invalidated":
      return {
        title: "未确认批次已失效并重算",
        detail: b.supersededByBatchId
          ? `备案价变更，本批未生效即作废，完整批次 ${b.supersededByBatchId} 承接重算；已生效班次不受影响。`
          : "备案价变更，本批未生效即作废，已重算；已生效班次不受影响。",
        tone: "default",
      };
    case "pending":
      return {
        title: "完整批次已生成，等待发布",
        detail: `${r.total} 台计价器/告示待下发，快照附加费 ${b.snapshot.surcharge} 元/次；发布两名运营员只放行先到者。`,
        tone: "info",
      };
    case "publishing":
      return {
        title: `发布锁定中（持锁：${b.publishHolder}）`,
        detail: "先到者持锁下发，其他运营员的发布请求被拒绝；下发完成进入回传，失败则回到完整批次重试。",
        tone: "warning",
      };
    case "failed":
      return {
        title: "发布失败，从完整批次重试",
        detail: `已尝试 ${b.attempts} 次；设备回执幂等保留，重试不重算已确认结果。`,
        tone: "error",
      };
    case "collecting": {
      if (r.openAnomalies > 0)
        return {
          title: `回传中，存在 ${r.openAnomalies} 条未处理异常${r.retroMissing > 0 ? `、补档缺 ${r.retroMissing} 天` : ""}`,
          detail: "异常设备单列，不参与一致判定，也不能改写已生效结果；核对一致的设备重发回执可消除异常。",
          tone: "warning",
        };
      if (r.retroMissing > 0)
        return {
          title: `回传中：${r.acked}/${r.total} 已回执，历史补档缺 ${r.retroMissing} 天`,
          detail: "可继续回收回执；但切换时补不全将停在待核。" + (r.offline > 0 ? `${r.offline} 台离线挂起，回连后按设备号+批次号核对。` : ""),
          tone: "warning",
        };
      if (r.offline > 0 || r.pending > 0)
        return {
          title: `回传中：${r.acked}/${r.total} 已回执一致`,
          detail: r.offline > 0 ? `${r.offline} 台离线挂起，回连后按设备号+批次号核对回执。` : "等待剩余告示/计价器回传。",
          tone: "info",
        };
      if (r.allConsistent)
        return {
          title: "全部回传一致，可切换附加费",
          detail: "全部计价器和告示回传附加费均与批次快照一致；切换后本批快照冻结。",
          tone: "success",
        };
      return { title: "回传不一致", detail: "回执附加费与批次快照不一致，已单列为异常。", tone: "warning" };
    }
    case "review":
      return {
        title: `待核：历史班次补档缺 ${r.retroMissing} 天`,
        detail: "旧附加费按生效日补档，补不全停在待核，不允许切换；补齐台账后可继续。",
        tone: "warning",
      };
  }
}
