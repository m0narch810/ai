import { config } from "./config.js";
import type { Bar, DetectedLevel, Side } from "./types.js";

const r2 = (n: number) => Math.round(n * 100) / 100;
const pct4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * Max favorable run after a confirmed reversal, for calibration: did this level originate a BIG
 * move (0.5% min / 1%+ ideal) or just a bounce? Scans forward from the confirming bar; within
 * each bar the ADVERSE side is checked first (a bar that both extends the run and breaks the
 * level freezes the run at the prior bar — no retroactive wins). Stops at a later hard-stop
 * break: the run is what the trade could have captured before the level failed.
 */
function maxRunFrom(bars: Bar[], from: number, strike: number, side: Side, hardStop: number, seed: number): number {
  let maxReject = seed;
  for (let k = from; k < bars.length; k++) {
    const bk = bars[k]!;
    const os = side === "resistance" ? bk.high - strike : strike - bk.low;
    if (os >= hardStop) break;
    const reject = side === "resistance" ? strike - bk.low : bk.high - strike;
    if (reject > maxReject) maxReject = reject;
  }
  return maxReject;
}

/** Graded outcome of ONE committed tape trade-call ("limit at entry, runs to target"). */
export interface CallGrade {
  /** no_fill = price never reached the entry (limit never filled — neutral, not a loss). */
  status: "no_fill" | "win" | "stopped" | "open";
  filledAt?: string;
  resolvedAt?: string;
  /** Max favorable excursion after the fill, % of entry — how far toward/through target it got. */
  mfe_pct?: number;
}

/**
 * Grade the tape's committed trade-call exactly like a resting limit order, strictly sequential
 * (trading rule: within a bar the ADVERSE side resolves first — a bar that hits both stop and
 * target grades as a stop, never a retroactive win). Stop = hard_stop_pts beyond the entry.
 */
export function gradeTradeCall(bars: Bar[], side: "long" | "short", entry: number, target: number): CallGrade {
  const hardStop = config.hardStopPts;
  let fi = -1;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    if (side === "long" ? b.low <= entry : b.high >= entry) { fi = i; break; }
  }
  if (fi === -1) return { status: "no_fill" };
  const filledAt = bars[fi]!.ts;
  let mfe = 0;
  for (let i = fi; i < bars.length; i++) {
    const b = bars[i]!;
    const adverse = side === "long" ? entry - b.low : b.high - entry;
    if (adverse >= hardStop) return { status: "stopped", filledAt, resolvedAt: b.ts, mfe_pct: pct4(mfe / entry) };
    const fav = side === "long" ? b.high - entry : entry - b.low;
    if (fav > mfe) mfe = fav;
    if (side === "long" ? b.high >= target : b.low <= target) {
      return { status: "win", filledAt, resolvedAt: b.ts, mfe_pct: pct4(mfe / entry) };
    }
  }
  return { status: "open", filledAt, mfe_pct: pct4(mfe / entry) };
}

/**
 * Wick-and-reject reversal detection on OHLC bars (Yahoo) — graded for CALIBRATION HISTORY,
 * so the labels must be honest: a sloppy grind is not a reversal, and a clean break through
 * the level is not a "valid" hold. Strictly sequential from the first touch (no look-ahead,
 * no retroactive wins) — the first of {hard-stop, reject} to occur wins, checked per bar.
 *
 *  broke     : price overshot the level by HARD_STOP_PTS and never came back for a confirmed retest.
 *  retested  : price broke through (HARD_STOP_PTS), recovered, then touched the level again and
 *              reversed with the required swing — the level has reasserted itself. Not crossed out.
 *  reversed  : price rejected >= REVERSAL_SWING_PCT off the level before any hard stop.
 *              `clean` = the overshoot beyond the level stayed within CLEAN_REVERSAL_PTS
 *              (a tight turn). A non-clean reversed held only after grinding past it.
 *  pending   : reached the level, still live — neither hard-stopped nor rejected yet (also set
 *              during an active retest confirmation window).
 *  untouched : price never actually REACHED it (within FILL_TOL_PTS = 0.15 pts).
 *
 * Overshoot is the ADVERSE excursion beyond the level (above it for resistance, below for
 * support); reject is the FAVORABLE move back off it. Within one bar the hard stop is checked
 * first, so a bar that both spikes a strike through and snaps back grades as a break, not a win.
 */
