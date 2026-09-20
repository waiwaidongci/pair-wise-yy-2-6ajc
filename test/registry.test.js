import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../store.js";
import { createRegistry, DomainError } from "../registry.js";
import { addDays } from "../eligibility.js";

async function freshRegistry() {
  const dir = await mkdtemp(join(tmpdir(), "pigeon-test-"));
  const store = createStore(join(dir, "db.json"));
  const registry = createRegistry(store);
  const db = await store.read();
  return { registry, store, dir, dbPath: store.dbPath };
}

function expectError(code) {
  return error => {
    assert.ok(error instanceof DomainError, `expected DomainError, got ${error}`);
    assert.equal(error.code, code);
    return true;
  };
}

let ctx;
beforeEach(async () => {
  ctx = await freshRegistry();
});

test("同一羽同一赛事重复与并发报名沿用首次结果，只有一份记录", async () => {
  const { registry } = ctx;
  const [a, b, c] = await Promise.all([
    registry.register("evt-1", "CHN-2026-001"),
    registry.register("evt-1", "CHN-2026-001"),
    registry.register("evt-1", "CHN-2026-001")
  ]);
  assert.equal(a.created, true);
  assert.equal(b.created, true); // 并发沿用首次结果
  assert.equal(c.created, true);
  assert.equal(a.registration.id, b.registration.id);
  assert.equal(a.registration.id, c.registration.id);
  const disk = await ctx.store.read();
  assert.equal(disk.registrations.filter(r => r.eventId === "evt-1" && r.ringNo === "CHN-2026-001").length, 1);
  // 再串行重复一次
  const again = await registry.register("evt-1", "CHN-2026-001");
  assert.equal(again.created, false);
  assert.equal(again.registration.id, a.registration.id);
});

test("报名绑定当前鸽主；血统未确认拒绝报名", async () => {
  const { registry } = ctx;
  // 新建鸽只（血统未确认）
  await registry.createPigeon({ ringNo: "T-1", owner: "甲棚", color: "灰", loft: "甲1棚", fatherRing: "CHN-2022-188", motherRing: "CHN-2023-512" });
  await assert.rejects(registry.register("evt-1", "T-1"), expectError("bloodline_unconfirmed"));
  await registry.confirmBloodline("T-1", { confirmedBy: "裁判乙" });
  await registry.register("evt-1", "T-1");
  const detail = await registry.getPigeonDetail("T-1");
  assert.equal(detail.registrations[0].owner, "甲棚");
  // 转让后报名绑定的仍是原鸽主
  await registry.transfer("T-1", { to: "乙棚", date: "2026-09-01" });
  const detail2 = await registry.getPigeonDetail("T-1");
  assert.equal(detail2.pigeon.owner, "乙棚");
  assert.equal(detail2.registrations[0].owner, "甲棚");
});

test("休药期覆盖比赛日：禁赛截止=用药日+休药天数；未解除只能候补不占正式名额", async () => {
  const { registry } = ctx;
  const raceDate = "2026-10-18";
  await registry.addMedication("CHN-2026-001", { drug: "甲硝唑", date: "2026-10-10", withdrawalDays: 14, administeredBy: "教练甲" });
  // 10-10 + 14 = 10-24，覆盖 10-18
  assert.equal(addDays("2026-10-10", 14), "2026-10-24");
  await registry.register("evt-1", "CHN-2026-001");

  // 另一只无禁赛鸽占正式名额：先补父母并确认血统
  await registry.createPigeon({ ringNo: "T-2", owner: "丙棚", color: "雨点", loft: "丙棚", fatherRing: "CHN-2022-188", motherRing: "CHN-2023-512" });
  await registry.confirmBloodline("T-2", { confirmedBy: "裁判乙" });
  await registry.register("evt-1", "T-2");
  let board = await registry.getBoard("evt-1");
  assert.equal(board.confirmed.length, 1);
  assert.equal(board.confirmed[0].ringNo, "T-2");
  assert.equal(board.waitlist.length, 1);
  assert.equal(board.waitlist[0].ringNo, "CHN-2026-001");
  assert.deepEqual(board.waitlist[0].reasons, ["withdrawal_hold"]);

  // 休药期在比赛日前自然结束的用药不构成禁赛
  await registry.addMedication("T-2", { drug: "维C", date: "2026-09-01", withdrawalDays: 7, administeredBy: "教练甲" });
  board = await registry.getBoard("evt-1");
  assert.equal(board.confirmed.some(r => r.ringNo === "T-2"), true);
});

