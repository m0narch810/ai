const POLL_MS     = 60_000;
const SPOT_MS     = 60_000;
const CANDLE_MS   = 5 * 60_000;
const NARR_MS     = 5 * 60_000;
const MACRO_MS    = 5 * 60_000;
const STALE_MS    = 30 * 60_000;
const SPOT_URL    = "/.netlify/functions/spot";
const CANDLES_URL = "/.netlify/functions/altaris-candles";
const BOARD_FN    = "/.netlify/functions/board"; // cloud deterministic board (box-off fallback)
const NARR_URL    = "/.netlify/functions/narrative";
const MACRO_URL   = "/.netlify/functions/macro";

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

// Canvas ink (grid/ticks/glyphs/telemetry) as an "r,g,b" string — flips with the theme.
let bgInkRGB = "17,18,16";
let bgRedRGB = "230,0,35";

const $ = (s) => document.querySelector(s);

/** Re-read the live CSS custom properties into C + bgInkRGB (called on theme change). */
function readPalette() {
  const s = getComputedStyle(document.documentElement);
  const g = (n, fb) => (s.getPropertyValue(n).trim() || fb);
  C.ink = g("--ink", C.ink); C.ink2 = g("--ink2", C.ink2); C.ink3 = g("--ink3", C.ink3);
  C.line = g("--line", C.line); C.line2 = g("--line2", C.line2);
  C.red = g("--red", C.red); C.blue = g("--blue", C.blue); C.green = g("--green", C.green);
  C.paper = g("--bg", C.paper);
  const dark = document.documentElement.dataset.theme === "dark";
  bgInkRGB = dark ? "190,180,158" : "17,18,16";  // warm dim gray ink on charcoal / black ink on paper
  bgRedRGB = dark ? "255,59,82"   : "230,0,35";   // red accent flips with theme (matches --red)
}
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
const ordinal  = (n) => { const v = n % 100; return n + (["th","st","nd","rd"][(v - 20) % 10] || ["th","st","nd","rd"][v] || "th"); };

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
    ctx.strokeStyle = `rgba(${bgInkRGB},0.08)`;
    ctx.beginPath();
    for (let x = 0; x <= W; x += GRID) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, H); }
    for (let y = -off; y <= H; y += GRID) { ctx.moveTo(0, y + 0.5); ctx.lineTo(W, y + 0.5); }
    ctx.stroke();
    ctx.strokeStyle = `rgba(${bgInkRGB},0.13)`;
    ctx.beginPath();
    for (let x = 0, i = 0; x <= W; x += GRID, i++) if (i % 4 === 0) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, H); }
    for (let y = -off, j = 0; y <= H; y += GRID, j++) if (j % 4 === 0) { ctx.moveTo(0, y + 0.5); ctx.lineTo(W, y + 0.5); }
    ctx.stroke();

    // ── big vertical 鳥居 watermark on the right gutter ──
    ctx.save();
    ctx.fillStyle = `rgba(${bgInkRGB},0.06)`;
    const wm = Math.min(W, H) * 0.34;
    ctx.font = `700 ${wm}px "Noto Sans JP", sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    const wmx = W > 760 ? W - wm * 0.62 : W * 0.5;
    ctx.fillText("鳥", wmx, H * 0.5 - wm * 0.56);
    ctx.fillText("居", wmx, H * 0.5 + wm * 0.56);
    ctx.restore();

    // ── left-edge ruler ──
    ctx.strokeStyle = `rgba(${bgInkRGB},0.16)`;
    ctx.fillStyle   = `rgba(${bgInkRGB},0.28)`;
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
    ctx.strokeStyle = `rgba(${bgRedRGB},0.16)`;
    ctx.lineWidth = 1;
    for (const f of [0.4, 0.7, 1]) { ctx.beginPath(); ctx.arc(rcx, rcy, rr * f, 0, Math.PI * 2); ctx.stroke(); }
    ctx.beginPath(); ctx.moveTo(rcx - rr, rcy); ctx.lineTo(rcx + rr, rcy);
    ctx.moveTo(rcx, rcy - rr); ctx.lineTo(rcx, rcy + rr); ctx.stroke();
    const ang = (now * 0.0009) % (Math.PI * 2);
    const sweep = ctx.createLinearGradient(rcx, rcy, rcx + Math.cos(ang) * rr, rcy + Math.sin(ang) * rr);
    sweep.addColorStop(0, `rgba(${bgRedRGB},0.34)`);
    sweep.addColorStop(1, `rgba(${bgRedRGB},0)`);
    ctx.strokeStyle = sweep; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(rcx, rcy); ctx.lineTo(rcx + Math.cos(ang) * rr, rcy + Math.sin(ang) * rr); ctx.stroke();

    // ── horizontal scan beam ──
    const beamY = ((now * 0.02) % (H + 240)) - 120;
    const bg = ctx.createLinearGradient(0, beamY - 110, 0, beamY + 110);
    bg.addColorStop(0,   `rgba(${bgRedRGB},0)`);
    bg.addColorStop(0.5, `rgba(${bgRedRGB},0.06)`);
    bg.addColorStop(1,   `rgba(${bgRedRGB},0)`);
    ctx.fillStyle = bg;
    ctx.fillRect(0, beamY - 110, W, 220);
    ctx.fillStyle = `rgba(${bgRedRGB},0.14)`;
    ctx.fillRect(0, beamY, W, 1);

    // ── floating hex/binary glyphs ──
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.fillStyle = `rgba(${bgInkRGB},0.12)`;
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
      ctx.strokeStyle = t.red ? `rgba(${bgRedRGB},0.26)` : `rgba(${bgInkRGB},0.16)`;
      ctx.beginPath();
      ctx.moveTo(t.x - t.s, t.y); ctx.lineTo(t.x + t.s, t.y);
      ctx.moveTo(t.x, t.y - t.s); ctx.lineTo(t.x, t.y + t.s);
      ctx.stroke();
    }

    // ── viewport corner brackets + telemetry ──
    const m = 14, L = 16;
    ctx.strokeStyle = `rgba(${bgRedRGB},0.4)`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(m, m + L); ctx.lineTo(m, m); ctx.lineTo(m + L, m);
    ctx.moveTo(W - m - L, m); ctx.lineTo(W - m, m); ctx.lineTo(W - m, m + L);
    ctx.moveTo(W - m, H - m - L); ctx.lineTo(W - m, H - m); ctx.lineTo(W - m - L, H - m);
    ctx.moveTo(m + L, H - m); ctx.lineTo(m, H - m); ctx.lineTo(m, H - m - L);
    ctx.stroke();

    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.fillStyle = `rgba(${bgInkRGB},0.3)`;
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

// ── next-open countdown ───────────────────────────────────────────────────────
// Reminder for the two opens that matter: the 18:00 ET futures (re)open (Sunday, and
// Mon–Thu after the daily 17:00–18:00 break) and the 09:30 ET cash open (Mon–Fri).
// Computed in ET wall-clock each tick — accurate to the second except across the two
// annual DST flips (acceptable for a reminder). Market holidays are not modelled.
const MARKET_OPENS = (() => {
  const list = [];
  for (let d = 1; d <= 5; d++) list.push({ dow: d, h: 9,  m: 30, kind: "CASH OPEN · 09:30 ET" });
  for (let d = 0; d <= 4; d++) list.push({ dow: d, h: 18, m: 0,  kind: "FUTURES OPEN · 18:00 ET" });
  return list;
})();

function etNowParts() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const g = (t) => parts.find((p) => p.type === t)?.value ?? "0";
  const dow = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[g("weekday")] ?? 0;
  const hour = parseInt(g("hour"), 10) % 24; // hour12:false can emit "24" at midnight
  return { dow, hour, min: parseInt(g("minute"), 10), sec: parseInt(g("second"), 10) };
}

function tickOpenCountdown() {
  const elTime = $("#ocTime"), elKind = $("#ocKind");
  if (!elTime || !elKind) return;
  const { dow, hour, min, sec } = etNowParts();
  const nowSec = dow * 86400 + hour * 3600 + min * 60 + sec;
  const WEEK = 7 * 86400;
  let best = null;
  for (const o of MARKET_OPENS) {
    let delta = (o.dow * 86400 + o.h * 3600 + o.m * 60) - nowSec;
    if (delta <= 0) delta += WEEK; // already passed this week → next week's occurrence
    if (!best || delta < best.delta) best = { delta, o };
  }
  if (!best) return;
  const d = Math.floor(best.delta / 86400);
  const hh = Math.floor((best.delta % 86400) / 3600);
  const mm = Math.floor((best.delta % 3600) / 60);
  const ss = Math.floor(best.delta % 60);
  const p2 = (n) => String(n).padStart(2, "0");
  elTime.textContent = (d > 0 ? `${d}d ` : "") + `${p2(hh)}:${p2(mm)}:${p2(ss)}`;
  elKind.textContent = best.o.kind;
}

// ── feed refresh timers ───────────────────────────────────────────────────────
// Each load function sets feedNext.X = Date.now() + interval at its start,
// so the countdown always reflects time until the NEXT fire of that source.
const feedNext = { spot: 0, board: 0, candles: 0, narr: 0, regime: 0, macro: 0 };

function fmtFeed(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s === 0) return "now";
  if (s < 60)  return `${s}s`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function tickFeedTimers() {
  const now = Date.now();
  const set = (id, next) => { const e = $(id); if (e) e.textContent = fmtFeed(next - now); };
  set("#feedSpot",    feedNext.spot);
  set("#feedBoard",   feedNext.board);
  set("#feedCandles", feedNext.candles);
  set("#feedNarr",    feedNext.narr);
  set("#feedRegime",  feedNext.regime);
  set("#feedMacro",   feedNext.macro);
}

// ── next-score countdown ──────────────────────────────────────────────────────
// Time until the next scheduled scoring tick. Both the local loop (cron */15) and the cloud
// capture function fire on clock-aligned 15-min boundaries (:00/:15/:30/:45). During the RTH
// AI window (09:15–16:00 ET, Mon–Fri) the next boundary is an AI re-score IF the box is online;
// if the board's gone stale (box offline) that same boundary is a *cloud capture* instead — the
// snapshot is saved for `npm run backfill`, but no fresh AI levels print. Outside the window the
// next score is the next session's 09:15 open.
const AI_OPEN_MIN  = 9 * 60 + 15; // 09:15 ET
const AI_CLOSE_MIN = 16 * 60;     // 16:00 ET (inclusive — the close-tick still scores)
const SCORE_STEP   = 15;          // minutes between ticks (matches SCORE_INTERVAL_MIN + capture cron)

function secsToNextAiOpen({ dow, hour, min, sec }) {
  const nowSec = dow * 86400 + hour * 3600 + min * 60 + sec;
  const WEEK = 7 * 86400;
  let best = Infinity;
  for (let d = 1; d <= 5; d++) {           // Mon–Fri
    let t = d * 86400 + AI_OPEN_MIN * 60 - nowSec;
    if (t <= 0) t += WEEK;                  // already passed this week → next week
    if (t < best) best = t;
  }
  return best;
}

// → { delta: seconds, mode: "tick" | "session" }
function nextScoreInfo() {
  const p = etNowParts();
  const curMin = p.hour * 60 + p.min;
  const inWindow = p.dow >= 1 && p.dow <= 5 && curMin >= AI_OPEN_MIN && curMin <= AI_CLOSE_MIN;
  if (inWindow) {
    const nextBoundaryMin = curMin - (p.min % SCORE_STEP) + SCORE_STEP; // next :00/:15/:30/:45
    if (nextBoundaryMin <= AI_CLOSE_MIN) {
      return { delta: (nextBoundaryMin - curMin) * 60 - p.sec, mode: "tick" };
    }
  }
  return { delta: secsToNextAiOpen(p), mode: "session" }; // past today's close / off-hours
}

function tickNextScore() {
  const elT = $("#nsTime"), elL = $("#nsLabel"), wrap = $("#nextScore");
  if (!elT || !elL) return;
  const { delta, mode } = nextScoreInfo();
  const d = Math.floor(delta / 86400);
  const hh = Math.floor((delta % 86400) / 3600);
  const mm = Math.floor((delta % 3600) / 60);
  const ss = Math.floor(delta % 60);
  const p2 = (n) => String(n).padStart(2, "0");
  elT.textContent = (d > 0 ? `${d}d ` : "") + (d > 0 || hh > 0 ? `${p2(hh)}:` : "") + `${p2(mm)}:${p2(ss)}`;

  // Online → AI score. Showing the cloud rule board (box offline) → the next tick recomputes
  // calculated levels. Box stale with no cloud board yet → the next tick is just a capture.
  const cloudRule = (lastData?.scoring_method === "rule") && (lastData?._cloud || lastData?.cloud);
  const calc = mode === "tick" && (cloudRule || boardStale());
  elL.textContent = !calc ? "NEXT AI SCORE" : cloudRule ? "NEXT CALC" : "NEXT CAPTURE";
  if (wrap) wrap.classList.toggle("capture", calc);
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

// Update all "X ago" timestamps every second so they drift live rather than freezing at render time.
function tickAgoStamps() {
  const asOf = $("#asOf");
  if (asOf && lastData) {
    const prefix = lastData.scoring_method === "rule" ? "rule scored" : "scored";
    asOf.textContent = `${prefix} ${scoredAgo()}`;
  }
  const ns = $(".ms-stamp");
  if (ns && narrData?.scoring_method === "ai") ns.textContent = `scored ${narrAgo(narrData)}`;
  // Regime stamp: first .vsub inside #regHero is always the "scored X ago" on the Regime cell.
  const rs = document.querySelector("#regHero .vsub");
  if (rs && regData) rs.textContent = `scored ${regAgo(regData)}`;
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
  grad.addColorStop(0, `rgba(${bgRedRGB},.12)`);
  grad.addColorStop(1, `rgba(${bgRedRGB},0)`);
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
function renderGexChart(gexProfile, spot, expectedMove) {
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

  // x-axis: strike labels under the chart (≤6 evenly spaced)
  const txt = (x, y, s, fill, anchor = "middle", weight) => {
    const t = svgEl("text", { x, y, "text-anchor": anchor, fill, "font-family": "JetBrains Mono,monospace", "font-size": 8 });
    if (weight) t.setAttribute("font-weight", weight);
    t.textContent = s;
    svg.appendChild(t);
  };
  const fmtK = (k) => (k % 1 === 0 ? String(k) : k.toFixed(1));
  const nTicks = Math.min(6, n);
  for (let t = 0; t < nTicks; t++) {
    const idx = nTicks === 1 ? 0 : Math.round((t / (nTicks - 1)) * (n - 1));
    const x = ML + (idx / n) * IW + (IW / n) / 2;
    txt(clamp(x, ML, W - MR), H - 4, fmtK(gexProfile[idx].strike), C.ink3);
  }

  // y-axis sign hints + zero line label
  txt(ML - 3, midY + 3.5, "0", C.ink3, "end");
  txt(ML - 3, MT + 8, "+", C.ink3, "end");
  txt(ML - 3, H - MB - 2, "−", C.ink3, "end");

  // NGA sigma bands (±1σ = ±expected_move, ±2σ = ±2×expected_move) — reference zones
  // drawn as faint vertical bands before the spot marker so the spot line renders on top.
  const strikes = gexProfile.map(p => p.strike);
  const priceToX = (price) => {
    if (n < 2) return null;
    let idxF;
    if (price <= strikes[0]) idxF = 0;
    else if (price >= strikes[n - 1]) idxF = n - 1;
    else { let i = 0; while (i < n - 1 && strikes[i + 1] < price) i++; const span = strikes[i + 1] - strikes[i] || 1; idxF = i + (price - strikes[i]) / span; }
    const x = ML + (idxF / n) * IW + (IW / n) / 2;
    return x >= ML && x <= W - MR ? x : null;
  };
  if (typeof spot === "number" && typeof expectedMove === "number" && expectedMove > 0) {
    for (const [mult, opacity, color] of [[1, 0.10, C.blue], [2, 0.06, C.amber]]) {
      for (const dir of [1, -1]) {
        const x = priceToX(spot + dir * mult * expectedMove);
        if (x != null) {
          svg.appendChild(svgEl("line", { x1: x, y1: MT, x2: x, y2: H - MB, stroke: color, "stroke-width": 1, "stroke-dasharray": "3 3", opacity }));
        }
      }
    }
    // Label the 1σ bands
    const x1up = priceToX(spot + expectedMove), x1dn = priceToX(spot - expectedMove);
    if (x1up != null) txt(clamp(x1up + 3, ML, W - MR - 4), H - MB - 3, "1σ", C.blue, "start");
    if (x1dn != null) txt(clamp(x1dn - 3, ML + 4, W - MR), H - MB - 3, "1σ", C.blue, "end");
  }

  // spot marker + its value — positioned on the SAME index scale as the bars (bars are
  // index-spaced, not value-spaced), so it lines up even when strikes aren't evenly spaced.
  if (typeof spot === "number" && gexProfile.length > 1) {
    const sx = priceToX(spot);
    if (sx != null) {
      svg.appendChild(svgEl("line", { x1: sx, y1: MT, x2: sx, y2: H - MB, stroke: C.red, "stroke-width": 1.5, "stroke-dasharray": "4 2" }));
      txt(clamp(sx, ML + 14, W - MR - 14), MT + 7, spot.toFixed(2), C.red, "middle", 600);
    }
  }

  // color key lives in the panel subtitle, off the plot
  const sub = $("#gexChartSub");
  if (sub) sub.textContent = "red +gex · dark −gex · ┊ spot · blue 1σ · amber 2σ";
}

// ── Candle + VWAP chart ──────────────────────────────────────────────────────
let candleData = null;

async function loadCandles() {
  feedNext.candles = Date.now() + CANDLE_MS;
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

  // Drop malformed bars: a single missing leg falling back to 0 would collapse the price axis.
  const fin = (x) => typeof x === "number" && Number.isFinite(x);
  const bars = candles.slice(-48).filter(b => fin(b.o ?? b.open) && fin(b.h ?? b.high) && fin(b.l ?? b.low) && fin(b.c ?? b.close));
  if (!bars.length) return;
  const W = 400, H = 150, MT = 8, MB = 20, ML = 42, MR = 6;
  const IW = W - ML - MR, IH = H - MT - MB;

  const highs = bars.map(b => b.h ?? b.high);
  const lows  = bars.map(b => b.l ?? b.low);
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

// Per-strike coverage: EVERY near-spot strike with its own reversal score, so a limit at any exact
// strike has a number. The board's curated picks are highlighted; the rest is the full field.
function renderCoverage(data, spot) {
  const wrap = $("#coverageWrap"), grid = $("#coverageGrid");
  if (!wrap || !grid) return;
  const cov = Array.isArray(data?.coverage) ? data.coverage : [];
  if (!cov.length) { wrap.hidden = true; return; }
  wrap.hidden = false;
  grid.replaceChildren();

  const keyOf = (s) => Math.round(s * 10) / 10;
  // Map strike → AI reversal_prob for picked levels (so we can show the regime-adjusted score alongside structure)
  const aiProb = new Map((data.levels || []).map((l) => [keyOf(l.strike), l.reversal_prob]));
  const picks = new Set(aiProb.keys());

  const col = (title, items, sideCls) => {
    const c = el("div", "cov-col");
    c.appendChild(el("div", "cov-col-head", title));
    for (const it of items) {
      const pick = picks.has(keyOf(it.strike));
      const row = el("div",
        `cov-row ${sideCls}${pick ? " pick" : ""}${it.prob < 15 && !pick ? " faint" : ""}`);
      row.appendChild(el("span", "cov-strike", it.strike % 1 === 0 ? String(it.strike) : it.strike.toFixed(1)));
      const bar = el("span", "cov-bar");
      const fill = el("span", "cov-fill");
      fill.style.width = `${clamp(it.prob, 0, 100)}%`;
      bar.appendChild(fill);
      row.appendChild(bar);
      row.appendChild(el("span", "cov-prob", String(it.prob)));
      row.appendChild(el("span", "cov-iv", typeof it.iv === "number" ? `${it.iv}` : "·"));
      // For board picks: surface AI% in the hover tooltip so the regime discount is visible
      const ai = pick ? aiProb.get(keyOf(it.strike)) : undefined;
      const meta = [it.reaction, ai != null ? `AI ${ai}%` : "", typeof it.iv === "number" ? `IV ${it.iv}` : "", ...(it.tags || [])].filter(Boolean).join(" · ");
      if (meta) row.dataset.tip = meta;
      c.appendChild(row);
    }
    return c;
  };

  // Both columns descending by strike (highest at top) — resistance above spot, support below.
  const res = cov.filter((c) => c.side === "resistance").sort((a, b) => b.strike - a.strike);
  const sup = cov.filter((c) => c.side === "support").sort((a, b) => b.strike - a.strike);
  grid.appendChild(col("抵抗 RES", res, "res"));
  grid.appendChild(col("支持 SUP", sup, "sup"));

  const sub = $("#coverageSub");
  if (sub) sub.textContent = `全価格 · structure score / AI% for board picks · ${cov.length} strikes`;
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
// A board with no/invalid timestamp must count as STALE (not silently fresh).
const boardStale  = () => { if (!lastData) return false; const t = scoredAt(); return !Number.isFinite(t) || t < Date.now() - STALE_MS; };

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
  if (o === "retested") return { cls: "retested", text: level.clean === false ? "retested loose" : "retested" };
  if (o === "reversed")  return { cls: "held",     text: level.clean === false ? "held loose" : "held" };
  // Spot actively past the hard stop right now — true live break.
  if (live === "broke")  return { cls: "broke",    text: "broke" };
  // Stored outcome is broke, but price has come back to the level — live retest setup.
  // Keep the level visible and treat it like a second touch, not an invalidation.
  if (o === "broke" && live !== null) return { cls: "testing", text: "retest" };
  if (o === "broke")     return { cls: "broke",    text: "broke" };
  if (live === "grind")  return { cls: "grinding", text: "grinding" };
  if (o === "pending")   return level.clean === false ? { cls: "grinding", text: "grinding" } : { cls: "testing", text: level.retestAt ? "retesting" : "testing" };
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

  // Justifications are always visible now (no click-to-expand).
  return { el: row, level, distEl, badgeEl, fill };
}

function applyOutcome(entry) {
  const v = outcomeView(entry.level);
  entry.el.classList.toggle("broke",    v.cls === "broke");
  entry.el.classList.toggle("retested", v.cls === "retested");
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

  // Gamma flip: show the level + distance from spot so you can see how far you are
  if (typeof data.zero_gamma === "number" && typeof data.spot === "number") {
    const dist = data.spot - data.zero_gamma;
    const sign = dist >= 0 ? "+" : "−";
    const absDist = Math.abs(dist).toFixed(2);
    const cls = dist >= 0 ? "pos" : "neg";
    cells.push({ k: "γ FLIP", v: `${data.zero_gamma.toFixed(2)} · ${sign}${absDist}`, cls });
  }

  // Net GEX — shows the aggregate dealer gamma ($B), signed
  if (typeof data.net_gex === "number") {
    const gB = data.net_gex / 1e9;
    const sign = gB >= 0 ? "+" : "−";
    const cls = gB >= 0 ? "pos" : "neg";
    cells.push({ k: "Net GEX", v: `${sign}$${Math.abs(gB).toFixed(1)}B`, cls });
  }

  if (typeof data.expected_move === "number") cells.push({ k: "Exp Move", v: `±${data.expected_move.toFixed(1)}`, cls: "" });
  if (data.iv && typeof data.iv.current === "number") {
    const dir   = (data.iv.direction || "").toUpperCase();
    const arrow = dir.startsWith("RIS") ? "▲" : dir.startsWith("FALL") ? "▼" : "→";
    cells.push({ k: "IV", v: `${data.iv.current.toFixed(1)} ${arrow}`, cls: "" });
  }
  // P/C ratio — >1.2 = heavy put hedging (fear); <0.7 = call chasing
  if (typeof data.pc_ratio === "number") {
    const pcc = data.pc_ratio > 1.2 ? "neg" : data.pc_ratio < 0.7 ? "pos" : "";
    cells.push({ k: "P/C", v: data.pc_ratio.toFixed(2), cls: pcc });
  }
  // 0DTE fraction — % of today's gamma expiring same-day (pinning intensity)
  if (typeof data.gex_0dte_ratio === "number") {
    const pct = Math.round(data.gex_0dte_ratio * 100);
    cells.push({ k: "0DTE", v: `${pct}%`, cls: pct >= 60 ? "neg" : "" });
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
  renderGexChart(lastData.gex_profile, spot, lastData.expected_move);
}

// ── banner ────────────────────────────────────────────────────────────────────
function renderBanner(data) {
  const b = $("#banner");
  if (data?.scoring_method === "rule" && !boardStale()) {
    b.hidden = false;
    const txt = data._cloud || data.cloud
      ? `Box offline — cloud-calculated rule-based levels (lower confidence), refreshed ${scoredAgo()}. Spot & reversals are live.`
      : `Manual scored (AI unavailable) — rule-based levels, refreshed ${scoredAgo()}. Spot & reversals are live.`;
    b.replaceChildren(el("span", "banner-dot"), el("span", "", txt));
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
    renderGexChart(data.gex_profile, currentSpot(), data.expected_move);
    renderCoverage(data, currentSpot());
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
  renderGexChart(data.gex_profile, currentSpot(), data.expected_move);
  renderCoverage(data, currentSpot());
  if (candleData) renderCandleChart(candleData);

  requestAnimationFrame(() =>
    rungEls.forEach((e, i) =>
      setTimeout(() => (e.fill.style.width = `${clamp(e.level.reversal_prob, 0, 100)}%`), 220 + i * 60)));

  repaintLive();
  $("#asOf").textContent = `${data?.scoring_method === "rule" ? "rule scored" : "scored"} ${scoredAgo()}`;
}

// ── data ──────────────────────────────────────────────────────────────────────
// The cloud deterministic board — fresh rule-based levels computed server-side when the box is off.
async function loadCloudBoard() {
  try {
    const res = await fetch(`${BOARD_FN}?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return null;
    const j = await res.json();
    return j && Array.isArray(j.levels) ? j : null;
  } catch { return null; }
}

