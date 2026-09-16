// IV WALL LEVELS — the four "IV wall" brackets (upper/lower inner+outer) for the session,
// per pdfs/IV Wall Derivation Spec.pdf, adapted SPY → QQQ.
//
// The method: the INNER walls are the ~19-delta strikes (|Δ| = 0.1925) of the front (next-session)
// expiry, found by interpolating Black-Scholes delta across the chain's own per-strike IV smile;
// the OUTER walls are a fixed-width offset beyond each inner wall. The spec inverts BS from option
// prices to get σ(K) — we skip that entirely because both providers already hand us the per-strike
// front-expiry IV smile (data.iv_skew, in PERCENT), so delta follows directly from spot + T + σ(K).
//
// QQQ adaptations vs the spec (which was calibrated on SPY against Spread Monster cards):
//  - δ* = 0.1925 transfers as-is (a delta concept; the smile does the cross-asset adjustment —
//    that is the spec's own point about why one threshold works on both wings despite put skew).
//  - The fixed outer widths (+1.56 / −1.79 SPY pts) do NOT transfer as absolute points; they are
//    re-expressed as fractions of spot (SPY traded ~750 across the calibration window).
//  - The v1.1 regime-dependent upper delta is intentionally NOT ported — fit on 13 SPY days,
//    too thin to trust cross-asset. Constant 0.1925 both sides (the validated base rule).
//  - Snapshot timing: the spec computes at 16:00 ET the prior evening only because that is the
//    source tool's workflow. Our equivalent is the first usable US-session chain of the day
//    (fresher IV, same expiry); the walls are then FROZEN for the rest of the session — a static
//    pre-session bracket, never a drifting intraday band.

import fs from "node:fs/promises";
import path from "node:path";
import { config, nowInSessionTz } from "./config.js";
import type { DataSnapshot, IvWalls, StrikeMap } from "./types.js";

/** |Δ| threshold for the inner walls — spec-calibrated, both wings (MAE ~1 SPY pt). */
const DELTA_STAR = 0.1925;
/** Outer-wall widths as fractions of spot (spec: +1.56 / −1.79 SPY pts at SPY ≈ 750; the lower
 *  band being wider is the put-skew fingerprint). */
const W_U_PCT = 1.56 / 750;
const W_L_PCT = 1.79 / 750;
/** Short financing rate (spec constant; wall placement is insensitive to it at 0-3 DTE). */
const R = 0.04;

// ── Black-Scholes delta ───────────────────────────────────────────────────────────

/** Abramowitz–Stegun 7.1.26 erf approximation (|err| < 1.5e-7 — far below strike resolution). */
function erf(x: number): number {
  const s = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return s * y;
}
const normCdf = (x: number) => 0.5 * (1 + erf(x / Math.SQRT2));

interface WingPoint { k: number; delta: number }

/**
 * Find the strike where |Δ| crosses DELTA_STAR along one OTM wing (points ordered spot→outward,
 * |Δ| nominally decreasing). Per the spec's implementation notes, enforce monotonically
 * decreasing |Δ| first — dropping points that violate it (stale/noisy IV prints) — then
 * linearly interpolate between the bracketing strikes. Null if the chain never reaches δ*.
 */
function deltaCross(wing: WingPoint[]): number | null {
  const mono: WingPoint[] = [];
  for (const p of wing) {
    if (!Number.isFinite(p.delta)) continue;
    if (!mono.length || p.delta < mono[mono.length - 1]!.delta) mono.push(p);
  }
  for (let i = 0; i + 1 < mono.length; i++) {
    const a = mono[i]!, b = mono[i + 1]!;
    if (a.delta >= DELTA_STAR && b.delta <= DELTA_STAR) {
      const f = (a.delta - DELTA_STAR) / (a.delta - b.delta || 1);
      return a.k + f * (b.k - a.k);
    }
  }
  return null;
}

/**
 * Compute the four IV wall levels from a per-strike IV smile (PERCENT, the captured iv_skew),
 * spot, and time-to-expiry in years. Pure — no I/O. Null when the chain is too thin/narrow
 * for a 19Δ crossing on either wing (both walls or none: a one-sided bracket isn't the product).
 */
export function computeIvWalls(ivSkew: StrikeMap<number>, spot: number, tYears: number, computedAt: string, dte: number): IvWalls | null {
  const pts = Object.entries(ivSkew)
    .map(([k, iv]) => ({ k: Number(k), sigma: iv / 100 }))
    .filter((p) => Number.isFinite(p.k) && p.k > 0 && Number.isFinite(p.sigma) && p.sigma > 0.01 && p.sigma < 5)
    .sort((a, b) => a.k - b.k);
  if (pts.length < 8 || !(spot > 0) || !(tYears > 0)) return null;

  const sqT = Math.sqrt(tYears);
  const d1 = (K: number, sigma: number) => (Math.log(spot / K) + (R + (sigma * sigma) / 2) * tYears) / (sigma * sqT);

  // Δ_call = N(d1) declines walking UP from spot; |Δ_put| = N(−d1) declines walking DOWN.
  const upper: WingPoint[] = pts.filter((p) => p.k >= spot).map((p) => ({ k: p.k, delta: normCdf(d1(p.k, p.sigma)) }));
  const lower: WingPoint[] = pts.filter((p) => p.k <= spot).reverse().map((p) => ({ k: p.k, delta: normCdf(-d1(p.k, p.sigma)) }));

  const uInner = deltaCross(upper);
  const lInner = deltaCross(lower);
  if (uInner == null || lInner == null) return null;

  const atm = pts.reduce((a, b) => (Math.abs(b.k - spot) < Math.abs(a.k - spot) ? b : a));
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    u_inner: r2(uInner),
    u_outer: r2(uInner + spot * W_U_PCT),
    l_inner: r2(lInner),
    l_outer: r2(lInner - spot * W_L_PCT),
    spot_at_calc: r2(spot),
    sigma_atm_pct: r2(atm.sigma * 100),
    delta: DELTA_STAR,
    computed_at: computedAt,
    dte,
  };
}

