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

/** Time to expiry in years, the desk's convention: ≥1 DTE calendar/365; 0DTE = time to 16:00 ET, floored at 30 min. */
function tYearsFor(dte, nowMinutesEt) {
  const d = dte ?? 0;
  if (d >= 1) return d / 365;
  const minsToClose = Math.max(16 * 60 - nowMinutesEt, 30);
  return minsToClose / (60 * 24 * 365);
}

/**
 * Walls from the live /net_iv payload: the front expiry's column of per-strike IVs.
 * Returns null when the chain is too thin for a 19Δ crossing on either wing.
 */
export function liveIvWalls(netIv, spot, nowMinutesEt) {
  const rows = netIv?.rows;
  const dtes = netIv?.dte_list;
  if (!Array.isArray(rows) || !Array.isArray(dtes) || !dtes.length || !isNum(spot)) return null;
  // Front expiry = column 0. If it is empty (post-close, before the next chain), fall to column 1.
  for (const j of [0, 1]) {
    if (!isNum(dtes[j])) continue;
    const smile = rows
      .filter((r) => isNum(r?.strike) && isNum(r?.cells?.[j]))
      .map((r) => ({ strike: r.strike, sigma: r.cells[j] }));
    if (smile.length < 8) continue;
    const w = computeIvWalls(smile, spot, tYearsFor(dtes[j], nowMinutesEt), dtes[j]);
    if (w) return w;
  }
  return null;
}
