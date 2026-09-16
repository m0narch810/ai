// TORII — QQQ options-flow terminal. Entry point: state, chrome, polling, routing.
//
// The shape of this app is set by one fact: the scoring PC is almost never on. So the primary
// data path is YYY (live, cloud, no desk required) and the locally-scored artefacts — board,
// pre-open brief, vol engine — are secondary and always age-stamped.
//
// Load path: paint the last snapshot from localStorage immediately, then fetch in small
// parallel batches and repaint as each lands. Panels whose endpoint is still in flight show
// a skeleton, never an error.

import { $, el, isNum, etClock, isRth, isUsSession, agoText } from "./lib/util.js";
import * as api from "./lib/api.js";
import { initBackground } from "./lib/bg.js";
import { toast, skeleton, decode, decodeAll } from "./lib/ui.js";
import { spark } from "./lib/draw.js";
import { initTips } from "./lib/tip.js";
import { collectLevels, formatLevels, copyText } from "./lib/levels.js";

import * as board from "./lib/views/board.js";
import * as greeks from "./lib/views/greeks.js";
import * as vol from "./lib/views/vol.js";
import * as flow from "./lib/views/flow.js";
import * as regime from "./lib/views/regime.js";
import * as narrative from "./lib/views/narrative.js";

const VIEWS = [board, greeks, vol, flow, regime, narrative];
const VIEW_BY_ID = Object.fromEntries(VIEWS.map((v) => [v.ID, v]));

/**
 * Always fetched, whatever tab is open — feeds the rail and the LEVELS button. net_iv and
 * flow are here because the IV-anomaly pass that feeds LEVELS needs them from any tab.
 */
const CORE_EPS = ["gex", "chart", "atr", "expected_move", "levels", "zero_dte", "dealer_delta", "net_iv", "flow"];

/* ── cadence ─────────────────────────────────────────────────────────────── */

const liveMs = () => (isRth() ? 60_000 : isUsSession() ? 120_000 : 300_000);
const spotMs = () => (isRth() ? 30_000 : 90_000);
const DESK_MS = 5 * 60_000;
const IDLE_MS = 2 * 24 * 60 * 60_000;

/* ── state ───────────────────────────────────────────────────────────────── */

const S = {
  view: "board",
  yyy: { ok: {}, err: {}, at: 0 },
  pending: new Set(),
  spot: NaN,
  spotMeta: null,
  desk: null,
  deskPending: true,
  narrative: null,
  regime: null,
  macro: null,
  lastLive: 0,
  snapAt: 0,
  lastErr: null,
  painted: {},
  shownSpot: NaN,
  sparkDrawn: false,
  lastVals: new Map(),       // "view|key" → last rendered text, for the change flash
};

const currentSpot = () => (isNum(S.spot) ? S.spot : S.yyy.ok?.gex?.spot);

/* ── chrome ──────────────────────────────────────────────────────────────── */

function buildChrome() {
  $("#accountUser").textContent = api.getUser();
  $("#signout").addEventListener("click", () => api.signOut());
  $("#refresh").addEventListener("click", () => { pullLive(true); pullDesk(); toast("resyncing"); });
  $("#copyLevels").addEventListener("click", copyLevels);
  $("#themeToggle").addEventListener("click", toggleTheme);

  const tabs = $("#tabs");
  VIEWS.forEach((v, i) => {
    tabs.append(el("button.tab", { type: "button", "data-view": v.ID, onClick: () => setView(v.ID) },
      [el("i", { text: String(i + 1).padStart(2, "0") }), el("span", { text: v.LABEL })]));
  });
  document.addEventListener("view:refresh", () => paintView());

  // The rail compacts once the header has scrolled away. Scroll position with hysteresis, not
  // an IntersectionObserver: compacting shrinks the rail, which moves the page, which used to
  // flip the observer straight back — the flicker between the two rail states on some scrolls.
  const rail = $("#rail"), sentinel = $("#railSentinel");
  if (rail && sentinel) {
    let compact = false, raf = 0;
    const check = () => {
      raf = 0;
      const y = window.scrollY, top = sentinel.offsetTop;
      if (!compact && y > top + 28) { compact = true; rail.classList.add("compact"); }
      else if (compact && y < top - 4) { compact = false; rail.classList.remove("compact"); }
    };
    window.addEventListener("scroll", () => { if (!raf) raf = requestAnimationFrame(check); }, { passive: true });
    check();
  }

  initLayoutControls();
  $("#resetLayout")?.addEventListener("click", () => { resetLayout(S.view); paintView(); toast("layout reset for this tab"); });
}

