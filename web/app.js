const POLL_MS     = 60_000;
const SPOT_MS     = 60_000;
const CANDLE_MS   = 5 * 60_000;
const NARR_MS     = 5 * 60_000;
const STALE_MS    = 30 * 60_000;
const SPOT_URL    = "/.netlify/functions/spot";
const CANDLES_URL = "/.netlify/functions/altaris-candles";
const NARR_URL    = "narrative.json";

// ── palette (kept in sync with styles.css) ──
const C = {
  ink:  "#111210",
  ink2: "#5c5b56",
  ink3: "#9b9a93",
  line: "#e3e2dc",
  line2:"#cdccc4",
  red:  "#e60023",
  blue: "#1f5fd0",
  green:"#1c7a52",
  paper:"#f1f1ee",
};

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

const NS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

// ── BACKGROUND — HUD blueprint: grid, ruler, watermark, radar, scan, telemetry ───
function initBackground() {
  const canvas = $("#bg");
  if (!canvas) return;
  const reduce = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const ctx = canvas.getContext("2d");
  let W = 0, H = 0, dpr = 1;

  const GRID = 44;
  let ticks = [];    // slow-drifting crosshair ticks
  let bits  = [];    // faint floating binary/hex glyphs

  function seed() {
    ticks = Array.from({ length: 26 }, () => ({
      x: Math.random() * W, y: Math.random() * H,
      vy: 5 + Math.random() * 10,
      red: Math.random() < 0.22,
      s: 2 + Math.random() * 3,
    }));
    bits = Array.from({ length: 22 }, () => ({
      x: Math.random() * W, y: Math.random() * H,
      vy: 8 + Math.random() * 16,
      ch: Math.random() < 0.5 ? (Math.random() < 0.5 ? "0" : "1") : "0123456789ABCDEF"[Math.floor(Math.random() * 16)],
    }));
  }
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W + "px"; canvas.style.height = H + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    seed();
  }

  const pad = (n, w) => String(n).padStart(w, "0");

  let last = performance.now();
  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.05); last = now;
    ctx.clearRect(0, 0, W, H);

    // ── grid: minor + major lines, slow vertical drift ──
    const off = (now * 0.006) % GRID;
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(17,18,16,0.08)";
    ctx.beginPath();
    for (let x = 0; x <= W; x += GRID) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, H); }
    for (let y = -off; y <= H; y += GRID) { ctx.moveTo(0, y + 0.5); ctx.lineTo(W, y + 0.5); }
    ctx.stroke();
    ctx.strokeStyle = "rgba(17,18,16,0.13)";
    ctx.beginPath();
    for (let x = 0, i = 0; x <= W; x += GRID, i++) if (i % 4 === 0) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, H); }
    for (let y = -off, j = 0; y <= H; y += GRID, j++) if (j % 4 === 0) { ctx.moveTo(0, y + 0.5); ctx.lineTo(W, y + 0.5); }
    ctx.stroke();

    // ── big vertical 鳥居 watermark on the right gutter ──
    ctx.save();
    ctx.fillStyle = "rgba(17,18,16,0.06)";
    const wm = Math.min(W, H) * 0.34;
    ctx.font = `700 ${wm}px "Noto Sans JP", sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    const wmx = W > 760 ? W - wm * 0.62 : W * 0.5;
    ctx.fillText("鳥", wmx, H * 0.5 - wm * 0.56);
    ctx.fillText("居", wmx, H * 0.5 + wm * 0.56);
    ctx.restore();

    // ── left-edge ruler ──
    ctx.strokeStyle = "rgba(17,18,16,0.16)";
    ctx.fillStyle   = "rgba(17,18,16,0.28)";
    ctx.font = '8px "JetBrains Mono", monospace';
    ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.lineWidth = 1;
    for (let y = 0, i = 0; y <= H; y += 22, i++) {
      const major = i % 5 === 0;
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5); ctx.lineTo(major ? 9 : 5, y + 0.5);
      ctx.stroke();
      if (major) ctx.fillText(pad(i * 22, 4), 13, y);
    }

    // ── radar sweep, top-right ──
    const rcx = W > 760 ? W - 96 : W - 60;
    const rcy = 110, rr = W > 760 ? 60 : 40;
    ctx.strokeStyle = "rgba(230,0,35,0.16)";
    ctx.lineWidth = 1;
    for (const f of [0.4, 0.7, 1]) { ctx.beginPath(); ctx.arc(rcx, rcy, rr * f, 0, Math.PI * 2); ctx.stroke(); }
    ctx.beginPath(); ctx.moveTo(rcx - rr, rcy); ctx.lineTo(rcx + rr, rcy);
    ctx.moveTo(rcx, rcy - rr); ctx.lineTo(rcx, rcy + rr); ctx.stroke();
    const ang = (now * 0.0009) % (Math.PI * 2);
    const sweep = ctx.createLinearGradient(rcx, rcy, rcx + Math.cos(ang) * rr, rcy + Math.sin(ang) * rr);
    sweep.addColorStop(0, "rgba(230,0,35,0.34)");
    sweep.addColorStop(1, "rgba(230,0,35,0)");
    ctx.strokeStyle = sweep; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(rcx, rcy); ctx.lineTo(rcx + Math.cos(ang) * rr, rcy + Math.sin(ang) * rr); ctx.stroke();

    // ── horizontal scan beam ──
    const beamY = ((now * 0.02) % (H + 240)) - 120;
    const bg = ctx.createLinearGradient(0, beamY - 110, 0, beamY + 110);
    bg.addColorStop(0,   "rgba(230,0,35,0)");
    bg.addColorStop(0.5, "rgba(230,0,35,0.06)");
    bg.addColorStop(1,   "rgba(230,0,35,0)");
    ctx.fillStyle = bg;
    ctx.fillRect(0, beamY - 110, W, 220);
    ctx.fillStyle = "rgba(230,0,35,0.14)";
    ctx.fillRect(0, beamY, W, 1);

    // ── floating hex/binary glyphs ──
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.fillStyle = "rgba(17,18,16,0.12)";
    ctx.textAlign = "left"; ctx.textBaseline = "middle";
    for (const b of bits) {
      b.y += b.vy * dt;
      if (b.y > H + 6) { b.y = -6; b.x = Math.random() * W; }
      ctx.fillText(b.ch, b.x, b.y);
    }

    // ── drifting crosshair ticks ──
    ctx.lineWidth = 1;
    for (const t of ticks) {
      t.y += t.vy * dt;
      if (t.y > H + 8) { t.y = -8; t.x = Math.random() * W; }
      ctx.strokeStyle = t.red ? "rgba(230,0,35,0.26)" : "rgba(17,18,16,0.16)";
      ctx.beginPath();
      ctx.moveTo(t.x - t.s, t.y); ctx.lineTo(t.x + t.s, t.y);
      ctx.moveTo(t.x, t.y - t.s); ctx.lineTo(t.x, t.y + t.s);
      ctx.stroke();
    }

    // ── viewport corner brackets + telemetry ──
    const m = 14, L = 16;
    ctx.strokeStyle = "rgba(230,0,35,0.4)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(m, m + L); ctx.lineTo(m, m); ctx.lineTo(m + L, m);
    ctx.moveTo(W - m - L, m); ctx.lineTo(W - m, m); ctx.lineTo(W - m, m + L);
    ctx.moveTo(W - m, H - m - L); ctx.lineTo(W - m, H - m); ctx.lineTo(W - m - L, H - m);
    ctx.moveTo(m + L, H - m); ctx.lineTo(m, H - m); ctx.lineTo(m, H - m - L);
    ctx.stroke();

    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.fillStyle = "rgba(17,18,16,0.3)";
    const t10 = Math.floor(now / 100);
    ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    ctx.fillText(`SYS ${pad(t10 % 100000, 5)}`, m + L + 8, m + 4);
    ctx.textAlign = "right";
    ctx.fillText(`SCAN ${pad(Math.floor(beamY < 0 ? 0 : beamY), 4)}`, W - m - L - 8, m + 4);
    ctx.textAlign = "left";
    ctx.fillText("TORII//QQQ", m + L + 8, H - m - 6);
    ctx.textAlign = "right";
    ctx.fillText(`FPS ${pad(Math.round(1 / Math.max(dt, .001)), 2)}`, W - m - L - 8, H - m - 6);

    if (!reduce) requestAnimationFrame(frame);
  }

  resize();
  window.addEventListener("resize", () => { resize(); if (reduce) frame(performance.now()); });
  frame(performance.now());  // reduced-motion → one static render; otherwise this kicks off the loop
}

// ── clock ───────────────────────────────────────────────────────────────────────
function tickClock() {
  const c = $("#clock");
  if (!c) return;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(new Date());
  c.textContent = `${parts} ET`;
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
  const H = canvas.offsetHeight || 60;
  canvas.width  = W * devicePixelRatio;
  canvas.height = H * devicePixelRatio;
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const pts = sparkHistory;
  if (pts.length < 2) return;
  const vals = pts.map(p => p.v);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const range = hi - lo || 0.01;
  const px = (i) => (i / (pts.length - 1)) * (W - 2) + 1;
  const py = (v)  => H - 3 - ((v - lo) / range) * (H - 8);

  // fill
  ctx.beginPath();
  ctx.moveTo(px(0), py(pts[0].v));
  for (let i = 1; i < pts.length; i++) ctx.lineTo(px(i), py(pts[i].v));
  ctx.lineTo(px(pts.length - 1), H);
  ctx.lineTo(px(0), H);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, "rgba(230,0,35,.12)");
  grad.addColorStop(1, "rgba(230,0,35,0)");
  ctx.fillStyle = grad;
  ctx.fill();

  // line
  ctx.beginPath();
  ctx.moveTo(px(0), py(pts[0].v));
  for (let i = 1; i < pts.length; i++) ctx.lineTo(px(i), py(pts[i].v));
  ctx.strokeStyle = C.red;
  ctx.lineWidth   = 1.5;
  ctx.lineJoin    = "round";
  ctx.stroke();

  const last = pts[pts.length - 1];
  ctx.beginPath();
  ctx.arc(px(pts.length - 1), py(last.v), 2.6, 0, Math.PI * 2);
  ctx.fillStyle = C.red;
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

  const W = 400, H = 150, MT = 12, MB = 20, ML = 36, MR = 8;
  const IW = W - ML - MR, IH = H - MT - MB;
  const maxAbs = Math.max(...gexProfile.map(p => Math.abs(p.gex_m)), 1);
  const n      = gexProfile.length;
  const barW   = Math.max(2, Math.floor(IW / n) - 1);
  const midY   = MT + IH / 2;

  svg.appendChild(svgEl("line", { x1: ML, y1: midY, x2: W - MR, y2: midY, stroke: C.line2, "stroke-width": 1 }));

  gexProfile.forEach((p, i) => {
    const x    = ML + (i / n) * IW + (IW / n - barW) / 2;
    const frac = p.gex_m / maxAbs;
    const barH = Math.abs(frac) * (IH / 2 - 2);
    const isPos = p.gex_m >= 0;
    const color = isPos ? C.red : C.ink;
    const y = isPos ? midY - barH : midY;
    svg.appendChild(svgEl("rect", { x, y, width: barW, height: Math.max(1, barH), fill: color, opacity: 0.5 }));
  });

  if (typeof spot === "number" && gexProfile.length > 1) {
    const strikes = gexProfile.map(p => p.strike);
    const slo = strikes[0], shi = strikes[strikes.length - 1], sr = shi - slo || 1;
    const sx = ML + ((spot - slo) / sr) * IW;
    if (sx >= ML && sx <= W - MR) {
      svg.appendChild(svgEl("line", { x1: sx, y1: MT, x2: sx, y2: H - MB, stroke: C.red, "stroke-width": 1.5, "stroke-dasharray": "4 2" }));
    }
  }

  const axLbl = svgEl("text", { x: ML - 3, y: midY + 3.5, "text-anchor": "end", fill: C.ink3, "font-family": "JetBrains Mono,monospace", "font-size": 8 });
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
  const W = 400, H = 150, MT = 8, MB = 20, ML = 42, MR = 6;
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
    const color = bull ? C.ink : C.red;
    const bodyTop = py(Math.max(o, c));
    const bodyBot = py(Math.min(o, c));
    const bodyH   = Math.max(1, bodyBot - bodyTop);
    const mx = x + bw / 2;
    svg.appendChild(svgEl("line", { x1: mx, y1: py(h), x2: mx, y2: py(l), stroke: color, "stroke-width": 0.8, opacity: 0.6 }));
    svg.appendChild(svgEl("rect", { x: x + bw * 0.15, y: bodyTop, width: bw * 0.7, height: bodyH, fill: color, opacity: 0.85 }));
  });

  const vwapD = vwapPts.map((v, i) => `${i === 0 ? "M" : "L"}${(ML + i * bw + bw / 2).toFixed(1)},${py(v).toFixed(1)}`).join(" ");
  svg.appendChild(svgEl("path", { d: vwapD, fill: "none", stroke: C.ink2, "stroke-width": 1.4, opacity: 0.8, "stroke-dasharray": "3 2" }));

  for (let i = 0; i <= 4; i++) {
    const v = lo + (prange * i) / 4;
    const y = py(v);
    svg.appendChild(svgEl("line", { x1: ML, y1: y, x2: W - MR, y2: y, stroke: C.line, "stroke-width": 0.5 }));
    const lbl = svgEl("text", { x: ML - 3, y: y + 3.5, "text-anchor": "end", fill: C.ink3, "font-family": "JetBrains Mono,monospace", "font-size": 8 });
    lbl.textContent = v.toFixed(1);
    svg.appendChild(lbl);
  }

  const sub = $("#candleChartSub");
  if (sub) sub.textContent = `${bars.length} bars · vwap`;
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
  const W = 420, H = 78, ML = 40, MR = 40;

  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.appendChild(svgEl("line", { x1: ML, y1: H / 2, x2: W - MR, y2: H / 2, stroke: C.line2, "stroke-width": 1 }));

  for (const l of levels) {
    const x = ML + ((l.strike - pLo) / range) * (W - ML - MR);
    const isRes = l.side === "resistance";
    const col  = isRes ? C.red : C.ink;
    const prob = l.reversal_prob / 100;
    const tkH  = 8 + prob * 20;
    const y1 = isRes ? H / 2 - tkH : H / 2;
    const y2 = isRes ? H / 2 : H / 2 + tkH;
    svg.appendChild(svgEl("rect", { x: x - 1.5, y: y1, width: 3, height: y2 - y1, fill: col, opacity: 0.28 + prob * 0.6 }));
    const lbl = svgEl("text", { x, y: isRes ? y1 - 3 : y2 + 8, "text-anchor": "middle", "font-family": "JetBrains Mono,monospace", "font-size": 7, fill: col });
    lbl.textContent = l.strike % 1 === 0 ? String(l.strike) : l.strike.toFixed(1);
    svg.appendChild(lbl);
  }

  if (typeof spot === "number") {
    const sx = ML + ((spot - pLo) / range) * (W - ML - MR);
    svg.appendChild(svgEl("line", { x1: sx, y1: 4, x2: sx, y2: H - 4, stroke: C.red, "stroke-width": 1.5, "stroke-dasharray": "3 2" }));
    const sLbl = svgEl("text", { x: sx, y: H - 1, "text-anchor": "middle", "font-family": "JetBrains Mono,monospace", "font-size": 7, fill: C.red, "font-weight": 600 });
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
function buildRung(level, i) {
  const isRes = level.side === "resistance";
  const row   = el("div", `rung ${isRes ? "res" : "sup"}`);
  row.style.setProperty("--i", i);

  // top row: [strike + dist] [react + meter] [prob%] [badge]
  const top = el("div", "rung-top");

  const sb = el("div", "strike-block");
  sb.appendChild(el("span", "strike", fmtPrice(level.strike)));
  const distEl = el("span", "dist");
  sb.appendChild(distEl);
  top.appendChild(sb);

  const mb = el("div", "meter-block");
  const react = level.reaction || "mixed";
  mb.appendChild(el("span", `react ${react}`, react.toUpperCase()));
  const track = el("div", "prob-track");
  const fill  = el("span");
  track.appendChild(fill);
  mb.appendChild(track);
  top.appendChild(mb);

  const prob = el("span", "prob-num", String(level.reversal_prob));
  prob.appendChild(el("i", null, "%"));
  top.appendChild(prob);

  const badgeEl = el("span", "badge");
  top.appendChild(badgeEl);
  row.appendChild(top);

  // tags
  const tags = Array.isArray(level.tags) ? level.tags.slice(0, 4) : [];
  if (tags.length) row.appendChild(el("div", "rung-tags", tags.join("  /  ")));

  // why + target
  if (level.why) {
    const why = el("div", "rung-why", level.why);
    if (level.target_strike != null) {
      why.appendChild(el("span", "target-inline", `  →  ${fmtPrice(level.target_strike)}`));
    }
    row.appendChild(why);
  }

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

// ── metrics ─────────────────────────────────────────────────────────────────--
function renderMetrics(data) {
  const m = $("#metricsRow");
  m.replaceChildren();
  const reg = data.regime || "";
  const cells = [];
  if (reg) cells.push({ k: "Gamma", v: reg === "positive" ? "Positive" : reg === "negative" ? "Negative" : reg, cls: reg === "negative" ? "neg" : reg === "positive" ? "pos" : "" });
  if (typeof data.expected_move === "number") cells.push({ k: "Exp Move", v: `±${data.expected_move.toFixed(1)}`, cls: "" });
  if (data.iv && typeof data.iv.current === "number") {
    const dir   = (data.iv.direction || "").toUpperCase();
    const arrow = dir.startsWith("RIS") ? "▲" : dir.startsWith("FALL") ? "▼" : "→";
    cells.push({ k: "IV", v: `${data.iv.current.toFixed(1)} ${arrow}`, cls: "" });
  }
  if (data.session) cells.push({ k: "Session", v: data.session, cls: "" });

  for (const c of cells) {
    const item = el("div", "metric");
    item.appendChild(el("span", "mk", c.k));
    item.appendChild(el("span", `mv ${c.cls}`.trim(), c.v));
    m.appendChild(item);
  }
  m.appendChild(el("span", "metric-spacer"));
  const method = data.scoring_method === "rule" ? "rule" : "ai";
  m.appendChild(el("span", `method-tag${method === "rule" ? " rule" : ""}`, method === "rule" ? "MANUAL" : "AI SCORED"));
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
    chg.textContent = `${d >= 0 ? "▲" : "▼"} ${signed(d)} · ${signed(pct)}%`;
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
    rt.replaceChildren(el("small", null, live ? "現値 LIVE" : "SPOT"));
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

  renderMetrics(data);

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
  if (ceilCount)  ceilCount.textContent  = res.length ? `${res.length}` : "";
  if (floorCount) floorCount.textContent = sup.length ? `${sup.length}` : "";

  res.forEach((l, i) => { const e = buildRung(l, i); ceil.appendChild(e.el);  rungEls.push(e); });
  sup.forEach((l, i) => { const e = buildRung(l, i); floor.appendChild(e.el); rungEls.push(e); });

  renderLevelMap(data, currentSpot());
  renderGexChart(data.gex_profile, currentSpot());
  if (candleData) renderCandleChart(candleData);

  requestAnimationFrame(() =>
    rungEls.forEach((e, i) =>
      setTimeout(() => (e.fill.style.width = `${clamp(e.level.reversal_prob, 0, 100)}%`), 220 + i * 60)));

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

// ── narrative tab ───────────────────────────────────────────────────────────────
let narrData = null;

const OPEN_TYPE_TONE = {
  manip_down_real_up: "bull", manip_up_real_down: "bear",
  real_pump: "bull", real_dump: "bear", unclear: "",
};

function narrAgo(n) {
  const t = typeof n?.scored_at === "number" ? n.scored_at : Date.parse(n?.generated_at ?? "");
  return agoMs(t);
}

function renderNarrative(n) {
  const hero = $("#narrHero");
  if (!n || !n.open_type) {
    hero.replaceChildren(el("div", "narr-empty"));
    hero.querySelector(".narr-empty").innerHTML =
      'No narrative yet. It generates automatically before the open (≈09:00 ET), or run <code>npm run narrative</code>.';
    for (const id of ["#narrOpen", "#narrMacro", "#narrZones"]) $(id).replaceChildren();
    $("#narrSummaryWrap").hidden = true;
    $("#narrFeedWrap").hidden = true;
    return;
  }

  // verdict hero
  const biasTone = n.macro_bias === "bullish" ? "bull" : n.macro_bias === "bearish" ? "bear" : "";
  const dirTone  = n.expansion_direction === "up" ? "up" : n.expansion_direction === "down" ? "down" : "";
  hero.replaceChildren();
  const v = el("div", "verdict");
  const cell = (k, val, cls, sub) => {
    const c = el("div", "verdict-cell");
    c.appendChild(el("span", "vk", k));
    c.appendChild(el("div", `vv ${cls}`.trim(), val));
    if (sub) c.appendChild(el("div", "vsub", sub));
    return c;
  };
  v.appendChild(cell("Macro Bias", n.macro_bias.toUpperCase(), biasTone,
    typeof n.macro_bias_score === "number" ? `score ${n.macro_bias_score > 0 ? "+" : ""}${n.macro_bias_score}` : ""));
  v.appendChild(cell("Expansion", n.expansion_direction.toUpperCase(), dirTone, "true open direction"));
  v.appendChild(cell("Day Type", n.clean_or_choppy.toUpperCase(), "", n.scoring_method === "ai" ? `scored ${narrAgo(n)}` : "rule-based"));
  hero.appendChild(v);

  // open type
  const open = $("#narrOpen");
  open.replaceChildren();
  const otTone = OPEN_TYPE_TONE[n.open_type] || "";
  const otHead = el("div", `vv ${otTone}`.trim(), n.open_type_label || n.open_type);
  otHead.style.fontSize = "17px"; otHead.style.marginBottom = "6px";
  open.appendChild(otHead);
  // Build nodes explicitly — never innerHTML (move_extent/completion_signal are LLM-sourced).
  const line = (k, val, nodes) => {
    if (!nodes && (val == null || val === "")) return;
    const r = el("div", "narr-line");
    r.appendChild(el("span", "nk", k));
    const nv = el("span", "nv");
    if (nodes) for (const node of nodes) nv.appendChild(node);
    else nv.textContent = String(val);
    r.appendChild(nv);
    open.appendChild(r);
  };
  if (n.targeted_level != null) line("Targets", null, [el("b", null, `$${fmtPrice(n.targeted_level)}`)]);
  line("Extent", n.move_extent);
  line("Confirms done", n.completion_signal);
  if (n.next_target != null) line("Then", null, [el("b", null, `$${fmtPrice(n.next_target)}`)]);
  if (n.manipulation_tell) {
    const tell = el("div", "tell", n.manipulation_tell);
    open.appendChild(tell);
  }

  // macro drivers
  const macro = $("#narrMacro");
  macro.replaceChildren();
  const drivers = Array.isArray(n.macro_drivers) ? n.macro_drivers : [];
  if (!drivers.length) macro.appendChild(el("div", "narr-empty", "No macro drivers reported."));
  for (const d of drivers) {
    const row = el("div", "driver");
    row.appendChild(el("span", "dk", d.label));
    row.appendChild(el("span", "dv", d.reading));
    row.appendChild(el("span", `lean ${d.lean === "bull" ? "bull" : d.lean === "bear" ? "bear" : ""}`.trim(), d.lean || "—"));
    macro.appendChild(row);
  }

  // reversal zones
  const zones = $("#narrZones");
  zones.replaceChildren();
  const zs = Array.isArray(n.reversal_zones) ? n.reversal_zones : [];
  if (!zs.length) zones.appendChild(el("div", "narr-empty", "No reversal zones flagged."));
  for (const z of zs) {
    const row = el("div", `zone ${z.side === "resistance" ? "resistance" : "support"}`);
    row.appendChild(el("span", "zone-tick"));
    row.appendChild(el("span", "zone-price", `$${fmtPrice(z.price)}`));
    row.appendChild(el("span", "zone-side", z.side === "resistance" ? "抵抗 RES" : "支持 SUP"));
    row.appendChild(el("span", "zone-note", z.note || ""));
    zones.appendChild(row);
  }

  // summary
  if (n.summary) { $("#narrSummaryWrap").hidden = false; $("#narrSummary").textContent = n.summary; }
  else $("#narrSummaryWrap").hidden = true;

  // macro feed (raw readings)
  const feedWrap = $("#narrFeedWrap"), feed = $("#narrFeed");
  feed.replaceChildren();
  const m = n.macro;
  const fEntries = [];
  if (m?.us2y)   fEntries.push(["US 2Y",  `${m.us2y.last} ${m.us2y.dir}`]);
  if (m?.us10y)  fEntries.push(["US 10Y", `${m.us10y.last} ${m.us10y.dir}`]);
  if (typeof m?.curve2s10s === "number") fEntries.push(["2s10s", `${m.curve2s10s}`]);
  if (m?.usdjpy) fEntries.push(["USD/JPY", `${m.usdjpy.last} ${m.usdjpy.dir}`]);
  if (m?.tga)    fEntries.push(["TGA", `${m.tga.dir}`]);
  if (m?.rrp)    fEntries.push(["RRP", `${m.rrp.dir}`]);
  if (m?.cot)    fEntries.push(["COT", `${m.cot.percentile}th pct`]);
  if (fEntries.length) {
    feedWrap.hidden = false;
    for (const [k, val] of fEntries) {
      const item = el("div", "metric");
      item.appendChild(el("span", "mk", k));
      item.appendChild(el("span", "mv", val));
      feed.appendChild(item);
    }
    if (m?.notes?.length) {
      const note = el("div", "metric");
      note.appendChild(el("span", "mk", "Unavailable"));
      note.appendChild(el("span", "mv", String(m.notes.length)));
      feed.appendChild(note);
    }
  } else feedWrap.hidden = true;
}

async function loadNarrative() {
  try {
    const res = await fetch(`${NARR_URL}?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    narrData = await res.json();
    renderNarrative(narrData);
  } catch {
    renderNarrative(null);
  }
}

// ── tabs ──────────────────────────────────────────────────────────────────────
function setView(view) {
  $("#viewBoard").hidden     = view !== "board";
  $("#viewNarrative").hidden = view !== "narrative";
  for (const t of document.querySelectorAll(".tab")) t.classList.toggle("active", t.dataset.view === view);
  try { localStorage.setItem("torii.view", view); } catch { /* ignore */ }
  if (view === "narrative") loadNarrative();
}
for (const t of document.querySelectorAll(".tab")) {
  t.addEventListener("click", () => setView(t.dataset.view));
}

// ── init ──────────────────────────────────────────────────────────────────────
initBackground();
tickClock();
setInterval(tickClock, 1000);
$("#refresh").addEventListener("click", () => { load(); loadSpot(); loadCandles(); loadNarrative(); });
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) { load(); loadSpot(); loadCandles(); loadNarrative(); }
});

let startView = "board";
try { startView = localStorage.getItem("torii.view") || "board"; } catch { /* ignore */ }
setView(startView);

load();
loadSpot();
loadCandles();
loadNarrative();
setInterval(load,         POLL_MS);
setInterval(loadSpot,     SPOT_MS);
setInterval(loadCandles,  CANDLE_MS);
setInterval(loadNarrative, NARR_MS);
