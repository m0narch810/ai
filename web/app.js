const POLL_MS = 60_000;
const SPOT_MS = 60_000;
const STALE_MS = 30 * 60_000;
const SPOT_URL = "/.netlify/functions/spot";

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const fmtPrice = (n) => (typeof n === "number" ? (Number.isInteger(n) ? String(n) : n.toFixed(2)) : "—");
const fmtSpot = (n) => (typeof n === "number" ? n.toFixed(2) : "—");
const signed = (n, d = 2) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(d)}`;

// ---- sparkline ---------------------------------------------------------------
const sparkHistory = [];
const MAX_SPARK = 90;

function pushSparkPoint(v) {
  if (typeof v !== "number") return;
  sparkHistory.push({ t: Date.now(), v });
  if (sparkHistory.length > MAX_SPARK) sparkHistory.shift();
}

function drawSparkline() {
  const canvas = document.getElementById("sparkline");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const pts = sparkHistory;
  if (pts.length < 2) return;
  const vals = pts.map(p => p.v);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const range = hi - lo || 0.01;
  const px = (i) => (i / (pts.length - 1)) * (W - 2) + 1;
  const py = (v) => H - 2 - ((v - lo) / range) * (H - 6);

  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, "rgba(201,168,124,.22)");
  grad.addColorStop(1, "rgba(201,168,124,0)");
  ctx.beginPath();
  ctx.moveTo(px(0), py(pts[0].v));
  for (let i = 1; i < pts.length; i++) ctx.lineTo(px(i), py(pts[i].v));
  ctx.lineTo(px(pts.length - 1), H);
  ctx.lineTo(px(0), H);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(px(0), py(pts[0].v));
  for (let i = 1; i < pts.length; i++) ctx.lineTo(px(i), py(pts[i].v));
  ctx.strokeStyle = "#c9a87c";
  ctx.lineWidth = 1.5;
  ctx.lineJoin = "round";
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(px(pts.length - 1), py(pts[pts.length - 1].v), 2.5, 0, Math.PI * 2);
  ctx.fillStyle = "#c9a87c";
  ctx.fill();

  const rangeEl = document.getElementById("sparkRange");
  if (rangeEl) rangeEl.textContent = range > 0.01 ? `${lo.toFixed(2)} – ${hi.toFixed(2)}` : "";
}

// ---- level map ---------------------------------------------------------------
function renderLevelMap(data, spot) {
  const wrap = document.getElementById("levelMapWrap");
  const svg = document.getElementById("levelMap");
  if (!wrap || !svg || !data?.levels?.length) { if (wrap) wrap.hidden = true; return; }
  const levels = data.levels;
  wrap.hidden = false;
  const ns = "http://www.w3.org/2000/svg";
  const mk = (tag, attrs) => {
    const e = document.createElementNS(ns, tag);
    Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v));
    return e;
  };
  svg.innerHTML = "";
  const allP = [...levels.map(l => l.strike), spot].filter(n => typeof n === "number");
  const lo = Math.min(...allP), hi = Math.max(...allP);
  const pad = Math.max((hi - lo) * 0.2, 1);
  const pLo = lo - pad, pHi = hi + pad, range = pHi - pLo;
  const W = 420, H = 90, ML = 44, MR = 44;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("preserveAspectRatio", "none");

  svg.appendChild(mk("line", { x1: ML, y1: H / 2, x2: W - MR, y2: H / 2, stroke: "rgba(107,94,79,.25)", "stroke-width": 1 }));

  for (const l of levels) {
    const x = ML + ((l.strike - pLo) / range) * (W - ML - MR);
    const isRes = l.side === "resistance";
    const col = isRes ? "#c9604a" : "#4ec98a";
    const prob = l.reversal_prob / 100;
    const tkH = 10 + prob * 22;
    const y1 = isRes ? H / 2 - tkH : H / 2;
    const y2 = isRes ? H / 2 : H / 2 + tkH;
    svg.appendChild(mk("rect", { x: x - 1.5, y: y1, width: 3, height: y2 - y1, rx: 1.5, fill: col, opacity: 0.3 + prob * 0.7 }));
    const lbl = mk("text", { x, y: isRes ? y1 - 3 : y2 + 8, "text-anchor": "middle", "font-family": "'JetBrains Mono',monospace", "font-size": 7.5, fill: col, opacity: 0.6 + prob * 0.4 });
    lbl.textContent = l.strike % 1 === 0 ? l.strike : l.strike.toFixed(1);
    svg.appendChild(lbl);
  }

  if (typeof spot === "number") {
    const sx = ML + ((spot - pLo) / range) * (W - ML - MR);
    svg.appendChild(mk("line", { x1: sx, y1: 4, x2: sx, y2: H - 4, stroke: "#9d7cdc", "stroke-width": 1.5, "stroke-dasharray": "3 2", opacity: 0.85 }));
    svg.appendChild(mk("circle", { cx: sx, cy: H / 2, r: 3, fill: "#9d7cdc" }));
    const lbl = mk("text", { x: sx, y: H - 2, "text-anchor": "middle", "font-family": "'JetBrains Mono',monospace", "font-size": 7, fill: "#9d7cdc", opacity: 0.7 });
    lbl.textContent = spot.toFixed(2);
    svg.appendChild(lbl);
  }

  const lmLabel = document.getElementById("levelMapLabel");
  if (lmLabel) lmLabel.textContent = `${levels.length} levels`;
}

// ---- time --------------------------------------------------------------------
function agoMs(t) {
  if (typeof t !== "number" || Number.isNaN(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}
const scoredAt = () => (typeof lastData?.scored_at === "number" ? lastData.scored_at : Date.parse(lastData?.generated_at ?? ""));
const scoredAgo = () => agoMs(scoredAt());

// ---- state -------------------------------------------------------------------
let lastData = null;
let liveSpot = null;
let liveSpotAt = null;
let rungEls = [];

const currentSpot = () => (typeof liveSpot === "number" ? liveSpot : lastData?.spot);
const boardStale = () => lastData && scoredAt() < Date.now() - STALE_MS;

function isRthNow() {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
  const get = (t) => p.find((x) => x.type === t)?.value;
  const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const wd = WD[get("weekday")] ?? 0;
  const minutes = Number(get("hour")) * 60 + Number(get("minute"));
  return wd >= 1 && wd <= 5 && minutes >= 555 && minutes <= 960;
}

function liveStatusFor(level) {
  if (typeof liveSpot !== "number" || !lastData) return null;
  const hard = lastData.hard_stop_pts ?? 1.0;
  const clean = lastData.clean_reversal_pts ?? 0.2;
  const over = level.side === "resistance" ? liveSpot - level.strike : level.strike - liveSpot;
  if (over >= hard) return "broke";
  if (over > clean) return "grind";
  return null;
}

function outcomeView(level) {
  const live = liveStatusFor(level);
  const o = level.outcome || "none";
  if (o === "broke" || live === "broke") return { cls: "broke", text: "broke" };
  if (o === "reversed") return { cls: "held", text: level.clean === false ? "held loose" : "held" };
  if (live === "grind") return { cls: "grinding", text: "grinding" };
  if (o === "pending") return level.clean === false ? { cls: "grinding", text: "grinding" } : { cls: "testing", text: "testing" };
  return { cls: "resting", text: "resting" };
}

// ---- building ----------------------------------------------------------------
function buildRung(level) {
  const row = el("div", `rung ${level.side === "resistance" ? "res" : "sup"}`);

  row.appendChild(el("div", "rung-stripe"));

  const body = el("div", "rung-body");
  const head = el("div", "rung-head");
  head.appendChild(el("span", "strike", `$${fmtPrice(level.strike)}`));
  const distEl = el("span", "dist");
  head.appendChild(distEl);
  body.appendChild(head);

  const tags = Array.isArray(level.tags) ? level.tags.slice(0, 4) : [];
  if (level.reaction || tags.length) {
    const chips = el("div", "chips");
    if (level.reaction) chips.appendChild(el("span", `chip react ${level.reaction}`, level.reaction === "clean" ? "clean" : level.reaction === "chop" ? "chop" : "mixed"));
    for (const t of tags) chips.appendChild(el("span", "chip", t));
    body.appendChild(chips);
  }
  if (level.why) body.appendChild(el("div", "why", level.why));
  if (level.target_strike != null) body.appendChild(el("div", "target", `→ $${fmtPrice(level.target_strike)}`));
  row.appendChild(body);

  const meter = el("div", "rung-meter");
  const tier = level.reversal_prob >= 60 ? "hi" : level.reversal_prob >= 45 ? "mid" : "lo";
  const prob = el("div", `prob ${tier}`);
  prob.appendChild(el("span", "pnum", String(level.reversal_prob)));
  prob.appendChild(el("span", "ppct", "%"));
  meter.appendChild(prob);
  const heat = el("div", "heat");
  const fill = el("span");
  heat.appendChild(fill);
  meter.appendChild(heat);
  const badgeEl = el("span", "badge");
  meter.appendChild(badgeEl);
  row.appendChild(meter);

  row.addEventListener("click", () => row.classList.toggle("open"));
  return { el: row, level, distEl, badgeEl, fill };
}

function applyOutcome(entry) {
  const v = outcomeView(entry.level);
  entry.el.classList.toggle("broke", v.cls === "broke");
  entry.el.classList.toggle("grinding", v.cls === "grinding");
  entry.el.classList.toggle("testing", v.cls === "testing");
  entry.badgeEl.className = `badge ${v.cls}`;
  entry.badgeEl.textContent = v.text;
}

function paintDist(entry, spot) {
  if (typeof spot !== "number") { entry.distEl.textContent = ""; return; }
  const d = entry.level.strike - spot;
  const pct = spot ? (d / spot) * 100 : 0;
  entry.distEl.textContent = `${signed(d, 1)} · ${signed(pct, 1)}%`;
}

function repaintLive() {
  if (!lastData) return;
  const spot = currentSpot();
  const live = typeof liveSpot === "number";

  $("#heroSpot").textContent = fmtSpot(spot);
  const chg = $("#heroChg");
  if (typeof spot === "number" && typeof lastData.spot === "number") {
    const d = spot - lastData.spot;
    const pct = lastData.spot ? (d / lastData.spot) * 100 : 0;
    chg.className = `spotchg ${d > 0.005 ? "up" : d < -0.005 ? "down" : "flat"}`;
    chg.textContent = `${signed(d)} (${signed(pct)}%)`;
  } else chg.textContent = "";

  $("#heroSrc").textContent = [live ? "live" : "last print", lastData.session, lastData.session === "Asia" ? "NQ-equiv" : null]
    .filter(Boolean).join(" · ");

  const rail = $("#spotrail");
  if (typeof spot === "number") {
    rail.hidden = false;
    const rt = $("#railTag");
    rt.replaceChildren(el("small", null, live ? "LIVE" : "SPOT"));
    rt.append(fmtSpot(spot));
  } else rail.hidden = true;

  for (const e of rungEls) { paintDist(e, spot); applyOutcome(e); }
  renderLevelMap(lastData, spot);
}

function renderHeroMetrics(data) {
  const m = $("#heroMetrics");
  m.replaceChildren();
  const cells = [];
  const reg = data.regime || "—";
  cells.push({ k: "Gamma", v: reg === "positive" ? "Positive" : reg === "negative" ? "Negative" : reg, cls: reg === "positive" ? "pos" : reg === "negative" ? "neg" : "" });
  if (data.iv && typeof data.iv.current === "number") {
    const dir = (data.iv.direction || "").toUpperCase();
    const arrow = dir.startsWith("RIS") ? "▲" : dir.startsWith("FALL") ? "▼" : "→";
    cells.push({ k: "IV", v: `${data.iv.current.toFixed(1)} ${arrow}`, cls: dir.startsWith("RIS") ? "warn" : "" });
  }
  if (typeof data.expected_move === "number") cells.push({ k: "Exp move", v: `±${data.expected_move.toFixed(1)}`, cls: "" });
  cells.push({ k: "Session", v: data.session || "—", cls: "" });
  for (const c of cells) {
    const cell = el("div", "metric");
    cell.appendChild(el("span", "mk", c.k));
    cell.appendChild(el("span", `mv ${c.cls}`.trim(), c.v));
    m.appendChild(cell);
  }
}

function renderBanner(data) {
  const b = $("#banner");
  if (data?.scoring_method === "rule" && !boardStale()) {
    b.hidden = false;
    b.replaceChildren(el("span", "banner-dot"), el("span", "banner-text", `Manual scored (AI unavailable) — rule-based levels, refreshed ${scoredAgo()}. Spot & reversals are live.`));
    return;
  }
  if (!boardStale()) { b.hidden = true; return; }
  b.hidden = false;
  const text = isRthNow()
    ? `Levels last scored ${scoredAgo()} — AI scoring paused (box offline). Spot & reversals are live.`
    : `Outside market hours — holding levels from the last RTH session (scored ${scoredAgo()}). Spot & reversals are live.`;
  b.replaceChildren(el("span", "banner-dot"), el("span", "banner-text", text));
}

function render(data) {
  renderBanner(data);
  const stale = boardStale();
  const offline = stale && isRthNow();
  const rule = !stale && data?.scoring_method === "rule";
  $("#statusDot").className = `status-dot ${stale ? "stale" : rule ? "rule" : "live"}`;
  $("#statusText").textContent = !stale ? (rule ? "rule scored" : "live") : isRthNow() ? `scored ${scoredAgo()}` : "held · off-rth";

  renderHeroMetrics(data);

  const read = $("#heroRead");
  if (data.read) { read.hidden = false; read.textContent = data.read; } else { read.hidden = true; }

  const levels = Array.isArray(data.levels) ? data.levels : [];
  const ceil = $("#ceilings"), floor = $("#floors");
  ceil.replaceChildren(); floor.replaceChildren(); rungEls = [];
  $("#ladder").classList.toggle("prev", offline);

  if (!levels.length) {
    $("#ladder").hidden = true; $("#spotrail").hidden = true;
    const empty = $("#empty");
    empty.hidden = false;
    empty.replaceChildren(el("b", null, "No board yet."), document.createElement("br"));
    empty.append("Run a capture to map the levels.");
    $("#asOf").textContent = "";
    renderLevelMap(data, currentSpot());
    return;
  }
  $("#ladder").hidden = false; $("#empty").hidden = true;

  const res = levels.filter((l) => l.side === "resistance").sort((a, b) => b.strike - a.strike);
  const sup = levels.filter((l) => l.side === "support").sort((a, b) => b.strike - a.strike);
  for (const l of res) { const e = buildRung(l); ceil.appendChild(e.el); rungEls.push(e); }
  for (const l of sup) { const e = buildRung(l); floor.appendChild(e.el); rungEls.push(e); }

  renderLevelMap(data, currentSpot());

  requestAnimationFrame(() => rungEls.forEach((e, i) =>
    setTimeout(() => (e.fill.style.width = `${clamp(e.level.reversal_prob, 0, 100)}%`), 40 + i * 55)));

  repaintLive();
  $("#asOf").textContent = `${data?.scoring_method === "rule" ? "rule scored" : "scored"} ${scoredAgo()}`;
}

// ---- data --------------------------------------------------------------------
async function load() {
  try {
    const res = await fetch(`dashboard.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    lastData = await res.json();
    render(lastData);
  } catch {
    $("#statusText").textContent = "no data";
    $("#statusDot").className = "status-dot";
    $("#banner").hidden = true;
    $("#ladder").hidden = true;
    const empty = $("#empty");
    empty.hidden = false;
    empty.textContent = "Waiting for dashboard.json — run a capture.";
  }
}

async function loadSpot() {
  try {
    const res = await fetch(`${SPOT_URL}?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    if (typeof j.spot === "number") {
      liveSpot = j.spot;
      liveSpotAt = j.at || new Date().toISOString();
      pushSparkPoint(liveSpot);
      drawSparkline();
      repaintLive();
    }
  } catch { /* no live spot (offline / LAN) — fall back to scored spot */ }
}

$("#refresh").addEventListener("click", () => { load(); loadSpot(); });
document.addEventListener("visibilitychange", () => { if (!document.hidden) { load(); loadSpot(); } });

load();
loadSpot();
setInterval(load, POLL_MS);
setInterval(loadSpot, SPOT_MS);