/* ── layout: user-arranged panel order + width, per tab ─────────────────── */

const LAY_KEY = (view) => `layout.v1.${view}`;
const loadLayout = (view) => { try { return JSON.parse(localStorage.getItem(LAY_KEY(view)) || "null") || { order: [], half: {} }; } catch { return { order: [], half: {} }; } };
const saveLayout = (view, lay) => { try { localStorage.setItem(LAY_KEY(view), JSON.stringify(lay)); } catch { /* optional */ } };
const resetLayout = (view) => { try { localStorage.removeItem(LAY_KEY(view)); } catch { /* optional */ } };

/** Read the current DOM order into the store (called after any user move). */
function captureLayout(host) {
  const lay = loadLayout(S.view);
  lay.order = Array.from(host.children).map((c) => c.dataset.key).filter(Boolean);
  saveLayout(S.view, lay);
}

/**
 * Impose the saved order and width overrides on a freshly rendered view. Panels the store has
 * never seen keep their default position relative to their neighbours (appended in default
 * order after the known ones), so a new panel shows up without wiping the user's arrangement.
 */
function applyLayout(host) {
  const lay = loadLayout(S.view);
  const kids = Array.from(host.children);
  if (lay.order?.length) {
    const rank = new Map(lay.order.map((k, i) => [k, i]));
    const known = kids.filter((c) => rank.has(c.dataset.key)).sort((a, b) => rank.get(a.dataset.key) - rank.get(b.dataset.key));
    const fresh = kids.filter((c) => !rank.has(c.dataset.key));
    host.replaceChildren(...known, ...fresh);
  }
  for (const c of host.children) {
    const ov = lay.half?.[c.dataset.key];
    if (ov === true) c.classList.add("half");
    else if (ov === false) c.classList.remove("half");
  }
}

function initLayoutControls() {
  const host = $("#viewRoot");
  if (!host) return;

  // arrows + width toggle (work everywhere, including touch)
  host.addEventListener("click", (e) => {
    const btn = e.target.closest?.(".p-laybtn");
    if (!btn) return;
    const pnl = btn.closest(".pnl");
    if (!pnl) return;
    const act = btn.dataset.lay;
    if (act === "up" && pnl.previousElementSibling) pnl.previousElementSibling.before(pnl);
    else if (act === "down" && pnl.nextElementSibling) pnl.nextElementSibling.after(pnl);
    else if (act === "width") {
      const lay = loadLayout(S.view);
      const now = pnl.classList.toggle("half");
      lay.half = { ...(lay.half || {}), [pnl.dataset.key]: now };
      saveLayout(S.view, lay);
    }
    captureLayout(host);
    pnl.classList.add("moved");
    setTimeout(() => pnl.classList.remove("moved"), 500);
  });

  // drag by the label bar (pointer devices)
  let dragging = null;
  host.addEventListener("dragstart", (e) => {
    const label = e.target.closest?.(".p-label");
    if (!label) { e.preventDefault(); return; }
    dragging = label.closest(".pnl");
    dragging.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", dragging.dataset.key); } catch { /* firefox needs data set */ }
  });
  host.addEventListener("dragover", (e) => {
    if (!dragging) return;
    e.preventDefault();
    const over = e.target.closest?.(".pnl");
    if (!over || over === dragging) return;
    const r = over.getBoundingClientRect();
    const before = e.clientY < r.top + r.height / 2;
    if (before) over.before(dragging); else over.after(dragging);
  });
  host.addEventListener("drop", (e) => { if (dragging) e.preventDefault(); });
  host.addEventListener("dragend", () => {
    if (!dragging) return;
    dragging.classList.remove("dragging");
    dragging = null;
    captureLayout(host);
  });
}

function setView(id) {
  if (!VIEW_BY_ID[id]) return;
  const changed = id !== S.view;
  S.view = id;
  localStorage.setItem("view", id);
  for (const b of document.querySelectorAll(".tab")) b.classList.toggle("on", b.dataset.view === id);
  if (changed) delete S.painted[id];
  paintView();
  pullLive();
}

