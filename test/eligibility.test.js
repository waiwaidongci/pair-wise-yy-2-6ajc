import test from "node:test";
import assert from "node:assert/strict";
import { addDays, activeBan, evaluate } from "../lib/eligibility.js";

test("禁赛截止日 = 用药日 + 休药天数", () => {
  assert.equal(addDays("2026-09-10", 30), "2026-10-10");
  assert.equal(addDays("2026-12-30", 3), "2027-01-02");
});

test("休药期覆盖比赛日（含截止日当天）即禁赛，解除后放行", () => {
  const pigeon = { medications: [{ date: "2026-09-10", name: "x", withdrawalDays: 30, recordedBy: "甲", lift: null }] };
  assert.equal(activeBan(pigeon, "2026-10-05").banned, true);
  assert.equal(activeBan(pigeon, "2026-10-10").banned, true);
  assert.equal(activeBan(pigeon, "2026-10-10").bannedUntil, "2026-10-10");
  assert.equal(activeBan(pigeon, "2026-10-11").banned, false);
  pigeon.medications[0].lift = { reviewedBy: "乙", reviewDate: "2026-10-10" };
  assert.equal(activeBan(pigeon, "2026-10-05").banned, false);
});

test("多条用药取最晚禁赛截止", () => {
  const pigeon = {
    medications: [
      { date: "2026-09-01", name: "a", withdrawalDays: 10, recordedBy: "甲", lift: null },
      { date: "2026-09-20", name: "b", withdrawalDays: 20, recordedBy: "甲", lift: null }
    ]
  };
  const ban = activeBan(pigeon, "2026-10-05");
  assert.equal(ban.banned, true);
  assert.equal(ban.bannedUntil, "2026-10-10");
});

test("资格：须血统已确认且不在禁赛期", () => {
  const event = { date: "2026-10-05" };
  const ok = { medications: [], pedigree: { status: "confirmed" } };
  assert.equal(evaluate(ok, event).eligible, true);
  const noPed = { medications: [], pedigree: { status: "unconfirmed" } };
  assert.deepEqual(evaluate(noPed, event).reasons, ["pedigree_unconfirmed"]);
  const banned = { medications: [{ date: "2026-09-30", name: "x", withdrawalDays: 10, recordedBy: "甲", lift: null }], pedigree: { status: "confirmed" } };
  assert.deepEqual(evaluate(banned, event).reasons, ["withdrawal_active"]);
});
