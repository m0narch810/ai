// IV TAPE — the 0DTE at-the-money implied-volatility tape through the session, and the one
// screen the 2022-25 studies actually support.
//
// WHAT THE STUDIES FOUND (data/study/*, pdfs/IV Dynamics at Intraday Reversals*.pdf):
//   * At real turns, ATM 0DTE IV had been RISING into lows (53-58%) and falling into upside
//     run-throughs (67%). Positioning at the strike (OI, gamma, vega, charm, vanna) looked the
//     same at holds and breaks.
//   * As a rule on every strike approach (2025 forward test, 2,886 approaches): rising-IV
//     approaches won 35.6% on the 40/80 bracket, falling-IV 30.7%. A screen, not a signal.
//   * The one strong rule: a PUT-SIDE level reached on FALLING IV — heavy put strike 23.8%
//     (−10 MNQ/fill), lower IV walls 21% (−10 to −15). That is the pass-through signature.
//   * "IV already rolled over" did NOT time entries (32.5% vs 37.0%). Not encoded.
// So this module produces a STATE (rising / falling / flat over the prior 30 min, plus how far
// off its 60-min peak) and a SCREEN per side. No probabilities are printed — the screen is a
// filter on what to skip, and the win rates in the tooltips are the study's, not a forecast.
//
// The tape is fed two ways: the cloud warmer (yyy-warm.mjs) samples every 5 min from 09:31 and
// serves the day via the `ivtape` proxy name, so a page opened at 13:00 has the morning; the
// browser adds a sample on every live poll (60 s in RTH) and keeps them in localStorage.

import { isNum, etNow } from "./util.js";
import { calendarDte, isExpired } from "./data.js";

const WIN_MIN = 30, PEAK_MIN = 60, THR = 0.01;   // fixed before any outcome was looked at
const KEY = (d) => `ivtape.v1.${d}`;
const MAX_LOCAL = 600;

/** Today's ET calendar date, "YYYY-MM-DD". */
export const etDate = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

/** In the cash session (09:31-16:00 ET, Mon-Fri) — the only time the chain moves. */
export function inSession(now = etNow()) {
  return now.dow >= 1 && now.dow <= 5 && now.minutes >= 571 && now.minutes <= 960;
}

/**
 * One tape sample from a /net_iv payload: the ATM IV of the front TRADEABLE expiry (calendar
 * dte, never the expired column) at the strike nearest spot, and the downside wing (spot−2 to
 * spot−5) for the skew read. Null outside the session or when the column is unusable.
 */
export function sampleFrom(netIv, spot, tMs = Date.now()) {
  if (!inSession()) return null;
  const rows = netIv?.rows, exps = netIv?.expiries, dtes = netIv?.dte_list;
  if (!Array.isArray(rows) || !Array.isArray(dtes) || !isNum(spot)) return null;
  let j = -1;
  for (let i = 0; i < dtes.length; i++) {
    const c = calendarDte(exps?.[i]); const d = isNum(c) ? c : dtes[i];
    if (isNum(d) && !isExpired(d)) { j = i; break; }
  }
  if (j < 0) return null;
  const pts = rows.filter((r) => isNum(r?.strike) && isNum(r?.cells?.[j]) && r.cells[j] > 0.01 && r.cells[j] < 5).map((r) => ({ k: r.strike, iv: r.cells[j] }));
  if (pts.length < 6) return null;
  const near = pts.filter((p) => Math.abs(p.k - spot) <= 1.0);
  if (!near.length) return null;
  const atm = near.reduce((s, p) => s + p.iv / (Math.abs(p.k - spot) + 0.05), 0) / near.reduce((s, p) => s + 1 / (Math.abs(p.k - spot) + 0.05), 0);
  const wingPts = pts.filter((p) => p.k <= spot - 2 && p.k >= spot - 5);
  const wing = wingPts.length ? wingPts.reduce((s, p) => s + p.iv, 0) / wingPts.length : NaN;
  return { t: tMs, atm: +atm.toFixed(5), wing: isNum(wing) ? +wing.toFixed(5) : null, spot: +spot.toFixed(2) };
}

/* ── storage: local samples for today ────────────────────────────────────── */

export function loadLocal(date = etDate()) {
  try { const j = JSON.parse(localStorage.getItem(KEY(date)) || "null"); return Array.isArray(j) ? j : []; } catch { return []; }
}

