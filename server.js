import http from "node:http";
import { readDb, transact } from "./lib/store.js";
import {
  addMedication, confirmPedigree, correctEventDate, correctMedication,
  correctPedigree, createEvent, enterRace, eventBoard, liftMedication
} from "./lib/entries.js";

const port = Number(process.env.PORT || 3024);

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("invalid_json"), { status: 400 });
  }
}
function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function relation(db, ringNo) {
  const pigeon = db.pigeons.find(item => item.ringNo === ringNo);
  if (!pigeon) return null;
  const father = db.pigeons.find(item => item.ringNo === pigeon.fatherRing) || null;
  const mother = db.pigeons.find(item => item.ringNo === pigeon.motherRing) || null;
  const children = db.pigeons.filter(item => item.fatherRing === ringNo || item.motherRing === ringNo);
  return { pigeon, father, mother, children };
}

const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>赛鸽登记站 · 参赛报名与休药期复核台</title>
  <style>
    :root { --bg:#eff2f5; --panel:#fff; --ink:#1f2833; --muted:#697786; --line:#d3dce4; --accent:#315f83; --red:#9b3f35; --green:#2f7d4f; --amber:#a06a00; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:#fff; border:1px solid var(--line); border-radius:8px; padding:16px; } h2 { margin:0 0 12px; font-size:18px; }
    h3 { margin:0; } h4 { margin:8px 0 6px; font-size:14px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; margin-bottom:6px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:9px 13px; font-weight:700; cursor:pointer; margin:2px 4px 2px 0; }
    .toolbar { display:grid; grid-template-columns:1fr auto; gap:10px; margin-bottom:14px; } .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:12px; }
    .card { display:grid; gap:6px; align-content:start; } .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .pill.ok { color:var(--green); border-color:var(--green); } .pill.warn { color:var(--amber); border-color:var(--amber); }
    .section { margin-top:14px; } .relation { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-bottom:14px; } .small { background:#f8fafb; border:1px solid var(--line); border-radius:8px; padding:10px; margin-bottom:6px; }
    .event { margin-bottom:12px; } .eventHead { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:8px; }
    .enter { display:grid; grid-template-columns:1fr 1fr auto; gap:8px; align-items:center; } .enter input { margin-bottom:0; }
    .cols { display:grid; grid-template-columns:1fr 1fr; gap:12px; } .cols ol { margin:0; padding-left:20px; } .cols li { margin-bottom:4px; }
    .side { display:grid; gap:16px; align-content:start; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} .relation,.cols,.enter{grid-template-columns:1fr;} }
  </style>
