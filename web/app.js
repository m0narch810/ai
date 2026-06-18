// Reversal ladder — reads dashboard.json (AI-scored levels) and overlays a live spot.
// No framework, no build. Levels are grouped into ceilings (resistance) and floors
// (support) around a live violet spot rail. Two clocks: the board (AI, can go stale)
// and the spot (live from a Netlify function, updates regardless of the scoring box).
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

function agoMs(t) {
  if (typeof t !== "number" || Number.isNaN(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}
/** Absolute scored time (timezone-proof); falls back to generated_at if missing. */
const scoredAt = () => (typeof lastData?.scored_at === "number" ? lastData.scored_at : Date.parse(lastData?.generated_at ?? ""));
const scoredAgo = () => agoMs(scoredAt());

// ---- state -------------------------------------------------------------------
let lastData = null;
let liveSpot = null;
let liveSpotAt = null;
let rungEls = []; // [{ el, level, distEl, badgeEl, fill }]

const currentSpot = () => (typeof liveSpot === "number" ? liveSpot : lastData?.spot);
const boardStale = () => lastData && scoredAt() < Date.now() - STALE_MS;

/** RTH (09:15–16:00 ET, Mon–Fri) = when the AI re-scores; outside it, levels are held. */
function isRthNow() {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
  const get = (t) => p.find((x) => x.type === t)?.value;
  const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const wd = WD[get("weekday")] ?? 0;
  const minutes = Number(get("hour")) * 60 + Number(get("minute"));
  return wd >= 1 && wd <= 5 && minutes >= 555 && minutes <= 960;
}

/** Live status from current spot vs a level's clean/hard-stop zones (between scores). */
function liveStatusFor(level) {
  if (typeof liveSpot !== "number" || !lastData) return null;
  const hard = lastData.hard_stop_pts ?? 1.0;
  const clean = lastData.clean_reversal_pts ?? 0.2;
  const over = level.side === "resistance" ? liveSpot - level.strike : level.strike - liveSpot;
  if (over >= hard) return "broke";
  if (over > clean) return "grind";
  return null;
}

/** Detector outcome + live status → one badge. */
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

  const price = el("div", "price");
  price.appendChild(el("span", "strike", `$${fmtPrice(level.strike)}`));
  const distEl = el("span", "dist");
  price.appendChild(distEl);
  row.appendChild(price);

  const body = el("div", "body");
  const tags = Array.isArray(level.tags) ? level.tags.slice(0, 4) : [];
  if (tags.length) {
    const chips = el("div", "chips");
    for (const t of tags) chips.appendChild(el("span", "chip", t));
    body.appendChild(chips);
  }
  if (level.why) body.appendChild(el("div", "why", level.why));
  row.appendChild(body);

  const meter = el("div", "meter");
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

/** Everything that depends on the (live) spot — hero, rail, per-rung distance + badge. */
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
  $("#statusDot").className = `status-dot ${stale ? "stale" : "live"}`;
  $("#statusText").textContent = !stale ? "live" : isRthNow() ? `scored ${scoredAgo()}` : "held · off-rth";

  renderHeroMetrics(data);

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
    return;
  }
  $("#ladder").hidden = false; $("#empty").hidden = true;

  const res = levels.filter((l) => l.side === "resistance").sort((a, b) => b.strike - a.strike);
  const sup = levels.filter((l) => l.side === "support").sort((a, b) => b.strike - a.strike);
  for (const l of res) { const e = buildRung(l); ceil.appendChild(e.el); rungEls.push(e); }
  for (const l of sup) { const e = buildRung(l); floor.appendChild(e.el); rungEls.push(e); }

  requestAnimationFrame(() => rungEls.forEach((e, i) =>
    setTimeout(() => (e.fill.style.width = `${clamp(e.level.reversal_prob, 0, 100)}%`), 40 + i * 55)));

  repaintLive();
  $("#asOf").textContent = `scored ${scoredAgo()}`;
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
      repaintLive();
    }
  } catch { /* no live spot (offline / LAN) — fall back to the scored spot */ }
}

$("#refresh").addEventListener("click", () => { load(); loadSpot(); });
document.addEventListener("visibilitychange", () => { if (!document.hidden) { load(); loadSpot(); } });

load();
loadSpot();
setInterval(load, POLL_MS);
setInterval(loadSpot, SPOT_MS);
