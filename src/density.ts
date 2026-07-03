/**
 * Risk-neutral density (RND) via Breeden–Litzenberger, from the per-strike IV smile.
 *
 * The Altaris Options Handbook, Part 4:  q(K) = e^{rT} · ∂²C/∂K²  — the curvature of the
 * call-vs-strike curve IS the market's risk-neutral probability density at that strike.
 *
 * Pipeline (the handbook's "right way", §4.2): smooth in IV space, not price space.
 *   1. Take the front-expiry IV smile (one IV per strike).
 *   2. Fit an SVI total-variance slice (smooth, well-behaved wings) by weighted least squares.
 *   3. Rebuild dense Black-76 call prices on a fine strike grid from the fitted smile.
 *   4. Second-derivative wrt K, clip tiny negatives, normalize to integrate to 1.
 *
 * HONEST LIMITS (handbook §4.3): this is RISK-NEUTRAL (premium-laden, fat left tail ≠ real-world
 * crash odds), TERMINAL (finish-at-expiry, not touch/path — touch ≈ 2× finish), and a SNAPSHOT.
 * It is also a simplification of the handbook in two places: (1) we do not enforce the full
 * Gatheral g-function butterfly constraint, relying on the SVI form + clip-and-normalize; (2) the
 * forward is approximated from carry (r−q) — the handbook pins F and r from put–call parity, which
 * an IV-only snapshot cannot do (if call/put mids ever land in the capture, derive F from ATM
 * parity instead). A mean≈forward sanity check below rejects densities the clip step has skewed.
 * Treat the numbers as a principled probability map, not gospel. Every entry point is defensive —
 * returns undefined on any numerical trouble so it can never break scoring.
 */

const R = 0.043; // risk-free (short-dated front expiry → minor effect on the density shape)
const Q = 0.006; // QQQ dividend yield

/** Standard normal CDF (Abramowitz & Stegun 7.1.26). */
function ncdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

/** Black-76 call priced off the forward (handbook §1.5). */
function bs76Call(F: number, K: number, T: number, sigma: number): number {
  if (T <= 0 || sigma <= 0) return Math.exp(-R * T) * Math.max(F - K, 0);
  const v = sigma * Math.sqrt(T);
  const d1 = (Math.log(F / K) + 0.5 * v * v) / v;
  return Math.exp(-R * T) * (F * ncdf(d1) - K * ncdf(d1 - v));
}

/** SVI total-variance slice w(k) = σ²·T at log-moneyness k (Gatheral, handbook §3.5). */
const sviTotalVar = (k: number, a: number, b: number, rho: number, m: number, s: number): number =>
  a + b * (rho * (k - m) + Math.sqrt((k - m) * (k - m) + s * s));

/** Clamp SVI params to sane bounds (handbook fit_svi bounds). */
function clampSvi(p: number[]): [number, number, number, number, number] {
  return [
    Math.max(-1, Math.min(5, p[0]!)),       // a (level)
    Math.max(1e-6, Math.min(5, p[1]!)),     // b (wings, ≥0)
    Math.max(-0.999, Math.min(0.999, p[2]!)), // rho (skew)
    Math.max(-1, Math.min(1, p[3]!)),       // m (shift)
    Math.max(1e-3, Math.min(2, p[4]!)),     // s (curvature, >0)
  ];
}

/** Nelder–Mead downhill simplex — no deps, deterministic. Minimizes f over an n-dim start. */
function nelderMead(f: (x: number[]) => number, x0: number[], iters = 500): number[] {
  const n = x0.length;
  const simplex: number[][] = [x0.slice()];
  for (let i = 0; i < n; i++) {
    const x = x0.slice();
    x[i]! += x[i] !== 0 ? 0.1 * Math.abs(x[i]!) : 0.05;
    simplex.push(x);
  }
  let fv = simplex.map(f);
  for (let it = 0; it < iters; it++) {
    const idx = simplex.map((_, i) => i).sort((a, b) => fv[a]! - fv[b]!);
    const sx = idx.map((i) => simplex[i]!), sf = idx.map((i) => fv[i]!);
    for (let i = 0; i < sx.length; i++) { simplex[i] = sx[i]!; fv[i] = sf[i]!; }
    const cen = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) cen[j] += simplex[i]![j]! / n;
    const worst = simplex[n]!, fWorst = fv[n]!, fBest = fv[0]!, fSecond = fv[n - 1]!;
    const refl = cen.map((c, j) => c + (c - worst[j]!));
    const fRefl = f(refl);
    if (fRefl < fBest) {
      const exp = cen.map((c, j) => c + 2 * (c - worst[j]!));
      const fExp = f(exp);
      if (fExp < fRefl) { simplex[n] = exp; fv[n] = fExp; } else { simplex[n] = refl; fv[n] = fRefl; }
    } else if (fRefl < fSecond) {
      simplex[n] = refl; fv[n] = fRefl;
    } else {
      const con = cen.map((c, j) => c + 0.5 * (worst[j]! - c));
      const fCon = f(con);
      if (fCon < fWorst) { simplex[n] = con; fv[n] = fCon; }
      else for (let i = 1; i <= n; i++) {
        simplex[i] = simplex[i]!.map((v, j) => simplex[0]![j]! + 0.5 * (v - simplex[0]![j]!));
        fv[i] = f(simplex[i]!);
      }
    }
  }
  const best = simplex.map((_, i) => i).sort((a, b) => fv[a]! - fv[b]!)[0]!;
  return simplex[best]!;
}