/** Append a sample (rate-limited to one per 45 s); returns today's local tape. */
export function record(netIv, spot) {
  const date = etDate();
  const s = sampleFrom(netIv, spot);
  const tape = loadLocal(date);
  if (!s) return tape;
  const last = tape[tape.length - 1];
  if (last && s.t - last.t < 45_000) return tape;
  tape.push(s);
  while (tape.length > MAX_LOCAL) tape.shift();
  try { localStorage.setItem(KEY(date), JSON.stringify(tape)); } catch { /* optional */ }
  return tape;
}

/** Cloud samples (5-min, from the warmer) merged with the browser's own, de-duplicated. */
export function merge(cloud, local) {
  const all = [...(Array.isArray(cloud?.samples) ? cloud.samples : []), ...(local || [])]
    .filter((s) => s && isNum(s.t) && isNum(s.atm)).sort((a, b) => a.t - b.t);
  const out = [];
  for (const s of all) if (!out.length || s.t - out[out.length - 1].t > 20_000) out.push(s);
  return out;
}

/* ── the state ───────────────────────────────────────────────────────────── */

const at = (tape, t) => { let best = null; for (const s of tape) { if (s.t <= t) best = s; else break; } return best; };

/**
 * @returns {{status:"empty"|"warming"|"stale"|"ok", atm, d30, d15, offPeak, offTrough, cls, rolled, wingRel, n, spanMin, ageMin}}
 */
export function state(tape, now = Date.now()) {
  if (!tape?.length) return { status: "empty", n: 0 };
  const last = tape[tape.length - 1];
  const ageMin = (now - last.t) / 60_000;
  const spanMin = (last.t - tape[0].t) / 60_000;
  const ref30 = at(tape, last.t - WIN_MIN * 60_000), ref15 = at(tape, last.t - 15 * 60_000);
  const base = { status: "ok", atm: last.atm, n: tape.length, spanMin, ageMin, spot: last.spot };
  if (!ref30 || spanMin < WIN_MIN - 5) return { ...base, status: ageMin > 20 ? "stale" : "warming" };
  const win60 = tape.filter((s) => s.t >= last.t - PEAK_MIN * 60_000);
  const peak = Math.max(...win60.map((s) => s.atm)), trough = Math.min(...win60.map((s) => s.atm));
  const d30 = last.atm - ref30.atm, d15 = ref15 ? last.atm - ref15.atm : NaN;
  const wingRel = isNum(last.wing) && isNum(ref30.wing) ? (last.wing - ref30.wing) - d30 : NaN;
  return {
    ...base, status: ageMin > 20 ? "stale" : "ok", d30, d15, offPeak: peak - last.atm, offTrough: last.atm - trough,
    cls: d30 > THR ? "rising" : d30 < -THR ? "falling" : "flat", rolled: peak - last.atm > THR, wingRel,
  };
}

/**
 * The screen for a level on `side` ("support" | "resistance"). `tone` is a tag tone;
 * the `why` carries the study numbers so the chip explains itself on hover.
 */
export function screen(st, side) {
  if (!st || st.status !== "ok") return { tone: "mute", label: "IV ?", why: st?.status === "stale" ? "tape stale — chain not updating" : "IV tape warming (needs 30 min of session)" };
  const sup = side === "support";
  if (sup) {
    if (st.cls === "falling") return { tone: "neg", label: "AVOID · IV↓", why: "put-side level reached on FALLING IV: heavy put strikes held 24% (−10 MNQ/fill), lower IV walls 21%, 2022-25. This is the pass-through signature." };
    if (st.cls === "rising") return { tone: "cool", label: "OK · IV↑", why: "support reached on RISING IV: 34-36% on the 40/80 bracket, +2 to +4 MNQ/fill (2025 forward test). Protection is being bought into it." };
    return { tone: "mute", label: "IV flat", why: "no IV drift either way over 30 min: 29-40% by wall type — no screen" };
  }
  if (st.cls === "rising") return { tone: "cool", label: "OK · IV↑", why: "resistance reached on RISING IV: 37-40%, +5 to +9 MNQ/fill (2025). A rally on rising IV is a squeeze, and squeezes top." };
  if (st.cls === "falling") return { tone: "warn", label: "weak · IV↓", why: "resistance reached on FALLING IV: 29%, −4 MNQ/fill (2025). Grind-ups on a vol crush ran through call walls 67% of the time in 2022-24." };
  return { tone: "mute", label: "IV flat", why: "no IV drift either way over 30 min — no screen" };
}