export function detectLevel(bars: Bar[], strike: number): DetectedLevel {
  if (bars.length === 0) return { strike, side: "resistance", touched: false, outcome: "untouched" };

  const swing = config.reversalSwingPct * strike;
  const hardStop = config.hardStopPts;      // points beyond the level = a break
  const cleanTol = config.cleanReversalPts; // points beyond the level still counted as clean
  const fillTol = config.fillTolPts;        // price must REACH the strike to be tested

  const lastClose = bars[bars.length - 1]!.close;

  // First bar where price genuinely REACHES the strike, from a clear side.
  let ti = -1;
  let side: Side = "resistance";
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    const prevClose = i > 0 ? bars[i - 1]!.close : b.open;
    const upInto   = prevClose < strike && b.high >= strike - fillTol;
    const downInto = prevClose > strike && b.low  <= strike + fillTol;
    const onLevel  = prevClose === strike;
    if (upInto   || (onLevel && b.close >= strike && b.high >= strike - fillTol)) { ti = i; side = "resistance"; break; }
    if (downInto || (onLevel && b.close <  strike && b.low  <= strike + fillTol)) { ti = i; side = "support";    break; }
  }
  if (ti === -1) {
    return { strike, side: strike >= lastClose ? "resistance" : "support", touched: false, outcome: "untouched" };
  }
  const touchedAt = bars[ti]!.ts;

  // Phase 1: scan from first touch — break or reversal.
  let worstOvershoot = 0;
  let brokeIdx = -1;
  for (let i = ti; i < bars.length; i++) {
    const b = bars[i]!;
    const overshoot = side === "resistance" ? b.high - strike : strike - b.low;
    if (overshoot > worstOvershoot) worstOvershoot = overshoot;

    if (overshoot >= hardStop) { brokeIdx = i; break; }

    const reject = side === "resistance" ? strike - b.low : b.high - strike;
    if (reject >= swing) {
      return {
        strike, side, touched: true, outcome: "reversed", touchedAt, resolvedAt: b.ts,
        reversalPct: pct4(reject / strike),
        maxRunPct: pct4(maxRunFrom(bars, i + 1, strike, side, hardStop, reject) / strike),
        overshoot: r2(worstOvershoot), clean: worstOvershoot <= cleanTol,
      };
    }
  }

  if (brokeIdx === -1) {
    return { strike, side, touched: true, outcome: "pending", touchedAt, overshoot: r2(worstOvershoot), clean: worstOvershoot <= cleanTol };
  }

  // Phase 2: after the break, scan for recovery then a confirmed retest reversal.
  // Recovery = price re-crosses to the favorable side; retest = second touch from the original
  // side with the required reversal swing. If the retest is live (no swing yet), return pending.
  let recovered = false;
  let recoveredAtBar = -1;

  for (let i = brokeIdx + 1; i < bars.length; i++) {
    const b = bars[i]!;
    const prevClose = bars[i - 1]!.close;

    if (!recovered) {
      if ((side === "support"    && b.high > strike + fillTol) ||
          (side === "resistance" && b.low  < strike - fillTol)) {
        recovered = true;
        recoveredAtBar = i;
      }
      continue; // don't check retest on the same bar as recovery
    }

    const downIntoSupport  = side === "support"    && prevClose > strike && b.low  <= strike + fillTol;
    const upIntoResistance = side === "resistance" && prevClose < strike && b.high >= strike - fillTol;

    if (downIntoSupport || upIntoResistance) {
      const retestAt = b.ts;
      let retestOvershoot = 0;

      for (let k = i; k < bars.length; k++) {
        const bk = bars[k]!;
        const os = side === "resistance" ? bk.high - strike : strike - bk.low;
        if (os > retestOvershoot) retestOvershoot = os;

        if (os >= hardStop) {
          // Broke again on retest — level is genuinely invalid.
          return { strike, side, touched: true, outcome: "broke", touchedAt, resolvedAt: bars[brokeIdx]!.ts, overshoot: r2(worstOvershoot) };
        }
        const reject = side === "resistance" ? strike - bk.low : bk.high - strike;
        if (reject >= swing) {
          return {
            strike, side, touched: true, outcome: "retested",
            touchedAt, retestAt, resolvedAt: bk.ts,
            reversalPct: pct4(reject / strike),
            maxRunPct: pct4(maxRunFrom(bars, k + 1, strike, side, hardStop, reject) / strike),
            overshoot: r2(Math.max(worstOvershoot, retestOvershoot)),
            clean: retestOvershoot <= cleanTol,
          };
        }
      }

      // End of bars during retest — live confirmation in progress.
      return {
        strike, side, touched: true, outcome: "pending",
        touchedAt, retestAt,
        overshoot: r2(Math.max(worstOvershoot, retestOvershoot)),
        clean: retestOvershoot <= cleanTol,
      };
    }
  }

  return { strike, side, touched: true, outcome: "broke", touchedAt, resolvedAt: bars[brokeIdx]!.ts, overshoot: r2(worstOvershoot) };
}

export function detectMany(bars: Bar[], strikes: number[]): DetectedLevel[] {
  const uniq = [...new Set(strikes.map((s) => Math.round(s * 100) / 100))];
  return uniq.map((s) => detectLevel(bars, s)).sort((a, b) => b.strike - a.strike);
}
