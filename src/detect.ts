import { config } from "./config.js";
import type { Bar, DetectedLevel, Side } from "./types.js";

/**
 * Wick-and-reject reversal detection on OHLC bars (Yahoo).
 *
 * Classify a level by where price LIVED relative to it across the session, not by a
 * single bar — that's what makes 735 (price stayed below, wicked up, rejected) a clean
 * resistance reversal while a mid-range level price closed on both sides of is "broke".
 *
 *  reversed  : price stayed one side, wicked the level, and rejected >= REVERSAL_SWING_PCT
 *  broke     : price closed clean through it (on both sides, or out the far side)
 *  pending   : reached the level but hugged it — no decisive reject or break
 *  untouched : price never reached it (excluded from grading, not a miss)
 *
 * NOTE: a "close beyond" uses the bar close (acceptance); a mere wick beyond is just a test.
 */
export function detectLevel(bars: Bar[], strike: number): DetectedLevel {
  if (bars.length === 0) return { strike, side: "resistance", touched: false, outcome: "untouched" };

  const tol = Math.max(config.touchTolerancePct, 0.0015) * strike;
  const swing = config.reversalSwingPct * strike;
  const breakBuf = config.breakBufferPct * strike;

  const hi = Math.max(...bars.map((b) => b.high));
  const lo = Math.min(...bars.map((b) => b.low));
  const lastClose = bars[bars.length - 1]!.close;
  const sideByPos: Side = strike >= lastClose ? "resistance" : "support";

  // Price never reached the level — not a miss, just excluded.
  if (!(hi >= strike - tol && lo <= strike + tol)) {
    return { strike, side: sideByPos, touched: false, outcome: "untouched" };
  }

  const ti = bars.findIndex((b) => b.high >= strike - tol && b.low <= strike + tol);
  const touchedAt = bars[ti]!.ts;

  const closedAbove = bars.some((b) => b.close >= strike + breakBuf);
  const closedBelow = bars.some((b) => b.close <= strike - breakBuf);

  // Crossed on both sides (or sliced clean through) => not a one-sided barrier.
  if (closedAbove && closedBelow) {
    return { strike, side: sideByPos, touched: true, outcome: "broke", touchedAt };
  }

  // Price lived BELOW and wicked up into it => resistance candidate.
  if (closedBelow && !closedAbove) {
    return rejectOrPending(bars, ti, strike, "resistance", swing);
  }
  // Price lived ABOVE and wicked down into it => support candidate.
  if (closedAbove && !closedBelow) {
    return rejectOrPending(bars, ti, strike, "support", swing);
  }

  // Hugged the level all session (never closed beyond the buffer either way).
  return { strike, side: sideByPos, touched: true, outcome: "pending", touchedAt };
}

function rejectOrPending(bars: Bar[], ti: number, strike: number, side: Side, swing: number): DetectedLevel {
  const after = bars.slice(ti);
  const extreme = side === "resistance"
    ? Math.min(...after.map((b) => b.low))
    : Math.max(...after.map((b) => b.high));
  const move = Math.abs(strike - extreme);
  const touchedAt = bars[ti]!.ts;

  if (move >= swing) {
    const resolvedBar = side === "resistance"
      ? after.find((b) => b.low <= strike - swing)
      : after.find((b) => b.high >= strike + swing);
    return {
      strike, side, touched: true, outcome: "reversed",
      touchedAt, resolvedAt: resolvedBar?.ts ?? touchedAt,
      reversalPct: Math.round((move / strike) * 10000) / 10000,
    };
  }
  return { strike, side, touched: true, outcome: "pending", touchedAt };
}

export function detectMany(bars: Bar[], strikes: number[]): DetectedLevel[] {
  const uniq = [...new Set(strikes.map((s) => Math.round(s * 100) / 100))];
  return uniq.map((s) => detectLevel(bars, s)).sort((a, b) => b.strike - a.strike);
}