</head>
<body>
  <header><div><h1>赛鸽登记站 · 参赛报名与休药期复核台</h1><div class="meta">档案、血统、转让、归巢成绩 · 赛事名额、候补与休药期复核</div></div><button id="reload">刷新</button></header>
  <main>
    <div class="side">
      <form id="form">
        <h2>创建鸽只档案</h2>
        <label>足环号</label><input name="ringNo" required>
        <label>鸽主</label><input name="owner" required>
        <label>父鸽足环号</label><input name="fatherRing">
        <label>母鸽足环号</label><input name="motherRing">
        <label>羽色</label><input name="color" required>
        <label>出生棚号</label><input name="loft" required>
        <button>保存档案</button>
      </form>
      <form id="eventForm">
        <h2>创建赛事</h2>
        <label>赛事名称</label><input name="name" required>
        <label>放飞日</label><input name="date" type="date" required>
        <label>正式名额</label><input name="capacity" type="number" min="1" value="2" required>
        <button>保存赛事</button>
      </form>
    </div>
    <section>
      <div class="toolbar"><input id="search" placeholder="输入足环号查询血统"><button id="searchBtn">查询</button></div>
      <div class="panel" id="detail"></div>
      <h2 class="section">赛事报名与名额</h2>
      <div class="section" id="events" style="margin-top:8px"></div>
      <h2 class="section">鸽只档案</h2>
      <div class="section grid" id="cards" style="margin-top:8px"></div>
    </section>
  </main>
  <script>
    const form = document.querySelector("#form");
    const eventForm = document.querySelector("#eventForm");
    const cards = document.querySelector("#cards");
    const eventsEl = document.querySelector("#events");
    const detail = document.querySelector("#detail");
    const search = document.querySelector("#search");
    const REASONS = { pedigree_unconfirmed: "血统未确认", withdrawal_active: "休药期未解除", pigeon_missing: "档案缺失" };
    let pigeons = [];
    let boards = [];
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ "Content-Type":"application/json" } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "请求失败");
      return data;
    }
    async function run(fn) { try { await fn(); await load(); } catch (error) { alert(error.message); } }
    function addDays(dateStr, days) {
      const d = new Date(dateStr + "T00:00:00Z");
      d.setUTCDate(d.getUTCDate() + Number(days || 0));
      return d.toISOString().slice(0, 10);
    }
    function val(sel) { const el = document.querySelector(sel); return el ? el.value.trim() : ""; }
    function reasonText(entry) {
      const parts = (entry.reasons || []).map(r => REASONS[r] || r);
      if (entry.banned && entry.bannedUntil) parts.push("禁赛至 " + entry.bannedUntil);
      if (!parts.length && entry.status === "waitlist") parts.push("名额已满");
      return parts.join("；");
    }
    function renderEvents() {
      eventsEl.innerHTML = boards.map(ev =>
        '<div class="panel event"><div class="eventHead"><h3>' + ev.name + '</h3>'
        + '<span class="pill">放飞日 ' + ev.date + '</span>'
        + '<span class="pill">正式名额 ' + ev.confirmed.length + '/' + ev.capacity + '</span>'
        + '<button data-evdate="' + ev.id + '">更正放飞日</button></div>'
        + '<div class="enter"><input data-en-ring="' + ev.id + '" placeholder="足环号"><input data-en-owner="' + ev.id + '" placeholder="当前鸽主（须与档案一致）"><button data-enter="' + ev.id + '">报名</button></div>'
        + '<div class="cols"><div><h4>正式名额</h4><ol>'
        + (ev.confirmed.map(e => '<li>' + e.ringNo + ' · ' + e.owner + '</li>').join("") || '<li class="meta">空缺</li>')
        + '</ol></div><div><h4>候补</h4><ol>'
        + (ev.waitlist.map(e => '<li>' + e.ringNo + ' · ' + e.owner + ' <span class="meta">' + reasonText(e) + '</span></li>').join("") || '<li class="meta">暂无</li>')
        + '</ol></div></div></div>'
      ).join("") || '<div class="panel meta">暂无赛事，请先在左侧创建。</div>';
      document.querySelectorAll("[data-enter]").forEach(btn => btn.onclick = () => run(async () => {
        const id = btn.dataset.enter;
        const result = await api('/api/events/' + id + '/entries', { method:'POST', body: JSON.stringify({ ringNo: val('[data-en-ring="' + id + '"]'), owner: val('[data-en-owner="' + id + '"]') }) });
        if (result.deduped) alert("已存在有效报名，沿用首次结果 " + result.entry.id);
        else if (result.entry.status === "waitlist") alert("已登记为候补：" + reasonText(result.entry));
      }));
      document.querySelectorAll("[data-evdate]").forEach(btn => btn.onclick = () => run(async () => {
        const ev = boards.find(item => item.id === btn.dataset.evdate);
        const date = prompt("新的放飞日（YYYY-MM-DD）", ev.date);
        if (!date) return;
        await api('/api/events/' + ev.id, { method:'PATCH', body: JSON.stringify({ date }) });
      }));
    }
    function medBlock(p) {
      if (!p.medications.length) return '<div class="meta">暂无用药</div>';
      return p.medications.map((m, i) => {
        const key = p.ringNo + ':' + i;
        return '<div class="small">' + m.date + ' ' + m.name + ' · 休药' + m.withdrawalDays + '天 · 禁赛至 ' + addDays(m.date, m.withdrawalDays)
          + '<br>录入：' + m.recordedBy + ' '
          + (m.lift
            ? '<span class="pill ok">已解除 · ' + m.lift.reviewedBy + ' · ' + m.lift.reviewDate + '</span>'
            : '<br><input data-lift-by="' + key + '" placeholder="复核人（须非录入人）"><input data-lift-date="' + key + '" type="date"><button data-lift="' + key + '">复核解除</button>')
          + ' <button data-medcorr="' + key + '">更正用药</button></div>';
      }).join("");
    }
    function renderCards() {
      cards.innerHTML = pigeons.map(p =>
        '<article class="card"><h3>' + p.ringNo + '</h3><span class="pill">' + p.owner + '</span>'
        + '<div class="meta">' + p.color + ' · ' + p.loft + '</div>'
        + '<div>父：' + (p.fatherRing || "未登记") + '</div><div>母：' + (p.motherRing || "未登记") + '</div>'
        + '<div>血统：' + (p.pedigree && p.pedigree.status === "confirmed"
            ? '<span class="pill ok">已确认 · ' + p.pedigree.confirmedBy + '</span>'
            : '<span class="pill warn">未确认</span>') + '</div>'
        + '<input data-confirmer="' + p.ringNo + '" placeholder="血统确认人"><div><button data-confirm="' + p.ringNo + '">确认血统</button><button data-pedcorr="' + p.ringNo + '">更正血统</button></div>'
        + '<label>用药与休药期</label>' + medBlock(p)
        + '<input data-med-date="' + p.ringNo + '" type="date"><input data-med-name="' + p.ringNo + '" placeholder="药品名">'
        + '<input data-med-days="' + p.ringNo + '" type="number" min="0" placeholder="休药天数"><input data-med-by="' + p.ringNo + '" placeholder="录入人">'
        + '<button data-med="' + p.ringNo + '">登记用药</button>'
        + '<label>录入转让</label><input data-to="' + p.ringNo + '" placeholder="新归属人"><button data-transfer="' + p.ringNo + '">保存转让</button>'
        + '<label>归巢成绩</label><input data-race="' + p.ringNo + '" placeholder="赛事/距离/名次，如200公里/200/6"><button data-score="' + p.ringNo + '">保存成绩</button>'
        + '<div class="meta">历史：' + (p.races.map(r => r.event + ' 第' + r.rank + '名' + (r.affected ? '（受影响·' + r.affectedReason + '）' : '')).join(' / ') || '暂无') + '</div>'
        + '</article>'
      ).join("");
      document.querySelectorAll("[data-transfer]").forEach(btn => btn.onclick = () => run(async () => {
        const ringNo = btn.dataset.transfer;
        await api('/api/pigeons/' + encodeURIComponent(ringNo) + '/transfers', { method:'POST', body: JSON.stringify({ to: val('[data-to="' + ringNo + '"]') }) });
      }));
      document.querySelectorAll("[data-score]").forEach(btn => btn.onclick = () => run(async () => {
        const ringNo = btn.dataset.score; const raw = val('[data-race="' + ringNo + '"]').split("/");
        await api('/api/pigeons/' + encodeURIComponent(ringNo) + '/races', { method:'POST', body: JSON.stringify({ event: raw[0] || "未命名赛事", distance: Number(raw[1] || 0), rank: Number(raw[2] || 0) }) });
      }));
      document.querySelectorAll("[data-confirm]").forEach(btn => btn.onclick = () => run(async () => {
        const ringNo = btn.dataset.confirm;
        await api('/api/pigeons/' + encodeURIComponent(ringNo) + '/pedigree/confirm', { method:'POST', body: JSON.stringify({ confirmedBy: val('[data-confirmer="' + ringNo + '"]') }) });
      }));
      document.querySelectorAll("[data-pedcorr]").forEach(btn => btn.onclick = () => run(async () => {
        const ringNo = btn.dataset.pedcorr;
        const p = pigeons.find(item => item.ringNo === ringNo);
        const fatherRing = prompt("父鸽足环号", p.fatherRing || ""); if (fatherRing === null) return;
        const motherRing = prompt("母鸽足环号", p.motherRing || ""); if (motherRing === null) return;
        await api('/api/pigeons/' + encodeURIComponent(ringNo) + '/pedigree', { method:'PATCH', body: JSON.stringify({ fatherRing, motherRing }) });
      }));
      document.querySelectorAll("[data-med]").forEach(btn => btn.onclick = () => run(async () => {
        const ringNo = btn.dataset.med;
        await api('/api/pigeons/' + encodeURIComponent(ringNo) + '/medications', { method:'POST', body: JSON.stringify({
          date: val('[data-med-date="' + ringNo + '"]'), name: val('[data-med-name="' + ringNo + '"]'),
          withdrawalDays: Number(val('[data-med-days="' + ringNo + '"]') || 0), recordedBy: val('[data-med-by="' + ringNo + '"]')
        }) });
      }));
      document.querySelectorAll("[data-lift]").forEach(btn => btn.onclick = () => run(async () => {
        const parts = btn.dataset.lift.split(":"); const idx = parts.pop(); const ringNo = parts.join(":");
        await api('/api/pigeons/' + encodeURIComponent(ringNo) + '/medications/' + idx + '/lift', { method:'POST', body: JSON.stringify({
          reviewedBy: val('[data-lift-by="' + btn.dataset.lift + '"]'), reviewDate: val('[data-lift-date="' + btn.dataset.lift + '"]') || undefined
        }) });
      }));
      document.querySelectorAll("[data-medcorr]").forEach(btn => btn.onclick = () => run(async () => {
        const parts = btn.dataset.medcorr.split(":"); const idx = parts.pop(); const ringNo = parts.join(":");
        const m = pigeons.find(item => item.ringNo === ringNo).medications[Number(idx)];
        const date = prompt("用药日期", m.date); if (!date) return;
        const days = prompt("休药天数", String(m.withdrawalDays)); if (days === null) return;
        await api('/api/pigeons/' + encodeURIComponent(ringNo) + '/medications/' + idx, { method:'PATCH', body: JSON.stringify({ date, withdrawalDays: Number(days) }) });
      }));
    }
    function renderRelation(data) {
      if (!data) { detail.innerHTML = '<h2>血统查询</h2><p class="meta">请输入足环号查看父母、子代、转让、用药和成绩。</p>'; return; }
      const p = data.pigeon;
      detail.innerHTML = '<h2>' + p.ringNo + ' 血统档案</h2>'
        + '<div class="relation"><div class="small"><b>父鸽</b><br>' + (data.father ? data.father.ringNo : p.fatherRing || "未登记") + '</div>'
        + '<div class="small"><b>本鸽</b><br>' + p.owner + ' · ' + p.color + '</div>'
        + '<div class="small"><b>母鸽</b><br>' + (data.mother ? data.mother.ringNo : p.motherRing || "未登记") + '</div></div>'
        + '<div><b>子代</b> ' + (data.children.map(c => c.ringNo).join("、") || "暂无") + '</div>'
        + '<div class="meta">转让：' + (p.transfers.map(t => t.from + "→" + t.to).join(" / ") || "暂无") + '</div>'
        + '<div class="meta">用药：' + (p.medications.map(m => m.date + " " + m.name + " 禁赛至" + addDays(m.date, m.withdrawalDays) + (m.lift ? "（已解除）" : "")).join(" / ") || "暂无") + '</div>'
        + '<div class="meta">归巢：' + (p.races.map(r => r.event + " 第" + r.rank + "名" + (r.affected ? "（受影响·" + r.affectedReason + "）" : "")).join(" / ") || "暂无") + '</div>';
    }
    async function load() {
      const results = await Promise.all([api("/api/pigeons"), api("/api/events")]);
      pigeons = results[0]; boards = results[1];
      renderEvents(); renderCards(); renderRelation(null);
    }
    document.querySelector("#searchBtn").onclick = () => run(async () => renderRelation(await api('/api/pigeons/' + encodeURIComponent(search.value) + '/relation')));
    document.querySelector("#reload").onclick = load;
    form.onsubmit = event => { event.preventDefault(); run(async () => {
      await api("/api/pigeons", { method:"POST", body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
      form.reset();
    }); };
    eventForm.onsubmit = event => { event.preventDefault(); run(async () => {
      await api("/api/events", { method:"POST", body: JSON.stringify(Object.fromEntries(new FormData(eventForm).entries())) });
      eventForm.reset();
    }); };
    load();
  </script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(page);
    }
    if (req.method === "GET" && url.pathname === "/api/pigeons") return sendJson(res, 200, (await readDb()).pigeons);
    if (req.method === "POST" && url.pathname === "/api/pigeons") {
      const input = await body(req);
      const pigeon = await transact(db => {
        if (db.pigeons.some(item => item.ringNo === input.ringNo)) throw Object.assign(new Error("ring_exists"), { status: 409 });
        const created = {
          ...input, vaccines: [], transfers: [], races: [], medications: [],
          pedigree: { status: "unconfirmed", confirmedBy: null, confirmedAt: null, version: 0 }, version: 1
        };
        db.pigeons.unshift(created);
        return created;
      });
      return sendJson(res, 201, pigeon);
    }
    const relationMatch = url.pathname.match(/^\/api\/pigeons\/(.+)\/relation$/);
    if (relationMatch && req.method === "GET") {
      const data = relation(await readDb(), decodeURIComponent(relationMatch[1]));
      return data ? sendJson(res, 200, data) : sendJson(res, 404, { error: "pigeon_not_found" });
    }
    // 用药登记 / 更正 / 复核解除
    const liftMatch = url.pathname.match(/^\/api\/pigeons\/(.+)\/medications\/(\d+)\/lift$/);
    if (liftMatch && req.method === "POST") {
      const input = await body(req);
      const med = await transact(db => liftMedication(db, decodeURIComponent(liftMatch[1]), liftMatch[2], input));
      return sendJson(res, 200, med);
    }
    const medItemMatch = url.pathname.match(/^\/api\/pigeons\/(.+)\/medications\/(\d+)$/);
    if (medItemMatch && req.method === "PATCH") {
      const input = await body(req);
      const med = await transact(db => correctMedication(db, decodeURIComponent(medItemMatch[1]), medItemMatch[2], input));
      return sendJson(res, 200, med);
    }
    const medMatch = url.pathname.match(/^\/api\/pigeons\/(.+)\/medications$/);
    if (medMatch && req.method === "POST") {
      const input = await body(req);
      const med = await transact(db => addMedication(db, decodeURIComponent(medMatch[1]), input));
      return sendJson(res, 201, med);
    }
    // 血统确认 / 更正
    const pedConfirmMatch = url.pathname.match(/^\/api\/pigeons\/(.+)\/pedigree\/confirm$/);
    if (pedConfirmMatch && req.method === "POST") {
      const input = await body(req);
      const pedigree = await transact(db => confirmPedigree(db, decodeURIComponent(pedConfirmMatch[1]), input));
      return sendJson(res, 200, pedigree);
    }
    const pedMatch = url.pathname.match(/^\/api\/pigeons\/(.+)\/pedigree$/);
    if (pedMatch && req.method === "PATCH") {
      const input = await body(req);
      const pigeon = await transact(db => correctPedigree(db, decodeURIComponent(pedMatch[1]), input));
      return sendJson(res, 200, pigeon);
    }
    const actionMatch = url.pathname.match(/^\/api\/pigeons\/(.+)\/(transfers|races|vaccines)$/);
    if (actionMatch && req.method === "POST") {
      const input = await body(req);
      const pigeon = await transact(db => {
        const found = db.pigeons.find(item => item.ringNo === decodeURIComponent(actionMatch[1]));
        if (!found) throw Object.assign(new Error("pigeon_not_found"), { status: 404 });
        if (actionMatch[2] === "transfers") {
          found.transfers.push({ date: input.date || new Date().toISOString().slice(0, 10), from: found.owner, to: input.to });
          found.owner = input.to;
        }
        if (actionMatch[2] === "races") found.races.push({ date: input.date || new Date().toISOString().slice(0, 10), event: input.event, distance: Number(input.distance || 0), returnTime: input.returnTime || "", rank: Number(input.rank || 0) });
        if (actionMatch[2] === "vaccines") found.vaccines.push({ date: input.date || new Date().toISOString().slice(0, 10), name: input.name });
        return found;
      });
      return sendJson(res, 200, pigeon);
    }
    // 赛事与报名
    if (req.method === "GET" && url.pathname === "/api/events") return sendJson(res, 200, eventBoard(await readDb()));
    if (req.method === "POST" && url.pathname === "/api/events") {
      const input = await body(req);
      const event = await transact(db => createEvent(db, input));
      return sendJson(res, 201, event);
    }
    const entryMatch = url.pathname.match(/^\/api\/events\/([^/]+)\/entries$/);
    if (entryMatch && req.method === "POST") {
      const input = await body(req);
      const result = await transact(db => enterRace(db, decodeURIComponent(entryMatch[1]), input));
      return sendJson(res, result.deduped ? 200 : 201, result);
    }
    const eventMatch = url.pathname.match(/^\/api\/events\/([^/]+)$/);
    if (eventMatch && req.method === "PATCH") {
      const input = await body(req);
      const event = await transact(db => correctEventDate(db, decodeURIComponent(eventMatch[1]), input));
      return sendJson(res, 200, event);
    }
    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    sendJson(res, error.status || 500, { error: error.code || error.message });
  }
});

server.listen(port, () => console.log(`Racing pigeon registry app listening on http://localhost:${port}`));
