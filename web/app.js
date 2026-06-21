const POLL_MS     = 60_000;
const SPOT_MS     = 60_000;
const CANDLE_MS   = 5 * 60_000;
const STALE_MS    = 30 * 60_000;
const SPOT_URL    = "/.netlify/functions/spot";
const CANDLES_URL = "/.netlify/functions/altaris-candles";

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls)          n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const clamp    = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const fmtPrice = (n) => (typeof n === "number" ? (Number.isInteger(n) ? String(n) : n.toFixed(2)) : "—");
const fmtSpot  = (n) => (typeof n === "number" ? n.toFixed(2) : "—");
const signed   = (n, d = 2) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(d)}`;

// ── SVG helper ───────────────────────────────────────────────────────────────
const NS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

// ── sparkline ────────────────────────────────────────────────────────────────
const sparkHistory = [];
const MAX_SPARK    = 90;

function pushSparkPoint(v) {
  if (typeof v !== "number") return;
  sparkHistory.push({ t: Date.now(), v });
  if (sparkHistory.length > MAX_SPARK) sparkHistory.shift();
}

function drawSparkline() {
  const canvas = $("#sparkline");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const W = canvas.offsetWidth  || 200;
  const H = canvas.offsetHeight || 48;
  canvas.width  = W * devicePixelRatio;
  canvas.height = H * devicePixelRatio;
  ctx.scale(devicePixelRatio, devicePixelRatio);
  ctx.clearRect(0, 0, W, H);
  const pts = sparkHistory;
  if (pts.length < 2) return;
  const vals = pts.map(p => p.v);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const range = hi - lo || 0.01;
  const px = (i) => (i / (pts.length - 1)) * (W - 2) + 1;
  const py = (v)  => H - 2 - ((v - lo) / range) * (H - 6);

  ctx.beginPath();
  ctx.moveTo(px(0), py(pts[0].v));
  for (let i = 1; i < pts.length; i++) ctx.lineTo(px(i), py(pts[i].v));
  ctx.strokeStyle = "#00aee0";
  ctx.lineWidth   = 1.5;
  ctx.lineJoin    = "round";
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(px(0), py(pts[0].v));
  for (let i = 1; i < pts.length; i++) ctx.lineTo(px(i), py(pts[i].v));
  ctx.lineTo(px(pts.length - 1), H);
  ctx.lineTo(px(0), H);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, "rgba(0,174,224,.15)");
  grad.addColorStop(1, "rgba(0,174,224,0)");
  ctx.fillStyle = grad;
  ctx.fill();

  const last = pts[pts.length - 1];
  ctx.beginPath();
  ctx.arc(px(pts.length - 1), py(last.v), 2.5, 0, Math.PI * 2);
  ctx.fillStyle = "#00aee0";
  ctx.fill();

  const rangeEl = $("#sparkRange");
  if (rangeEl) rangeEl.textContent = range > 0.01 ? `${lo.toFixed(2)} – ${hi.toFixed(2)}` : "";
}

// ── GEX profile chart ────────────────────────────────────────────────────────
function renderGexChart(gexProfile, spot) {
  const svg = $("#gexChart");
  if (!svg) return;
  svg.innerHTML = "";
  if (!Array.isArray(gexProfile) || !gexProfile.length) return;

  const W = 400, H = 160, MT = 12, MB = 20, ML = 36, MR = 8;
  const IW = W - ML - MR, IH = H - MT - MB;
  const maxAbs = Math.max(...gexProfile.map(p => Math.abs(p.gex_m)), 1);
  const n      = gexProfile.length;
  const barW   = Math.max(2, Math.floor(IW / n) - 1);
  const midY   = MT + IH / 2;

  svg.appendChild(svgEl("line", { x1: ML, y1: midY, x2: W - MR, y2: midY, stroke: "#1d2b3e", "stroke-width": 1 }));

  gexProfile.forEach((p, i) => {
    const x    = ML + (i / n) * IW + (IW / n - barW) / 2;
    const frac = p.gex_m / maxAbs;
    const barH = Math.abs(frac) * (IH / 2 - 2);
    const isPos = p.gex_m >= 0;
    const color = isPos ? "#e03333" : "#00cc78";
    const y = isPos ? midY - barH : midY;
    svg.appendChild(svgEl("rect", { x, y, width: barW, height: Math.max(1, barH), fill: color, opacity: 0.6 }));
  });

  if (typeof spot === "number" && gexProfile.length > 1) {
    const strikes = gexProfile.map(p => p.strike);
    const slo = strikes[0], shi = strikes[strikes.length - 1], sr = shi - slo || 1;
    const sx = ML + ((spot - slo) / sr) * IW;
    if (sx >= ML && sx <= W - MR) {
      svg.appendChild(svgEl("line", { x1: sx, y1: MT, x2: sx, y2: H - MB, stroke: "#00aee0", "stroke-width": 1.5, "stroke-dasharray": "4 2" }));
    }
  }

  const axLbl = svgEl("text", { x: ML - 3, y: midY + 3.5, "text-anchor": "end", fill: "#1c2940", "font-family": "JetBrains Mono,monospace", "font-size": 8 });
  axLbl.textContent = "0";
  svg.appendChild(axLbl);
}

// ── Candle + VWAP chart ──────────────────────────────────────────────────────
let candleData = null;

async function loadCandles() {
  try {
    const res = await fetch(`${CANDLES_URL}?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return;
    const json = await res.json();
    if (Array.isArray(json?.candles) && json.candles.length)  candleData = json.candles;
    else if (Array.isArray(json) && json.length)              candleData = json;
    if (candleData) renderCandleChart(candleData);
  } catch { /* silent */ }
}

