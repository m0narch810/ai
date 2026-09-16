// ATR-derived statistical sigma grid — the trader's own reference indicator ("ATR Sigma Grid
// [NQ]", Pine v6): bands anchored at the most recent Globex reopen (18:00 ET) on NQ futures,
// spaced by daily-ATR-implied volatility. Deliberately INDEPENDENT of options positioning (no
// GEX/OI/charm/vanna anywhere in this file) — when a band lines up with a mid-tier options wall,
// that's two unrelated methodologies (dealer hedging vs. pure statistical volatility) agreeing on
// the same price, not the same signal counted twice. See SIGMA GRID CONFLUENCE in the system prompt.
import YahooFinance from "yahoo-finance2";
import { nqToQqqRatio } from "./market.js";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

const ATR_LEN = 10;
const MULTS = [0.5, 0.7, 1, 1.5, 2, 2.5, 3];

export interface SigmaBand { mult: number; qqq: number }
export interface SigmaGrid { anchor_qqq: number; sigma_qqq: number; bands: SigmaBand[] }

function etParts(d: Date): { hour: number; minute: number } {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d);
  const g = (t: string) => Number(p.find((x) => x.type === t)!.value);
  return { hour: g("hour"), minute: g("minute") };
}

/** Wilder's smoothing (ta.rma) over true range — same as Pine's ta.atr. */
function wilderAtr(bars: { high: number; low: number; close: number }[], len: number): number | null {
  if (bars.length < len + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i]!.high, l = bars[i]!.low, pc = bars[i - 1]!.close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let atr = trs.slice(0, len).reduce((a, b) => a + b, 0) / len;
  for (let i = len; i < trs.length; i++) atr = (atr * (len - 1) + trs[i]!) / len;
  return atr;
}

/**
 * Statistical sigma grid in QQQ terms: NQ daily ATR(10) → sigma = ATR * sqrt(5/390) (the
 * indicator's own scaling), bands at ±{0.5,0.7,1,1.5,2,2.5,3}σ from the close at the most recent
 * 18:00 ET Globex reopen. Converted to QQQ-equivalent via the same smoothed ratio the Asia
 * session uses. Best-effort: any missing data (holiday gap, no 18:00 bar in range) returns null
 * rather than guessing — never blocks scoring.
 */
export async function computeSigmaGrid(): Promise<SigmaGrid | null> {
  const now = new Date();
  const [daily, minute, ratio] = await Promise.all([
    yf.chart("NQ=F", { period1: new Date(now.getTime() - 30 * 24 * 3600 * 1000), period2: now, interval: "1d" }),
    yf.chart("NQ=F", { period1: new Date(now.getTime() - 48 * 3600 * 1000), period2: now, interval: "1m" }),
    nqToQqqRatio(),
  ]);

  const dailyBars = daily.quotes
    .filter((q) => q.high != null && q.low != null && q.close != null)
    .map((q) => ({ high: q.high!, low: q.low!, close: q.close! }));
  // Drop the still-forming current daily bar — matches the Pine indicator's lookahead_off
  // (yesterday's completed ATR persists all session, not recomputed intrabar).
  const atr = wilderAtr(dailyBars.slice(0, -1), ATR_LEN);
  if (atr == null) return null;
  const sigma = atr * Math.sqrt(5 / 390);

  const minuteBars = minute.quotes.filter((q) => q.close != null);
  let anchor: number | null = null;
  for (let i = minuteBars.length - 1; i >= 0; i--) {
    const { hour, minute: min } = etParts(minuteBars[i]!.date);
    if (hour === 18 && min === 0) { anchor = minuteBars[i]!.close!; break; }
  }
  if (anchor == null) return null;

  const bands: SigmaBand[] = [];
  for (const m of MULTS) {
    bands.push({ mult: m, qqq: (anchor + m * sigma) / ratio });
    bands.push({ mult: -m, qqq: (anchor - m * sigma) / ratio });
  }
  bands.sort((a, b) => a.qqq - b.qqq);
  return { anchor_qqq: anchor / ratio, sigma_qqq: sigma / ratio, bands };
}

/** Nearest band multiplier to a price, within tolerance (QQQ points) — null if nothing's close. */
export function sigmaNodeAt(grid: SigmaGrid | null | undefined, price: number, tolQqq = 0.5): number | null {
  if (!grid) return null;
  let best: { mult: number; dist: number } | null = null;
  for (const b of grid.bands) {
    const dist = Math.abs(b.qqq - price);
    if (dist <= tolQqq && (!best || dist < best.dist)) best = { mult: b.mult, dist };
  }
  return best?.mult ?? null;
}
