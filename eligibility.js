// 资格计算层：只根据数据派生资格与名额排布，不读写任何存储。
// 与“入口（HTTP）”“报名存储（store）”严格分开。

export function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}

// 禁赛截止日 = 用药日 + 休药天数（休药第 N 天结束，次日方可出赛）
export function suspensionEnd(med) {
  return addDays(med.date, med.withdrawalDays);
}

// 该次用药在比赛日是否仍有禁赛效力：窗口覆盖比赛日，且尚未完成有效解除
export function activeOnRaceDay(med, raceDate, reviewer = "") {
  if (med.date > raceDate) return false; // 比赛后才用药，不影响该赛事
  if (suspensionEnd(med) < raceDate) return false; // 休药期在比赛日前已自然结束
  return !isReleased(med, reviewer);
}

export function isReleased(med, reviewer = "") {
  return Boolean(
    med.release &&
      med.release.confirmed &&
      med.release.reviewDate &&
      med.release.reviewDate >= suspensionEnd(med) &&
      med.release.reviewedBy &&
      (!reviewer || med.release.reviewedBy !== reviewer)
  );
}

export function findPigeon(db, ringNo) {
  return db.pigeons.find(item => item.ringNo === ringNo) || null;
}

export function bloodlineReady(db, pigeon) {
  return (
    Boolean(pigeon.fatherRing) &&
    Boolean(pigeon.motherRing) &&
    db.pigeons.some(item => item.ringNo === pigeon.fatherRing) &&
    db.pigeons.some(item => item.ringNo === pigeon.motherRing) &&
    pigeon.bloodlineConfirmed === true
  );
}

// 返回 { eligible, hard: 是否硬性禁报, reasons, blockers }
export function evaluatePigeon(db, pigeon, event, reviewer = "") {
  const reasons = [];
  const blockers = [];

  if (!bloodlineReady(db, pigeon)) {
    reasons.push("bloodline_unconfirmed");
    blockers.push("bloodline_unconfirmed");
  }

  const coveringMeds = pigeon.medications.filter(
    med => med.date <= event.date && suspensionEnd(med) >= event.date
  );
  const activeMeds = coveringMeds.filter(med => activeOnRaceDay(med, event.date, reviewer));
  for (const med of activeMeds) {
    reasons.push("withdrawal_hold");
    blockers.push(`med:${med.id}`);
  }

  const hard = blockers.some(code => code === "bloodline_unconfirmed");
  const eligible = blockers.length === 0;
  const waitlistOnly = !eligible && activeMeds.length > 0 && !hard;
  return {
    eligible,
    hard,
    waitlistOnly,
    reasons: [...new Set(reasons)],
    blockers,
    activeMeds: coveringMeds.map(med => ({
      id: med.id,
      drug: med.drug,
      date: med.date,
      withdrawalDays: med.withdrawalDays,
      suspensionEnd: suspensionEnd(med),
      released: isReleased(med, reviewer),
      release: med.release || null
    }))
  };
}

// 对一场赛事重新排布正式名额与候补顺序，并把结果写回各条报名记录。
// 已完赛（finalized）赛事冻结，不重算；历史保留原样。
export function recalcEvent(db, eventId, reason = "recalc") {
  const event = db.events.find(item => item.id === eventId);
  if (!event) return null;
  if (event.finalized) return planEvent(db, event);

  const plan = planEvent(db, event);
  for (const row of plan.rows) {
    const reg = db.registrations.find(item => item.id === row.regId);
    if (!reg) continue;
    reg.status = row.status;
    reg.slotNo = row.slotNo;
    reg.waitlistNo = row.waitlistNo;
    reg.reasons = row.reasons;
    reg.qualificationVersion = (reg.qualificationVersion || 0) + 1;
    reg.lastRecalcReason = reason;
    reg.lastRecalcAt = new Date().toISOString();
  }
  event.recalcAt = new Date().toISOString();
  return plan;
}

// 纯排布：不写库。返回正式名额/候补/失效三组的一致快照。
export function planEvent(db, event, reviewer = "") {
  const regs = db.registrations
    .filter(reg => reg.eventId === event.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || Number(a.id.split("-").pop()) - Number(b.id.split("-").pop()));

  const rows = [];
  for (const reg of regs) {
    const pigeon = findPigeon(db, reg.ringNo);
    let status;
    let reasons = [];
    let activeMeds = [];
    if (!pigeon) {
      status = "invalid";
      reasons = ["pigeon_missing"];
    } else if (event.finalized) {
      status = reg.status; // 已完赛：保留历史排序，不重判
      reasons = reg.reasons || [];
    } else {
      const q = evaluatePigeon(db, pigeon, event, reviewer);
      reasons = q.reasons;
      activeMeds = q.activeMeds.filter(med => !med.released);
      if (q.hard) status = "invalid";
      else status = "eligible"; // 候补/正式由报名先后 + 名额统一决定
    }
    rows.push({
      regId: reg.id,
      ringNo: reg.ringNo,
      owner: reg.owner,
      pigeon: pigeon ? { ringNo: pigeon.ringNo, owner: pigeon.owner, color: pigeon.color } : null,
      status,
      reasons,
      activeMeds,
      createdAt: reg.createdAt,
      slotNo: null,
      waitlistNo: null,
      affected: reg.affectedReasons?.length
        ? { reasons: reg.affectedReasons, at: reg.affectedAt || null }
        : null,
      finalizedResult: reg.result || null
    });
  }

  if (event.finalized) {
    rows.forEach(row => {
      const reg = regs.find(item => item.id === row.regId);
      row.slotNo = reg.slotNo ?? null;
      row.waitlistNo = reg.waitlistNo ?? null;
    });
    rows.sort((a, b) => (a.slotNo ?? Infinity) - (b.slotNo ?? Infinity) || a.createdAt.localeCompare(b.createdAt));
    return {
      event: { ...event },
      rows,
      confirmed: rows.filter(r => r.status === "confirmed"),
      waitlist: rows.filter(r => r.status === "waitlisted"),
      invalid: rows.filter(r => r.status === "invalid")
    };
  }

  // 失效（血统未确认等硬伤）不占名额、也不进候补排序
  const live = rows.filter(r => r.status !== "invalid");
  const invalid = rows.filter(r => r.status === "invalid");
  // 休药禁赛未解除者只能候补：正式名额只发给无禁赛理由者，按报名先后截取
  const capable = live
    .filter(r => !r.reasons.includes("withdrawal_hold"))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  capable.forEach((row, index) => {
    if (index < event.quota) {
      row.status = "confirmed";
      row.slotNo = index + 1;
    }
  });
  // 候补 = 禁赛未解除者 + 名额外可参赛者，统一按报名时间排队；解除后重算可能升正式
  live
    .filter(r => r.status !== "confirmed")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .forEach((row, index) => {
      row.status = "waitlisted";
      row.waitlistNo = index + 1;
    });
  live
    .filter(r => r.status === "confirmed")
    .sort((a, b) => a.slotNo - b.slotNo);
  return {
    event: { ...event },
    rows,
    confirmed: live.filter(r => r.status === "confirmed"),
    waitlist: live.filter(r => r.status === "waitlisted"),
    invalid
  };
}

// 更正类操作：未结束的赛事让报名/候补立即失效重算；已完赛只标记受影响，历史保留。
export function markAffected(reg, changeType, at = new Date().toISOString()) {
  reg.affectedReasons ??= [];
  if (!reg.affectedReasons.includes(changeType)) reg.affectedReasons.push(changeType);
  reg.affectedAt = at;
}
