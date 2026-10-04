import assert from "node:assert/strict";
import { test } from "node:test";
import {
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
} from "../src/domain/engine";
import type { Outcome, State } from "../src/domain/types";

const ALL = [...METER_IDS, ...NOTICE_IDS];
let state: State = initialState();
let log: ReturnType<typeof stampEvents>["stamped"] = [];
let clock = 0;
function now() {
  return new Date(Date.UTC(2026, 0, 1) + clock++ * 60000).toISOString();
}
function run(outcome: Outcome): boolean {
  const r = stampEvents(outcome.events, state, now());
  state = r.state;
  log.push(...r.stamped);
  return outcome.ok;
}
function reset() {
  state = initialState();
  log = [];
}
function register(price: number, surcharge: number, date: string, operator = "甲", retroactive = false, note = "") {
  const out = cmdRegisterFiling(state, { fuelPrice: price, surcharge, effectiveDate: date, operator, retroactive, note });
  assert.ok(out.ok, out.error ?? "unexpected");
  run(out);
  return state.batches.find((b) => b.status === "pending")!.id;
}
function ackAll(batchId: string, except: string[] = []) {
  for (const id of ALL) {
    if (except.includes(id)) continue;
    const kind = (METER_IDS as readonly string[]).includes(id) ? "meter" : "notice";
    const out = cmdAcceptReceipt(state, { batchId, deviceId: id, receiptId: `R-${id}`, checksumValue: checksum(batchId, id), deviceKind: kind });
    assert.ok(out.ok, out.error ?? "unexpected");
    run(out);
  }
}
function publish(batchId: string, operatorId: string, simulateFailure = false) {
  const out = cmdPublish(state, { batchId, operatorId, simulateFailure });
  run(out);
  return out;
}

test("1. 备案价变化：未确认批次立即失效重算，旧批次未刷完的回执不沿用", () => {
  reset();
  const b1 = register(7.41, 1, "2026-07-01");
  const out = cmdAcceptReceipt(state, { batchId: b1, deviceId: "M-01", receiptId: "R1", checksumValue: checksum(b1, "M-01"), deviceKind: "meter" });
  run(out);
  assert.equal(state.batches.find((b) => b.id === b1)!.received["M-01"].receiptId, "R1");

  const b2 = register(7.76, 1.5, "2026-09-15");
  assert.notEqual(b1, b2);
  const old = state.batches.find((b) => b.id === b1)!;
  const fresh = state.batches.find((b) => b.id === b2)!;
  assert.equal(old.status, "superseded");
  assert.equal(Object.keys(old.received).length, 0, "失效批次的已回传计数必须清空，不能沿用到新标准");
  assert.equal(fresh.status, "pending");
  assert.equal(fresh.surcharge, 1.5);
});

test("2. 离线设备回连按设备号+批次号核对；批次号不符 -> 异常单列", () => {
  reset();
  const b = register(7.76, 1.5, "2026-09-15");
  const bad = cmdAcceptReceipt(state, { batchId: b, deviceId: "M-03", receiptId: "RBAD", checksumValue: "deadbeef", deviceKind: "meter" });
  assert.equal(bad.ok, false);
  run(bad);
  const batch = state.batches.find((x) => x.id === b)!;
  assert.ok(batch.quarantined["M-03"]);
  assert.equal(state.anomalies.length, 1);
  assert.equal(state.anomalies[0].deviceId, "M-03");

  // 修正后（恢复 + 正确校验码）才计入
  run(cmdReinstate(state, b, "M-03"));
  const ok = cmdAcceptReceipt(state, { batchId: b, deviceId: "M-03", receiptId: "R3", checksumValue: checksum(b, "M-03"), deviceKind: "meter" });
  assert.ok(ok.ok, ok.error ?? "unexpected");
  run(ok);
  assert.equal(state.batches.find((x) => x.id === b)!.received["M-03"].receiptId, "R3");
});

test("3. 重复回执幂等：不重复计入；同设备换回执号视为重放列异常", () => {
  reset();
  const b = register(7.76, 1.5, "2026-09-15");
  const send = (receiptId: string) =>
    cmdAcceptReceipt(state, { batchId: b, deviceId: "M-01", receiptId, checksumValue: checksum(b, "M-01"), deviceKind: "meter" });
  run(send("R-DUP"));
  const dup = send("R-DUP");
  assert.ok(dup.ok, "同一回执重发是幂等成功");
  run(dup);
  const batch = state.batches.find((x) => x.id === b)!;
  assert.equal(Object.keys(batch.received).length, 1);
  assert.equal(batch.received["M-01"].receiptId, "R-DUP");

  const replay = send("R-OTHER");
  assert.equal(replay.ok, false);
  run(replay);
  const afterReplay = state.batches.find((x) => x.id === b)!;
  assert.ok(afterReplay.quarantined["M-01"]);
  assert.equal(Object.keys(afterReplay.received).length, 1, "重放回执不增加计数");
});

