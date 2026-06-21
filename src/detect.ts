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
 *  untouched : price never actually REACHED it (within FILL_TOL_PTS) — excluded from grading.
 *              Coming within ~a point is NOT a touch; a resting limit there would never fill.
 *
 * Overshoot is the ADVERSE excursion beyond the level (above it for resistance, below for
 * support); reject is the FAVORABLE move back off it. Within one bar the hard stop is checked
 * first, so a bar that both spikes a strike through and snaps back grades as a break, not a win.
 */
export function detectLevel(bars: Bar[], strike: number): DetectedLevel {
  if (bars.length === 0) return { strike, side: "resistance", touched: false, outcome: "untouched" };

  const swing = config.reversalSwingPct * strike;
  const hardStop = config.hardStopPts;     // points beyond the level = a break
  const cleanTol = config.cleanReversalPts; // points beyond the level still counted as clean
  const fillTol = config.fillTolPts;        // price must REACH the strike to be tested

  const lastClose = bars[bars.length - 1]!.close;

  // First bar where price genuinely REACHES the strike, from a clear side. A resting limit
  // only fills if price trades to the level — coming within ~a point is not a test, so those
  // levels stay "untouched" and are never graded as a hold. Decided pre-touch (no look-ahead).
  let ti = -1;
  let side: Side = "resistance";
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    const prevClose = i > 0 ? bars[i - 1]!.close : b.open;
    // Side = which way price came from. Strict inequalities so an open exactly ON the level isn't
    // double-counted as both; an at-level open is tie-broken by the bar's own close direction.
    const upInto = prevClose < strike && b.high >= strike - fillTol;
    const downInto = prevClose > strike && b.low <= strike + fillTol;
    const onLevel = prevClose === strike;
    if (upInto || (onLevel && b.close >= strike && b.high >= strike - fillTol)) { ti = i; side = "resistance"; break; } // up into it
    if (downInto || (onLevel && b.close < strike && b.low <= strike + fillTol)) { ti = i; side = "support"; break; }    // down into it
  }
  if (ti === -1) {
    return { strike, side: strike >= lastClose ? "resistance" : "support", touched: false, outcome: "untouched" };
  }
  const touchedAt = bars[ti]!.ts;

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
