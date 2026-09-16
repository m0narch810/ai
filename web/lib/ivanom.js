// IV anomaly finder — strikes where the vol surface is kinked.
//
// A smooth smile is what a chain looks like with no one leaning on it. Where a single strike's
// IV sits above or below the curve its neighbours draw, someone is paying up (rich) or dumping
// (cheap) at that strike specifically — the cleanest positioning signature the chain offers
// without a tape. Three independent reads, then merged per strike:
//
//   SURFACE  per expiry, fit IV ~ a + b·x + c·x² over log-moneyness x = ln(K/S), score each
//            strike's residual against a robust (MAD) sigma. |z| ≥ 2 and ≥ 0.6 vol pts = a hit.
//   SKEW     per expiry, fit (call IV − put IV) ~ moneyness and score the residual the same
//            way. A positive kink means calls bid over puts AT that strike; negative, puts bid.
//   IVZ      YYY's own per-strike/side IV z-score (flow.sentiment_data), taken at |z| ≥ 2.5
//            where the contract actually has open interest or volume.
//
// Nothing here is a direction call. A rich strike is a strike the market is defending or
// buying protection at; what that means for price is the scorer's job, not this module's.

import { isNum } from "./util.js";

/* ── robust helpers ──────────────────────────────────────────────────────── */

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
/** MAD × 1.4826 ≈ σ for normal data, floored so a perfectly smooth column cannot divide by ~0. */
const robustSigma = (res, floor) => Math.max(floor, 1.4826 * median(res.map((r) => Math.abs(r - median(res)))));

/** Least-squares quadratic y = a + b·x + c·x² via the 3×3 normal equations. */
function fitQuad(xs, ys) {
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, t0 = 0, t1 = 0, t2 = 0;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i], y = ys[i], x2 = x * x;
    s0 += 1; s1 += x; s2 += x2; s3 += x2 * x; s4 += x2 * x2;
    t0 += y; t1 += x * y; t2 += x2 * y;
  }
  // Solve [[s0,s1,s2],[s1,s2,s3],[s2,s3,s4]] · [a,b,c] = [t0,t1,t2] by Cramer's rule.
  const det = s0 * (s2 * s4 - s3 * s3) - s1 * (s1 * s4 - s3 * s2) + s2 * (s1 * s3 - s2 * s2);
  if (Math.abs(det) < 1e-12) return null;
  const a = (t0 * (s2 * s4 - s3 * s3) - s1 * (t1 * s4 - s3 * t2) + s2 * (t1 * s3 - s2 * t2)) / det;
  const b = (s0 * (t1 * s4 - s3 * t2) - t0 * (s1 * s4 - s3 * s2) + s2 * (s1 * t2 - t1 * s2)) / det;
  const c = (s0 * (s2 * t2 - t1 * s3) - s1 * (s1 * t2 - t1 * s2) + t0 * (s1 * s3 - s2 * s2)) / det;
  return (x) => a + b * x + c * x * x;
}

function fitLine(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  const b = den ? num / den : 0;
  return (x) => my + b * (x - mx);
}

/* ── the three reads ─────────────────────────────────────────────────────── */

const Z_SURF = 2.0, MIN_R_SURF = 0.008;   // vol as a decimal: 0.008 = 0.8 vol points
const WING = 0.06;                          // ±6% log-moneyness — beyond that quotes are sparse and stale
const Z_SKEW = 2.0, MIN_R_SKEW = 1.5;     // skew_data is in vol POINTS
const Z_IVZ  = 2.5;

function surfaceHits(netIv, spot) {
  const rows = (netIv?.rows || []).filter((r) => isNum(r?.strike) && Array.isArray(r.cells));
  const dtes = netIv?.dte_list || [];
  const hits = [];
  if (!rows.length || !isNum(spot)) return hits;

  for (let j = 0; j < dtes.length; j++) {
    const pts = rows.filter((r) => isNum(r.cells[j]) && r.cells[j] > 0)
      .map((r) => ({ strike: r.strike, x: Math.log(r.strike / spot), iv: r.cells[j] }))
      .filter((p) => Math.abs(p.x) < WING);
    if (pts.length < 7) continue;
    const f = fitQuad(pts.map((p) => p.x), pts.map((p) => p.iv));
    if (!f) continue;
    const res = pts.map((p) => p.iv - f(p.x));
    const sigma = robustSigma(res, 0.0025);
    pts.forEach((p, i) => {
      const z = res[i] / sigma;
      if (Math.abs(z) >= Z_SURF && Math.abs(res[i]) >= MIN_R_SURF) {
        hits.push({ kind: "surface", strike: p.strike, dteIdx: j, dte: dtes[j], iv: p.iv, fit: f(p.x), r: res[i], z, dir: z > 0 ? "rich" : "cheap" });
      }
    });
  }
  return hits;
}

