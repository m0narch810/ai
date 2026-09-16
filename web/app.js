// TORII — QQQ options-flow terminal. Entry point: state, chrome, polling, routing.
//
// The shape of this app is set by one fact: the scoring PC is almost never on. So the primary
// data path is YYY (live, cloud, no desk required) and the locally-scored artefacts — board,
// pre-open brief, vol engine — are secondary and always age-stamped. Nothing on screen depends
// on the box being awake.

import { $, el, isNum, etClock, isRth, isUsSession, agoText, asciiSpark } from "./lib/util.js";
import * as api from "./lib/api.js";
import { initBackground } from "./lib/bg.js";
import { tag } from "./lib/ui.js";

import * as board from "./lib/views/board.js";
import * as greeks from "./lib/views/greeks.js";
import * as vol from "./lib/views/vol.js";
import * as flow from "./lib/views/flow.js";
import * as regime from "./lib/views/regime.js";
import * as narrative from "./lib/views/narrative.js";

const VIEWS = [board, greeks, vol, flow, regime, narrative];
const VIEW_BY_ID = Object.fromEntries(VIEWS.map((v) => [v.ID, v]));

/** Always fetched, whatever tab is open — this is what feeds the spot rail. */
const CORE_EPS = ["gex", "expected_move", "atr", "chart"];

/* ── cadence ─────────────────────────────────────────────────────────────── */

const liveMs = () => (isRth() ? 60_000 : isUsSession() ? 120_000 : 300_000);
const spotMs = () => (isRth() ? 30_000 : 90_000);
const DESK_MS = 5 * 60_000;
const IDLE_MS = 2 * 24 * 60 * 60_000;

/* ── state ───────────────────────────────────────────────────────────────── */

const S = {
  view: "board",
  yyy: { ok: {}, err: {}, at: 0 },
  spot: NaN,
  spotMeta: null,
  desk: null,
  narrative: null,
  regime: null,
  macro: null,
  loading: false,
  lastLive: 0,
  lastErr: null,
  spark: [],
};

/** Spot, in freshness order: the live Yahoo print, else whatever YYY last quoted. */
const currentSpot = () => (isNum(S.spot) ? S.spot : S.yyy.ok?.gex?.spot);

/* ── chrome ──────────────────────────────────────────────────────────────── */

function buildChrome() {
  $("#accountUser").textContent = api.getUser();
  $("#signout").addEventListener("click", () => api.signOut());
  $("#refresh").addEventListener("click", () => { pullLive(true); pullDesk(); });

  const tabs = $("#tabs");
  for (const v of VIEWS) {
    tabs.append(el("button.tab", {
      type: "button", "data-view": v.ID,
      onClick: () => setView(v.ID),
    }, [el("i.tab-jp", { text: v.JP }), el("span.tab-en", { text: v.LABEL })]));
  }

  $("#themeToggle").addEventListener("click", toggleTheme);
  document.addEventListener("view:refresh", () => paintView());
}

function setView(id) {
  if (!VIEW_BY_ID[id]) return;
  S.view = id;
  localStorage.setItem("view", id);
  for (const b of document.querySelectorAll(".tab")) b.classList.toggle("on", b.dataset.view === id);
  document.querySelector("#viewRoot").scrollIntoView({ block: "start", behavior: "instant" });
  paintView();
  pullLive();            // the new tab almost always wants endpoints we have not fetched
}

/* ── theme ───────────────────────────────────────────────────────────────── */

let bg = null;

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", t === "dark" ? "#060606" : "#f4f4f2");
  $("#themeToggle").textContent = t === "dark" ? "☀" : "☾";
  bg?.repaint();
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem("theme", next);
  applyTheme(next);
  paintView();           // charts read their colours from CSS custom properties at paint time
}

/* ── the spot rail ───────────────────────────────────────────────────────── */

