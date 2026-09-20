import test from "node:test";
import assert from "node:assert/strict";
import {
  addMedication, confirmPedigree, correctEventDate, correctMedication,
  correctPedigree, createEvent, enterRace, eventBoard, liftMedication
} from "../lib/entries.js";

function makePigeon(ringNo, owner, overrides = {}) {
  return {
    ringNo, owner, fatherRing: "", motherRing: "", color: "灰", loft: "1棚",
    vaccines: [], transfers: [], races: [], medications: [],
    pedigree: { status: "confirmed", confirmedBy: "甲", confirmedAt: "2026-01-01", version: 1 },
    version: 1, ...overrides
  };
}
function makeDb(capacity = 1) {
  const db = {
    counters: { event: 0, entry: 0 },
    pigeons: [
      makePigeon("A", "张三", { races: [{ date: "2026-06-01", event: "资格赛", distance: 300, returnTime: "", rank: 1 }] }),
      makePigeon("B", "李四"),
      makePigeon("C", "王五")
    ],
    events: [],
    entries: []
  };
  createEvent(db, { name: "资格赛", date: "2026-10-05", capacity });
  return db;
}
const boardOf = (db, id = "EVT-1") => eventBoard(db).find(e => e.id === id);

test("同一羽同一赛事只保留一份有效报名，重复沿用首次结果", () => {
  const db = makeDb();
  const first = enterRace(db, "EVT-1", { ringNo: "A", owner: "张三" });
  const second = enterRace(db, "EVT-1", { ringNo: "A", owner: "张三" });
  assert.equal(first.deduped, false);
  assert.equal(second.deduped, true);
  assert.equal(second.entry.id, first.entry.id);
  assert.equal(db.entries.length, 1);
});

test("报名须绑定当前鸽主", () => {
  const db = makeDb();
  assert.throws(() => enterRace(db, "EVT-1", { ringNo: "A", owner: "李四" }), /owner_mismatch/);
});

test("名额按首次报名顺序分配，其余候补", () => {
  const db = makeDb(1);
  enterRace(db, "EVT-1", { ringNo: "A", owner: "张三" });
  enterRace(db, "EVT-1", { ringNo: "B", owner: "李四" });
  const board = boardOf(db);
  assert.deepEqual(board.confirmed.map(e => e.ringNo), ["A"]);
  assert.deepEqual(board.waitlist.map(e => [e.ringNo, e.waitPos]), [["B", 1]]);
});

test("休药期覆盖比赛日只能候补，不得占正式名额", () => {
  const db = makeDb(2);
  addMedication(db, "C", { date: "2026-09-10", name: "呼吸道合剂", withdrawalDays: 30, recordedBy: "兽医" });
  enterRace(db, "EVT-1", { ringNo: "C", owner: "王五" });
  enterRace(db, "EVT-1", { ringNo: "A", owner: "张三" });
  const board = boardOf(db);
  const c = board.waitlist.find(e => e.ringNo === "C");
  assert.equal(c.banned, true);
  assert.equal(c.bannedUntil, "2026-10-10");
  assert.ok(c.reasons.includes("withdrawal_active"));
  assert.deepEqual(board.confirmed.map(e => e.ringNo), ["A"]);
});

test("解除须另一人复核且复查日不早于禁赛截止", () => {
  const db = makeDb(2);
  addMedication(db, "C", { date: "2026-09-10", name: "呼吸道合剂", withdrawalDays: 30, recordedBy: "兽医" });
  enterRace(db, "EVT-1", { ringNo: "C", owner: "王五" });
  assert.throws(() => liftMedication(db, "C", 0, { reviewedBy: "兽医", reviewDate: "2026-10-10" }), /reviewer_must_differ/);
  assert.throws(() => liftMedication(db, "C", 0, { reviewedBy: "复核员", reviewDate: "2026-10-09" }), /review_before_ban_end/);
  liftMedication(db, "C", 0, { reviewedBy: "复核员", reviewDate: "2026-10-10" });
  const board = boardOf(db);
  assert.deepEqual(board.confirmed.map(e => e.ringNo), ["C"]);
  assert.throws(() => liftMedication(db, "C", 0, { reviewedBy: "复核员", reviewDate: "2026-10-10" }), /already_lifted/);
});

test("更正血统立即使报名失效重算，已完赛历史保留但标记受影响", () => {
  const db = makeDb(1);
  enterRace(db, "EVT-1", { ringNo: "A", owner: "张三" });
  assert.equal(boardOf(db).confirmed.length, 1);
  correctPedigree(db, "A", { fatherRing: "F-1", motherRing: "M-1" });
  let board = boardOf(db);
  assert.equal(board.confirmed.length, 0);
  assert.ok(board.waitlist[0].reasons.includes("pedigree_unconfirmed"));
  assert.equal(db.pigeons[0].races[0].affected, true);
  assert.equal(db.pigeons[0].races[0].affectedReason, "血统更正");
  assert.equal(db.pigeons[0].races[0].rank, 1); // 历史保留
  confirmPedigree(db, "A", { confirmedBy: "乙" });
  board = boardOf(db);
  assert.deepEqual(board.confirmed.map(e => e.ringNo), ["A"]);
});

test("更正放飞日重算报名与候补，相关历史标记受影响", () => {
  const db = makeDb(1);
  addMedication(db, "A", { date: "2026-09-10", name: "x", withdrawalDays: 30, recordedBy: "兽医" });
  enterRace(db, "EVT-1", { ringNo: "A", owner: "张三" });
  assert.equal(boardOf(db).waitlist[0].banned, true);
  const event = correctEventDate(db, "EVT-1", { date: "2026-11-01" });
  assert.equal(event.version, 2);
  const board = boardOf(db);
  assert.deepEqual(board.confirmed.map(e => e.ringNo), ["A"]); // 禁赛截止 10-10，新放飞日已出休药期
  assert.equal(board.confirmed[0].basis.eventVersion, 2);
  assert.equal(db.pigeons[0].races[0].affected, true);
  assert.equal(db.pigeons[0].races[0].affectedReason, "放飞日更正");
});

test("更正用药后原解除作废，需重新复核", () => {
  const db = makeDb(1);
  addMedication(db, "A", { date: "2026-09-10", name: "x", withdrawalDays: 30, recordedBy: "兽医" });
  liftMedication(db, "A", 0, { reviewedBy: "复核员", reviewDate: "2026-10-10" });
  correctMedication(db, "A", 0, { withdrawalDays: 40 });
  const med = db.pigeons[0].medications[0];
  assert.equal(med.lift, null);
  assert.equal(med.withdrawalDays, 40);
  enterRace(db, "EVT-1", { ringNo: "A", owner: "张三" });
  assert.equal(boardOf(db).waitlist[0].bannedUntil, "2026-10-20");
});