function renderCandleChart(candles) {
  const svg = $("#candleChart");
  if (!svg || !candles?.length) return;
  svg.innerHTML = "";

  const bars = candles.slice(-48);
  const W = 400, H = 160, MT = 8, MB = 20, ML = 42, MR = 6;
  const IW = W - ML - MR, IH = H - MT - MB;

  const highs = bars.map(b => b.h ?? b.high  ?? 0);
  const lows  = bars.map(b => b.l ?? b.low   ?? 0);
  let lo = Math.min(...lows), hi = Math.max(...highs);
  const pad = (hi - lo) * 0.08 || 1;
  lo -= pad; hi += pad;
  const prange = hi - lo;
  const py = (v) => MT + ((hi - v) / prange) * IH;

  let cumVP = 0, cumV = 0;
  const vwapPts = bars.map(b => {
    const tp = ((b.h ?? b.high ?? b.c ?? b.close) + (b.l ?? b.low ?? b.c ?? b.close) + (b.c ?? b.close)) / 3;
    const v  = b.v ?? b.volume ?? 0;
    cumVP += tp * v; cumV += v;
    return cumV > 0 ? cumVP / cumV : tp;
  });

  const bw = IW / bars.length;

  bars.forEach((b, i) => {
    const o = b.o ?? b.open  ?? 0;
    const c = b.c ?? b.close ?? 0;
    const h = b.h ?? b.high  ?? 0;
    const l = b.l ?? b.low   ?? 0;
    const x    = ML + i * bw;
    const bull  = c >= o;
    const color = bull ? "#00cc78" : "#e03333";
    const bodyTop = py(Math.max(o, c));
    const bodyBot = py(Math.min(o, c));
    const bodyH   = Math.max(1, bodyBot - bodyTop);
    const mx = x + bw / 2;
    svg.appendChild(svgEl("line", { x1: mx, y1: py(h), x2: mx, y2: py(l), stroke: color, "stroke-width": 0.8, opacity: 0.7 }));
    svg.appendChild(svgEl("rect", { x: x + bw * 0.15, y: bodyTop, width: bw * 0.7, height: bodyH, fill: color, opacity: 0.85 }));
  });

  const vwapD = vwapPts.map((v, i) => `${i === 0 ? "M" : "L"}${(ML + i * bw + bw / 2).toFixed(1)},${py(v).toFixed(1)}`).join(" ");
  svg.appendChild(svgEl("path", { d: vwapD, fill: "none", stroke: "#f0a623", "stroke-width": 1.5, opacity: 0.85 }));

  for (let i = 0; i <= 4; i++) {
    const v = lo + (prange * i) / 4;
    const y = py(v);
    svg.appendChild(svgEl("line", { x1: ML, y1: y, x2: W - MR, y2: y, stroke: "#1d2b3e", "stroke-width": 0.5 }));
    const lbl = svgEl("text", { x: ML - 3, y: y + 3.5, "text-anchor": "end", fill: "#1c2940", "font-family": "JetBrains Mono,monospace", "font-size": 8 });
    lbl.textContent = v.toFixed(1);
    svg.appendChild(lbl);
  }

  const sub = $("#candleChartSub");
  if (sub) sub.textContent = `last ${bars.length} · VWAP amber`;
}

