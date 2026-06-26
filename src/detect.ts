import { config } from "./config.js";
import type { Bar, DetectedLevel, Side } from "./types.js";

const r2 = (n: number) => Math.round(n * 100) / 100;

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
        reversalPct: Math.round((reject / strike) * 10000) / 10000,
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
            reversalPct: Math.round((reject / strike) * 10000) / 10000,
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
