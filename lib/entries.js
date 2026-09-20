import { medicationBanUntil, recalculate, toDays } from "./eligibility.js";

export class DomainError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}
const fail = (status, code) => { throw new DomainError(status, code); };
const today = () => new Date().toISOString().slice(0, 10);

function pigeonOf(db, ringNo) {
  const pigeon = db.pigeons.find(item => item.ringNo === ringNo);
  if (!pigeon) fail(404, "pigeon_not_found");
  return pigeon;
}
function eventOf(db, eventId) {
  const event = db.events.find(item => item.id === eventId);
  if (!event) fail(404, "event_not_found");
  return event;
}

export function recalcEvent(db, event) {
  recalculate(event, db.entries.filter(e => e.eventId === event.id), new Map(db.pigeons.map(p => [p.ringNo, p])));
}
export function recalcAll(db) {
  for (const event of db.events) recalcEvent(db, event);
}

// 已完赛历史保留，仅标记受影响
function flagRaces(pigeon, predicate, reason) {
  for (const race of pigeon.races) {
    if (predicate(race)) {
      race.affected = true;
      race.affectedReason = reason;
    }
  }
}

// 报名：同一羽同一赛事只保留一份有效报名，重复或并发请求沿用首次结果。
// 报名时绑定当前鸽主与当前血统/档案版本。
export function enterRace(db, eventId, input) {
  const event = eventOf(db, eventId);
  const pigeon = pigeonOf(db, input.ringNo);
  const existing = db.entries.find(e => e.eventId === event.id && e.ringNo === pigeon.ringNo);
  if (existing) return { entry: existing, deduped: true };
  if (!input.owner || input.owner !== pigeon.owner) fail(409, "owner_mismatch");
  db.counters.entry += 1;
  const entry = {
    id: "EN-" + String(db.counters.entry).padStart(4, "0"),
    eventId: event.id,
    ringNo: pigeon.ringNo,
    owner: pigeon.owner,
    seq: db.counters.entry,
    status: "waitlist",
    waitPos: null,
    banned: false,
    bannedUntil: null,
    reasons: [],
    basis: { pigeonVersion: pigeon.version, eventVersion: event.version },
    createdAt: today()
  };
  db.entries.push(entry);
  recalcEvent(db, event);
  return { entry, deduped: false };
}

export function createEvent(db, input) {
  if (!input.name || !input.date) fail(400, "event_incomplete");
  db.counters.event += 1;
  const event = { id: "EVT-" + db.counters.event, name: input.name, date: input.date, capacity: Math.max(1, Number(input.capacity || 1)), version: 1, createdAt: today() };
  db.events.push(event);
  return event;
}

// 更正放飞日：赛事版本递增，报名与候补立即重算，该赛事已完赛历史标记受影响
export function correctEventDate(db, eventId, input) {
  const event = eventOf(db, eventId);
  if (!input.date) fail(400, "date_required");
  event.date = input.date;
  event.version += 1;
  for (const pigeon of db.pigeons) flagRaces(pigeon, r => r.event === event.name, "放飞日更正");
  recalcEvent(db, event);
  return event;
}

// 登记用药：休药期覆盖比赛日的报名随即失去正式名额
export function addMedication(db, ringNo, input) {
  const pigeon = pigeonOf(db, ringNo);
  if (!input.date || !input.name || !input.recordedBy) fail(400, "medication_incomplete");
  const med = { date: input.date, name: input.name, withdrawalDays: Math.max(0, Number(input.withdrawalDays || 0)), recordedBy: input.recordedBy, lift: null };
  pigeon.medications.push(med);
  pigeon.version += 1;
  flagRaces(pigeon, r => toDays(r.date) >= toDays(med.date), "用药变更");
  recalcAll(db);
  return med;
}

// 更正用药：版本递增、原解除作废需重新复核、报名与候补重算、历史标记受影响
export function correctMedication(db, ringNo, index, input) {
  const pigeon = pigeonOf(db, ringNo);
  const med = pigeon.medications[Number(index)];
  if (!med) fail(404, "medication_not_found");
  if (input.date) med.date = input.date;
  if (input.name) med.name = input.name;
  if (input.withdrawalDays !== undefined && input.withdrawalDays !== null) med.withdrawalDays = Math.max(0, Number(input.withdrawalDays));
  med.lift = null;
  pigeon.version += 1;
  flagRaces(pigeon, r => toDays(r.date) >= toDays(med.date), "用药变更");
  recalcAll(db);
  return med;
}

// 解除禁赛：须另一人复核（复核人 ≠ 录入人），复查日不早于禁赛截止日
export function liftMedication(db, ringNo, index, input) {
  const pigeon = pigeonOf(db, ringNo);
  const med = pigeon.medications[Number(index)];
  if (!med) fail(404, "medication_not_found");
  if (med.lift) fail(409, "already_lifted");
  if (!input.reviewedBy) fail(400, "reviewer_required");
  if (input.reviewedBy === med.recordedBy) fail(409, "reviewer_must_differ");
  const reviewDate = input.reviewDate || today();
  if (toDays(reviewDate) < toDays(medicationBanUntil(med))) fail(400, "review_before_ban_end");
  med.lift = { reviewedBy: input.reviewedBy, reviewDate };
  pigeon.version += 1;
  recalcAll(db);
  return med;
}

export function confirmPedigree(db, ringNo, input) {
  const pigeon = pigeonOf(db, ringNo);
  if (!input.confirmedBy) fail(400, "confirmer_required");
  pigeon.pedigree = { status: "confirmed", confirmedBy: input.confirmedBy, confirmedAt: today(), version: (pigeon.pedigree.version || 0) + 1 };
  pigeon.version += 1;
  recalcAll(db);
  return pigeon.pedigree;
}

// 更正血统：已确认状态作废需重新确认，报名与候补重算，全部已完赛历史标记受影响
export function correctPedigree(db, ringNo, input) {
  const pigeon = pigeonOf(db, ringNo);
  pigeon.fatherRing = input.fatherRing ?? pigeon.fatherRing;
  pigeon.motherRing = input.motherRing ?? pigeon.motherRing;
  pigeon.pedigree = { status: "unconfirmed", confirmedBy: null, confirmedAt: null, version: (pigeon.pedigree.version || 0) + 1 };
  pigeon.version += 1;
  flagRaces(pigeon, () => true, "血统更正");
  recalcAll(db);
  return pigeon;
}

// 名额与候补视图：由同一份存储直接算出，刷新后必然一致
export function eventBoard(db) {
  return db.events.map(event => {
    const entries = db.entries.filter(e => e.eventId === event.id).sort((a, b) => a.seq - b.seq);
    return {
      ...event,
      confirmed: entries.filter(e => e.status === "confirmed"),
      waitlist: entries.filter(e => e.status === "waitlist").sort((a, b) => a.waitPos - b.waitPos)
    };
  });
}
