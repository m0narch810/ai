// TORII — QQQ options-flow terminal. Entry point: state, chrome, polling, routing.
//
// The shape of this app is set by one fact: the scoring PC is almost never on. So the primary
// data path is YYY (live, cloud, no desk required) and the locally-scored artefacts — board,
// pre-open brief, vol engine — are secondary and always age-stamped.
//
// Load path (the second thing that was wrong with v1): paint the last snapshot from
// localStorage immediately, then fetch in small parallel batches and repaint as each lands.
// Panels whose endpoint is still in flight show a skeleton, never an error.

import { $, el, isNum, etClock, isRth, isUsSession, agoText } from "./lib/util.js";
import * as api from "./lib/api.js";
import { initBackground } from "./lib/bg.js";
import { tag, toast, skeleton, initSpotlight } from "./lib/ui.js";
import { spark } from "./lib/draw.js";
import { collectLevels, formatLevels, copyText } from "./lib/levels.js";

import * as board from "./lib/views/board.js";
import * as greeks from "./lib/views/greeks.js";
import * as vol from "./lib/views/vol.js";
import * as flow from "./lib/views/flow.js";
import * as regime from "./lib/views/regime.js";
import * as narrative from "./lib/views/narrative.js";

const VIEWS = [board, greeks, vol, flow, regime, narrative];
const VIEW_BY_ID = Object.fromEntries(VIEWS.map((v) => [v.ID, v]));

/** Always fetched, whatever tab is open — feeds the rail and the LEVELS button. All small. */
const CORE_EPS = ["gex", "chart", "atr", "expected_move", "levels", "zero_dte", "dealer_delta"];

/* ── cadence ─────────────────────────────────────────────────────────────── */

const liveMs = () => (isRth() ? 60_000 : isUsSession() ? 120_000 : 300_000);
const spotMs = () => (isRth() ? 30_000 : 90_000);
const DESK_MS = 5 * 60_000;
const IDLE_MS = 2 * 24 * 60 * 60_000;

/* ── state ───────────────────────────────────────────────────────────────── */

const S = {
  view: "board",
  yyy: { ok: {}, err: {}, at: 0 },
  pending: new Set(),        // endpoints currently in flight
  spot: NaN,
  spotMeta: null,
  desk: null,
  deskPending: true,
  narrative: null,
  regime: null,
  macro: null,
  lastLive: 0,               // last time a live part landed
  snapAt: 0,                 // age of the restored snapshot, if that is what is on screen
  lastErr: null,
  painted: {},               // view id → true once revealed (subsequent paints don't re-animate)
  shownSpot: NaN,            // what the rail numeral currently reads (for the tick-up)
};

const currentSpot = () => (isNum(S.spot) ? S.spot : S.yyy.ok?.gex?.spot);

/* ── chrome ──────────────────────────────────────────────────────────────── */

function buildChrome() {
  $("#accountUser").textContent = api.getUser();
  $("#signout").addEventListener("click", () => api.signOut());
  $("#refresh").addEventListener("click", () => { pullLive(true); pullDesk(); });
  $("#copyLevels").addEventListener("click", copyLevels);
  $("#themeToggle").addEventListener("click", toggleTheme);

  const tabs = $("#tabs");
  for (const v of VIEWS) {
    tabs.append(el("button.tab", { type: "button", "data-view": v.ID, onClick: () => setView(v.ID) },
      [el("i.tab-jp", { text: v.JP }), el("span.tab-en", { text: v.LABEL })]));
  }
  document.addEventListener("view:refresh", () => paintView());
  initSpotlight($("#viewRoot"));
}

function setView(id) {
  if (!VIEW_BY_ID[id]) return;
  const changed = id !== S.view;
  S.view = id;
  localStorage.setItem("view", id);
  for (const b of document.querySelectorAll(".tab")) b.classList.toggle("on", b.dataset.view === id);
  if (changed) delete S.painted[id];   // a tab you switch to reveals again
  paintView();
  pullLive();
}

/* ── theme ───────────────────────────────────────────────────────────────── */

let bg = null;

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", t === "dark" ? "#050507" : "#f5f5f8");
  $("#themeToggle").textContent = t === "dark" ? "☀" : "☾";
  bg?.repaint();
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem("theme", next);
  applyTheme(next);
  paintView();
}

/* ── the rail ────────────────────────────────────────────────────────────── */

