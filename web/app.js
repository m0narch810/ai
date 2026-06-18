// Reads dashboard.json and renders the reversal elevation. No framework, no build.
// Levels are placed at their true price on a vertical scale; the gold datum line
// marks spot. Bar length = reversal probability (relative to the strongest level).
const POLL_MS = 60_000;
const STALE_MS = 30 * 60_000;
const PAD = 30;            // top/bottom room (px) inside the gauge for the datum tag
const MIN_GAP = 44;        // min vertical spacing between walls before de-overlap kicks in

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const fmtPrice = (n) => (typeof n === "number" ? n.toFixed(Number.isInteger(n) ? 0 : 2) : "—");
const fmtSpot = (n) => (typeof n === "number" ? n.toFixed(2) : "—");

function ago(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

const TAG = { resistance: "ceiling", support: "floor" };
const MARK = { reversed: "held", broke: "broke", pending: "testing", untouched: "resting", none: "resting" };
const OUTCOME_CLASS = { reversed: "held", broke: "broke", pending: "testing" };

function gaugeHeight(n) {
  const byCount = n * 76 + 2 * PAD;
  const byScreen = clamp(window.innerHeight * 0.68, 460, 760);
  return Math.round(clamp(byCount, 360, Math.max(byScreen, byCount)));
}

/** Map prices to y within [PAD, H-PAD]; high price at top. */
function makeScale(levels, spot, H) {
  const prices = [...levels.map((l) => l.strike), spot];
  let lo = Math.min(...prices), hi = Math.max(...prices);
  const pad = Math.max((hi - lo) * 0.08, spot * 0.0015, 0.5);
  lo -= pad; hi += pad;
  const usable = H - 2 * PAD;
  return (price) => PAD + ((hi - price) / (hi - lo)) * usable;
}

/** Keep at true price, but nudge crowded walls apart so bars never overlap. */
function deOverlap(items) {
  const sorted = [...items].sort((a, b) => a.y - b.y); // top→bottom
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].y - sorted[i - 1].y < MIN_GAP) sorted[i].y = sorted[i - 1].y + MIN_GAP;
  }
  return items;
}

function buildWall(level, x) {
  const outcome = level.outcome || "none";
  const wall = el("div", `wall ${level.side === "resistance" ? "res" : "sup"} ${OUTCOME_CLASS[outcome] || ""}`.trim());
  wall.style.top = `${x.y}px`;

  wall.appendChild(el("span", "stem"));

  const bar = el("div", "bar");
  const track = el("div", "track");
  track.style.setProperty("--p", "0%");
  track.dataset.p = `${clamp(level.reversal_prob, 0, 100)}%`;
  bar.appendChild(track);
  bar.appendChild(el("span", "strike", `$${fmtPrice(level.strike)}`));
  bar.appendChild(el("span", "tag", TAG[level.side] || level.side));
  bar.appendChild(el("span", "spacer"));
  if (outcome !== "untouched" && outcome !== "none") bar.appendChild(el("span", `mark ${MARK[outcome]}`, MARK[outcome]));
  const prob = el("span", `prob ${level.reversal_prob < 45 ? "lo" : ""}`.trim(), `${level.reversal_prob}%`);
  bar.appendChild(prob);
  wall.appendChild(bar);

  const why = el("div", "why", level.why || "");
  wall.appendChild(why);

  wall.addEventListener("click", () => wall.classList.toggle("open"));
  return { wall, track };
}

function renderReadout(data) {
  const r = $("#readout");
  r.replaceChildren();
  const regimeCls = data.regime === "positive" ? "pos" : data.regime === "negative" ? "neg" : "";
  const cells = [
    ["spot", `$${fmtSpot(data.spot)}`, "", null],
    ["regime", data.regime || "—", regimeCls, data.regime === "negative" ? "breaks favored" : data.regime === "positive" ? "pins favored" : ""],
    ["session", data.session || "—", "", data.session === "Asia" ? "NQ-derived" : null],
  ];
  for (const [k, v, cls, note] of cells) {
    const cell = el("div", "cell");
    cell.appendChild(el("div", "k", k));
    const val = el("div", `v ${cls}`.trim(), v);
    if (note) val.appendChild(el("small", null, note));
    cell.appendChild(val);
    r.appendChild(cell);
  }
}

function render(data) {
  const stale = Date.parse(data.as_of) < Date.now() - STALE_MS;
  $("#statusDot").className = `status-dot ${stale ? "stale" : "live"}`;
  $("#statusText").textContent = stale ? "last board" : "live";

  renderReadout(data);

  const gauge = $("#gauge");
  const walls = $("#walls");
  const levels = Array.isArray(data.levels) ? data.levels : [];
  walls.replaceChildren();
  $("#datum").hidden = true;

  if (!levels.length) {
    gauge.style.height = "auto";
    const empty = el("div", "empty");
    empty.appendChild(el("b", null, "No board yet."));
    empty.appendChild(document.createElement("br"));
    empty.append("Run a capture to map the levels.");
    walls.appendChild(empty);
    $("#asOf").textContent = "";
    return;
  }

  const H = gaugeHeight(levels.length);
  gauge.style.height = `${H}px`;
  walls.style.height = `${H}px`;

  const scale = makeScale(levels, data.spot, H);
  const placed = deOverlap(levels.map((l) => ({ level: l, y: scale(l.strike) })));

  // Stagger the bar-draw outward from spot: nearest levels animate first.
  const order = [...placed].sort((a, b) => Math.abs(a.level.strike - data.spot) - Math.abs(b.level.strike - data.spot));
  const tracks = [];
  for (const p of placed) {
    const { wall, track } = buildWall(p.level, p);
    walls.appendChild(wall);
    tracks.push({ track, rank: order.indexOf(p) });
  }
  requestAnimationFrame(() => tracks.forEach(({ track, rank }) =>
    setTimeout(() => (track.style.setProperty("--p", track.dataset.p)), 60 + rank * 70)));

  // Datum: the spot line, the signature element.
  const datum = $("#datum");
  datum.hidden = false;
  datum.style.top = `${clamp(scale(data.spot), PAD, H - PAD)}px`;
  const tag = $("#datumTag");
  tag.replaceChildren();
  tag.appendChild(el("small", null, "SPOT"));
  tag.append(`$${fmtSpot(data.spot)}`);

  $("#asOf").textContent = `scored ${ago(data.as_of)}`;
}

let lastData = null;
async function load() {
  try {
    const res = await fetch(`dashboard.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    lastData = await res.json();
    render(lastData);
  } catch (err) {
    $("#statusText").textContent = "no data";
    $("#statusDot").className = "status-dot";
    $("#walls").replaceChildren(Object.assign(el("div", "empty"), { textContent: "Waiting for dashboard.json — run a capture." }));
    $("#datum").hidden = true;
  }
}

$("#refresh").addEventListener("click", load);
document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
window.addEventListener("resize", () => { if (lastData) render(lastData); });
load();
setInterval(load, POLL_MS);