test("4. 全部计价器和告示回传一致后才允许切换附加费", () => {
  reset();
  const b = register(7.76, 1.5, "2026-09-15");
  ackAll(b, ["M-04", "N-02"]);
  let p = cmdPublish(state, { batchId: b, operatorId: "甲" });
  assert.equal(p.ok, false);
  assert.match(p.error ?? "unexpected", /计价器/);
  run(p);

  ackAll(b); // 补齐离线设备
  p = cmdPublish(state, { batchId: b, operatorId: "甲" });
  assert.ok(p.ok, p.error ?? "unexpected");
  run(p);
  assert.equal(state.batches.find((x) => x.id === b)!.status, "active");
});

test("5. 异常设备不能改写已生效结果", () => {
  reset();
  const b = register(7.41, 1, "2026-07-01");
  ackAll(b);
  assert.ok(publish(b, "甲").ok);
  const active = state.batches.find((x) => x.id === b)!;

  const late = cmdAcceptReceipt(state, { batchId: b, deviceId: "M-01", receiptId: "RX", checksumValue: checksum(b, "M-01"), deviceKind: "meter" });
  assert.equal(late.ok, false);
  run(late);
  const rein = cmdReinstate(state, b, "M-01");
  assert.equal(rein.ok, false);
  assert.match(rein.error ?? "unexpected", /不能改写/);
  // 快照附加费不变
  assert.equal(state.batches.find((x) => x.id === b)!.surcharge, active.surcharge);
});

test("6. 两名运营员发布只放行先到者", () => {
  reset();
  const b = register(7.76, 1.5, "2026-09-15");
  ackAll(b);
  // 甲先抢占成功，乙再抢占被拒
  const first = cmdClaimPublish(state, { batchId: b, operatorId: "运营员甲" });
  assert.ok(first.ok, first.error ?? "unexpected");
  run(first);
  const second = cmdClaimPublish(state, { batchId: b, operatorId: "运营员乙" });
  assert.equal(second.ok, false);
  assert.match(second.error ?? "unexpected", /只放行先到者/);
  run(second);
  // 持锁的是甲：乙发布也被拒，甲发布生效
  const secondPub = cmdPublish(state, { batchId: b, operatorId: "运营员乙" });
  assert.equal(secondPub.ok, false);
  run(secondPub);
  assert.equal(state.batches.find((x) => x.id === b)!.status, "pending", "后到者不能发布");
  const mine = cmdPublish(state, { batchId: b, operatorId: "运营员甲" });
  assert.ok(mine.ok, mine.error ?? "unexpected");
  run(mine);
  assert.equal(state.batches.find((x) => x.id === b)!.status, "active");
});

test("7. 发布失败释放锁，从完整批次重试仍可成功", () => {
  reset();
  const b = register(7.76, 1.5, "2026-09-15");
  ackAll(b);
  const fail = publish(b, "运营员甲", true);
  assert.equal(fail.ok, false);
  const batch = state.batches.find((x) => x.id === b)!;
  assert.equal(batch.status, "pending");
  assert.equal(batch.publishClaim, null, "失败必须释放锁");
  assert.equal(Object.keys(batch.received).length, ALL.length, "失败不产生部分生效，完整批次仍在");

  // 同一运营员从完整批次重试成功
  const retry = publish(b, "运营员甲");
  assert.ok(retry.ok, retry.error ?? "unexpected");
  assert.equal(state.batches.find((x) => x.id === b)!.status, "active");
});

test("8. 已生效班次保留当时快照，后续备案变化不影响它", () => {
  reset();
  const b1 = register(7.41, 1, "2026-07-01");
  ackAll(b1);
  publish(b1, "甲");
  run(cmdSettleShift(state));
  const before = state.shifts[0];
  assert.equal(before.snapshotSurcharge, 1);

  register(7.76, 1.5, "2026-09-15"); // 未确认新批次
  const after = state.shifts[0];
  assert.equal(after.snapshotSurcharge, 1, "历史班次快照不变");
  assert.equal(after.snapshotFilingId, before.snapshotFilingId);
});