let tickRaf = 0;
/** Tick the big numeral from what it reads now to the new print. */
function tickSpot(to) {
  const node = $("#railSpot");
  const from = isNum(S.shownSpot) ? S.shownSpot : to;
  cancelAnimationFrame(tickRaf);
  if (!isNum(to)) { node.textContent = "—"; return; }
  if (Math.abs(to - from) < 0.005 || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    node.textContent = to.toFixed(2); S.shownSpot = to; return;
  }
  const t0 = performance.now(), dur = 650;
  const step = (now) => {
    const p = Math.min(1, (now - t0) / dur);
    const e = 1 - Math.pow(1 - p, 3);
    const v = from + (to - from) * e;
    node.textContent = v.toFixed(2);
    if (p < 1) tickRaf = requestAnimationFrame(step); else S.shownSpot = to;
  };
  tickRaf = requestAnimationFrame(step);
}

function paintRail() {
  const s = currentSpot();
  tickSpot(s);

  const bars = S.yyy.ok?.chart?.candles;
  const open = bars?.[0]?.open;
  const chg = isNum(s) && isNum(open) ? s - open : NaN;
  const chgEl = $("#railChg");
  chgEl.textContent = isNum(chg) ? `${chg >= 0 ? "+" : "−"}${Math.abs(chg).toFixed(2)}  ${(chg / open * 100).toFixed(2)}%` : "";
  chgEl.className = `rail-chg ${isNum(chg) ? (chg >= 0 ? "p" : "n") : ""}`;

  $("#railSrc").textContent = S.spotMeta
    ? `${S.spotMeta.source} · ${S.spotMeta.session}`
    : (isNum(S.yyy.ok?.gex?.spot) ? "YYY CHAIN" : "");

  if (bars?.length) spark($("#railSpark"), bars.slice(-78).map((b) => b.close));

  const gx = S.yyy.ok?.gex, em = S.yyy.ok?.expected_move, atr = S.yyy.ok?.atr;
  const chips = [];
  if (gx?.gamma_env) chips.push(tag(`${gx.gamma_env} Γ`, gx.gamma_env === "POSITIVE" ? "cool" : "hot"));
  if (isNum(gx?.net_gex_bn)) chips.push(tag(`GEX ${gx.net_gex_bn >= 0 ? "+" : "−"}${Math.abs(gx.net_gex_bn).toFixed(2)}B`, "mute"));
  if (isNum(gx?.call_wall)) chips.push(tag(`CW ${gx.call_wall}`, "cool"));
  if (isNum(gx?.put_wall)) chips.push(tag(`PW ${gx.put_wall}`, "hot"));
  if (isNum(em?.atm_iv)) chips.push(tag(`IV ${em.atm_iv.toFixed(1)}%`, "mute"));
  if (isNum(em?.moves?.["1d"]?.move_pts)) chips.push(tag(`EM ±${em.moves["1d"].move_pts.toFixed(2)}`, "mute"));
  if (isNum(atr?.atr)) chips.push(tag(`ATR ${atr.atr.toFixed(2)}`, "mute"));
  $("#railChips").replaceChildren(...chips);
}

function paintStatus() {
  const dot = $("#statusDot"), txt = $("#statusText"), age = $("#statusAge");
  const fresh = S.lastLive && Date.now() - S.lastLive < liveMs() * 2.5;
  if (fresh) { dot.className = "dot is-live"; txt.textContent = isRth() ? "LIVE" : "OPEN"; age.textContent = agoText(S.lastLive); }
  else if (S.pending.size && !S.lastLive) { dot.className = "dot is-load"; txt.textContent = S.snapAt ? "CACHED" : "SYNC"; age.textContent = S.snapAt ? agoText(S.snapAt) : ""; }
  else if (S.lastLive) { dot.className = "dot is-warn"; txt.textContent = "STALE"; age.textContent = agoText(S.lastLive); }
  else if (S.snapAt) { dot.className = "dot is-cache"; txt.textContent = "CACHED"; age.textContent = agoText(S.snapAt); }
  else { dot.className = "dot is-err"; txt.textContent = S.lastErr ? "NO FEED" : "BOOT"; age.textContent = ""; }
}

/* ── render ──────────────────────────────────────────────────────────────── */

function paintView() {
  const host = $("#viewRoot");
  const v = VIEW_BY_ID[S.view];
  if (!v) return;

  const ctx = {
    yyy: S.yyy,
    pending: S.pending,
    /** A skeleton while `ep` is in flight and nothing is cached for it; null otherwise. */
    wait: (ep, kind = "rows", n) => (S.pending.has(ep) && S.yyy.ok[ep] === undefined ? skeleton(kind, n) : null),
    deskPending: S.deskPending,
    spot: currentSpot(),
    spotMeta: S.spotMeta,
    desk: S.desk,
    narrative: S.narrative,
    regime: S.regime,
    macro: S.macro,
  };

  // Reveal once per visit to a tab; repaints from arriving data should not re-run the entrance.
  host.classList.toggle("no-reveal", !!S.painted[S.view]);
  try { v.render(host, ctx); }
  catch (e) {
    console.error("[view]", S.view, e);
    host.replaceChildren(el("div.chart-empty", { text: `render error: ${e?.message ?? e}` }));
  }
  if (!S.painted[S.view]) {
    Array.from(host.children).forEach((c, i) => c.style.setProperty("--i", String(i)));
    S.painted[S.view] = true;
  }
  paintRail();
  paintStatus();
}

