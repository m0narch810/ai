// Shared primitives: DOM, numbers, time, ASCII meters.
// No state, no fetching — everything here is pure or a thin DOM wrapper.

/* ── DOM ─────────────────────────────────────────────────────────────────── */

export const $ = (sel, root = document) => root.querySelector(sel);

/** el("div.cls#id", {attr}, children|text) — the only element factory in the app. */
export function el(spec, attrs, kids) {
  const [head, ...classes] = String(spec).split(".");
  const [tag, id] = head.split("#");
  const node = document.createElement(tag || "div");
  if (id) node.id = id;
  if (classes.length) node.className = classes.join(" ");
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "text") node.textContent = String(v);
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  if (kids !== undefined) append(node, kids);
  return node;
}

export function append(node, kids) {
  if (kids === null || kids === undefined || kids === false) return node;
  if (Array.isArray(kids)) { for (const k of kids) append(node, k); return node; }
  node.append(kids instanceof Node ? kids : document.createTextNode(String(kids)));
  return node;
}

const SVG_NS = "http://www.w3.org/2000/svg";
/** svg("rect", {x,y,...}) — attribute names pass through verbatim (SVG is case-sensitive). */
export function svg(tag, attrs, kids) {
  const node = document.createElementNS(SVG_NS, tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "text") node.textContent = String(v);
    else node.setAttribute(k, String(v));
  }
  if (kids) for (const k of [].concat(kids)) if (k) node.append(k);
  return node;
}

/* ── numbers ─────────────────────────────────────────────────────────────── */

export const isNum  = (n) => typeof n === "number" && Number.isFinite(n);
export const clamp  = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Fixed decimals, em-dash for anything non-numeric. Never prints "NaN". */
export const fmt = (n, d = 2) => (isNum(n) ? n.toFixed(d) : "—");

/** Explicit sign, minus rendered as U+2212 so columns line up with the plus. */
export const signed = (n, d = 2) => (isNum(n) ? `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(d)}` : "—");

export const pct = (n, d = 1) => (isNum(n) ? `${n.toFixed(d)}%` : "—");

/** 1.24B / 86.6M / 12.4k — magnitude-aware, always a few significant characters. */
export function compact(n, d = 2) {
  if (!isNum(n)) return "—";
  const a = Math.abs(n), s = n < 0 ? "−" : "";
  if (a >= 1e12) return `${s}${(a / 1e12).toFixed(d)}T`;
  if (a >= 1e9)  return `${s}${(a / 1e9).toFixed(d)}B`;
  if (a >= 1e6)  return `${s}${(a / 1e6).toFixed(d)}M`;
  if (a >= 1e3)  return `${s}${(a / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
  return `${s}${a.toFixed(a < 10 ? d : 1)}`;
}

/** Signed compact with an explicit leading + — used wherever direction is the point. */
export const compactSigned = (n, d = 2) => (isNum(n) ? (n >= 0 ? "+" : "") + compact(n, d) : "—");

/** Strike labels: 705 not 705.00, but 705.5 keeps its half. */
export const strikeLabel = (n) => (isNum(n) ? (Number.isInteger(n) ? String(n) : String(+n.toFixed(2))) : "—");

/* ── ASCII meters ────────────────────────────────────────────────────────── */

// Eighth-blocks give a mono bar 8x the resolution of its character count, which is what makes
// an ASCII meter readable at the 6-10 char widths this layout has room for.
const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
const FULL = "█";
const TRACK = "·";

/** asciiBar(0.62, 10) -> a filled proportion as monospace text. */
export function asciiBar(frac, width = 10, track = TRACK) {
  const f = clamp(isNum(frac) ? frac : 0, 0, 1);
  const units = f * width;
  const whole = Math.floor(units);
  const rem = Math.round((units - whole) * 8);
  let out = FULL.repeat(Math.min(whole, width));
  if (whole < width && rem > 0) out += EIGHTHS[rem];
  return out + track.repeat(Math.max(0, width - out.length));
}

/** Centre-out bar for signed values; left of the pipe is negative. */
export function asciiSpine(frac, half = 6) {
  const f = clamp(isNum(frac) ? frac : 0, -1, 1);
  const n = Math.round(Math.abs(f) * half);
  const bar = FULL.repeat(n) + TRACK.repeat(half - n);
  return f < 0
    ? `${[...bar].reverse().join("")}│${TRACK.repeat(half)}`
    : `${TRACK.repeat(half)}│${bar}`;
}

/** Sparkline as text — for places too small for a canvas. */
const SPARKS = "▁▂▃▄▅▆▇█";
export function asciiSpark(values) {
  const nums = (values || []).filter(isNum);
  if (nums.length < 2) return "";
  const lo = Math.min(...nums), hi = Math.max(...nums), span = hi - lo || 1;
  return nums.map((v) => SPARKS[clamp(Math.round(((v - lo) / span) * 7), 0, 7)]).join("");
}

/* ── time ────────────────────────────────────────────────────────────────── */

const ET_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hour12: false, weekday: "short",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
  month: "2-digit", day: "2-digit",
});
const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock ET parts for a Date — the app reasons about sessions in ET, never local time. */
export function etNow(date = new Date()) {
  const p = Object.fromEntries(ET_PARTS.formatToParts(date).map((x) => [x.type, x.value]));
  const hour = +p.hour % 24, minute = +p.minute, second = +p.second;
  return { dow: DOW[p.weekday] ?? 0, hour, minute, second, month: p.month, day: p.day, minutes: hour * 60 + minute };
}

export const etClock = (date = new Date()) => {
  const { hour, minute, second } = etNow(date);
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
};

/** RTH = the cash session the board is graded on. */
export function isRth(date = new Date()) {
  const { dow, minutes } = etNow(date);
  return dow >= 1 && dow <= 5 && minutes >= 570 && minutes < 960; // 09:30-16:00 ET
}

/** Extended US session — what "the desk is awake" means for polling cadence. */
export function isUsSession(date = new Date()) {
  const { dow, minutes } = etNow(date);
  return dow >= 1 && dow <= 5 && minutes >= 480 && minutes <= 1020; // 08:00-17:00 ET
}

export function msAgo(t) {
  const ms = typeof t === "number" ? t : Date.parse(t ?? "");
  return Number.isFinite(ms) ? Date.now() - ms : NaN;
}

/** "just now" / "4m ago" / "3h ago" / "2d ago" — the only staleness vocabulary in the UI. */
export function agoText(t) {
  const d = msAgo(t);
  if (!Number.isFinite(d)) return "—";
  const s = Math.max(0, Math.round(d / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/* ── misc ────────────────────────────────────────────────────────────────── */

/** Largest |value| in a list, guarding the all-zero case so callers can divide by it. */
export const maxAbs = (arr) => Math.max(1e-12, ...arr.map((v) => Math.abs(isNum(v) ? v : 0)));

export const sum = (arr) => arr.reduce((a, b) => a + (isNum(b) ? b : 0), 0);

/** Nearest entry in `rows` to `target` by `key` — used constantly to find the spot row. */
export function nearestBy(rows, target, key = "strike") {
  let best = null, bd = Infinity;
  for (const r of rows || []) {
    const d = Math.abs((r?.[key] ?? NaN) - target);
    if (d < bd) { bd = d; best = r; }
  }
  return best;
}
