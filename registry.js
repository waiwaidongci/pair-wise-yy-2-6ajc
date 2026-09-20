// 报名与休药期复核服务：编排“资格计算”与“存储”，HTTP 入口只做参数搬运。
import {
  addDays,
  suspensionEnd,
  isReleased,
  findPigeon,
  bloodlineReady,
  evaluatePigeon,
  recalcEvent,
  planEvent,
  markAffected
} from "./eligibility.js";
import { createStore } from "./store.js";

export class DomainError extends Error {
  constructor(code, status = 400, extra = {}) {
    super(code);
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

const today = () => new Date().toISOString().slice(0, 10);

function requireEvent(db, eventId) {
  const event = db.events.find(item => item.id === eventId);
  if (!event) throw new DomainError("event_not_found", 404);
  return event;
}
function requirePigeon(db, ringNo) {
  const pigeon = findPigeon(db, ringNo);
  if (!pigeon) throw new DomainError("pigeon_not_found", 404);
  return pigeon;
}
function regsOfPigeon(db, ringNo) {
  return db.registrations.filter(reg => reg.ringNo === ringNo);
}
function touchEvent(db, eventId, reason) {
  recalcEvent(db, eventId, reason);
  return planEvent(db, db.events.find(item => item.id === eventId));
}

export function createRegistry(store = createStore()) {
  // 同一羽同一赛事的并发报名共用同一个 Promise：重复或并发沿用首次结果
  const inflight = new Map();

  // ---------- 鸽只档案 ----------
  function createPigeon(input) {
    return store.mutate(db => {
      if (!input.ringNo || !input.owner || !input.color || !input.loft) {
        throw new DomainError("missing_fields", 400);
      }
      if (db.pigeons.some(item => item.ringNo === input.ringNo)) {
        throw new DomainError("ring_exists", 409);
      }
      const pigeon = {
        ringNo: input.ringNo,
        owner: input.owner,
        fatherRing: input.fatherRing || "",
        motherRing: input.motherRing || "",
        color: input.color,
        loft: input.loft,
        bloodlineConfirmed: false,
        vaccines: [],
        transfers: [],
        races: [],
        medications: []
      };
      db.pigeons.unshift(pigeon);
      return pigeon;
    });
  }

  function transfer(ringNo, input) {
    return store.mutate(db => {
      const pigeon = requirePigeon(db, ringNo);
      if (!input.to) throw new DomainError("missing_to", 400);
      pigeon.transfers.push({ date: input.date || today(), from: pigeon.owner, to: input.to });
      pigeon.owner = input.to;
      // 新鸽主信息变更：其名下报名绑定的仍是报名时鸽主，现有报名资格不因此失效
      return pigeon;
    });
  }

  function addRaceResult(ringNo, input) {
    return store.mutate(db => {
      const pigeon = requirePigeon(db, ringNo);
      pigeon.races.push({
        date: input.date || today(),
        event: input.event,
        distance: Number(input.distance || 0),
        returnTime: input.returnTime || "",
        rank: Number(input.rank || 0)
      });
      return pigeon;
    });
  }

  function addVaccine(ringNo, input) {
    return store.mutate(db => {
      const pigeon = requirePigeon(db, ringNo);
      pigeon.vaccines.push({ date: input.date || today(), name: input.name });
      return pigeon;
    });
  }

  // 更正血统（父母足环）：立即令确认失效，相关报名/候补重算或标记
  function correctBloodline(ringNo, input) {
    return store.mutate(db => {
      const pigeon = requirePigeon(db, ringNo);
      pigeon.fatherRing = input.fatherRing ?? pigeon.fatherRing;
      pigeon.motherRing = input.motherRing ?? pigeon.motherRing;
      pigeon.bloodlineConfirmed = false;
      delete pigeon.bloodlineConfirmedBy;
      const at = new Date().toISOString();
      const boards = [];
      for (const reg of regsOfPigeon(db, ringNo)) {
        markAffected(reg, "bloodline_corrected", at);
        const event = db.events.find(item => item.id === reg.eventId);
        if (!event) continue;
        if (!event.finalized) recalcEvent(db, event.id, "bloodline_corrected");
        boards.push(event.id);
      }
      return {
        pigeon,
        boards: [...new Set(boards)].map(id => planEvent(db, db.events.find(item => item.id === id)))
      };
    });
  }

  // 血统确认（报名前置条件之一）
  function confirmBloodline(ringNo, input) {
    return store.mutate(db => {
      const pigeon = requirePigeon(db, ringNo);
      const parentsKnown =
        Boolean(pigeon.fatherRing) &&
        Boolean(pigeon.motherRing) &&
        db.pigeons.some(item => item.ringNo === pigeon.fatherRing) &&
        db.pigeons.some(item => item.ringNo === pigeon.motherRing);
      if (!parentsKnown) throw new DomainError("parents_not_registered", 400);
      if (!input.confirmedBy) throw new DomainError("missing_confirmer", 400);
      pigeon.bloodlineConfirmed = true;
      pigeon.bloodlineConfirmedBy = input.confirmedBy;
      const boards = [];
      for (const eventId of new Set(regsOfPigeon(db, ringNo).map(reg => reg.eventId))) {
        const event = db.events.find(item => item.id === eventId);
        if (event && !event.finalized) recalcEvent(db, eventId, "bloodline_confirmed");
        boards.push(eventId);
      }
      return {
        pigeon,
        boards: [...new Set(boards)].map(id => planEvent(db, db.events.find(item => item.id === id)))
      };
    });
  }

  // ---------- 用药与休药期 ----------
  function addMedication(ringNo, input) {
    return store.mutate(db => {
      const pigeon = requirePigeon(db, ringNo);
      if (!input.drug || !input.date || input.withdrawalDays === undefined) {
        throw new DomainError("missing_medication_fields", 400);
      }
      const withdrawalDays = Number(input.withdrawalDays);
      if (!Number.isInteger(withdrawalDays) || withdrawalDays < 0) {
        throw new DomainError("bad_withdrawal_days", 400);
      }
      const med = {
        id: store.nextId(db, "medication", "med"),
        drug: input.drug,
        date: input.date,
        withdrawalDays,
        administeredBy: input.administeredBy || "",
        correctedAt: null,
        release: null
      };
      pigeon.medications.push(med);
      const at = new Date().toISOString();
      const boards = [];
      for (const reg of regsOfPigeon(db, ringNo)) {
        const event = db.events.find(item => item.id === reg.eventId);
        if (!event) continue;
        markAffected(reg, "medication_added", at);
        if (!event.finalized) recalcEvent(db, event.id, "medication_added");
        boards.push(event.id);
      }
      return {
        medication: med,
        suspensionEnd: suspensionEnd(med),
        boards: [...new Set(boards)].map(id => planEvent(db, db.events.find(item => item.id === id)))
      };
    });
  }

  // 更正用药：解除作废、休药截止重算，报名/候补立即失效重算，历史标记
  function correctMedication(ringNo, medId, input) {
    return store.mutate(db => {
      const pigeon = requirePigeon(db, ringNo);
      const med = pigeon.medications.find(item => item.id === medId);
      if (!med) throw new DomainError("medication_not_found", 404);
      if (input.drug !== undefined) med.drug = input.drug;
      if (input.date !== undefined) med.date = input.date;
      if (input.withdrawalDays !== undefined) {
        const days = Number(input.withdrawalDays);
        if (!Number.isInteger(days) || days < 0) throw new DomainError("bad_withdrawal_days", 400);
        med.withdrawalDays = days;
      }
      med.correctedAt = new Date().toISOString();
      med.release = null; // 更正后原解除作废，须另一人重新复核
      const at = med.correctedAt;
      const boards = [];
      for (const reg of regsOfPigeon(db, ringNo)) {
        const event = db.events.find(item => item.id === reg.eventId);
        if (!event) continue;
        markAffected(reg, "medication_corrected", at);
        if (!event.finalized) recalcEvent(db, event.id, "medication_corrected");
        boards.push(event.id);
      }
      return {
        medication: med,
        suspensionEnd: suspensionEnd(med),
        boards: [...new Set(boards)].map(id => planEvent(db, db.events.find(item => item.id === id)))
      };
    });
  }

  // 解除休药禁赛：必须另一人复核，复查日不早于禁赛截止
  function releaseMedication(ringNo, medId, input) {
    return store.mutate(db => {
      const pigeon = requirePigeon(db, ringNo);
      const med = pigeon.medications.find(item => item.id === medId);
      if (!med) throw new DomainError("medication_not_found", 404);
      if (!input.reviewedBy) throw new DomainError("missing_reviewer", 400);
      if (med.administeredBy && input.reviewedBy === med.administeredBy) {
        throw new DomainError("reviewer_must_differ", 409);
      }
      const end = suspensionEnd(med);
      const reviewDate = input.reviewDate || today();
      if (reviewDate < end) throw new DomainError("review_before_suspension_end", 409, { suspensionEnd: end });
      med.release = {
        reviewedBy: input.reviewedBy,
        reviewDate,
        confirmed: true,
        releasedAt: new Date().toISOString()
      };
      const boards = [];
      for (const eventId of new Set(regsOfPigeon(db, ringNo).map(reg => reg.eventId))) {
        const event = db.events.find(item => item.id === eventId);
        if (!event || event.finalized) continue;
        recalcEvent(db, eventId, "medication_released");
        boards.push(eventId);
      }
      return {
        medication: med,
        suspensionEnd: end,
        boards: [...new Set(boards)].map(id => planEvent(db, db.events.find(item => item.id === id)))
      };
    });
  }

  // ---------- 赛事 ----------
  function createEvent(input) {
    return store.mutate(db => {
      if (!input.name || !input.date || input.quota === undefined) {
        throw new DomainError("missing_event_fields", 400);
      }
      const quota = Number(input.quota);
      if (!Number.isInteger(quota) || quota < 1) throw new DomainError("bad_quota", 400);
      const event = {
        id: store.nextId(db, "event", "evt"),
        name: input.name,
        date: input.date,
        distance: Number(input.distance || 0),
        quota,
        finalized: false
      };
      db.events.unshift(event);
      return event;
    });
  }

  // 更正赛事：放飞日/名额变化令报名与候补立即重算；已完赛仅标记受影响
  function updateEvent(eventId, input) {
    return store.mutate(db => {
      const event = requireEvent(db, eventId);
      const dateChanged = input.date !== undefined && input.date !== event.date;
      const quotaChanged = input.quota !== undefined && Number(input.quota) !== event.quota;
      if (input.quota !== undefined) {
        const quota = Number(input.quota);
        if (!Number.isInteger(quota) || quota < 1) throw new DomainError("bad_quota", 400);
        event.quota = quota;
      }
      if (input.name !== undefined) event.name = input.name;
      if (input.distance !== undefined) event.distance = Number(input.distance);
      if (dateChanged) event.date = input.date;
      const at = new Date().toISOString();
      const affectedRegs = db.registrations.filter(reg => reg.eventId === eventId);
      if (dateChanged) affectedRegs.forEach(reg => markAffected(reg, "race_date_corrected", at));
      if (quotaChanged) affectedRegs.forEach(reg => markAffected(reg, "quota_corrected", at));
      if (!event.finalized && (dateChanged || quotaChanged)) {
        recalcEvent(db, eventId, dateChanged ? "race_date_corrected" : "quota_corrected");
      }
      return { board: planEvent(db, event), affected: affectedRegs.map(reg => ({ id: reg.id, affectedReasons: reg.affectedReasons })) };
    });
  }

  // 完赛封存：历史保留，之后改动只标记不重排
  function finalizeEvent(eventId, input = {}) {
    return store.mutate(db => {
      const event = requireEvent(db, eventId);
      if (event.finalized) throw new DomainError("event_already_finalized", 409);
      // 完赛前按最新资格定格一次
      recalcEvent(db, eventId, "finalize");
      event.finalized = true;
      event.finalizedAt = new Date().toISOString();
      if (input.results && Array.isArray(input.results)) {
        for (const item of input.results) {
          const reg = db.registrations.find(reg => reg.eventId === eventId && reg.ringNo === item.ringNo);
          if (reg) reg.result = { rank: Number(item.rank || 0), returnTime: item.returnTime || "" };
        }
      }
      return planEvent(db, event);
    });
  }

  // ---------- 报名 ----------
  function register(eventId, ringNo, input = {}) {
    const key = `${eventId}|${ringNo}`;
    const running = inflight.get(key);
    if (running) return running; // 并发：沿用首次结果
    const promise = store
      .mutate(db => {
        const event = requireEvent(db, eventId);
        const pigeon = requirePigeon(db, ringNo);
        if (event.finalized) throw new DomainError("event_finalized", 409);

        // 同一羽同一赛事只保留一份有效报名：重复报名直接沿用首次结果
        const existing = db.registrations.find(reg => reg.eventId === eventId && reg.ringNo === ringNo);
        if (existing) {
          return { created: false, registration: existing, board: planEvent(db, event) };
        }

        if (!bloodlineReady(db, pigeon)) throw new DomainError("bloodline_unconfirmed", 400);

        const reg = {
          id: store.nextId(db, "registration", "reg"),
          eventId,
          ringNo,
          owner: pigeon.owner, // 绑定报名时当前鸽主
          ownerHistory: pigeon.transfers.map(t => ({ date: t.date, from: t.from, to: t.to })),
          bloodlineConfirmedBy: pigeon.bloodlineConfirmedBy || "系统补认",
          createdAt: new Date().toISOString(),
          status: "waitlisted",
          slotNo: null,
          waitlistNo: null,
          reasons: [],
          qualificationVersion: 1,
          affectedReasons: [],
          result: null
        };
        db.registrations.push(reg);
        recalcEvent(db, eventId, "registered");
        return { created: true, registration: reg, board: planEvent(db, event) };
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
  }

  // ---------- 查询（只读快照，名额/候补/历史同源刷新后一致） ----------
  async function getBoard(eventId) {
    const db = await store.read();
    const event = requireEvent(db, eventId);
    return planEvent(db, event);
  }

  async function listEvents() {
    const db = await store.read();
    return db.events.map(event => {
      const plan = planEvent(db, event);
      return {
        ...event,
        counts: {
          confirmed: plan.confirmed.length,
          waitlisted: plan.waitlist.length,
          invalid: plan.invalid.length,
          total: plan.rows.length
        }
      };
    });
  }

  async function listPigeons() {
    const db = await store.read();
    return db.pigeons;
  }

  async function getPigeonDetail(ringNo) {
    const db = await store.read();
    const pigeon = findPigeon(db, ringNo);
    if (!pigeon) throw new DomainError("pigeon_not_found", 404);
    const father = db.pigeons.find(item => item.ringNo === pigeon.fatherRing) || null;
    const mother = db.pigeons.find(item => item.ringNo === pigeon.motherRing) || null;
    const children = db.pigeons.filter(item => item.fatherRing === ringNo || item.motherRing === ringNo);
    const registrations = db.registrations
      .filter(reg => reg.ringNo === ringNo)
      .map(reg => {
        const event = db.events.find(item => item.id === reg.eventId);
        return {
          ...reg,
          eventName: event ? event.name : null,
          eventDate: event ? event.date : null,
          qualification: event
            ? evaluatePigeon(db, pigeon, event).activeMeds.map(med => ({
                drug: med.drug,
                suspensionEnd: med.suspensionEnd,
                released: med.released
              }))
            : []
        };
      });
    return { pigeon, father, mother, children, registrations };
  }

  return {
    createPigeon,
    transfer,
    addRaceResult,
    addVaccine,
    correctBloodline,
    confirmBloodline,
    addMedication,
    correctMedication,
    releaseMedication,
    createEvent,
    updateEvent,
    finalizeEvent,
    register,
    getBoard,
    listEvents,
    listPigeons,
    getPigeonDetail,
    _internal: { addDays, suspensionEnd, isReleased, evaluatePigeon, planEvent, recalcEvent }
  };
}
