// IV walls, computed in the browser from the live chain.
//
// A straight port of src/ivWalls.ts (pdfs/IV Wall Derivation Spec.pdf, adapted SPY → QQQ):
// the INNER walls are the ~19-delta strikes (|Δ| = 0.1925) of the front expiry, found by
// interpolating Black-Scholes delta across the chain's own per-strike IV smile; the OUTER walls
// sit a fixed fraction of spot beyond each inner wall (the spec's +1.56 / −1.79 SPY points at
// SPY ≈ 750, the lower band wider because of put skew).
//
// Why here as well as on the desk: the desk freezes one bracket per session from its first
// usable chain, and with the box off that bracket is days old. The front end has the same smile
// live from /net_iv, so it can draw the walls the spec would produce RIGHT NOW. The desk's frozen
// bracket is still shown alongside when it exists — the two disagreeing is itself information
// (IV has moved since the open).

import { isNum } from "./util.js";
import { calendarDte, isExpired } from "./data.js";

const DELTA_STAR = 0.1925;
const W_U_PCT = 1.56 / 750;
const W_L_PCT = 1.79 / 750;
const R = 0.04;

function erf(x) {
  const s = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return s * y;
}
const normCdf = (x) => 0.5 * (1 + erf(x / Math.SQRT2));

/** Strike where |Δ| crosses DELTA_STAR along one OTM wing, enforcing monotone |Δ| first. */
function deltaCross(wing) {
  const mono = [];
  for (const p of wing) {
    if (!Number.isFinite(p.delta)) continue;
    if (!mono.length || p.delta < mono[mono.length - 1].delta) mono.push(p);
  }
  for (let i = 0; i + 1 < mono.length; i++) {
    const a = mono[i], b = mono[i + 1];
    if (a.delta >= DELTA_STAR && b.delta <= DELTA_STAR) {
      const f = (a.delta - DELTA_STAR) / (a.delta - b.delta || 1);
      return a.k + f * (b.k - a.k);
    }
  }
  return null;
}

/**
 * @param {{strike:number, sigma:number}[]} smile  per-strike IV as a DECIMAL (0.24 = 24%)
 * @param {number} spot
 * @param {number} tYears
 */
function computeIvWalls(smile, spot, tYears, dte) {
  const pts = (smile || [])
    .filter((p) => isNum(p?.strike) && p.strike > 0 && isNum(p?.sigma) && p.sigma > 0.01 && p.sigma < 5)
    .sort((a, b) => a.strike - b.strike);
  if (pts.length < 8 || !(spot > 0) || !(tYears > 0)) return null;

  const sqT = Math.sqrt(tYears);
  const d1 = (K, sigma) => (Math.log(spot / K) + (R + (sigma * sigma) / 2) * tYears) / (sigma * sqT);

  const upper = pts.filter((p) => p.strike >= spot).map((p) => ({ k: p.strike, delta: normCdf(d1(p.strike, p.sigma)) }));
  const lower = pts.filter((p) => p.strike <= spot).reverse().map((p) => ({ k: p.strike, delta: normCdf(-d1(p.strike, p.sigma)) }));

  const uInner = deltaCross(upper);
  const lInner = deltaCross(lower);
  if (uInner == null || lInner == null) return null;

  const atm = pts.reduce((a, b) => (Math.abs(b.strike - spot) < Math.abs(a.strike - spot) ? b : a));
  const r2 = (n) => Math.round(n * 100) / 100;
  return {
    u_inner: r2(uInner),
    u_outer: r2(uInner + spot * W_U_PCT),
    l_inner: r2(lInner),
    l_outer: r2(lInner - spot * W_L_PCT),
    spot_at_calc: r2(spot),
    sigma_atm_pct: r2(atm.sigma * 100),
    delta: DELTA_STAR,
    dte,
    n: pts.length,
  };
}

/**
 * Time to expiry in years: the minutes from now (ET) to that expiry's 16:00 ET close, floored
 * at 30 min. Inside RTH this is exactly the desk's 0DTE convention (src/ivWalls.ts); overnight
 * it keeps counting down to the NEXT close instead of pretending a 24h day, which is what the
 * spec's prior-evening bracket implies.
 */
function tYearsFor(dte, nowMinutesEt) {
  const d = isNum(dte) ? dte : 0;
  const mins = Math.max(d * 1440 + (16 * 60 - nowMinutesEt), 30);
  return mins / (60 * 24 * 365);
}

/**
 * Walls from the live /net_iv payload: the FRONT TRADEABLE expiry's column of per-strike IVs.
 *
 * "Front" is by calendar, not by the feed's `dte_list`: after the close YYY still serves the
 * expired chain in column 0 (its IVs blow out to 40-50% as the last prints die) and floors
 * tomorrow's dte to 0 as well. Building the bracket on that column produced an overnight wall
 * roughly twice as wide as the real one, which then snapped inward at the open (2026-09-16).
 * Returns null when the chain is too thin for a 19Δ crossing on either wing.
 */
export function liveIvWalls(netIv, spot, nowMinutesEt) {
  const rows = netIv?.rows;
  const exps = netIv?.expiries;
  const dtes = netIv?.dte_list;
  if (!Array.isArray(rows) || !Array.isArray(dtes) || !dtes.length || !isNum(spot)) return null;
  const cal = dtes.map((d, j) => { const c = calendarDte(exps?.[j]); return isNum(c) ? c : (isNum(d) ? d : null); });
  const order = cal.map((d, j) => j).filter((j) => isNum(cal[j]) && !isExpired(cal[j]));
  for (const j of order.slice(0, 2)) {
    const smile = rows
      .filter((r) => isNum(r?.strike) && isNum(r?.cells?.[j]))
      .map((r) => ({ strike: r.strike, sigma: r.cells[j] }));
    if (smile.length < 8) continue;
    const w = computeIvWalls(smile, spot, tYearsFor(cal[j], nowMinutesEt), cal[j]);
    if (w) return { ...w, expiry: String(exps?.[j] ?? "").match(/^\s*([\d-]{4,10})/)?.[1] ?? null };
  }
  return null;
}

/** The two bracket bands as ladder zones: [{lo, hi, label}] — what every spine shades. */
export function wallZones(w) {
  if (!w) return [];
  const z = [];
  if (isNum(w.u_inner) && isNum(w.u_outer)) z.push({ lo: Math.min(w.u_inner, w.u_outer), hi: Math.max(w.u_inner, w.u_outer), label: "IV WALL \u25b2" });
  if (isNum(w.l_inner) && isNum(w.l_outer)) z.push({ lo: Math.min(w.l_inner, w.l_outer), hi: Math.max(w.l_inner, w.l_outer), label: "IV WALL \u25bc" });
  return z;
}