/* ── data ────────────────────────────────────────────────────────────────── */

let liveTimer = 0;
let saveTimer = 0;

function mergePart(part) {
  const got = Object.keys(part.ok || {});
  if (got.length) {
    S.yyy = { ok: { ...S.yyy.ok, ...part.ok }, err: { ...S.yyy.err }, at: Date.now() };
    for (const k of got) delete S.yyy.err[k];
    S.lastLive = Date.now();
    S.lastErr = null;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => api.saveSnapshot(S.yyy.ok), 1500);
  }
  for (const [k, msg] of Object.entries(part.err || {})) {
    S.yyy.err[k] = msg;
    S.lastErr = msg;
  }
}

/**
 * Pull the current view's endpoints plus the core set. Batches are small and parallel, and
 * every batch that lands repaints immediately — the page assembles progressively instead of
 * waiting for the slowest upstream route.
 */
async function pullLive(force = false) {
  const want = [...new Set([...CORE_EPS, ...(VIEW_BY_ID[S.view]?.EPS || [])])];
  const eps = force ? want : want.filter((e) => !S.pending.has(e));
  if (!eps.length) return;

  for (const e of eps) S.pending.add(e);
  paintStatus();
  paintView();   // panels for freshly-pending endpoints switch to skeletons

  try {
    await api.yyy(eps, {
      onPart: (part, chunk) => {
        for (const e of chunk) S.pending.delete(e);
        mergePart(part);
        paintView();
      },
    });
  } finally {
    for (const e of eps) S.pending.delete(e);
    paintView();
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => pullLive(), liveMs());
  }
}

async function pullSpot() {
  const j = await api.spot();
  if (j && isNum(j.spot)) {
    const moved = j.spot !== S.spot;
    S.spot = j.spot;
    S.spotMeta = { source: j.source, session: j.session, at: j.at };
    paintRail();
    if (moved && S.view === "board") paintView();
  }
  setTimeout(pullSpot, spotMs());
}

async function pullDesk() {
  S.deskPending = true;
  const [b, n, r, m] = await Promise.all([api.board(), api.narrative(), api.regime(), api.macro()]);
  if (b) S.desk = b;
  if (n) S.narrative = n;
  if (r) S.regime = r;
  if (m) S.macro = m;
  S.deskPending = false;
  paintView();
}

/* ── copy levels ─────────────────────────────────────────────────────────── */

async function copyLevels() {
  const btn = $("#copyLevels");
  const levels = collectLevels({ yyy: S.yyy, desk: S.desk });
  if (!levels.length) { toast("no levels yet — still loading"); return; }
  const ok = await copyText(formatLevels(levels));
  if (!ok) { toast("clipboard blocked by the browser"); return; }
  btn.classList.add("done");
  setTimeout(() => btn.classList.remove("done"), 1100);
  toast(`*${levels.length} levels* copied · paste into the converter's Batch Strikes`);
}

/* ── clock ───────────────────────────────────────────────────────────────── */

function tickClock() {
  $("#clock").textContent = `${etClock()} ET`;
  paintStatus();
}

/* ── boot ────────────────────────────────────────────────────────────────── */

function boot() {
  const idle = Date.now() - parseInt(localStorage.getItem("lastSeen") ?? "0", 10) > IDLE_MS;
  if (!api.getToken() || idle) { api.clearAuth(); window.location.href = "/login.html"; return; }
  localStorage.setItem("lastSeen", String(Date.now()));

  applyTheme(localStorage.getItem("theme") || "dark");
  bg = initBackground($("#bg"));
  buildChrome();

  // Instant first paint from the last frame this browser saw. Stamped CACHED until live
  // parts replace it; anything older than six hours is not worth showing.
  const snap = api.loadSnapshot();
  if (snap) { S.yyy = { ok: snap.ok, err: {}, at: snap.at }; S.snapAt = snap.at; }

  const saved = localStorage.getItem("view");
  setView(VIEW_BY_ID[saved] ? saved : "board");

  tickClock();
  setInterval(tickClock, 1000);

  pullSpot();
  pullDesk();
  setInterval(pullDesk, DESK_MS);

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && Date.now() - S.lastLive > liveMs()) pullLive(true);
  });
}

boot();