/* ── theme ───────────────────────────────────────────────────────────────── */

let bg = null;

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", t === "dark" ? "#06060a" : "#f4f4f7");
  $("#themeToggle").textContent = t === "dark" ? "light" : "dark";
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
    node.textContent = (from + (to - from) * e).toFixed(2);
    if (p < 1) tickRaf = requestAnimationFrame(step); else S.shownSpot = to;
  };
  tickRaf = requestAnimationFrame(step);
}

const chip = (label, value, tone = "", opt = false) =>
  el(`span.chip${tone ? "." + tone : ""}${opt ? ".opt" : ""}`, null, [`${label} `, el("b", { text: value })]);

function paintRail() {
  const s = currentSpot();
  tickSpot(s);

  const bars = S.yyy.ok?.chart?.candles;
  const open = bars?.[0]?.open;
  const chg = isNum(s) && isNum(open) ? s - open : NaN;
  const chgEl = $("#railChg");
  chgEl.textContent = isNum(chg) ? `${chg >= 0 ? "+" : "−"}${Math.abs(chg).toFixed(2)}  ${(chg / open * 100).toFixed(2)}%` : "";
  chgEl.className = `rail-chg ${isNum(chg) ? (chg >= 0 ? "p" : "n") : ""}`;
  $("#railSrc").textContent = S.spotMeta ? `${S.spotMeta.source} · ${S.spotMeta.session}` : (isNum(S.yyy.ok?.gex?.spot) ? "yyy chain" : "");

  if (bars?.length) {
    const last78 = bars.slice(-78);
    spark($("#railSpark"), last78.map((b) => b.close), { draw: !S.sparkDrawn, tips: last78.map((b) => String(b.time ?? "").match(/T?(\d{2}:\d{2})/)?.[1] ?? "") });
    S.sparkDrawn = true;
  }

  const gx = S.yyy.ok?.gex, em = S.yyy.ok?.expected_move, atr = S.yyy.ok?.atr, z = S.yyy.ok?.zero_dte;
  const chips = [];
  if (gx?.gamma_env) chips.push(chip("Γ", gx.gamma_env === "POSITIVE" ? "POS" : "NEG", gx.gamma_env === "POSITIVE" ? "cool" : "hot"));
  if (isNum(gx?.net_gex_bn)) chips.push(chip("GEX", `${gx.net_gex_bn >= 0 ? "+" : "−"}${Math.abs(gx.net_gex_bn).toFixed(2)}B`, "", true));
  if (isNum(gx?.call_wall)) chips.push(chip("CW", String(gx.call_wall), "cool"));
  if (isNum(gx?.vol_trigger)) chips.push(chip("VT", String(gx.vol_trigger), "", true));
  if (isNum(gx?.put_wall)) chips.push(chip("PW", String(gx.put_wall), "hot"));
  if (isNum(z?.gamma_flip)) chips.push(chip("0DTE FLIP", String(z.gamma_flip), "", true));
  if (isNum(em?.atm_iv)) chips.push(chip("IV", `${em.atm_iv.toFixed(1)}%`, "", true));
  if (isNum(em?.moves?.["1d"]?.move_pts)) chips.push(chip("EM", `±${em.moves["1d"].move_pts.toFixed(2)}`, "", true));
  if (isNum(atr?.atr)) chips.push(chip("ATR", atr.atr.toFixed(2), "", true));
  $("#railChips").replaceChildren(...chips);
}

function paintStatus() {
  const txt = $("#statusText"), age = $("#statusAge");
  const fresh = S.lastLive && Date.now() - S.lastLive < liveMs() * 2.5;
  txt.className = "";
  if (fresh) { txt.textContent = isRth() ? "LIVE" : "OPEN"; txt.classList.add("live"); age.textContent = agoText(S.lastLive); }
  else if (S.pending.size && !S.lastLive) { txt.textContent = S.snapAt ? "CACHED" : "SYNC"; age.textContent = S.snapAt ? agoText(S.snapAt) : "…"; }
  else if (S.lastLive) { txt.textContent = "STALE"; age.textContent = agoText(S.lastLive); }
  else if (S.snapAt) { txt.textContent = "CACHED"; age.textContent = agoText(S.snapAt); }
  else { txt.textContent = S.lastErr ? "NO FEED" : "BOOT"; if (S.lastErr) txt.classList.add("err"); age.textContent = ""; }
}