/** Fit an SVI slice to (k, w) points, weighted toward ATM (liquidity/vega proxy). */
function fitSvi(ks: number[], ws: number[]): [number, number, number, number, number] {
  const wts = ks.map((k) => Math.exp(-(k * k) / (2 * 0.15 * 0.15)));
  const obj = (praw: number[]): number => {
    const p = clampSvi(praw);
    let sse = 0;
    for (let i = 0; i < ks.length; i++) {
      const r = sviTotalVar(ks[i]!, ...p) - ws[i]!;
      sse += wts[i]! * r * r;
    }
    return sse;
  };
  const p0 = [Math.max(1e-4, Math.min(...ws)), 0.1, -0.3, 0, 0.1];
  return clampSvi(nelderMead(obj, p0));
}

export interface Rnd {
  /** Forward used to center the smile. */
  forward: number;
  /** Time to expiry in years. */
  T: number;
  /** P(terminal price finishes within ±half of `strike`). */
  probWithin: (strike: number, half: number) => number;
  /** P(terminal price finishes above `level`). */
  probAbove: (level: number) => number;
}

/**
 * Build the risk-neutral density from a front-expiry IV smile.
 * @param ivByStrike strike (string) → IV in PERCENT (the captured iv_skew map).
 * @param spot current underlying.
 * @param dteDays days to the smile's expiration.
 */
export function riskNeutralDensity(
  ivByStrike: Record<string, number>,
  spot: number,
  dteDays: number,
  opts: { gridN?: number; width?: number } = {},
): Rnd | undefined {
  try {
    const T = dteDays / 365;
    if (!(T > 0) || !(spot > 0)) return undefined;
    const F = spot * Math.exp((R - Q) * T);

    const pts: { k: number; w: number }[] = [];
    for (const [ks, ivPct] of Object.entries(ivByStrike)) {
      const K = parseFloat(ks), iv = ivPct / 100;
      if (!(K > 0) || !(iv > 0) || !Number.isFinite(iv)) continue;
      pts.push({ k: Math.log(K / F), w: iv * iv * T });
    }
    if (pts.length < 5) return undefined; // too sparse to fit a smile
    pts.sort((a, b) => a.k - b.k);
    const p = fitSvi(pts.map((q) => q.k), pts.map((q) => q.w));

    const gridN = opts.gridN ?? 801, width = opts.width ?? 0.6;
    const K: number[] = new Array(gridN), C: number[] = new Array(gridN);
    for (let i = 0; i < gridN; i++) {
      const k = -width + (2 * width * i) / (gridN - 1);
      K[i] = F * Math.exp(k);
      const w = Math.max(1e-8, sviTotalVar(k, ...p));
      C[i] = bs76Call(F, K[i]!, T, Math.sqrt(w / T));
    }

    // central-difference gradient on a (mildly) non-uniform grid, applied twice → ∂²C/∂K²
    const grad = (y: number[], x: number[]): number[] => {
      const g = new Array<number>(y.length);
      g[0] = (y[1]! - y[0]!) / (x[1]! - x[0]!);
      g[y.length - 1] = (y[y.length - 1]! - y[y.length - 2]!) / (x[y.length - 1]! - x[y.length - 2]!);
      for (let i = 1; i < y.length - 1; i++) g[i] = (y[i + 1]! - y[i - 1]!) / (x[i + 1]! - x[i - 1]!);
      return g;
    };
    const d2 = grad(grad(C, K), K);
    const disc = Math.exp(R * T);
    const q = d2.map((v) => Math.max(0, disc * v)); // clip numeric negatives (handbook §4.2)

    let area = 0;
    for (let i = 1; i < gridN; i++) area += 0.5 * (q[i]! + q[i - 1]!) * (K[i]! - K[i - 1]!);
    if (!(area > 0)) return undefined;
    for (let i = 0; i < gridN; i++) q[i] = q[i]! / area;

    // Sanity check (handbook §4.2 step 5): the density's mean must sit at the forward. The
    // asymmetric negative-clip above can skew a badly-fit smile; a drifted mean = a density that
    // would silently bias p_above_spot and the tail split, so reject it rather than serve it.
    let mean = 0;
    for (let i = 1; i < gridN; i++) {
      mean += 0.5 * (K[i]! * q[i]! + K[i - 1]! * q[i - 1]!) * (K[i]! - K[i - 1]!);
    }
    if (!(Math.abs(mean / F - 1) < 0.01)) return undefined;

    const cdfAt = (x: number): number => {
      if (x <= K[0]!) return 0;
      if (x >= K[gridN - 1]!) return 1;
      let acc = 0;
      for (let i = 1; i < gridN; i++) {
        if (K[i]! <= x) { acc += 0.5 * (q[i]! + q[i - 1]!) * (K[i]! - K[i - 1]!); continue; }
        const frac = (x - K[i - 1]!) / (K[i]! - K[i - 1]!); // partial final bin
        const qx = q[i - 1]! + (q[i]! - q[i - 1]!) * frac;
        acc += 0.5 * (q[i - 1]! + qx) * (x - K[i - 1]!);
        break;
      }
      return Math.min(1, Math.max(0, acc));
    };

    return {
      forward: F,
      T,
      probWithin: (strike, half) => Math.max(0, cdfAt(strike + half) - cdfAt(strike - half)),
      probAbove: (level) => Math.max(0, Math.min(1, 1 - cdfAt(level))),
    };
  } catch {
    return undefined;
  }
}
