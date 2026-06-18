import { config } from "./config.js";
import type { Bar, DetectedLevel, Side } from "./types.js";

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Wick-and-reject reversal detection on OHLC bars (Yahoo) — graded for CALIBRATION HISTORY,
 * so the labels must be honest: a sloppy grind is not a reversal, and a clean break through
 * the level is not a "valid" hold. Strictly sequential from the first touch (no look-ahead,
 * no retroactive wins) — the first of {hard-stop, reject} to occur wins, checked per bar.
 *
 *  broke     : price overshot the level by a full strike (HARD_STOP_PTS) — the hard stop.
 *  reversed  : price rejected >= REVERSAL_SWING_PCT off the level before any hard stop.
 *              `clean` = the overshoot beyond the level stayed within CLEAN_REVERSAL_PTS
 *              (a tight turn). A non-clean reversed held only after grinding past it.
 *  pending   : reached the level, still live — neither hard-stopped nor rejected yet.
 *  untouched : price never reached it (excluded from grading, not a miss).
 *
 * Overshoot is the ADVERSE excursion beyond the level (above it for resistance, below for
 * support); reject is the FAVORABLE move back off it. Within one bar the hard stop is checked
 * first, so a bar that both spikes a strike through and snaps back grades as a break, not a win.
 */
export function detectLevel(bars: Bar[], strike: number): DetectedLevel {
  if (bars.length === 0) return { strike, side: "resistance", touched: false, outcome: "untouched" };

  const tol = Math.max(config.touchTolerancePct, 0.0015) * strike;
  const swing = config.reversalSwingPct * strike;
  const hardStop = config.hardStopPts;     // points beyond the level = a break
  const cleanTol = config.cleanReversalPts; // points beyond the level still counted as clean

  const hi = Math.max(...bars.map((b) => b.high));
  const lo = Math.min(...bars.map((b) => b.low));
  const lastClose = bars[bars.length - 1]!.close;

  // Price never reached the level — not a miss, just excluded from grading.
  if (!(hi >= strike - tol && lo <= strike + tol)) {
    return { strike, side: strike >= lastClose ? "resistance" : "support", touched: false, outcome: "untouched" };
  }

  const ti = bars.findIndex((b) => b.high >= strike - tol && b.low <= strike + tol);
  const touchedAt = bars[ti]!.ts;

  // Approach side from just before the touch: came from below => resistance (reject down),
  // came from above => support (bounce up). Decided pre-touch, so no look-ahead.
  const prevClose = ti > 0 ? bars[ti - 1]!.close : bars[ti]!.open;
  const side: Side = prevClose <= strike ? "resistance" : "support";

  let worstOvershoot = 0;
  for (let i = ti; i < bars.length; i++) {
    const b = bars[i]!;
    const overshoot = side === "resistance" ? b.high - strike : strike - b.low;
    if (overshoot > worstOvershoot) worstOvershoot = overshoot;

    // Hard stop first (adverse excursion): a full strike beyond kills the level.
    if (overshoot >= hardStop) {
      return { strike, side, touched: true, outcome: "broke", touchedAt, resolvedAt: b.ts, overshoot: r2(worstOvershoot) };
    }
    // Then the favorable reject: price snapped >= swing back off the level => reversal.
    const reject = side === "resistance" ? strike - b.low : b.high - strike;
    if (reject >= swing) {
      return {
        strike, side, touched: true, outcome: "reversed", touchedAt, resolvedAt: b.ts,
        reversalPct: Math.round((reject / strike) * 10000) / 10000,
        overshoot: r2(worstOvershoot), clean: worstOvershoot <= cleanTol,
      };
    }
  }

  // Touched, still hovering — no hard stop, no decisive reject yet.
  return { strike, side, touched: true, outcome: "pending", touchedAt, overshoot: r2(worstOvershoot), clean: worstOvershoot <= cleanTol };
}

export function detectMany(bars: Bar[], strikes: number[]): DetectedLevel[] {
  const uniq = [...new Set(strikes.map((s) => Math.round(s * 100) / 100))];
  return uniq.map((s) => detectLevel(bars, s)).sort((a, b) => b.strike - a.strike);
}