// ── Mobile level map ──────────────────────────────────────────────────────────
function renderLevelMap(data, spot) {
  const wrap = $("#levelMapWrap");
  const svg  = $("#levelMap");
  if (!wrap || !svg || !data?.levels?.length) { if (wrap) wrap.hidden = true; return; }
  wrap.hidden = false;
  svg.innerHTML = "";

  const levels = data.levels;
  const allP = [...levels.map(l => l.strike), spot].filter(n => typeof n === "number");
  const lo = Math.min(...allP), hi = Math.max(...allP);
  const pad = Math.max((hi - lo) * 0.2, 1);
  const pLo = lo - pad, pHi = hi + pad, range = pHi - pLo;
  const W = 420, H = 72, ML = 40, MR = 40;

  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.appendChild(svgEl("line", { x1: ML, y1: H / 2, x2: W - MR, y2: H / 2, stroke: "#1d2b3e", "stroke-width": 1 }));

  for (const l of levels) {
    const x = ML + ((l.strike - pLo) / range) * (W - ML - MR);
    const isRes = l.side === "resistance";
    const col  = isRes ? "#e03333" : "#00cc78";
    const prob = l.reversal_prob / 100;
    const tkH  = 8 + prob * 18;
    const y1 = isRes ? H / 2 - tkH : H / 2;
    const y2 = isRes ? H / 2 : H / 2 + tkH;
    svg.appendChild(svgEl("rect", { x: x - 1.5, y: y1, width: 3, height: y2 - y1, fill: col, opacity: 0.3 + prob * 0.7 }));
    const lbl = svgEl("text", { x, y: isRes ? y1 - 2 : y2 + 7, "text-anchor": "middle", "font-family": "JetBrains Mono,monospace", "font-size": 7, fill: col });
    lbl.textContent = l.strike % 1 === 0 ? String(l.strike) : l.strike.toFixed(1);
    svg.appendChild(lbl);
  }

  if (typeof spot === "number") {
    const sx = ML + ((spot - pLo) / range) * (W - ML - MR);
    svg.appendChild(svgEl("line", { x1: sx, y1: 4, x2: sx, y2: H - 4, stroke: "#00aee0", "stroke-width": 1.5, "stroke-dasharray": "3 2" }));
    const sLbl = svgEl("text", { x: sx, y: H - 1, "text-anchor": "middle", "font-family": "JetBrains Mono,monospace", "font-size": 7, fill: "#00aee0" });
    sLbl.textContent = spot.toFixed(2);
    svg.appendChild(sLbl);
  }

  const lbl = $("#levelMapLabel");
  if (lbl) lbl.textContent = `${levels.length} levels`;
}