function paintRail() {
  const s = currentSpot();
  $("#railSpot").textContent = isNum(s) ? s.toFixed(2) : "—";

  // Session change: first bar's open against the live print. /chart is the session's own bars,
  // so this is a true intraday change rather than a close-to-close one.
  const bars = S.yyy.ok?.chart?.candles;
  const open = bars?.[0]?.open;
  const chg = isNum(s) && isNum(open) ? s - open : NaN;
  const chgEl = $("#railChg");
  chgEl.textContent = isNum(chg) ? `${chg >= 0 ? "+" : "−"}${Math.abs(chg).toFixed(2)}  ${(chg / open * 100).toFixed(2)}%` : "";
  chgEl.className = `rail-chg ${isNum(chg) ? (chg >= 0 ? "p" : "n") : ""}`;

  $("#railSrc").textContent = S.spotMeta
    ? `${S.spotMeta.source} · ${S.spotMeta.session}`
    : (isNum(S.yyy.ok?.gex?.spot) ? "YYY CHAIN" : "");

  if (bars?.length) {
    S.spark = bars.slice(-60).map((b) => b.close);
    $("#railSpark").textContent = asciiSpark(S.spark);
  }

  const gx = S.yyy.ok?.gex;
  const em = S.yyy.ok?.expected_move;
  const atr = S.yyy.ok?.atr;
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
  const dot = $("#statusDot"), txt = $("#statusText");
  const fresh = S.lastLive && Date.now() - S.lastLive < liveMs() * 2.5;
  if (S.loading) { dot.className = "dot is-load"; txt.textContent = "SYNC"; }
  else if (fresh) { dot.className = "dot is-live"; txt.textContent = isRth() ? "LIVE" : "OPEN"; }
  else if (S.lastLive) { dot.className = "dot is-warn"; txt.textContent = "STALE"; }
  else { dot.className = "dot is-err"; txt.textContent = S.lastErr ? "NO FEED" : "BOOT"; }
  $("#statusAge").textContent = S.lastLive ? agoText(S.lastLive) : "";
}

/* ── render ──────────────────────────────────────────────────────────────── */

function paintView() {
  const host = $("#viewRoot");
  const v = VIEW_BY_ID[S.view];
  if (!v) return;
  const ctx = {
    yyy: S.yyy,
    spot: currentSpot(),
    spotMeta: S.spotMeta,
    desk: S.desk,
    narrative: S.narrative,
    regime: S.regime,
    macro: S.macro,
  };
  try { v.render(host, ctx); }
  catch (e) {
    console.error("[view]", S.view, e);
    host.replaceChildren(el("div.chart-empty", { text: `render error: ${e?.message ?? e}` }));
  }
  paintRail();
  paintStatus();
}

/* ── data ────────────────────────────────────────────────────────────────── */

let liveTimer = 0;

/**
 * Pull the current view's endpoints plus the core set. Results MERGE into the cache rather
 * than replacing it, so switching tabs never blanks the rail and a tab you come back to still
 * has its last good paint while the new request is in flight.
 */
async function pullLive(force = false) {
  if (S.loading && !force) return;
  S.loading = true;
  paintStatus();

  const eps = [...new Set([...CORE_EPS, ...(VIEW_BY_ID[S.view]?.EPS || [])])];
  try {
    const res = await api.yyy(eps);
    const got = Object.keys(res.ok).length;
    if (got) {
      S.yyy = { ok: { ...S.yyy.ok, ...res.ok }, err: res.err, at: Date.now() };
      S.lastLive = Date.now();
      S.lastErr = null;
    } else {
      S.lastErr = Object.values(res.err)[0] ?? "no response";
    }
  } catch (e) {
    S.lastErr = String(e?.message ?? e);
  } finally {
    S.loading = false;
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
    // A moved print changes every distance reading on the page, but a full view rebuild once a
    // minute is enough — the rail carries the tick itself.
    if (moved && S.view === "board") paintView();
  }
  setTimeout(pullSpot, spotMs());
}

async function pullDesk() {
  const [b, n, r, m] = await Promise.all([api.board(), api.narrative(), api.regime(), api.macro()]);
  if (b) S.desk = b;
  if (n) S.narrative = n;
  if (r) S.regime = r;
  if (m) S.macro = m;
  paintView();
}

/* ── clock ───────────────────────────────────────────────────────────────── */

function tickClock() {
  $("#clock").textContent = `${etClock()} ET`;
  paintStatus();
}

/* ── boot ────────────────────────────────────────────────────────────────── */

function boot() {
  // Session gate. The token is checked server-side on every call too — this is only so an
  // expired session lands on the login page instead of a wall of 401s.
  const idle = Date.now() - parseInt(localStorage.getItem("lastSeen") ?? "0", 10) > IDLE_MS;
  if (!api.getToken() || idle) { api.clearAuth(); window.location.href = "/login.html"; return; }
  localStorage.setItem("lastSeen", String(Date.now()));

  applyTheme(localStorage.getItem("theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  bg = initBackground($("#bg"));
  buildChrome();

  const saved = localStorage.getItem("view");
  setView(VIEW_BY_ID[saved] ? saved : "board");

  tickClock();
  setInterval(tickClock, 1000);

  pullLive();
  pullSpot();
  pullDesk();
  setInterval(pullDesk, DESK_MS);

  // Coming back to a backgrounded tab should show current data, not whatever was on screen
  // when it was hidden.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && Date.now() - S.lastLive > liveMs()) pullLive(true);
  });
}

boot();
