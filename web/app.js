// Reads dashboard.json and renders the reversal elevation. No framework, no build.
// Levels are placed at their true price on a vertical scale; the gold datum line
// marks spot. Bar length = reversal probability (relative to the strongest level).
//
// Two independent clocks:
//   • the BOARD (levels + regime) is AI-scored locally and can go stale if the PC is off.
//   • the SPOT line is fetched live from a Netlify function, so it keeps moving regardless.
// When the board is stale we keep showing the last levels but mark them "as scored Xago".
const POLL_MS = 60_000;          // re-read dashboard.json
const SPOT_MS = 60_000;          // re-fetch live spot
const STALE_MS = 30 * 60_000;    // board older than this = AI not currently updating
const SPOT_URL = "/.netlify/functions/spot";
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

// ---- shared state across the two clocks --------------------------------------
let lastData = null;       // last dashboard.json
let liveSpot = null;       // last live price from the spot function
let liveSpotAt = null;     // when we fetched it
let scaleFn = null;        // price -> y, fixed per board so the ladder doesn't reflow
let gaugeH = 0;
let placedWalls = [];      // [{ level, wall, markEl }] for live outcome updates

/**
 * Live outcome from the current spot vs the level's clean/hard-stop zones — lets the board
 * flag a grind or a break between 15-min scores. "broke" once price is a full strike beyond,
 * "grind" once it's past the clean zone but not yet broken. Mirrors the detector's rule.
 */
function liveStatusFor(level) {
  if (typeof liveSpot !== "number" || !lastData) return null;
  const hard = lastData.hard_stop_pts ?? 1.0;
  const clean = lastData.clean_reversal_pts ?? 0.2;
  const over = level.side === "resistance" ? liveSpot - level.strike : level.strike - liveSpot;
  if (over >= hard) return "broke";
  if (over > clean) return "grind";
  return null;
}

/** Merge the scored detector outcome with the live status into a single badge. */
function outcomeView(level) {
  const live = liveStatusFor(level);
  const o = level.outcome || "none";
  if (o === "broke" || live === "broke") return { cls: "broke", text: "broke" };
  if (o === "reversed") return { cls: "held", text: level.clean === false ? "held loose" : "held" };
  if (live === "grind") return { cls: "grinding", text: "grinding" };
  if (o === "pending") return level.clean === false ? { cls: "grinding", text: "grinding" } : { cls: "testing", text: "testing" };
  return { cls: "", text: "" }; // untouched / none / resting — no badge
}

function applyOutcome(entry) {
  const v = outcomeView(entry.level);
  entry.wall.classList.toggle("broke", v.cls === "broke");
  entry.wall.classList.toggle("testing", v.cls === "testing");
  entry.wall.classList.toggle("grinding", v.cls === "grinding");
  entry.markEl.className = `mark ${v.cls}`.trim();
  entry.markEl.textContent = v.text;
  entry.markEl.hidden = !v.text;
}

const refreshOutcomes = () => placedWalls.forEach(applyOutcome);

/** Spot to draw the datum at: live if we have it, else the board's scored spot. */
const currentSpot = () => (typeof liveSpot === "number" ? liveSpot : lastData?.spot);
const boardStale = () => lastData && Date.parse(lastData.as_of) < Date.now() - STALE_MS;

function gaugeHeight(n) {
  const byCount = n * 76 + 2 * PAD;
  const byScreen = clamp(window.innerHeight * 0.68, 460, 760);
  return Math.round(clamp(byCount, 360, Math.max(byScreen, byCount)));
}

/** Map prices to y within [PAD, H-PAD]; high price at top. Anchored on the board spot. */
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
  const wall = el("div", `wall ${level.side === "resistance" ? "res" : "sup"}`);
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
  const markEl = el("span", "mark");
  markEl.hidden = true;
  bar.appendChild(markEl);
  const prob = el("span", `prob ${level.reversal_prob < 45 ? "lo" : ""}`.trim(), `${level.reversal_prob}%`);
  bar.appendChild(prob);
  wall.appendChild(bar);

  const why = el("div", "why", level.why || "");
  wall.appendChild(why);

  wall.addEventListener("click", () => wall.classList.toggle("open"));
  return { wall, track, markEl };
}

function renderReadout(data) {
  const r = $("#readout");
  r.replaceChildren();
  const regimeCls = data.regime === "positive" ? "pos" : data.regime === "negative" ? "neg" : "";
  const cells = [
    ["spot", `$${fmtSpot(currentSpot())}`, "", null, "spotVal"],
    ["regime", data.regime || "—", regimeCls, data.regime === "negative" ? "breaks favored" : data.regime === "positive" ? "pins favored" : "", null],
    ["session", data.session || "—", "", data.session === "Asia" ? "NQ-derived" : null, null],
  ];
  for (const [k, v, cls, note, id] of cells) {
    const cell = el("div", "cell");
    cell.appendChild(el("div", "k", k));
    const val = el("div", `v ${cls}`.trim(), v);
    if (id) val.id = id;
    if (note) val.appendChild(el("small", null, note));
    cell.appendChild(val);
    r.appendChild(cell);
  }
}