/* ── render ──────────────────────────────────────────────────────────────── */

function paintView() {
  const host = $("#viewRoot");
  const v = VIEW_BY_ID[S.view];
  if (!v) return;

  const ctx = {
    yyy: S.yyy,
    pending: S.pending,
    wait: (ep, kind = "rows", n) => (S.pending.has(ep) && S.yyy.ok[ep] === undefined ? skeleton(kind, n) : null),
    deskPending: S.deskPending,
    spot: currentSpot(),
    spotMeta: S.spotMeta,
    desk: S.desk,
    narrative: S.narrative,
    regime: S.regime,
    macro: S.macro,
  };

  const first = !S.painted[S.view];
  host.classList.toggle("no-reveal", !first);
  try { v.render(host, ctx); }
  catch (e) {
    console.error("[view]", S.view, e);
    host.replaceChildren(el("div.chart-empty", { text: `render error: ${e?.message ?? e}` }));
  }
  applyLayout(host);
  if (first) {
    Array.from(host.children).forEach((c, i) => c.style.setProperty("--i", String(i)));
    host.querySelectorAll(".statgrid").forEach((g) => Array.from(g.children).forEach((c, i) => c.style.setProperty("--i", String(i))));
    host.querySelectorAll(".meters, .ladder, .omx, .dlevels, .xa-list").forEach((g) => Array.from(g.children).forEach((c, i) => c.style.setProperty("--i", String(i))));
    decodeAll(host, 60);
    S.painted[S.view] = true;
  }
  paintRail();
  flashChanged(host, first);   // after the rail, so the fresh chip nodes are the ones that flash
  paintStatus();
}

/**
 * Bloomberg's one indispensable animation: a cell whose number just changed lights up. Keyed
 * by view + the cell's label (or its position when there is none); the first paint of a view
 * only records, it never flashes.
 */
function flashChanged(host, first) {
  const seen = new Set();
  const check = (node, key) => {
    const k = `${S.view}|${key}`;
    seen.add(k);
    const now = node.textContent;
    const was = S.lastVals.get(k);
    S.lastVals.set(k, now);
    if (!first && was !== undefined && was !== now) {
      node.classList.add("flash");
      node.addEventListener("animationend", () => node.classList.remove("flash"), { once: true });
    }
  };
  host.querySelectorAll(".stat").forEach((s, i) => {
    const v = s.querySelector(".stat-val");
    if (v) check(v, `stat:${s.querySelector(".stat-lbl")?.textContent ?? i}`);
  });
  host.querySelectorAll(".ladder-row").forEach((r, i) => { const v = r.querySelector(".lr-price"); if (v) check(v, `lr:${r.querySelector(".lr-name")?.textContent ?? i}`); });
  host.querySelectorAll(".gbook-row:not(.is-head)").forEach((r) => { const v = r.querySelector(".gb-net"); if (v) check(v, `gb:${r.querySelector(".gb-name")?.textContent ?? ""}`); });
  host.querySelectorAll(".meter").forEach((m, i) => { const v = m.querySelector(".meter-val"); if (v) check(v, `m:${m.querySelector(".meter-lbl")?.textContent ?? i}`); });
  document.querySelectorAll("#railChips .chip").forEach((c) => { const v = c.querySelector("b"); if (v) check(v, `chip:${c.firstChild?.textContent?.trim() ?? ""}`); });
  // keys from panels that disappeared would flash spuriously if they came back — forget them
  for (const k of [...S.lastVals.keys()]) if (k.startsWith(`${S.view}|`) && !seen.has(k)) S.lastVals.delete(k);
}

/* ── data ────────────────────────────────────────────────────────────────── */

let liveTimer = 0, saveTimer = 0;

function mergePart(part) {
  const got = Object.keys(part.ok || {});
  if (got.length) {
    S.yyy = { ok: { ...S.yyy.ok, ...part.ok }, err: { ...S.yyy.err }, at: Date.now() };
    for (const k of got) delete S.yyy.err[k];
    if (!S.lastLive) document.dispatchEvent(new CustomEvent("yyy:first"));
    S.lastLive = Date.now();
    S.lastErr = null;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => api.saveSnapshot(S.yyy.ok), 1500);
  }
  for (const [k, msg] of Object.entries(part.err || {})) { S.yyy.err[k] = msg; S.lastErr = msg; }
}

