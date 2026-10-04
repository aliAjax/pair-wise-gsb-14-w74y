import { computed, ref } from "vue";
import { defineStore } from "pinia";
import {
  auditDetail,
  auditTitle,
  auditTone,
  buildModel,
  checksum,
  cmdAcceptReceipt,
  cmdClaimPublish,
  cmdImportLegacyShift,
  cmdPublish,
  cmdRegisterFiling,
  cmdReinstate,
  cmdSettleShift,
  cmdSupplyBackfillEntry,
  fold,
  initialState,
  stampEvents,
  METER_IDS,
  NOTICE_IDS
} from "./domain/engine";
import { buildSeed } from "./domain/seed";
import type { DeviceKind, Outcome, StampedEvent } from "./domain/types";

const STORAGE_KEY = "taxi-fuel-batch-log-v1";

function loadLog(): StampedEvent[] {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      const log = JSON.parse(raw) as StampedEvent[];
      if (Array.isArray(log)) return log;
    } catch {
      /* 损坏则回落种子 */
    }
  }
  return buildSeed().log;
}

export const useBatchStore = defineStore("batch", () => {
  const log = ref<StampedEvent[]>(loadLog());
  const state = ref(fold(log.value, initialState()));
  const lastError = ref("");
  const lastInfo = ref("");

  const model = computed(() => buildModel(state.value, log.value));

  function persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(log.value));
  }

  function commit(outcome: Outcome, okMessage: string) {
    if (outcome.events.length) {
      const now = new Date().toISOString();
      const { state: next, stamped } = stampEvents(outcome.events, state.value, now);
      state.value = next;
      log.value.push(...stamped);
      persist();
    }
    if (outcome.ok) {
      lastError.value = "";
      lastInfo.value = okMessage;
    } else {
      lastInfo.value = "";
      lastError.value = outcome.error ?? "操作被拒绝";
    }
    return outcome.ok;
  }

  function registerFiling(input: {
    fuelPrice: number;
    surcharge: number;
    effectiveDate: string;
    operator: string;
    note: string;
    retroactive: boolean;
  }) {
    return commit(
      cmdRegisterFiling(state.value, input),
      input.retroactive ? "旧标准已登记，未确认批次已失效重算" : "备案已登记，未确认批次已失效重算"
    );
  }

  function sendReceipt(input: {
    batchId: string;
    deviceId: string;
    receiptId: string;
    checksumValue: string;
    deviceKind: DeviceKind;
  }) {
    return commit(cmdAcceptReceipt(state.value, input), `设备 ${input.deviceId} 回传已核对计入`);
  }

  /** 演示：模拟离线设备回连，按设备号+批次号自动核对 */
  function deviceReconnect(batchId: string, deviceId: string) {
    const kind: DeviceKind = (METER_IDS as readonly string[]).includes(deviceId) ? "meter" : "notice";
    return commit(
      cmdAcceptReceipt(state.value, {
        batchId,
        deviceId,
        receiptId: `R-${deviceId}-${Date.now()}`,
        checksumValue: checksum(batchId, deviceId),
        deviceKind: kind
      }),
      `设备 ${deviceId} 回连，回执核对一致`
    );
  }

  /** 演示：重发同一条回执（不重复计入） */
  function resendSameReceipt(batchId: string, deviceId: string) {
    const batch = state.value.batches.find((b) => b.id === batchId);
    const prior = batch?.received[deviceId];
    if (!prior) {
      lastError.value = "该设备尚无回执可重发";
      return false;
    }
    const kind: DeviceKind = (METER_IDS as readonly string[]).includes(deviceId) ? "meter" : "notice";
    return commit(
      cmdAcceptReceipt(state.value, {
        batchId,
        deviceId,
        receiptId: prior.receiptId,
        checksumValue: checksum(batchId, deviceId),
        deviceKind: kind
      }),
      `重复回执已忽略（设备 ${deviceId} 不重复计入）`
    );
  }

  /** 演示：伪造批次号不符的回传（校验失败 -> 异常单列） */
  function sendTamperedReceipt(batchId: string, deviceId: string) {
    const kind: DeviceKind = (METER_IDS as readonly string[]).includes(deviceId) ? "meter" : "notice";
    return commit(
      cmdAcceptReceipt(state.value, {
        batchId,
        deviceId,
        receiptId: `R-BAD-${Date.now()}`,
        checksumValue: "deadbeef",
        deviceKind: kind
      }),
      "已列入异常设备"
    );
  }

  function reinstate(batchId: string, deviceId: string) {
    return commit(cmdReinstate(state.value, batchId, deviceId), `设备 ${deviceId} 已移出异常名单`);
  }

  function claimPublish(batchId: string, operatorId: string) {
    return commit(cmdClaimPublish(state.value, { batchId, operatorId }), `运营员 ${operatorId} 取得发布权（先到者）`);
  }

  function publish(batchId: string, operatorId: string, simulateFailure = false) {
    return commit(
      cmdPublish(state.value, { batchId, operatorId, simulateFailure }),
      simulateFailure ? "发布失败，锁已释放" : `批次 ${batchId} 已切换生效`
    );
  }

  function settleShift() {
    return commit(cmdSettleShift(state.value), "班次已按当前生效快照结算");
  }

  function importLegacyShift(date: string) {
    return commit(cmdImportLegacyShift(state.value, date), `已迁移 ${date} 历史班次，缺档已挂入补档`);
  }

  function supplyBackfill(date: string) {
    return commit(cmdSupplyBackfillEntry(state.value, date), `${date} 已按生效日补录`);
  }

  function supplyAllBackfill() {
    const bf = state.value.backfill;
    if (!bf) return false;
    let ok = true;
    for (const entry of bf.entries.filter((e) => e.status === "held")) {
      ok = commit(cmdSupplyBackfillEntry(state.value, entry.date), "补档已处理") && ok;
    }
    return ok;
  }

  function resetSeed() {
    const seed = buildSeed();
    log.value = seed.log;
    state.value = fold(seed.log, initialState());
    persist();
    lastError.value = "";
    lastInfo.value = "已恢复演示基线";
  }

  return {
    log,
    state,
    model,
    lastError,
    lastInfo,
    registerFiling,
    sendReceipt,
    deviceReconnect,
    resendSameReceipt,
    sendTamperedReceipt,
    reinstate,
    claimPublish,
    publish,
    settleShift,
    importLegacyShift,
    supplyBackfill,
    supplyAllBackfill,
    resetSeed,
    auditTitle,
    auditDetail,
    auditTone,
    meterIds: METER_IDS,
    noticeIds: NOTICE_IDS
  };
});