/**
 * Time to expiry in years. Front expiry ≥ 1 DTE → calendar days / 365 (the spec's convention).
 * 0DTE → the remaining fraction of the day to the 16:00 ET cash close, floored at 30 minutes so
 * a late first-compute (box turned on mid-afternoon) can't produce degenerate hairline walls.
 * Exported so the cloud board (netlify/functions/board.mts) anchors T the same way — the cloud
 * path computes its own walls when the box is off, and must not drift from this convention.
 */
export function tYearsFor(dte: number | undefined, nowMinutesEt: number): number {
  const d = dte ?? 0;
  if (d >= 1) return d / 365;
  const minsToClose = Math.max(16 * 60 - nowMinutesEt, 30);
  return minsToClose / (60 * 24 * 365);
}

const fileFor = (date: string) => path.join(config.paths.scored, `${date}.ivwalls.json`);

/** The frozen walls for a date, if that session already computed them. */
export async function loadIvWalls(date: string): Promise<IvWalls | null> {
  try {
    const w = JSON.parse(await fs.readFile(fileFor(date), "utf8")) as IvWalls;
    return Number.isFinite(w?.u_inner) && Number.isFinite(w?.l_inner) ? w : null;
  } catch {
    return null;
  }
}

/** Days to look back for a carried-forward bracket — covers a 3-day weekend plus a holiday. */
const CARRY_BACK_DAYS = 5;

const shiftDate = (date: string, days: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/**
 * The most recent frozen bracket at or before `date`. Overnight and pre-open there is no bracket
 * for the new ET date yet, but the prior session's is still the live one — the spec itself builds
 * the walls from the PRIOR EVENING's 16:00 chain, so carrying it forward is the spec's own
 * convention, not a stand-in. Callers can tell a carried bracket from a fresh one by its
 * `computed_at` date.
 */
export async function loadRecentIvWalls(date: string): Promise<IvWalls | null> {
  for (let back = 0; back <= CARRY_BACK_DAYS; back++) {
    const w = await loadIvWalls(shiftDate(date, -back));
    if (w) return w;
  }
  return null;
}

/**
 * The day's IV walls: computed ONCE from the first usable US-session chain of the date, persisted,
 * and reused unchanged for the rest of the session. `allowCompute` false (Asia / off-RTH ticks,
 * where the chain is stale prior-close data) never computes. `persist` false (fixture runs)
 * computes without writing. `capturedAt` (ET ISO of the snapshot) anchors T for 0DTE chains — pass
 * it so a backfilled morning tick gets morning walls, not walls shrunk to whatever time the
 * backfill happens to run.
 *
 * When this date has no bracket of its own yet, the most recent prior session's is carried forward
 * rather than returning null — otherwise the board loses its walls at 00:00 ET every night and
 * doesn't get them back until the next US-session tick (and loses them for days when a session
 * produces no US tick at all, as on 2026-08-28). The carried bracket is deliberately NOT persisted
 * under `date`: this date's first usable US chain must still freeze its own.
 * Best-effort — null only when nothing is available at all, never throws.
 */
export async function ivWallsForDate(date: string, cur: DataSnapshot, spot: number, allowCompute: boolean, persist: boolean, capturedAt?: string): Promise<IvWalls | null> {
  const existing = await loadIvWalls(date);
  if (existing) return existing;

  if (allowCompute && cur.iv_skew && spot > 0) {
    const at = capturedAt && capturedAt.length >= 16 ? capturedAt : nowInSessionTz().iso;
    const minutes = Number(at.slice(11, 13)) * 60 + Number(at.slice(14, 16));
    const walls = computeIvWalls(cur.iv_skew, spot, tYearsFor(cur.iv_skew_dte, minutes), at, cur.iv_skew_dte ?? 0);
    if (walls) {
      if (persist) {
        try {
          await fs.mkdir(config.paths.scored, { recursive: true });
          await fs.writeFile(fileFor(date), JSON.stringify(walls, null, 2), "utf8");
        } catch (err) {
          console.warn("iv walls persist failed (walls still used this tick):", err instanceof Error ? err.message : err);
        }
      }
      return walls;
    }
  }

  return loadRecentIvWalls(shiftDate(date, -1));
}