/** Position the datum line + spot readout from the *current* (live if available) spot. */
function paintSpot() {
  if (!lastData || !scaleFn) return;
  const spot = currentSpot();
  const datum = $("#datum");

  if (typeof spot !== "number") { datum.hidden = true; return; }
  datum.hidden = false;
  datum.style.top = `${clamp(scaleFn(spot), PAD, gaugeH - PAD)}px`;

  const tag = $("#datumTag");
  tag.replaceChildren();
  const live = typeof liveSpot === "number";
  tag.appendChild(el("small", null, live ? "LIVE" : "SPOT"));
  tag.append(`$${fmtSpot(spot)}`);
  tag.classList.toggle("is-live", live);

  const spotVal = $("#spotVal");
  if (spotVal) {
    spotVal.childNodes[0] && (spotVal.childNodes[0].nodeValue = `$${fmtSpot(spot)}`);
    const note = spotVal.querySelector("small") || spotVal.appendChild(el("small"));
    note.textContent = live ? `live · ${ago(liveSpotAt)}` : "";
    note.className = live ? "live-note" : "";
  }

  refreshOutcomes(); // live spot may have just turned a level into a grind/break
}

/** Stale banner: when the AI isn't currently scoring, say so plainly. */
function renderBanner() {
  const b = $("#banner");
  if (boardStale()) {
    b.hidden = false;
    b.replaceChildren(
      Object.assign(el("span", "banner-dot"), {}),
      el("span", "banner-text", `Levels last scored ${ago(lastData.as_of)} — AI not currently running (scoring box offline). Spot below is live.`),
    );
  } else {
    b.hidden = true;
  }
}

function render(data) {
  renderBanner();

  const stale = boardStale();
  $("#statusDot").className = `status-dot ${stale ? "stale" : "live"}`;
  $("#statusText").textContent = stale ? `levels ${ago(data.as_of)}` : "live";

  renderReadout(data);

  const gauge = $("#gauge");
  const walls = $("#walls");
  const levels = Array.isArray(data.levels) ? data.levels : [];
  walls.replaceChildren();
  walls.classList.toggle("prev", stale); // dim the bars to read as "previously scored"
  $("#datum").hidden = true;
  scaleFn = null;
  placedWalls = [];

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
  gaugeH = H;

  scaleFn = makeScale(levels, data.spot, H);
  const placed = deOverlap(levels.map((l) => ({ level: l, y: scaleFn(l.strike) })));

  // Stagger the bar-draw outward from spot: nearest levels animate first.
  const order = [...placed].sort((a, b) => Math.abs(a.level.strike - data.spot) - Math.abs(b.level.strike - data.spot));
  const tracks = [];
  for (const p of placed) {
    const { wall, track, markEl } = buildWall(p.level, p);
    walls.appendChild(wall);
    placedWalls.push({ level: p.level, wall, markEl });
    tracks.push({ track, rank: order.indexOf(p) });
  }
  refreshOutcomes(); // badges from detector outcome + live status
  requestAnimationFrame(() => tracks.forEach(({ track, rank }) =>
    setTimeout(() => (track.style.setProperty("--p", track.dataset.p)), 60 + rank * 70)));

  $("#datumTag").replaceChildren();
  paintSpot(); // draws the (live or scored) spot line into the fresh ladder

  $("#asOf").textContent = `levels scored ${ago(data.as_of)}`;
}

async function load() {
  try {
    const res = await fetch(`dashboard.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    lastData = await res.json();
    render(lastData);
  } catch (err) {
    $("#statusText").textContent = "no data";
    $("#statusDot").className = "status-dot";
    $("#banner").hidden = true;
    $("#walls").replaceChildren(Object.assign(el("div", "empty"), { textContent: "Waiting for dashboard.json — run a capture." }));
    $("#datum").hidden = true;
  }
}

/** Live spot — independent of the board; degrades silently (e.g. on LAN, no function). */
async function loadSpot() {
  try {
    const res = await fetch(`${SPOT_URL}?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    if (typeof j.spot === "number") {
      liveSpot = j.spot;
      liveSpotAt = j.at || new Date().toISOString();
      paintSpot();
    }
  } catch {
    /* no live spot here (offline / LAN) — datum falls back to the scored spot */
  }
}

$("#refresh").addEventListener("click", () => { load(); loadSpot(); });
document.addEventListener("visibilitychange", () => { if (!document.hidden) { load(); loadSpot(); } });
window.addEventListener("resize", () => { if (lastData) render(lastData); });

load();
loadSpot();
setInterval(load, POLL_MS);
setInterval(loadSpot, SPOT_MS);