export const fmtDelta = (d) => (isNum(d) ? `${d >= 0 ? "+" : "−"}${(Math.abs(d) * 100).toFixed(1)}` : "—");


/* ── DAY READ: open-drive bias + wall targets (2022-24 breakout study, data/study/breaks_2224_report.md) ── */

// First-hour move in E0 → how often the close was in that direction, and the median rest-of-day
// move the same way. Bins were fixed in the study script before its output was seen.
const DRIVE_BINS = [
  { max: 0.25, persist: 62, rest: 0.10 },
  { max: 0.5,  persist: 75, rest: 0.18 },
  { max: 0.8,  persist: 83, rest: 0.30 },
  { max: 1e9,  persist: 86, rest: 0.01 },
];
// Distance from a broken strike to the next heavy strike, in E → share of breaks that reached it
// before price traded back to the broken strike.
const REACH_BINS = [
  { max: 0.4, reach: 96 }, { max: 0.8, reach: 71 }, { max: 1.5, reach: 42 }, { max: 1e9, reach: 13 },
];

const sampleAt = (tape, hhmm) => {
  let best = null;
  for (const s of tape) {
    const et = new Date(s.t).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit" });
    if (et <= hhmm) best = s; else break;
  }
  return best;
};

/**
 * The open drive: first-hour move (09:31 → 10:30 ET) in units of the expected move at the open.
 * Null before 10:30 or without both samples. `persist` and `rest` are the study's bucket values.
 */
export function openDrive(tape) {
  if (!tape?.length) return null;
  const s0 = sampleAt(tape, "09:36"), s1 = sampleAt(tape, "10:35");
  const now = etNow();
  if (!s0 || !s1 || s1.t - s0.t < 40 * 60_000 || now.minutes < 630) return null;
  const E0 = s0.spot * s0.atm * Math.sqrt(389 / 525600);
  if (!(E0 > 0)) return null;
  const h1 = (s1.spot - s0.spot) / E0;
  const bin = DRIVE_BINS.find((b) => Math.abs(h1) < b.max) || DRIVE_BINS[DRIVE_BINS.length - 1];
  return { h1, E0, spot0: s0.spot, spot1: s1.spot, dir: h1 > 0 ? "up" : "down", persist: bin.persist, rest: bin.rest, size: Math.abs(h1) < 0.25 ? "small" : Math.abs(h1) < 0.5 ? "moderate" : Math.abs(h1) < 0.8 ? "strong" : "extended" };
}

/**
 * Heavy strikes (top-3 |net gex| within ±1% of spot, or defending-side OI ≥ 2× the band median)
 * as targets: the two nearest above and below spot with distance in E and the study's reach rate.
 * `rows` = data.js greek("gex").rows (strike, net, callOi, putOi); `E` = spot·σ·√T to the close.
 */
export function wallTargets(rows, spot, E) {
  if (!Array.isArray(rows) || !isNum(spot) || !(E > 0)) return { above: [], below: [] };
  const band = rows.filter((r) => isNum(r.strike) && Math.abs(r.strike - spot) <= spot * 0.01);
  const med = (xs) => { const a = xs.filter(isNum).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : 0; };
  const medC = med(band.map((r) => r.callOi)), medP = med(band.map((r) => r.putOi));
  const top3 = new Set([...band].sort((a, b) => Math.abs(b.net) - Math.abs(a.net)).slice(0, 3).map((r) => r.strike));
  const heavyUp = (r) => top3.has(r.strike) || (isNum(r.callOi) && medC > 0 && r.callOi >= 2 * medC);
  const heavyDn = (r) => top3.has(r.strike) || (isNum(r.putOi) && medP > 0 && r.putOi >= 2 * medP);
  const tag = (k) => {
    const dE = Math.abs(k - spot) / E;
    const b = REACH_BINS.find((x) => dE < x.max) || REACH_BINS[REACH_BINS.length - 1];
    return { strike: k, dE, reach: b.reach };
  };
  const above = rows.filter((r) => r.strike > spot + 0.5 && r.strike - spot <= 3 * E && heavyUp(r)).map((r) => r.strike).sort((a, b) => a - b).slice(0, 2).map(tag);
  const below = rows.filter((r) => r.strike < spot - 0.5 && spot - r.strike <= 3 * E && heavyDn(r)).map((r) => r.strike).sort((a, b) => b - a).slice(0, 2).map(tag);
  return { above, below };
}
