import http from "node:http";
import { createRegistry, DomainError } from "./registry.js";

const port = Number(process.env.PORT || 3024);
const registry = createRegistry();

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
async function handler(fn, req, res) {
  try {
    const [status, data] = await fn(req, res);
    sendJson(res, status, data);
  } catch (error) {
    if (error instanceof SyntaxError) return sendJson(res, 400, { error: "bad_json" });
    if (error instanceof DomainError) return sendJson(res, error.status, { error: error.code, ...(error.suspensionEnd ? { suspensionEnd: error.suspensionEnd } : {}) });
    sendJson(res, 500, { error: error.message });
  }
}

const page = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>赛鸽参赛报名与休药期复核台</title>
<style>
:root{--bg:#eff2f5;--panel:#fff;--ink:#1f2833;--muted:#697786;--line:#d3dce4;--accent:#315f83;--red:#9b3f35;--green:#2f6d3f;--amber:#9a6a17;}
*{box-sizing:border-box;} body{margin:0;background:var(--bg);color:var(--ink);font-family:Arial,"PingFang SC",sans-serif;}
header{padding:20px 28px;background:#fff;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;gap:16px;align-items:center;}
h1{margin:0;font-size:23px;} main{padding:18px 28px;}
nav{display:flex;gap:8px;margin-bottom:16px;} nav button{background:#fff;color:var(--ink);border:1px solid var(--line);} nav button.active{background:var(--accent);color:#fff;border-color:var(--accent);}
form,.panel,.card{background:#fff;border:1px solid var(--line);border-radius:8px;padding:16px;} h2{margin:0 0 12px;font-size:18px;} h3{margin:0;}
label{display:block;margin:10px 0 5px;color:var(--muted);font-size:13px;} input,select{width:100%;border:1px solid var(--line);border-radius:6px;padding:9px;font:inherit;}
button{border:0;border-radius:6px;background:var(--accent);color:#fff;padding:9px 12px;font-weight:700;cursor:pointer;} button.ghost{background:#eef3f7;color:var(--accent);} button.danger{background:var(--red);} button.small{padding:5px 9px;font-size:12px;}
.cols{display:grid;grid-template-columns:360px 1fr;gap:16px;align-items:start;}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:12px;margin-top:14px;}
.card{display:grid;gap:6px;} .meta{color:var(--muted);font-size:13px;}
.pill{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:2px 9px;font-size:12px;margin:2px 4px 2px 0;}
.pill.confirmed{background:#e7f2ea;color:var(--green);border-color:#b9d8c2;} .pill.waitlisted{background:#fdf5e3;color:var(--amber);border-color:#e6d2a2;}
.pill.invalid{background:#f8e7e5;color:var(--red);border-color:#e0bcb6;} .pill.done{background:#e7edf3;color:var(--accent);}
.rowline{border-top:1px dashed var(--line);margin-top:8px;padding-top:8px;}
.board-section{margin-top:14px;} .slot{display:flex;justify-content:space-between;gap:8px;padding:8px 10px;border:1px solid var(--line);border-radius:6px;margin:6px 0;background:#fbfcfd;}
.tag{font-size:12px;color:var(--red);} .ok{color:var(--green);} .muted{color:var(--muted);}
.relation{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:12px;} .small{background:#f8fafb;border:1px solid var(--line);border-radius:8px;padding:10px;}
.toolbar{display:flex;gap:8px;align-items:end;flex-wrap:wrap;}
@media (max-width:900px){header{display:block;padding:16px;} main{padding:14px;} .cols{grid-template-columns:1fr;} .relation{grid-template-columns:1fr;}}
</style>
</head>
<body>
<header><div><h1>赛鸽参赛报名与休药期复核台</h1><div class="meta">报名绑定当前鸽主与已确认血统 · 休药禁赛只可候补 · 解除须他人复核</div></div><button id="reload">刷新</button></header>
<main>
<nav><button id="tabRaces" class="active">赛事与报名</button><button id="tabPigeons">鸽只档案 / 用药 / 血统</button></nav>

<section id="viewRaces">
<div class="cols">
  <div>
    <form id="eventForm">
      <h2>建立赛事（放飞日 + 名额）</h2>
      <label>赛事名称</label><input name="name" required placeholder="秋季300公里联赛">
      <label>放飞日</label><input name="date" type="date" required>
      <label>距离(公里)</label><input name="distance" type="number" value="300">
      <label>正式名额</label><input name="quota" type="number" value="2" min="1">
      <button>建立赛事</button>
    </form>
    <form id="registerForm" class="panel" style="margin-top:14px;">
      <h2>参赛报名</h2>
      <label>赛事</label><select name="eventId"></select>
      <label>足环号</label><input name="ringNo" required placeholder="CHN-2026-001">
      <button>提交报名</button>
      <div class="meta" style="margin-top:8px;">同一羽同一赛事仅一份有效报名，重复或并发沿用首次结果。</div>
    </form>
  </div>
  <div>
    <div class="panel">
      <h2>赛事榜（名额 / 候补 / 失效 / 历史）</h2>
      <div class="toolbar">
        <select id="eventPick" style="max-width:260px;"></select>
        <button class="ghost small" id="refreshBoard">刷新榜单</button>
        <button class="small" id="finalizeBtn">完赛封存</button>
      </div>
      <div class="toolbar" style="margin-top:10px;">
        <label style="margin:0;">更正放飞日 <input id="fixDate" type="date"></label>
        <label style="margin:0;">更正名额 <input id="fixQuota" type="number" min="1" style="width:90px;"></label>
        <button class="ghost small" id="fixEventBtn">保存更正并重算</button>
      </div>
      <div id="board"></div>
    </div>
  </div>
</div>
</section>

<section id="viewPigeons" style="display:none;">
<div class="cols">
<form id="pigeonForm">
  <h2>创建鸽只档案</h2>
  <label>足环号</label><input name="ringNo" required>
  <label>鸽主</label><input name="owner" required>
  <label>父鸽足环号</label><input name="fatherRing">
  <label>母鸽足环号</label><input name="motherRing">
  <label>羽色</label><input name="color" required>
  <label>出生棚号</label><input name="loft" required>
  <button>保存档案</button>
</form>
<div>
  <div class="toolbar"><input id="search" placeholder="输入足环号查询档案" style="max-width:300px;"><button id="searchBtn">查询</button></div>
  <div class="panel" id="detail" style="margin-top:10px;"></div>
  <div class="grid" id="cards"></div>
</div>
</div>
</section>
</main>
<script>
const $=s=>document.querySelector(s);
let events=[], pigeons=[], currentEvent=null;
async function api(path,options){
  const res=await fetch(path,options&&options.body?{...options,headers:{"Content-Type":"application/json"}}:options);
  const data=await res.json();
  if(!res.ok) throw new Error(data.error+(data.suspensionEnd?"（禁赛截止 "+data.suspensionEnd+"）":""));
  return data;
}
const REASON={withdrawal_hold:"休药禁赛未解除",bloodline_unconfirmed:"血统未确认",pigeon_missing:"档案缺失"};
const AFFECTED={medication_added:"用药新增",medication_corrected:"用药更正",bloodline_corrected:"血统更正",race_date_corrected:"放飞日更正",quota_corrected:"名额调整"};
function esc(s){return String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c]));}
function aff(row){return row.affected&&row.affected.reasons.length?'<div class="tag">受影响：'+row.affected.reasons.map(r=>AFFECTED[r]||r).join("、")+"</div>":"";}
function medLine(row){const m=(row.activeMeds||[]).find(x=>!x.released);return m?'<div class="meta">禁赛截止 '+m.suspensionEnd+" · "+esc(m.drug)+"</div>":"";}

async function loadEvents(){
  events=await api("/api/events");
  const opts=events.map(e=>'<option value="'+e.id+'">'+esc(e.name)+" "+e.date+"（名额"+e.quota+"）"+(e.finalized?" [已完赛]":"")+"</option>").join("");
  $("[name=eventId]").innerHTML=opts||'<option value="">暂无赛事</option>';
  $("#eventPick").innerHTML=opts;
  if(!currentEvent||!events.some(e=>e.id===currentEvent)) currentEvent=events[0]?.id||null;
  $("#eventPick").value=currentEvent||"";
  if(currentEvent) loadBoard();
}
async function loadBoard(){
  if(!currentEvent){$("#board").innerHTML='<p class="meta">请先建立赛事。</p>';return;}
  const b=await api("/api/events/"+encodeURIComponent(currentEvent)+"/board");
  const ev=b.event;
  $("#fixDate").value=ev.date; $("#fixQuota").value=ev.quota;
  $("#finalizeBtn").style.display=ev.finalized?"none":"";
  const head='<div style="margin-top:12px;"><b>'+esc(ev.name)+"</b> "+ev.date+" · "+ev.distance+'公里 · 正式名额 '+ev.quota+(ev.finalized?' <span class="pill done">已完赛 · 历史封存</span>':'')+"</div>";
  const slot=r=>'<div class="slot"><div><b>#'+(r.slotNo??"候补"+(r.waitlistNo??""))+"</b> "+esc(r.ringNo)+' <span class="meta">'+esc(r.owner)+"</span>"+medLine(r)+aff(r)+(r.finalizedResult?'<div class="meta">成绩：第 '+r.finalizedResult.rank+"名</div>":"")+'</div><span class="pill confirmed">正式</span></div>';
  const wait=r=>'<div class="slot"><div><b>候补'+(r.waitlistNo??"")+"</b> "+esc(r.ringNo)+' <span class="meta">'+esc(r.owner)+"</span>"+medLine(r)+aff(r)+"</div><span class='pill waitlisted'>候补</span></div>";
  const inv=r=>'<div class="slot"><div>'+esc(r.ringNo)+' <span class="meta">'+esc(r.owner)+"</span><div class='tag'>"+r.reasons.map(x=>REASON[x]||x).join("、")+"</div>"+aff(r)+'</div><span class="pill invalid">失效</span></div>';
  let body="";
  if(ev.finalized){
    body+='<div class="board-section"><h3>完赛历史（保留，更正只标记）</h3>'+b.rows.map(r=>{
      const pill=r.status==="confirmed"?'<span class="pill done">正式</span>':r.status==="waitlisted"?'<span class="pill waitlisted">候补</span>':'<span class="pill invalid">失效</span>';
      return '<div class="slot"><div><b>'+(r.status==="confirmed"?"#"+r.slotNo:"候补"+(r.waitlistNo??""))+"</b> "+esc(r.ringNo)+' <span class="meta">'+esc(r.owner)+"</span>"+(r.finalizedResult?'<div class="meta">第 '+r.finalizedResult.rank+"名</div>":"")+aff(r)+"</div>"+pill+"</div>";
    }).join("")+"</div>";
  }else{
    body+='<div class="board-section"><h3>正式名额（'+b.confirmed.length+"/"+ev.quota+"）</h3>"+(b.confirmed.map(slot).join("")||'<p class="meta">暂无</p>')+"</div>";
    body+='<div class="board-section"><h3>候补队列（按报名时间，解除禁赛后重算晋升）</h3>'+(b.waitlist.map(wait).join("")||'<p class="meta">暂无</p>')+"</div>";
    body+='<div class="board-section"><h3>失效（不占名额 / 不进候补）</h3>'+(b.invalid.map(inv).join("")||'<p class="meta">暂无</p>')+"</div>";
  }
  $("#board").innerHTML=head+body;
}
async function loadPigeons(){pigeons=await api("/api/pigeons");renderCards();}
function renderCards(){
  $("#cards").innerHTML=pigeons.map(p=>'<article class="card"><h3>'+esc(p.ringNo)+"</h3><span class='pill "+(p.bloodlineConfirmed?"confirmed":"invalid")+"'>"+(p.bloodlineConfirmed?"血统已确认":"血统未确认")+'</span><div class="meta">'+esc(p.owner)+" · "+esc(p.color)+" · "+esc(p.loft)+"</div><div>父："+esc(p.fatherRing||"未登记")+"　母："+esc(p.motherRing||"未登记")+'</div>'
    +'<div class="rowline"><label>录入转让（新鸽主）</label><input data-to="'+p.ringNo+'" placeholder="新归属人"><button class="small" data-transfer="'+p.ringNo+'">保存转让</button></div>'
    +'<div class="rowline"><label>用药登记（药名/用药日/休药天数/施药人）</label><input data-med="'+p.ringNo+'" placeholder="甲硝唑/2026-10-01/14/教练甲"><button class="small danger" data-addmed="'+p.ringNo+'">登记用药</button></div>'
    +'<div class="rowline"><label>血统确认人</label><input data-confirmer="'+p.ringNo+'" placeholder="裁判姓名"><button class="small" data-confirm="'+p.ringNo+'">确认血统</button><label>更正父母</label><input data-parents="'+p.ringNo+'" placeholder="父环/母环"><button class="small ghost" data-fixblood="'+p.ringNo+'">保存更正（重算）</button></div>'
    +'<div class="rowline"><label>归巢成绩</label><input data-race="'+p.ringNo+'" placeholder="赛事/距离/名次，如200公里/200/6"><button class="small" data-score="'+p.ringNo+'">保存成绩</button></div>'
    +"</article>").join("");
  const val=(sel)=>document.querySelector(sel).value;
  document.querySelectorAll("[data-transfer]").forEach(btn=>btn.onclick=async()=>{await api("/api/pigeons/"+encodeURIComponent(btn.dataset.transfer)+"/transfers",{method:"POST",body:JSON.stringify({to:val('[data-to="'+btn.dataset.transfer+'"]')})});await refreshAll();});
  document.querySelectorAll("[data-addmed]").forEach(btn=>btn.onclick=async()=>{const r=val('[data-med="'+btn.dataset.addmed+'"]').split("/");await api("/api/pigeons/"+encodeURIComponent(btn.dataset.addmed)+"/medications",{method:"POST",body:JSON.stringify({drug:r[0],date:r[1],withdrawalDays:Number(r[2]),administeredBy:r[3]||""})});await refreshAll();});
  document.querySelectorAll("[data-confirm]").forEach(btn=>btn.onclick=async()=>{await api("/api/pigeons/"+encodeURIComponent(btn.dataset.confirm)+"/bloodline/confirm",{method:"POST",body:JSON.stringify({confirmedBy:val('[data-confirmer="'+btn.dataset.confirm+'"]')})});await refreshAll();});
  document.querySelectorAll("[data-fixblood]").forEach(btn=>btn.onclick=async()=>{const r=val('[data-parents="'+btn.dataset.fixblood+'"]').split("/");await api("/api/pigeons/"+encodeURIComponent(btn.dataset.fixblood)+"/bloodline",{method:"PATCH",body:JSON.stringify({fatherRing:r[0],motherRing:r[1]})});await refreshAll();});
  document.querySelectorAll("[data-score]").forEach(btn=>btn.onclick=async()=>{const r=val('[data-race="'+btn.dataset.score+'"]').split("/");await api("/api/pigeons/"+encodeURIComponent(btn.dataset.score)+"/races",{method:"POST",body:JSON.stringify({event:r[0]||"未命名赛事",distance:Number(r[1]||0),rank:Number(r[2]||0)})});await refreshAll();});
}
function renderDetail(d){
  if(!d){$("#detail").innerHTML='<h2>档案查询</h2><p class="meta">输入足环号查看血统、用药休药与报名记录。</p>';return;}
  const p=d.pigeon;
  const meds=p.medications.map(m=>{
    const end=addDays(m.date,m.withdrawalDays);
    const rel=m.release?'<span class="ok">已解除：'+esc(m.release.reviewedBy)+" 复查 "+m.release.reviewDate+"</span>":'<span class="tag">未解除，禁赛截止 '+end+"</span>";
    const fix='<input data-meddrug="'+m.id+'" placeholder="药名/用药日/休药天数" style="margin-top:6px;"><button class="small ghost" data-fixmed="'+p.ringNo+'" data-medid="'+m.id+'">更正（解除作废）</button>';
    const relForm=m.release?'':'<div class="rowline"><label>解除复核（须非施药人：'+esc(m.administeredBy||"无")+"，复查日 ≥ "+end+'）</label><input data-rev="'+m.id+'" placeholder="复核人/复查日"><button class="small" data-release="'+p.ringNo+'" data-medid="'+m.id+'">复核解除</button></div>';
    return '<div class="small" style="margin:6px 0;"><b>'+esc(m.drug)+"</b> "+m.date+" · 休药"+m.withdrawalDays+"天<br>"+rel+(m.correctedAt?'<div class="tag">已于 '+m.correctedAt.slice(0,10)+" 更正</div>":"")+fix+relForm+"</div>";
  }).join("");
  const regs=d.registrations.map(r=>'<div class="small" style="margin:6px 0;"><b>'+esc(r.eventName||r.eventId)+"</b>（"+r.eventDate+"）<span class='pill "+r.status+"'>"+({confirmed:"正式#"+r.slotNo,waitlisted:"候补"+r.waitlistNo,invalid:"失效"}[r.status]||r.status)+"</span><div class='meta'>报名鸽主："+esc(r.owner)+(r.affectedReasons&&r.affectedReasons.length?" · 受影响："+r.affectedReasons.map(x=>AFFECTED[x]||x).join("、"):"")+"</div></div>").join("");
  $("#detail").innerHTML='<h2>'+esc(p.ringNo)+" 档案</h2><div class='relation'><div class='small'><b>父鸽</b><br>"+esc(d.father?.ringNo||p.fatherRing||"未登记")+'</div><div class="small"><b>本鸽</b><br>'+esc(p.owner)+" · "+esc(p.color)+(p.bloodlineConfirmed?' <span class="ok">血统已确认</span>':' <span class="tag">血统未确认</span>')+'</div><div class="small"><b>母鸽</b><br>'+esc(d.mother?.ringNo||p.motherRing||"未登记")+'</div></div>'
    +'<div class="rowline"><b>用药与休药期</b>'+(meds||'<p class="meta">无用药记录</p>')+"</div>"
    +'<div class="rowline"><b>报名记录</b>'+(regs||'<p class="meta">无报名</p>')+"</div>"
    +'<div class="meta rowline">转让：'+esc(p.transfers.map(t=>t.from+"→"+t.to).join(" / ")||"暂无")+"　归巢："+esc(p.races.map(r=>r.event+" 第"+r.rank+"名").join(" / ")||"暂无")+"</div>";
  document.querySelectorAll("[data-release]").forEach(btn=>btn.onclick=async()=>{const r=document.querySelector('[data-rev="'+btn.dataset.medid+'"]').value.split("/");await api("/api/pigeons/"+encodeURIComponent(btn.dataset.release)+"/medications/"+encodeURIComponent(btn.dataset.medid)+"/release",{method:"POST",body:JSON.stringify({reviewedBy:r[0],reviewDate:r[1]})});await refreshAll();});
  document.querySelectorAll("[data-fixmed]").forEach(btn=>btn.onclick=async()=>{const r=document.querySelector('[data-meddrug="'+btn.dataset.medid+'"]').value.split("/");const body={};if(r[0])body.drug=r[0];if(r[1])body.date=r[1];if(r[2])body.withdrawalDays=Number(r[2]);await api("/api/pigeons/"+encodeURIComponent(btn.dataset.fixmed)+"/medications/"+encodeURIComponent(btn.dataset.medid),{method:"PATCH",body:JSON.stringify(body)});await refreshAll();});
}
function addDays(s,n){const d=new Date(s+"T00:00:00Z");d.setUTCDate(d.getUTCDate()+Number(n));return d.toISOString().slice(0,10);}
async function refreshDetail(){if($("#search").value) renderDetail(await api("/api/pigeons/"+encodeURIComponent($("#search").value)+"/relation"));}
async function refreshAll(){await loadEvents();await loadPigeons();await refreshDetail();}

$("#tabRaces").onclick=()=>{$("#viewRaces").style.display="";$("#viewPigeons").style.display="none";$("#tabRaces").classList.add("active");$("#tabPigeons").classList.remove("active");};
$("#tabPigeons").onclick=()=>{$("#viewRaces").style.display="none";$("#viewPigeons").style.display="";$("#tabPigeons").classList.add("active");$("#tabRaces").classList.remove("active");};
$("#reload").onclick=refreshAll;
$("#eventPick").onchange=e=>{currentEvent=e.target.value;loadBoard();};
$("#refreshBoard").onclick=loadBoard;
$("#eventForm").onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target);await api("/api/events",{method:"POST",body:JSON.stringify(Object.fromEntries(f.entries()))});e.target.reset();await refreshAll();};
$("#registerForm").onsubmit=async e=>{e.preventDefault();const f=Object.fromEntries(new FormData(e.target).entries());try{await api("/api/events/"+encodeURIComponent(f.eventId)+"/registrations",{method:"POST",body:JSON.stringify({ringNo:f.ringNo})});}catch(err){alert(err.message);}await loadBoard();};
$("#fixEventBtn").onclick=async()=>{await api("/api/events/"+encodeURIComponent(currentEvent),{method:"PATCH",body:JSON.stringify({date:$("#fixDate").value,quota:Number($("#fixQuota").value)})});await refreshAll();};
$("#finalizeBtn").onclick=async()=>{await api("/api/events/"+encodeURIComponent(currentEvent)+"/finalize",{method:"POST",body:"{}"});await refreshAll();};
$("#searchBtn").onclick=async()=>{try{renderDetail(await api("/api/pigeons/"+encodeURIComponent($("#search").value)+"/relation"));}catch(err){alert(err.message);}};
$("#pigeonForm").onsubmit=async e=>{e.preventDefault();await api("/api/pigeons",{method:"POST",body:JSON.stringify(Object.fromEntries(new FormData(e.target).entries()))});e.target.reset();await refreshAll();};
refreshAll();
</script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = decodeURIComponent(url.pathname);

  if (req.method === "GET" && p === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(page);
  }

  // ---- 入口层：只做路由与参数搬运，业务在 registry，资格在 eligibility ----
  if (req.method === "GET" && p === "/api/pigeons") return handler(() => registry.listPigeons().then(data => [200, data]), req, res);
  if (req.method === "POST" && p === "/api/pigeons") return handler(async () => [201, await registry.createPigeon(await body(req))], req, res);

  if (req.method === "GET" && p === "/api/events") return handler(() => registry.listEvents().then(data => [200, data]), req, res);
  if (req.method === "POST" && p === "/api/events") return handler(async () => [201, await registry.createEvent(await body(req))], req, res);

  let m;
  if ((m = p.match(/^\/api\/events\/([^/]+)$/)) && req.method === "PATCH")
    return handler(async () => [200, await registry.updateEvent(m[1], await body(req))], req, res);
  if ((m = p.match(/^\/api\/events\/([^/]+)\/finalize$/)) && req.method === "POST")
    return handler(async () => [200, await registry.finalizeEvent(m[1], await body(req))], req, res);
  if ((m = p.match(/^\/api\/events\/([^/]+)\/board$/)) && req.method === "GET")
    return handler(async () => [200, await registry.getBoard(m[1])], req, res);
  if ((m = p.match(/^\/api\/events\/([^/]+)\/registrations$/)) && req.method === "POST")
    return handler(async () => {
      const input = await body(req);
      const result = await registry.register(m[1], input.ringNo, input);
      return [result.created ? 201 : 200, result];
    }, req, res);

  if ((m = p.match(/^\/api\/pigeons\/([^/]+)\/relation$/)) && req.method === "GET")
    return handler(async () => [200, await registry.getPigeonDetail(m[1])], req, res);
  if ((m = p.match(/^\/api\/pigeons\/([^/]+)\/transfers$/)) && req.method === "POST")
    return handler(async () => [200, await registry.transfer(m[1], await body(req))], req, res);
  if ((m = p.match(/^\/api\/pigeons\/([^/]+)\/races$/)) && req.method === "POST")
    return handler(async () => [200, await registry.addRaceResult(m[1], await body(req))], req, res);
  if ((m = p.match(/^\/api\/pigeons\/([^/]+)\/vaccines$/)) && req.method === "POST")
    return handler(async () => [200, await registry.addVaccine(m[1], await body(req))], req, res);
  if ((m = p.match(/^\/api\/pigeons\/([^/]+)\/bloodline\/confirm$/)) && req.method === "POST")
    return handler(async () => [200, await registry.confirmBloodline(m[1], await body(req))], req, res);
  if ((m = p.match(/^\/api\/pigeons\/([^/]+)\/bloodline$/)) && req.method === "PATCH")
    return handler(async () => [200, await registry.correctBloodline(m[1], await body(req))], req, res);
  if ((m = p.match(/^\/api\/pigeons\/([^/]+)\/medications\/([^/]+)\/release$/)) && req.method === "POST")
    return handler(async () => [200, await registry.releaseMedication(m[1], m[2], await body(req))], req, res);
  if ((m = p.match(/^\/api\/pigeons\/([^/]+)\/medications\/([^/]+)$/)) && req.method === "PATCH")
    return handler(async () => [200, await registry.correctMedication(m[1], m[2], await body(req))], req, res);
  if ((m = p.match(/^\/api\/pigeons\/([^/]+)\/medications$/)) && req.method === "POST")
    return handler(async () => [201, await registry.addMedication(m[1], await body(req))], req, res);

  sendJson(res, 404, { error: "not_found" });
});

server.listen(port, () => console.log(`Racing pigeon registration desk listening on http://localhost:${port}`));