// ── time ──────────────────────────────────────────────────────────────────────
function agoMs(t) {
  if (typeof t !== "number" || Number.isNaN(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 90)   return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}
const scoredAt  = () => (typeof lastData?.scored_at === "number" ? lastData.scored_at : Date.parse(lastData?.generated_at ?? ""));
const scoredAgo = () => agoMs(scoredAt());

// ── state ─────────────────────────────────────────────────────────────────────
let lastData   = null;
let liveSpot   = null;
let liveSpotAt = null;
let rungEls    = [];

const currentSpot = () => (typeof liveSpot === "number" ? liveSpot : lastData?.spot);
const boardStale  = () => lastData && scoredAt() < Date.now() - STALE_MS;

function isRthNow() {
  const p   = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
  const get  = (t) => p.find(x => x.type === t)?.value;
  const WD   = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const wd   = WD[get("weekday")] ?? 0;
  const min  = Number(get("hour")) * 60 + Number(get("minute"));
  return wd >= 1 && wd <= 5 && min >= 555 && min <= 960;
}

function liveStatusFor(level) {
  if (typeof liveSpot !== "number" || !lastData) return null;
  const hard  = lastData.hard_stop_pts      ?? 1.0;
  const clean = lastData.clean_reversal_pts ?? 0.2;
  const over  = level.side === "resistance" ? liveSpot - level.strike : level.strike - liveSpot;
  if (over >= hard)  return "broke";
  if (over >  clean) return "grind";
  return null;
}

function outcomeView(level) {
  const live = liveStatusFor(level);
  const o = level.outcome || "none";
  if (o === "broke" || live === "broke") return { cls: "broke",    text: "broke" };
  if (o === "reversed")  return { cls: "held",     text: level.clean === false ? "held loose" : "held" };
  if (live === "grind")  return { cls: "grinding", text: "grinding" };
  if (o === "pending")   return level.clean === false ? { cls: "grinding", text: "grinding" } : { cls: "testing", text: "testing" };
  return { cls: "resting", text: "resting" };
}

// ── rung ──────────────────────────────────────────────────────────────────────
function buildRung(level) {
  const isRes = level.side === "resistance";
  const row   = el("div", `rung ${isRes ? "res" : "sup"}`);

  // col 1: color stripe
  row.appendChild(el("div", "rung-stripe"));

  // col 2: strike + distance
  const colS  = el("div", "col-strike");
  colS.appendChild(el("span", "strike", `$${fmtPrice(level.strike)}`));
  const distEl = el("span", "dist");
  colS.appendChild(distEl);
  row.appendChild(colS);

  // col 3: probability + heat bar
  const colP = el("div", "col-prob");
  const tier = level.reversal_prob >= 60 ? "hi" : level.reversal_prob >= 45 ? "mid" : "lo";
  const prob = el("div", `prob ${tier}`);
  prob.appendChild(el("span", "pnum", String(level.reversal_prob)));
  prob.appendChild(el("span", "ppct", "%"));
  colP.appendChild(prob);
  const heat = el("div", "heat");
  const fill = el("span");
  heat.appendChild(fill);
  colP.appendChild(heat);
  row.appendChild(colP);

  // col 4: reaction (hidden on narrow screens via 0px column width)
  const react = level.reaction || "";
  row.appendChild(el("div", `col-react ${react || "mixed"}`, react ? react.toUpperCase() : "—"));

  // col 5: tags + why + optional target
  const colC = el("div", "col-content");
  const tags = Array.isArray(level.tags) ? level.tags.slice(0, 4) : [];
  if (tags.length) colC.appendChild(el("div", "tag-row", tags.join(" · ")));
  if (level.why) {
    const whyEl = el("div", "why-text", level.why);
    if (level.target_strike != null) {
      whyEl.appendChild(el("span", "target-inline", ` → $${fmtPrice(level.target_strike)}`));
    }
    colC.appendChild(whyEl);
  }
  row.appendChild(colC);

  // col 6: outcome badge (hidden on narrow screens via 0px column width)
  const badgeEl = el("span", "badge");
  const colB    = el("div", "col-badge");
  colB.appendChild(badgeEl);
  row.appendChild(colB);

  row.addEventListener("click", () => row.classList.toggle("open"));
  return { el: row, level, distEl, badgeEl, fill };
}

function applyOutcome(entry) {
  const v = outcomeView(entry.level);
  entry.el.classList.toggle("broke",    v.cls === "broke");
  entry.el.classList.toggle("grinding", v.cls === "grinding");
  entry.el.classList.toggle("testing",  v.cls === "testing");
  entry.badgeEl.className   = `badge ${v.cls}`;
  entry.badgeEl.textContent = v.text;
}

function paintDist(entry, spot) {
  if (typeof spot !== "number") { entry.distEl.textContent = ""; return; }
  const d   = entry.level.strike - spot;
  const pct = spot ? (d / spot) * 100 : 0;
  entry.distEl.textContent = `${signed(d, 1)} · ${signed(pct, 1)}%`;
}

// ── metrics strip ─────────────────────────────────────────────────────────────
function renderHeroMetrics(data) {
  const m = $("#heroMetrics");
  m.replaceChildren();
  const reg = data.regime || "";
  const cells = [];
  if (reg) cells.push({ k: "GEX", v: reg === "positive" ? "POS" : reg === "negative" ? "NEG" : reg.toUpperCase(), cls: reg === "positive" ? "pos" : reg === "negative" ? "neg" : "" });
  if (typeof data.expected_move === "number") cells.push({ k: "Exp Move", v: `±${data.expected_move.toFixed(1)}`, cls: "" });
  if (data.session) cells.push({ k: "Session", v: data.session, cls: "" });
  for (const c of cells) {
    const item = el("div", "mitem");
    item.appendChild(el("span", "mk", c.k));
    item.appendChild(el("span", `mv ${c.cls}`.trim(), c.v));
    m.appendChild(item);
  }
}

function renderHeroIv(data) {
  const iv = $("#heroIv");
  iv.replaceChildren();
  if (data.iv && typeof data.iv.current === "number") {
    const dir   = (data.iv.direction || "").toUpperCase();
    const arrow = dir.startsWith("RIS") ? "▲" : dir.startsWith("FALL") ? "▼" : "→";
    const item  = el("div", "mitem");
    item.appendChild(el("span", "mk", "IV"));
    item.appendChild(el("span", dir.startsWith("RIS") ? "mv warn" : "mv", `${data.iv.current.toFixed(1)} ${arrow}`));
    iv.appendChild(item);
  }
  const method = data.scoring_method === "rule" ? "rule" : "ai";
  const mitem  = el("div", "mitem");
  mitem.appendChild(el("span", `method-tag${method === "rule" ? " rule" : ""}`, method === "rule" ? "manual" : "ai scored"));
  iv.appendChild(mitem);
}

// ── repaint ───────────────────────────────────────────────────────────────────
function repaintLive() {
  if (!lastData) return;
  const spot = currentSpot();
  const live = typeof liveSpot === "number";

  $("#heroSpot").textContent = fmtSpot(spot);

  const chg = $("#heroChg");
  if (typeof spot === "number" && typeof lastData.spot === "number") {
    const d   = spot - lastData.spot;
    const pct = lastData.spot ? (d / lastData.spot) * 100 : 0;
    chg.className   = `spotchg ${d > 0.005 ? "up" : d < -0.005 ? "down" : "flat"}`;
    chg.textContent = `${signed(d)} (${signed(pct)}%)`;
  } else {
    chg.textContent = "";
  }

  $("#heroSrc").textContent = [
    live ? "live" : "last print",
    lastData.session,
    lastData.session === "Asia" ? "NQ-equiv" : null,
  ].filter(Boolean).join(" · ");

  const rail = $("#spotrail");
  if (typeof spot === "number") {
    rail.hidden = false;
    const rt = $("#railTag");
    rt.replaceChildren(el("small", null, live ? "LIVE" : "SPOT"));
    rt.append(fmtSpot(spot));
  } else {
    rail.hidden = true;
  }

  for (const e of rungEls) { paintDist(e, spot); applyOutcome(e); }
  renderLevelMap(lastData, spot);
  renderGexChart(lastData.gex_profile, spot);
}

// ── banner ────────────────────────────────────────────────────────────────────
function renderBanner(data) {
  const b = $("#banner");
  if (data?.scoring_method === "rule" && !boardStale()) {
    b.hidden = false;
    b.replaceChildren(el("span", "banner-dot"), el("span", "", `Manual scored (AI unavailable) — rule-based levels, refreshed ${scoredAgo()}. Spot & reversals are live.`));
    return;
  }
  if (!boardStale()) { b.hidden = true; return; }
  b.hidden = false;
  const text = isRthNow()
    ? `Levels last scored ${scoredAgo()} — AI scoring paused (box offline). Spot & reversals are live.`
    : `Outside market hours — holding levels from the last RTH session (scored ${scoredAgo()}). Spot & reversals are live.`;
  b.replaceChildren(el("span", "banner-dot"), el("span", "", text));
}

// ── render ────────────────────────────────────────────────────────────────────
function render(data) {
  renderBanner(data);
  const stale   = boardStale();
  const offline = stale && isRthNow();
  const rule    = !stale && data?.scoring_method === "rule";

  $("#statusDot").className    = `status-dot ${stale ? "stale" : rule ? "rule" : "live"}`;
  $("#statusText").textContent  = !stale
    ? (rule ? "rule scored" : "live")
    : isRthNow() ? `scored ${scoredAgo()}` : "held · off-rth";

  renderHeroMetrics(data);
  renderHeroIv(data);

  const rw = $("#readWrap");
  if (data.read) { rw.hidden = false; $("#heroRead").textContent = data.read; }
  else           { rw.hidden = true; }

  const levels = Array.isArray(data.levels) ? data.levels : [];
  const ceil   = $("#ceilings"), floor = $("#floors");
  ceil.replaceChildren(); floor.replaceChildren(); rungEls = [];

  $("#ladderGrid").classList.toggle("prev", offline);

  if (!levels.length) {
    $("#ladderGrid").hidden = true;
    $("#spotrail").hidden   = true;
    const empty = $("#empty");
    empty.hidden = false;
    empty.replaceChildren(el("b", null, "No board yet."), document.createElement("br"));
    empty.append("Run a capture to map the levels.");
    $("#asOf").textContent = "";
    renderLevelMap(data, currentSpot());
    renderGexChart(data.gex_profile, currentSpot());
    return;
  }

  $("#ladderGrid").hidden = false;
  $("#empty").hidden      = true;

  const res = levels.filter(l => l.side === "resistance").sort((a, b) => b.strike - a.strike);
  const sup = levels.filter(l => l.side === "support").sort((a, b) => b.strike - a.strike);

  const ceilCount  = $("#ceilCount");
  const floorCount = $("#floorCount");
  if (ceilCount)  ceilCount.textContent  = res.length ? String(res.length) : "";
  if (floorCount) floorCount.textContent = sup.length ? String(sup.length) : "";

  for (const l of res) { const e = buildRung(l); ceil.appendChild(e.el);  rungEls.push(e); }
  for (const l of sup) { const e = buildRung(l); floor.appendChild(e.el); rungEls.push(e); }

  renderLevelMap(data, currentSpot());
  renderGexChart(data.gex_profile, currentSpot());
  if (candleData) renderCandleChart(candleData);

  requestAnimationFrame(() =>
    rungEls.forEach((e, i) =>
      setTimeout(() => (e.fill.style.width = `${clamp(e.level.reversal_prob, 0, 100)}%`), 40 + i * 50)));

  repaintLive();
  $("#asOf").textContent = `${data?.scoring_method === "rule" ? "rule scored" : "scored"} ${scoredAgo()}`;
}

// ── data ──────────────────────────────────────────────────────────────────────
async function load() {
  try {
    const res = await fetch(`dashboard.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    lastData = await res.json();
    render(lastData);
  } catch {
    $("#statusText").textContent = "no data";
    $("#statusDot").className    = "status-dot";
    $("#banner").hidden          = true;
    $("#ladderGrid").hidden      = true;
    const empty = $("#empty");
    empty.hidden      = false;
    empty.textContent = "Waiting for dashboard.json — run a capture.";
  }
}

async function loadSpot() {
  try {
    const res = await fetch(`${SPOT_URL}?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    if (typeof j.spot === "number") {
      liveSpot   = j.spot;
      liveSpotAt = j.at || new Date().toISOString();
      pushSparkPoint(liveSpot);
      drawSparkline();
      repaintLive();
    }
  } catch { /* offline / LAN — use scored spot */ }
}

// ── init ──────────────────────────────────────────────────────────────────────
$("#refresh").addEventListener("click", () => { load(); loadSpot(); loadCandles(); });
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) { load(); loadSpot(); loadCandles(); }
});

load();
loadSpot();
loadCandles();
setInterval(load,        POLL_MS);
setInterval(loadSpot,    SPOT_MS);
setInterval(loadCandles, CANDLE_MS);