async function pullLive(force = false) {
  const want = [...new Set([...CORE_EPS, ...(VIEW_BY_ID[S.view]?.EPS || [])])];
  const eps = force ? want : want.filter((e) => !S.pending.has(e));
  if (!eps.length) return;
  for (const e of eps) S.pending.add(e);
  paintStatus();
  paintView();
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
  const levels = collectLevels({ yyy: S.yyy, desk: S.desk, spot: currentSpot() });
  if (!levels.length) { toast("no levels yet — still loading"); return; }
  const ok = await copyText(formatLevels(levels));
  if (!ok) { toast("clipboard blocked by the browser"); return; }
  btn.classList.add("done");
  setTimeout(() => btn.classList.remove("done"), 1100);
  toast(`*${levels.length} levels* copied · paste into Batch Strikes`);
}

/* ── clock + spinner ─────────────────────────────────────────────────────── */

const SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
let spinI = 0, spinTimer = 0;

function tickClock() {
  $("#clock").textContent = etClock();
  paintStatus();
}
function tickSpin() {
  const el_ = $("#spin");
  if (!el_) return;
  el_.textContent = S.pending.size ? SPIN[spinI++ % SPIN.length] : "";
}

/* ── boot log ────────────────────────────────────────────────────────────── */

/**
 * A short, honest boot transcript under the wordmark: the events that actually happen on a
 * cold load, printed as they happen, then folded away. Reads as a terminal coming up because
 * that is what it is.
 */
const bootLines = [];
function bootLog(text, done = false) {
  const log = $("#bootlog");
  if (!log) return;
  if (done && bootLines.length) bootLines[bootLines.length - 1] = text;
  else bootLines.push(text);
  log.replaceChildren();
  bootLines.forEach((l, i) => {
    const row = el("span", null);
    const m = l.match(/^(.*?)(\s*\.{2,}\s*)(.*)$/);
    if (m) row.append(m[1], el("i", { text: m[2] }), el("b", { text: m[3] }));
    else row.append(l);
    log.append(row);
    if (i < bootLines.length - 1) log.append("\n");
  });
  log.classList.add("on");
}
function bootLogClose(delay = 4200) {
  setTimeout(() => $("#bootlog")?.classList.remove("on"), delay);
}

/* ── boot ────────────────────────────────────────────────────────────────── */

function boot() {
  const idle = Date.now() - parseInt(localStorage.getItem("lastSeen") ?? "0", 10) > IDLE_MS;
  if (!api.getToken() || idle) { api.clearAuth(); window.location.href = "/login.html"; return; }
  localStorage.setItem("lastSeen", String(Date.now()));

  applyTheme(localStorage.getItem("theme") || "dark");
  bg = initBackground($("#bg"));
  buildChrome();
  initTips();
  decode($("#wordmark"), 700);

  bootLog(`auth ${api.getUser() || "operator"} ...... ok`);
  const snap = api.loadSnapshot();
  if (snap) { S.yyy = { ok: snap.ok, err: {}, at: snap.at }; S.snapAt = snap.at; }
  bootLog(snap ? `snapshot ...... ${Object.keys(snap.ok).length} ep · ${agoText(snap.at)}` : "snapshot ...... cold");
  bootLog(`session ....... ${isRth() ? "rth" : isUsSession() ? "us ext" : "off-hours"}`);
  bootLog("link yyy ...... …");
  // the last line resolves when the first live part lands
  const unhook = () => { bootLog("link yyy ...... ok", true); bootLogClose(); document.removeEventListener("yyy:first", unhook); };
  document.addEventListener("yyy:first", unhook);
  setTimeout(() => { if (bootLines[bootLines.length - 1].endsWith("…")) { bootLog("link yyy ...... slow", true); bootLogClose(2600); } }, 9000);

  const saved = localStorage.getItem("view");
  setView(VIEW_BY_ID[saved] ? saved : "board");

  tickClock();
  setInterval(tickClock, 1000);
  spinTimer = setInterval(tickSpin, 90);

  pullSpot();
  pullDesk();
  setInterval(pullDesk, DESK_MS);

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && Date.now() - S.lastLive > liveMs()) pullLive(true);
  });
}

boot();