function skewHits(flow) {
  const data = (flow?.skew_data || []).filter((d) => isNum(d?.strike) && isNum(d?.skew) && isNum(d?.moneyness));
  const hits = [];
  const byDte = new Map();
  for (const d of data) { const k = d.dte ?? 0; if (!byDte.has(k)) byDte.set(k, []); byDte.get(k).push(d); }
  for (const [dte, pts] of byDte) {
    if (pts.length < 6) continue;
    const f = fitLine(pts.map((p) => p.moneyness), pts.map((p) => p.skew));
    const res = pts.map((p) => p.skew - f(p.moneyness));
    const sigma = robustSigma(res, 0.75);
    pts.forEach((p, i) => {
      const z = res[i] / sigma;
      if (Math.abs(z) >= Z_SKEW && Math.abs(res[i]) >= MIN_R_SKEW) {
        hits.push({ kind: "skew", strike: p.strike, dte, callIv: p.call_iv, putIv: p.put_iv, skew: p.skew, r: res[i], z, dir: z > 0 ? "call" : "put" });
      }
    });
  }
  return hits;
}

function ivzHits(flow) {
  return (flow?.sentiment_data || [])
    .filter((d) => isNum(d?.strike) && isNum(d?.iv_zscore) && Math.abs(d.iv_zscore) >= Z_IVZ && ((d.oi ?? 0) > 0 || (d.volume ?? 0) > 0))
    .map((d) => ({ kind: "ivz", strike: d.strike, side: d.side, iv: d.iv, z: d.iv_zscore, oi: d.oi, volume: d.volume, dir: d.iv_zscore > 0 ? "rich" : "cheap" }));
}

/* ── merge ───────────────────────────────────────────────────────────────── */

/**
 * @returns {{
 *   byStrike: {strike:number, score:number, dir:"rich"|"cheap"|"mixed", hits:object[]}[],  // desc by score
 *   surface: object[],  // raw surface hits, for plotting on the surface panels
 *   counts: {surface:number, skew:number, ivz:number}
 * }}
 */
export function findIvAnomalies({ net_iv, flow, spot }) {
  const surface = surfaceHits(net_iv, spot);
  const skew = skewHits(flow);
  const ivz = ivzHits(flow);

  const map = new Map();
  const bump = (h, weight) => {
    if (!map.has(h.strike)) map.set(h.strike, { strike: h.strike, score: 0, rich: 0, cheap: 0, hits: [] });
    const e = map.get(h.strike);
    e.score += Math.min(4, Math.abs(h.z)) * weight;
    e.hits.push(h);
    // A call-bid skew kink lifts the call side; treat it as "rich" for the strike's tilt.
    const up = h.kind === "skew" ? h.dir === "call" : h.dir === "rich";
    if (up) e.rich += Math.abs(h.z); else e.cheap += Math.abs(h.z);
  };
  surface.forEach((h) => bump(h, h.dteIdx === 0 ? 1.25 : 1));   // today's expiry matters more today
  skew.forEach((h) => bump(h, 0.9));
  ivz.forEach((h) => bump(h, 0.8));

  // A kink two strikes from spot is tradeable this session; one 5% away is context. Scale the
  // score by proximity so the ladder ranks what can actually be reached.
  const prox = (k) => (isNum(spot) ? Math.max(0.35, 1 - Math.abs(Math.log(k / spot)) / WING) : 1);
  for (const e of map.values()) e.score *= prox(e.strike);

  const byStrike = [...map.values()]
    .map((e) => ({
      strike: e.strike,
      score: e.score,
      dir: e.rich > 0 && e.cheap > 0 && Math.min(e.rich, e.cheap) / Math.max(e.rich, e.cheap) > 0.5 ? "mixed" : (e.rich >= e.cheap ? "rich" : "cheap"),
      hits: e.hits.sort((a, b) => Math.abs(b.z) - Math.abs(a.z)),
    }))
    .sort((a, b) => b.score - a.score);

  return { byStrike, surface, counts: { surface: surface.length, skew: skew.length, ivz: ivz.length } };
}