test("解除须另一人复核且复查日不早于禁赛截止", async () => {
  const { registry } = ctx;
  await registry.addMedication("CHN-2026-001", { drug: "甲硝唑", date: "2026-10-10", withdrawalDays: 14, administeredBy: "教练甲" });
  const med = (await registry.getPigeonDetail("CHN-2026-001")).pigeon.medications[0];
  // 施药人自己复核 → 拒绝
  await assert.rejects(registry.releaseMedication("CHN-2026-001", med.id, { reviewedBy: "教练甲", reviewDate: "2026-10-24" }), expectError("reviewer_must_differ"));
  // 他人但复查日早于截止 → 拒绝
  await assert.rejects(registry.releaseMedication("CHN-2026-001", med.id, { reviewedBy: "裁判乙", reviewDate: "2026-10-23" }), expectError("review_before_suspension_end"));
  // 合规解除
  const result = await registry.releaseMedication("CHN-2026-001", med.id, { reviewedBy: "裁判乙", reviewDate: "2026-10-24" });
  assert.equal(result.medication.release.confirmed, true);
});

test("解除后候补按规则重算晋升正式", async () => {
  const { registry } = ctx;
  await registry.addMedication("CHN-2026-001", { drug: "甲硝唑", date: "2026-10-10", withdrawalDays: 14, administeredBy: "教练甲" });
  const med = (await registry.getPigeonDetail("CHN-2026-001")).pigeon.medications[0];
  await registry.register("evt-1", "CHN-2026-001");
  // 两只无禁赛鸽占满 2 个名额
  for (let i = 3; i <= 4; i++) {
    const ring = `T-${i}`;
    await registry.createPigeon({ ringNo: ring, owner: `棚${i}`, color: "灰", loft: "棚", fatherRing: "CHN-2022-188", motherRing: "CHN-2023-512" });
    await registry.confirmBloodline(ring, { confirmedBy: "裁判乙" });
    await registry.register("evt-1", ring);
  }
  let board = await registry.getBoard("evt-1");
  assert.equal(board.confirmed.length, 2);
  assert.equal(board.waitlist[0].ringNo, "CHN-2026-001"); // 禁赛者候补第1

  await registry.releaseMedication("CHN-2026-001", med.id, { reviewedBy: "裁判乙", reviewDate: "2026-10-24" });
  board = await registry.getBoard("evt-1");
  // 解除后全部按报名时间排：001 最先报，占第1名额，T-4 落候补
  assert.deepEqual(board.confirmed.map(r => r.ringNo), ["CHN-2026-001", "T-3"]);
  assert.deepEqual(board.waitlist.map(r => r.ringNo), ["T-4"]);
});

test("更正用药令解除作废、报名重算；已完赛历史保留但标记受影响", async () => {
  const { registry } = ctx;
  await registry.register("evt-1", "CHN-2026-001");
  await registry.addMedication("CHN-2026-001", { drug: "短休药", date: "2026-10-10", withdrawalDays: 3, administeredBy: "教练甲" });
  const med = (await registry.getPigeonDetail("CHN-2026-001")).pigeon.medications[0];
  // 休药 10-13 截止，不覆盖 10-18？ 10-10+3=10-13 < 10-18，确实不覆盖。改成覆盖比赛日再验证
  let board = await registry.getBoard("evt-1");
  assert.equal(board.confirmed.some(r => r.ringNo === "CHN-2026-001"), true);

  await registry.releaseMedication("CHN-2026-001", med.id, { reviewedBy: "裁判乙", reviewDate: "2026-10-13" });
  // 更正休药天数为 14 → 截止 10-24 覆盖比赛日，原解除作废，跌入候补
  await registry.correctMedication("CHN-2026-001", med.id, { withdrawalDays: 14 });
  board = await registry.getBoard("evt-1");
  assert.equal(board.waitlist.some(r => r.ringNo === "CHN-2026-001"), true);
  const detail = await registry.getPigeonDetail("CHN-2026-001");
  assert.equal(detail.pigeon.medications[0].release, null);
  assert.ok(detail.registrations[0].affectedReasons.includes("medication_corrected"));

  // 完赛后再更正：历史保留（状态不变），仅标记
  await registry.releaseMedication("CHN-2026-001", med.id, { reviewedBy: "裁判丙", reviewDate: "2026-10-24" });
  await registry.finalizeEvent("evt-1");
  const beforeStatus = (await registry.getPigeonDetail("CHN-2026-001")).registrations[0].status;
  await registry.correctMedication("CHN-2026-001", med.id, { withdrawalDays: 20 });
  const after = await registry.getPigeonDetail("CHN-2026-001");
  assert.equal(after.registrations[0].status, beforeStatus);
  const doneBoard = await registry.getBoard("evt-1");
  assert.equal(doneBoard.event.finalized, true);
  assert.equal(doneBoard.rows.length, 1);
  assert.ok(doneBoard.rows[0].affected.reasons.includes("medication_corrected"));
});