const freshnessOf = (d) => { const t = typeof d?.scored_at === "number" ? d.scored_at : Date.parse(d?.generated_at ?? ""); return Number.isFinite(t) ? t : 0; };

async function load() {
  feedNext.board = Date.now() + POLL_MS;
  try {
    const res = await fetch(`dashboard.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let data = await res.json();
    // Box offline (any session) → published board is frozen. Pull the cloud rule board so
    // levels keep moving at all hours, not just RTH.
    if (freshnessOf(data) < Date.now() - STALE_MS) {
      const cloud = await loadCloudBoard();
      if (cloud && freshnessOf(cloud) > freshnessOf(data)) data = cloud;
    }
    lastData = data;
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
  feedNext.spot = Date.now() + SPOT_MS;
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

// ── size rule banner (entropy gate — YYY guide Ch.12.4) ──────────────────────
function renderSizeRule() {
  const banner = $("#sizeRuleBanner");
  if (!banner) return;
  // Source priority: narrative (computed at 9AM from live entropy) → board (computed every 15min)
  const rule   = narrData?.size_rule   || (lastData?.entropy_state === "CRITICAL" ? "ZERO" : lastData?.entropy_state === "ELEVATED" ? "HALF" : lastData?.entropy_state ? "FULL" : null);
  const reason = narrData?.size_rule_reason || (lastData?.entropy_state ? `entropy ${(lastData.entropy_state || "").toLowerCase()} (board ρ=${lastData?.entropy_ratio ?? "?"})` : "");
  if (!rule) { banner.hidden = true; return; }
  banner.hidden = false;
  banner.dataset.rule = rule;
  const rv = $("#sizeRuleVal"), rr = $("#sizeRuleReason");
  if (rv) rv.textContent = rule;
  if (rr) rr.textContent = reason;
}

// ── GEX key levels strip ──────────────────────────────────────────────────────
function renderGexKeyLevels() {
  const wrap = $("#gexLevelsWrap"), body = $("#gexLevelsBody");
  if (!wrap || !body) return;
  const kl = narrData?.gex_key_levels || {};
  const vt  = lastData?.vol_trigger  ?? kl.vol_trigger;
  const zg  = lastData?.zero_gamma;
  const spot = lastData?.spot;
  if (!kl.call_wall && !kl.put_wall && !vt) { wrap.hidden = true; return; }
  wrap.hidden = false;
  body.replaceChildren();

  const levels = el("div", "key-levels");
  const chip = (label, val, tag) => {
    if (val == null || !Number.isFinite(val) || val === 0) return;
    const c = el("div", `kl-chip ${tag || ""}`.trim());
    c.appendChild(el("span", "kl-label", label));
    c.appendChild(el("span", "kl-val", `$${fmtPrice(val)}`));
    levels.appendChild(c);
  };
  chip("CALL WALL", kl.call_wall, "kl-res");
  chip("PUT WALL", kl.put_wall, "kl-sup");
  chip("VOL TRIGGER", vt, spot != null && vt && spot < vt ? "kl-warn" : "");
  chip("ZERO GAMMA", zg, "");
  chip("MAX PAIN", kl.max_pain, "");
  if (kl.expected_move) {
    const c = el("div", "kl-chip");
    c.appendChild(el("span", "kl-label", "EXP MOVE"));
    c.appendChild(el("span", "kl-val", `±$${fmtPrice(kl.expected_move)}`));
    levels.appendChild(c);
  }
  body.appendChild(levels);

  // Vol trigger position tag: above = positive gamma (dealers suppress), below = negative (amplify)
  if (vt && spot) {
    const above = spot >= vt;
    const pos = el("div", `kl-vtp ${above ? "kl-vtp-pos" : "kl-vtp-neg"}`);
    pos.appendChild(el("span", "kl-vtp-label", "SPOT VS VOL TRIGGER"));
    pos.appendChild(el("span", "kl-vtp-val", above
      ? "ABOVE — dealers positive gamma · suppresses moves"
      : "BELOW — dealers negative gamma · amplifies moves"));
    body.appendChild(pos);
  }
}

function renderNarrative(n) {
  const hero = $("#narrHero");
  renderSizeRule();
  renderGexKeyLevels();
  if (!n || !n.open_type) {
    hero.replaceChildren(el("div", "narr-empty"));
    hero.querySelector(".narr-empty").innerHTML =
      'No narrative yet. It generates automatically before the open (≈09:00 ET), or run <code>npm run narrative</code>.';
    for (const id of ["#narrOpen", "#narrZones"]) $(id).replaceChildren();
    return;
  }

  const GLYPH = { rising: "▲", falling: "▼", flat: "►", up: "▲", down: "▼", neutral: "►" };
  const biasTone = n.macro_bias === "bullish" ? "bull" : n.macro_bias === "bearish" ? "bear" : "";
  const dirTone  = n.expansion_direction === "up" ? "up" : n.expansion_direction === "down" ? "down" : "";
  hero.replaceChildren();

  // ── 4-cell verdict row: LEAN | ENTROPY | TOPOLOGY | OPEN TYPE ────────────────
  const v = el("div", "verdict");
  const cell = (k, val, cls, sub) => {
    const c = el("div", "verdict-cell");
    c.appendChild(el("span", "vk", k));
    c.appendChild(el("div", `vv ${cls}`.trim(), val));
    if (sub) c.appendChild(el("div", "vsub", sub));
    return c;
  };

  // Cell 1: LEAN (macro bias + direction)
  const leanSub = [
    typeof n.macro_bias_score === "number" ? `${n.macro_bias_score > 0 ? "+" : ""}${n.macro_bias_score} score` : null,
    n.clean_or_choppy || null,
  ].filter(Boolean).join(" · ");
  const leanCls = `${biasTone} ${dirTone}`.trim();
  v.appendChild(cell("Lean", (n.macro_bias || "neutral").toUpperCase(), leanCls, leanSub || null));

  // Cell 2: ENTROPY (from narrData or live board)
  const entState = n.entropy_state || lastData?.entropy_state;
  const entRatio = n.entropy_ratio ?? lastData?.entropy_ratio;
  const entCls   = entState === "CRITICAL" ? "bear" : entState === "ELEVATED" ? "amber" : entState === "NORMAL" ? "bull" : "";
  const entSub   = entRatio != null ? `ρ = ${entRatio.toFixed(2)}` : (entState ? "" : "no entropy data");
  v.appendChild(cell("Entropy", entState || "—", entCls, entSub));

  // Cell 3: TOPOLOGY (PCA1/PCA2 alignment proxy)
  const topoAlign  = n.topology_alignment || "unclear";
  const topoCls    = topoAlign === "aligned" ? "bull" : topoAlign === "conflicted" ? "bear" : "";
  const topoSub    = [
    n.pca1_dir ? `P1 ${n.pca1_dir}` : null,
    n.pca2_dir ? `P2 ${n.pca2_dir}` : null,
  ].filter(Boolean).join(" · ") || null;
  v.appendChild(cell("Topology", topoAlign.toUpperCase(), topoCls, topoSub));

  // Cell 4: OPEN TYPE
  const otToneC = OPEN_TYPE_TONE[n.open_type] || "";
  const otSub   = n.expansion_direction ? `expand ${GLYPH[n.expansion_direction] || "►"} · ${n.scoring_method === "ai" ? narrAgo(n) : "rule-based"}` : null;
  v.appendChild(cell("Open Type", (n.open_type_label || n.open_type || "—").replace("→", "→"), otToneC, otSub));

  hero.appendChild(v);

  // ── cross-asset strip (live macro overrides stale 9AM) ────────────────────────
  const mac = n.macro || {};
  const cx = macroData?.cross ?? mac.cross ?? {};
  const liveUs2y = macroData?.us2y;
  const rateData = liveUs2y || mac.us10y;
  const rateLabel = liveUs2y ? "2Y" : "RATE";
  const cross = el("div", "mscan-cross");
  const xa = (key, dir, val, tone) => {
    const x = el("div", "xa");
    x.appendChild(el("span", "xk", key));
    x.appendChild(el("span", `xar ${tone || ""}`.trim(), GLYPH[dir] || "·"));
    if (val != null) x.appendChild(el("span", "xv", String(val)));
    return x;
  };
  cross.appendChild(xa("EQ", n.expansion_direction || "neutral", null, dirTone));
  if (rateData) cross.appendChild(xa(rateLabel, rateData.dir, rateData.last));
  if (cx.brent)  cross.appendChild(xa("OIL",  cx.brent.dir, cx.brent.last));
  if (cx.gold)   cross.appendChild(xa("GOLD", cx.gold.dir,  cx.gold.last));
  if (cx.copper) cross.appendChild(xa("COPP", cx.copper.dir, cx.copper.last, cx.copper.dir === "falling" ? "down" : ""));
  if (cx.dxy)    cross.appendChild(xa("USD",  cx.dxy.dir,   cx.dxy.last));
  if (cx.vix)    cross.appendChild(xa("VOL",  cx.vix.dir,   cx.vix.last, cx.vix.dir === "rising" ? "amber" : ""));
  const narrVt = macroData?.vix_term;
  if (narrVt) cross.appendChild(xa("VIX-T", "flat", narrVt.structure === "backwardation" ? "BACK" : narrVt.structure === "contango" ? "CNTGO" : "FLAT", narrVt.structure === "backwardation" ? "amber" : ""));
  if (cx.btc)    cross.appendChild(xa("BTC",  cx.btc.dir,   `${Math.round(cx.btc.last / 1000)}k`));
  if (cx.hyg)    cross.appendChild(xa("HYG",  cx.hyg.dir,   cx.hyg.last));
  if (cross.childElementCount) hero.appendChild(cross);

  // ── news ──────────────────────────────────────────────────────────────────────
  const evs = (Array.isArray(n.news_events) ? n.news_events : []).filter((e) => e?.headline).slice(0, 3);
  if (evs.length) {
    const watch = el("div", "mscan-watch");
    watch.appendChild(el("span", "ms-label", "NEWS"));
    const list = el("span", "ms-watch-list");
    evs.forEach((ev, idx) => {
      if (idx) list.appendChild(el("span", "ms-sep", " · "));
      const tone = ev.impact === "bullish" ? "bull" : ev.impact === "bearish" ? "bear" : "";
      const item = el("span", `ms-ev ${tone}`.trim(), ev.headline);
      item.dataset.tip = `${ev.source ? ev.source + " — " : ""}${ev.headline}`;
      list.appendChild(item);
    });
    watch.appendChild(list);
    hero.appendChild(watch);
  }

  // ── AI summary paragraph ──────────────────────────────────────────────────────
  if (n.summary && n.scoring_method === "ai") {
    const sumWrap = el("div", "narr-summary");
    sumWrap.appendChild(el("p", "narr-summary-text", n.summary));
    hero.appendChild(sumWrap);
  }

  // ── open type ─────────────────────────────────────────────────────────────────
  const open = $("#narrOpen");
  open.replaceChildren();
  const otTone = OPEN_TYPE_TONE[n.open_type] || "";
  const otHead = el("div", `vv ${otTone}`.trim(), n.open_type_label || n.open_type);
  otHead.style.fontSize = "17px"; otHead.style.marginBottom = "6px";
  open.appendChild(otHead);
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
  // Topology note as a contextual caveat below the mechanics
  if (n.topology_note) open.appendChild(el("div", "tell topo-note", n.topology_note));
  if (n.manipulation_tell) open.appendChild(el("div", "tell", n.manipulation_tell));

  // ── reversal zones ────────────────────────────────────────────────────────────
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
}

async function loadNarrative() {
  feedNext.narr = Date.now() + NARR_MS;
  try {
    const res = await fetch(`${NARR_URL}?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    narrData = await res.json();
    renderNarrative(narrData);
  } catch {
    renderNarrative(null);
  }
}

// ── live macro (YYY guide bias — self-refreshing) ───────────────────────────────
let macroData = null;

function renderLiveMacro(m) {
  const wrap = $("#liveMacroWrap");
  const body = $("#liveMacro");
  if (!m || !m.bias) { if (wrap) wrap.hidden = true; return; }
  if (wrap) wrap.hidden = false;
  body.replaceChildren();

  const GLYPH = { rising: "▲", falling: "▼", flat: "►" };

  // Auction day warning — shown first (sizing override beats directional bias)
  if (m.auction_today) {
    body.appendChild(el("div", "auction-warn", "⚑ AUCTION DAY (10Y/20Y/30Y) — size down regardless of bias"));
  }

  // Status line: live bias + score + confidence
  const status = el("div", "mscan-status");
  const biasTone = m.bias === "bullish" ? "bull" : m.bias === "bearish" ? "bear" : "";
  status.appendChild(el("span", `ms-bias ${biasTone}`.trim(), m.bias.toUpperCase()));
  if (typeof m.bias_score === "number")
    status.appendChild(el("span", "ms-score", `${m.bias_score > 0 ? "+" : ""}${m.bias_score}`));
  status.appendChild(el("span", "ms-sep", "·"));
  status.appendChild(el("span", "live-tag", "LIVE"));
  const sAbs = Math.abs(m.bias_score ?? 0);
  status.appendChild(el("span", "ms-sep", "·"));
  status.appendChild(el("span", "ms-conf", sAbs >= 50 ? "●●● high" : sAbs >= 25 ? "●●○ med" : "●○○ low"));
  status.appendChild(el("span", "ms-stamp", `refreshed ${agoMs(m.scored_at)}`));
  body.appendChild(status);

  // YYY key inputs: 2Y, TGA, RRP, COT + OAS (Ch.12.2) + reserve_bal + walcl
  const keys = el("div", "macro-keys");
  const mkKey = (label, dir, val, lean) => {
    const d = el("div", "mk");
    d.appendChild(el("span", "mk-label", label));
    const glyphTone = lean === "bull" ? "up" : lean === "bear" ? "down" : lean === "amber" ? "amber" : "";
    d.appendChild(el("span", `xar ${glyphTone}`.trim(), GLYPH[dir] || "►"));
    if (val != null) d.appendChild(el("span", "mk-val", String(val)));
    return d;
  };
  if (m.us2y) keys.appendChild(mkKey("2Y YIELD", m.us2y.dir, m.us2y.last, m.us2y.dir === "rising" ? "bear" : m.us2y.dir === "falling" ? "bull" : ""));
  if (m.tga)  keys.appendChild(mkKey("TGA", m.tga.dir, null, m.tga.dir === "falling" ? "bull" : "bear"));
  if (m.rrp)  keys.appendChild(mkKey("RRP", m.rrp.dir, null, m.rrp.dir === "falling" ? "bull" : "bear"));
  if (m.cot)  keys.appendChild(mkKey("COT", "flat", `${m.cot.percentile}th pct`, m.cot.percentile > 80 ? "bear" : m.cot.percentile < 50 ? "bull" : ""));
  if (m.oas)  {
    const oasTone = m.oas.level === "healthy" ? "bull" : m.oas.level === "crisis" ? "bear" : m.oas.level === "elevated" ? "amber" : "";
    const oasLabel = m.oas.level === "crisis" ? "CRISIS" : m.oas.level === "elevated" ? "ELEV" : m.oas.level === "mild" ? "MILD" : "OK";
    keys.appendChild(mkKey("OAS HY", m.oas.dir || "flat", `${m.oas.last}% · ${oasLabel}`, oasTone));
  }
  if (m.reserve_bal && m.reserve_bal.dir !== "flat")
    keys.appendChild(mkKey("RESV BAL", m.reserve_bal.dir, null, m.reserve_bal.dir === "rising" ? "bull" : "bear"));
  if (m.walcl && m.walcl.dir !== "flat")
    keys.appendChild(mkKey("FED BS", m.walcl.dir, null, m.walcl.dir === "rising" ? "bull" : "bear"));
  if (keys.childElementCount) body.appendChild(keys);

  // Cross-asset strip — live values + copper + VIX term structure
  const cx = m.cross || {};
  const cross = el("div", "mscan-cross");
  const xa = (key, dir, val, tone) => {
    const x = el("div", "xa");
    x.appendChild(el("span", "xk", key));
    x.appendChild(el("span", `xar ${tone || ""}`.trim(), GLYPH[dir] || "·"));
    if (val != null) x.appendChild(el("span", "xv", String(val)));
    return x;
  };
  if (m.us10y)  cross.appendChild(xa("10Y", m.us10y.dir, m.us10y.last));
  if (cx.brent) cross.appendChild(xa("OIL", cx.brent.dir, cx.brent.last));
  if (cx.gold)  cross.appendChild(xa("GOLD", cx.gold.dir, cx.gold.last));
  if (cx.copper) cross.appendChild(xa("COPP", cx.copper.dir, cx.copper.last, cx.copper.dir === "falling" ? "down" : ""));
  if (cx.dxy)   cross.appendChild(xa("USD", cx.dxy.dir, cx.dxy.last));
  if (cx.vix)   cross.appendChild(xa("VOL", cx.vix.dir, cx.vix.last, cx.vix.dir === "rising" ? "amber" : ""));
  if (m.vix_term) {
    const vtTone = m.vix_term.structure === "backwardation" ? "amber" : "";
    const vtLabel = m.vix_term.structure === "backwardation" ? "BACK" : m.vix_term.structure === "contango" ? "CNTGO" : "FLAT";
    cross.appendChild(xa("VIX-T", "flat", vtLabel, vtTone));
  }
  // VXN — Nasdaq-specific vol; VXN > VIX by a wide margin = tech-specific fear premium
  if (cx.vxn) cross.appendChild(xa("VXN", cx.vxn.dir, cx.vxn.last.toFixed(1), cx.vxn.dir === "rising" ? "amber" : ""));
  // CBOE SKEW — tail risk premium; >135 = elevated tail hedging; >145 = extreme
  if (cx.skew_index) {
    const skTone = cx.skew_index.last > 145 ? "bear" : cx.skew_index.last > 135 ? "amber" : "";
    cross.appendChild(xa("SKEW", cx.skew_index.dir, Math.round(cx.skew_index.last), skTone));
  }
  if (cx.btc)   cross.appendChild(xa("BTC", cx.btc.dir, `${Math.round(cx.btc.last / 1000)}k`));
  if (cx.hyg)   cross.appendChild(xa("HYG", cx.hyg.dir, cx.hyg.last));
  if (typeof m.curve2s10s === "number")
    cross.appendChild(xa("2s10s", m.curve2s10s >= 0 ? "rising" : "falling", `${m.curve2s10s > 0 ? "+" : ""}${m.curve2s10s?.toFixed(2)}`, m.curve2s10s < -0.1 ? "bear" : ""));
  // Copper/gold ratio — rising = reflation/growth; falling = haven rotation
  if (typeof m.copper_gold_ratio === "number") {
    // Ratio = Cu / Au: rises when copper rises OR gold falls; falls when copper falls OR gold rises.
    const cgDir = (cx.copper?.dir === "rising" || cx.gold?.dir === "falling") ? "rising"
               : (cx.copper?.dir === "falling" || cx.gold?.dir === "rising")  ? "falling" : "flat";
    cross.appendChild(xa("Cu/Au", cgDir, m.copper_gold_ratio.toFixed(4), cgDir === "falling" ? "amber" : ""));
  }
  if (cross.childElementCount) body.appendChild(cross);

  // YYY driver list — each factor with its reading and lean
  if (m.drivers?.length) {
    const dl = el("div", null);
    for (const d of m.drivers) {
      const row = el("div", "narr-line");
      row.appendChild(el("span", "nk", d.label));
      const nvTone = d.lean === "bull" ? "bull" : d.lean === "bear" ? "bear" : "";
      const nv = el("span", `nv ${nvTone}`.trim());
      nv.textContent = d.reading;
      row.appendChild(nv);
      dl.appendChild(row);
    }
    body.appendChild(dl);
  }

  // Re-render the narrative verdict strip so the cross-asset arrows and entropy update with live data.
  renderSizeRule();
  renderGexKeyLevels();
  if (narrData) renderNarrative(narrData);
}

async function loadMacro() {
  feedNext.macro = Date.now() + MACRO_MS;
  try {
    const res = await fetch(`${MACRO_URL}?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    macroData = await res.json();
    renderLiveMacro(macroData);
  } catch {
    renderLiveMacro(macroData || null);
  }
}

// ── regime tab ──────────────────────────────────────────────────────────────────
let regData = null;
const REGIME_FN  = "/.netlify/functions/regime"; // cloud compute (works with the box off)
const REGIME_URL = "regime.json";                // static fallback (LAN / first paint)

function regAgo(r) {
  const t = typeof r?.scored_at === "number" ? r.scored_at : Date.parse(r?.generated_at ?? "");
  return agoMs(t);
}

function renderRegime(r) {
  const hero = $("#regHero");
  if (!r || !r.state) {
    hero.replaceChildren(el("div", "narr-empty", "No regime yet — run a capture to compute it."));
    for (const id of ["#regGauges", "#regPivots"]) $(id).replaceChildren();
    $("#regRead").textContent = "";
    return;
  }

  // hero: state · bias · confidence
  hero.replaceChildren();
  const v = el("div", "verdict");
  const cell = (k, val, cls, sub) => {
    const c = el("div", "verdict-cell");
    c.appendChild(el("span", "vk", k));
    c.appendChild(el("div", `vv ${cls}`.trim(), val));
    if (sub) c.appendChild(el("div", "vsub", sub));
    return c;
  };
  const biasTone = r.bias === "up" ? "up bull" : r.bias === "down" ? "down bear" : "";
  v.appendChild(cell("Regime", r.state, "reg-state", `scored ${regAgo(r)}`));
  v.appendChild(cell("Bias", r.bias.toUpperCase(), biasTone, r.trend?.direction ? `tape ${r.trend.direction}` : ""));
  v.appendChild(cell("Confidence", `${r.confidence}%`, "", "axis agreement"));
  hero.appendChild(v);

  $("#regRead").textContent = r.read || "";

  // gauges — labelled meter bars
  const gw = $("#regGauges");
  gw.replaceChildren();
  for (const g of (Array.isArray(r.gauges) ? r.gauges : [])) {
    const row = el("div", "gauge");
    const head = el("div", "gauge-head");
    head.appendChild(el("span", "gk", g.label));
    head.appendChild(el("span", `gv ${g.tone || ""}`.trim(), g.value));
    row.appendChild(head);
    const track = el("div", "prob-track");
    const fill = el("span");
    fill.dataset.tone = g.tone || "";
    track.appendChild(fill);
    row.appendChild(track);
    gw.appendChild(row);
    requestAnimationFrame(() => setTimeout(() => (fill.style.width = `${clamp(g.pct, 0, 100)}%`), 120));
  }

  // topology pivots — reuse the zone row visual
  const pw = $("#regPivots");
  pw.replaceChildren();
  const pivots = Array.isArray(r.pivots) ? r.pivots : [];
  if (!pivots.length) pw.appendChild(el("div", "narr-empty", "No persistent pivots in range."));
  for (const p of pivots) {
    const row = el("div", `zone ${p.side === "resistance" ? "resistance" : "support"}`);
    row.appendChild(el("span", "zone-tick"));
    row.appendChild(el("span", "zone-price", `$${fmtPrice(p.price)}`));
    row.appendChild(el("span", "zone-side", p.side === "resistance" ? "抵抗 RES" : "支持 SUP"));
    const note = el("span", "zone-note");
    note.appendChild(el("span", "pivot-persist", `persistence ${fmtPrice(p.persistence)} pt`));
    if (p.confluence) note.appendChild(el("span", "pivot-confl", "● board level"));
    row.appendChild(note);
    pw.appendChild(row);
  }
}

async function loadRegime() {
  feedNext.regime = Date.now() + NARR_MS;
  // Prefer the cloud function (live even when the scoring box is off); fall back to the static
  // file for LAN viewing. Keep the last good read if both fail rather than blanking the tab.
  for (const url of [`${REGIME_FN}?t=${Date.now()}`, `${REGIME_URL}?t=${Date.now()}`]) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) continue;
      regData = await res.json();
      renderRegime(regData);
      return;
    } catch { /* try next source */ }
  }
  renderRegime(regData || null);
}

// ── tabs ──────────────────────────────────────────────────────────────────────
function setView(view) {
  $("#viewBoard").hidden     = view !== "board";
  $("#viewRegime").hidden    = view !== "regime";
  $("#viewNarrative").hidden = view !== "narrative";
  for (const t of document.querySelectorAll(".tab")) t.classList.toggle("active", t.dataset.view === view);
  try { localStorage.setItem("torii.view", view); } catch { /* ignore */ }
  // Re-render from cached data immediately (element is now visible → animations fire correctly),
  // then kick off a background fetch to pick up any newer data.
  if (view === "narrative") { renderSizeRule(); renderGexKeyLevels(); if (narrData) renderNarrative(narrData); if (macroData) renderLiveMacro(macroData); loadNarrative(); loadMacro(); }
  if (view === "regime")    { if (regData)  renderRegime(regData);     loadRegime(); }
}
for (const t of document.querySelectorAll(".tab")) {
  t.addEventListener("click", () => setView(t.dataset.view));
}

// ── theme (light / dark) ────────────────────────────────────────────────────
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const btn = $("#themeToggle");
  if (btn) {
    btn.textContent = theme === "dark" ? "☀" : "☾";
    btn.setAttribute("aria-label", theme === "dark" ? "Switch to light mode" : "Switch to dark mode");
  }
  readPalette();
}
let theme = "light";
try {
  theme = localStorage.getItem("torii.theme")
    || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
} catch { /* ignore */ }
applyTheme(theme);
$("#themeToggle")?.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  try { localStorage.setItem("torii.theme", next); } catch { /* ignore */ }
  applyTheme(next);
  if (lastData) render(lastData);  // repaint canvas/SVG charts with the new palette
});

// ── init ──────────────────────────────────────────────────────────────────────
initBackground();
tickClock(); tickOpenCountdown(); tickNextScore(); tickAgoStamps(); tickFeedTimers();
setInterval(() => { tickClock(); tickOpenCountdown(); tickNextScore(); tickAgoStamps(); tickFeedTimers(); }, 1000);
$("#refresh").addEventListener("click", () => { load(); loadSpot(); loadCandles(); loadNarrative(); loadRegime(); loadMacro(); });
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) { load(); loadSpot(); loadCandles(); loadNarrative(); loadRegime(); loadMacro(); }
});

let startView = "board";
try { startView = localStorage.getItem("torii.view") || "board"; } catch { /* ignore */ }
setView(startView);

load();
loadSpot();
loadCandles();
loadNarrative();
loadRegime();
loadMacro();
setInterval(load,          POLL_MS);
setInterval(loadSpot,      SPOT_MS);
setInterval(loadCandles,   CANDLE_MS);
setInterval(loadNarrative, NARR_MS);
setInterval(loadRegime,    NARR_MS);
setInterval(loadMacro,     MACRO_MS);

// ── custom tooltip ────────────────────────────────────────────────────────────
(function () {
  const tip = document.getElementById("tip");
  if (!tip) return;
  let target = null;

  function place(x, y) {
    const gap = 14;
    tip.style.left = "0"; tip.style.top = "0";
    const w = tip.offsetWidth, h = tip.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight;
    const left = (x + gap + w > vw - 6) ? x - w - gap : x + gap;
    const top  = (y + gap + h > vh - 6) ? y - h - gap : y + gap;
    tip.style.left = `${left}px`;
    tip.style.top  = `${top}px`;
  }

  document.addEventListener("mouseover", e => {
    const el = e.target.closest("[data-tip]");
    if (!el || el === target) return;
    target = el;
    tip.textContent = el.dataset.tip;
    tip.hidden = false;
    place(e.clientX, e.clientY);
  });

  document.addEventListener("mousemove", e => {
    if (target) place(e.clientX, e.clientY);
  });

  document.addEventListener("mouseout", e => {
    if (!target) return;
    const el = e.target.closest("[data-tip]");
    if (el && !el.contains(e.relatedTarget)) { tip.hidden = true; target = null; }
  });
})();
