// 资格计算：纯函数，不触碰存储。
// 禁赛截止日 = 用药日 + 休药天数；休药期覆盖比赛日（含截止日当天）即禁赛。

export function toDays(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

export function toDateStr(days) {
  return new Date(days * 86400000).toISOString().slice(0, 10);
}

export function addDays(dateStr, days) {
  return toDateStr(toDays(dateStr) + Number(days || 0));
}

// 单条用药记录的禁赛截止日
export function medicationBanUntil(med) {
  return addDays(med.date, med.withdrawalDays);
}

// 比赛日仍生效的禁赛：休药期覆盖比赛日且未经复核解除
export function activeBan(pigeon, raceDate) {
  let bannedUntil = null;
  let source = null;
  for (const med of pigeon.medications || []) {
    if (med.lift) continue;
    const until = medicationBanUntil(med);
    if (toDays(raceDate) <= toDays(until) && (!bannedUntil || toDays(until) > toDays(bannedUntil))) {
      bannedUntil = until;
      source = med;
    }
  }
  return { banned: Boolean(bannedUntil), bannedUntil, source };
}

// 单羽单项赛事的资格：血统已确认 + 不在禁赛期
export function evaluate(pigeon, event) {
  const reasons = [];
  const pedigreeOk = Boolean(pigeon.pedigree && pigeon.pedigree.status === "confirmed");
  if (!pedigreeOk) reasons.push("pedigree_unconfirmed");
  const ban = activeBan(pigeon, event.date);
  if (ban.banned) reasons.push("withdrawal_active");
  return { eligible: pedigreeOk && !ban.banned, pedigreeOk, banned: ban.banned, bannedUntil: ban.bannedUntil, reasons };
}

// 重算某赛事的全部报名：按首次报名顺序分配正式名额，其余进候补。
// 禁赛未解除或血统未确认者只能候补，不得占正式名额。
export function recalculate(event, entries, pigeonsByRing) {
  const ordered = [...entries].sort((a, b) => a.seq - b.seq);
  let slots = Number(event.capacity);
  let waitPos = 0;
  for (const entry of ordered) {
    const pigeon = pigeonsByRing.get(entry.ringNo);
    const result = pigeon
      ? evaluate(pigeon, event)
      : { eligible: false, banned: false, bannedUntil: null, reasons: ["pigeon_missing"] };
    entry.banned = result.banned;
    entry.bannedUntil = result.bannedUntil;
    entry.reasons = result.reasons;
    if (result.eligible && slots > 0) {
      entry.status = "confirmed";
      entry.waitPos = null;
      slots -= 1;
    } else {
      entry.status = "waitlist";
      waitPos += 1;
      entry.waitPos = waitPos;
    }
    entry.basis = { pigeonVersion: pigeon ? pigeon.version : null, eventVersion: event.version };
  }
  return ordered;
}
