// 演示基线：通过正式命令构造，保证种子数据也服从同一套批次规则
import {
  cmdAcceptReceipt,
  cmdImportLegacyShift,
  cmdPublish,
  cmdRegisterFiling,
  cmdSettleShift,
  checksum,
  fold,
  initialState,
  stampEvents,
  METER_IDS,
  NOTICE_IDS
} from "./engine";
import type { State, StampedEvent } from "./types";

function append(state: State, log: StampedEvent[], outcome: { ok: boolean; events: any[] }, at: string): State {
  const { state: next, stamped } = stampEvents(outcome.events, state, at);
  log.push(...stamped);
  return next;
}

export function buildSeed(): { state: State; log: StampedEvent[] } {
  let state = initialState();
  const log: StampedEvent[] = [];

  // 7 月备案价 7.41，附加费 1 元，已切换生效；随后结算两个历史班次（持有当时快照）
  state = append(
    state,
    log,
    cmdRegisterFiling(state, {
      fuelPrice: 7.41,
      surcharge: 1,
      effectiveDate: "2026-07-01",
      operator: "运营员甲",
      note: "7月备案"
    }),
    "2026-06-28T09:00:00.000Z"
  );
  const b1 = state.batches[0].id;
  for (const id of [...METER_IDS, ...NOTICE_IDS]) {
    state = append(
      state,
      log,
      cmdAcceptReceipt(state, {
        batchId: b1,
        deviceId: id,
        receiptId: `R-seed-${id}`,
        checksumValue: checksum(b1, id),
        deviceKind: METER_IDS.includes(id as never) ? "meter" : "notice"
      }),
      "2026-06-29T10:00:00.000Z"
    );
  }
  state = append(state, log, cmdPublish(state, { batchId: b1, operatorId: "运营员甲" }), "2026-06-30T08:00:00.000Z");
  state = append(state, log, cmdSettleShift(state), "2026-07-15T20:00:00.000Z");
  state = append(state, log, cmdSettleShift(state), "2026-08-16T20:00:00.000Z");
  // 一张更老的迁移班次（2026-05），当时附加费记录缺失，补档停在待核，阻断新批次切换
  state = append(state, log, cmdImportLegacyShift(state, "2026-05-10"), "2026-09-09T15:00:00.000Z");

  // 9 月备案价上调至 7.76，附加费 1.5 元，新批次下发中：M-01/M-02 已回传，其余离线
  state = append(
    state,
    log,
    cmdRegisterFiling(state, {
      fuelPrice: 7.76,
      surcharge: 1.5,
      effectiveDate: "2026-09-15",
      operator: "运营员甲",
      note: "9月调价"
    }),
    "2026-09-10T09:00:00.000Z"
  );
  const b2 = state.batches.find((b) => b.status === "pending")!.id;
  for (const id of ["M-01", "M-02"]) {
    state = append(
      state,
      log,
      cmdAcceptReceipt(state, {
        batchId: b2,
        deviceId: id,
        receiptId: `R-seed-${id}`,
        checksumValue: checksum(b2, id),
        deviceKind: "meter"
      }),
      "2026-09-11T09:30:00.000Z"
    );
  }
  // 旧附加费按生效日补档：0.5 元标准自 2026-05-01 生效，补档登记不重算执行批次，
  // 迁移班次当日即补齐；执行批次仍是 B-0002（1.5 元），等待剩余设备回传
  state = append(
    state,
    log,
    cmdRegisterFiling(state, {
      fuelPrice: 7.05,
      surcharge: 0.5,
      effectiveDate: "2026-05-01",
      operator: "运营员乙",
      note: "5月旧标准补档",
      retroactive: true
    }),
    "2026-09-12T14:00:00.000Z"
  );

  return { state, log };
}

export { fold };