test("8b. 新批次生效后旧批次停用（retired），旧班次快照不变", () => {
  reset();
  const b1 = register(7.41, 1, "2026-07-01");
  ackAll(b1);
  publish(b1, "甲");
  run(cmdSettleShift(state));

  const b2 = register(7.76, 1.5, "2026-09-15");
  ackAll(b2);
  const pub = cmdPublish(state, { batchId: b2, operatorId: "甲" });
  assert.ok(pub.ok, pub.error ?? "unexpected");
  run(pub);

  assert.equal(state.batches.find((x) => x.id === b2)!.status, "active");
  const old = state.batches.find((x) => x.id === b1)!;
  assert.equal(old.status, "retired", "旧标准停用而不是继续生效");
  assert.equal(old.surcharge, 1, "旧批次快照保留");
  assert.equal(state.shifts[0].snapshotSurcharge, 1, "按旧标准结算的班次不变");
  const late = cmdAcceptReceipt(state, { batchId: b1, deviceId: "M-02", receiptId: "RX", checksumValue: checksum(b1, "M-02"), deviceKind: "meter" });
  assert.equal(late.ok, false);
});

test("9. 旧附加费按生效日补档；补不全停在待核并阻断切换；补齐后放行", () => {
  reset();
  const b1 = register(7.41, 1, "2026-07-01");
  ackAll(b1);
  publish(b1, "甲");
  run(cmdSettleShift(state)); // 7月正常班次

  // 迁移一张 5 月的老班次，当天没有标准
  run(cmdImportLegacyShift(state, "2026-05-10"));

  // 9月新批次 -> 自动检出缺档，停在待核
  const b2 = register(7.76, 1.5, "2026-09-15");
  ackAll(b2);
  const blocked = cmdPublish(state, { batchId: b2, operatorId: "甲" });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error ?? "unexpected", /待核/);
  run(blocked);
  assert.equal(state.backfill!.status, "held");

  // 未登记旧标准前尝试补录：仍然待核
  run(cmdSupplyBackfillEntry(state, "2026-05-10"));
  assert.equal(state.backfill!.status, "held");

  // 登记 5月1日生效的旧标准（补档登记不产生新批次，缺档挂在 b2 上并立即补齐）
  const batchCountBefore = state.batches.length;
  const retro = cmdRegisterFiling(state, { fuelPrice: 7.05, surcharge: 0.5, effectiveDate: "2026-05-01", operator: "乙", retroactive: true, note: "旧标准补档" });
  assert.ok(retro.ok, retro.error ?? "unexpected");
  run(retro);
  assert.equal(state.batches.length, batchCountBefore, "补档登记不重算执行批次");
  assert.equal(state.backfill!.batchId, b2);
  assert.equal(state.backfill!.status, "done");
  const entry = state.backfill!.entries.find((e) => e.date === "2026-05-10")!;
  assert.equal(entry.status, "filled");
  assert.equal(entry.surcharge, 0.5);

  // 迁移班次按生效日拿到补录快照
  const legacy = state.shifts.find((s) => s.legacy)!;
  assert.equal(legacy.snapshotSurcharge, 0.5);

  // 回传已齐，补档解除阻断，b2 可切换
  const p = cmdPublish(state, { batchId: b2, operatorId: "甲" });
  assert.ok(p.ok, p.error ?? "unexpected");
  run(p);
  assert.equal(state.batches.find((x) => x.id === b2)!.status, "active");
});

test("10. 总览、详情、审计读取同一结论", () => {
  reset();
  const b = register(7.76, 1.5, "2026-09-15");
  ackAll(b, ["M-05"]);
  const model = buildModel(state, log);
  assert.match(model.conclusion.verdict, /M-05/);
  assert.equal(model.conclusion.pendingBatch!.readiness.missingMeters.length, 1);
  // 再折叠一次（模拟审计页独立重建）：结论文本、批次列表逐字节一致
  const rebuilt = buildModel(fold(log), log);
  assert.equal(rebuilt.conclusion.verdict, model.conclusion.verdict);
  assert.deepEqual(
    rebuilt.batches.map((x) => x.id),
    model.batches.map((x) => x.id)
  );
  assert.equal(model.audit.length, log.length);
  assert.equal(JSON.stringify(rebuilt.state), JSON.stringify(state));
});

test("11. 种子基线可折叠且处于「待确认 + 缺回传 + 补档已补齐」的可演示状态", async () => {
  const { buildSeed } = await import("../src/domain/seed");
  const { state: seeded } = buildSeed();
  const pending = seeded.batches.find((b) => b.status === "pending")!;
  assert.ok(pending, "种子包含一个待确认批次");
  assert.equal(pending.surcharge, 1.5);
  assert.ok(Object.keys(pending.received).length < ALL.length, "仍有离线设备未回传");
  assert.equal(seeded.backfill?.status, "done", "5月旧标准已按生效日补齐");
  const active = seeded.batches.find((b) => b.status === "active")!;
  assert.equal(active.surcharge, 1);
});