test("更正血统立即令报名失效（不占名额不进候补），重新确认后回候补", async () => {
  const { registry } = ctx;
  await registry.register("evt-1", "CHN-2026-001");
  await registry.correctBloodline("CHN-2026-001", { fatherRing: "CHN-2099-999", motherRing: "CHN-2023-512" });
  let board = await registry.getBoard("evt-1");
  assert.equal(board.confirmed.length, 0);
  assert.equal(board.waitlist.length, 0);
  assert.equal(board.invalid.length, 1);
  assert.deepEqual(board.invalid[0].reasons, ["bloodline_unconfirmed"]);
  // 父亲不存在 → 无法重新确认
  await assert.rejects(registry.confirmBloodline("CHN-2026-001", { confirmedBy: "裁判乙" }), expectError("parents_not_registered"));
  // 改回已登记父母并确认 → 回到名额排布（原报名仍生效，不产生重复）
  await registry.correctBloodline("CHN-2026-001", { fatherRing: "CHN-2022-188", motherRing: "CHN-2023-512" });
  await registry.confirmBloodline("CHN-2026-001", { confirmedBy: "裁判乙" });
  board = await registry.getBoard("evt-1");
  assert.equal(board.confirmed[0].ringNo, "CHN-2026-001");
  const disk = await ctx.store.read();
  assert.equal(disk.registrations.filter(r => r.ringNo === "CHN-2026-001" && r.eventId === "evt-1").length, 1);
});

test("更正放飞日：报名资格与历史标记一致刷新", async () => {
  const { registry } = ctx;
  // 用药休药至 10-24
  await registry.addMedication("CHN-2026-001", { drug: "甲硝唑", date: "2026-10-10", withdrawalDays: 14, administeredBy: "教练甲" });
  // 赛事放飞日改到休药期结束之后（10-25）→ 不覆盖，不构成禁赛
  await registry.updateEvent("evt-1", { date: "2026-10-25", quota: 2 });
  await registry.register("evt-1", "CHN-2026-001");
  let board = await registry.getBoard("evt-1");
  assert.equal(board.confirmed[0].ringNo, "CHN-2026-001");
  // 再把放飞日改回 10-18 → 立即重算跌入候补，并标记
  await registry.updateEvent("evt-1", { date: "2026-10-18" });
  board = await registry.getBoard("evt-1");
  assert.equal(board.waitlist[0].ringNo, "CHN-2026-001");
  assert.ok(board.waitlist[0].affected.reasons.includes("race_date_corrected"));
  // 名额收紧到 0 以下不允许
  await assert.rejects(registry.updateEvent("evt-1", { quota: 0 }), expectError("bad_quota"));
});

test("名额、候补、历史在同一快照中一致", async () => {
  const { registry } = ctx;
  // 名额从 2 调整为 1：正式减少、候补增加且排序连续
  await registry.register("evt-1", "CHN-2026-001");
  await registry.createPigeon({ ringNo: "T-9", owner: "棚9", color: "灰", loft: "棚", fatherRing: "CHN-2022-188", motherRing: "CHN-2023-512" });
  await registry.confirmBloodline("T-9", { confirmedBy: "裁判乙" });
  await registry.register("evt-1", "T-9");
  let board = await registry.getBoard("evt-1");
  assert.deepEqual(board.confirmed.map(r => r.ringNo), ["CHN-2026-001", "T-9"]);
  await registry.updateEvent("evt-1", { quota: 1 });
  board = await registry.getBoard("evt-1");
  assert.deepEqual(board.confirmed.map(r => r.ringNo), ["CHN-2026-001"]);
  assert.deepEqual(board.waitlist.map(r => r.ringNo), ["T-9"]);
  assert.equal(board.waitlist[0].waitlistNo, 1);
});

test("完赛后拒绝新报名", async () => {
  const { registry } = ctx;
  await registry.finalizeEvent("evt-1");
  await assert.rejects(registry.register("evt-1", "CHN-2026-001"), expectError("event_finalized"));
});
