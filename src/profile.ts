// Composite volume profile over the prior ~5 RTH sessions — the PRICE-HISTORY structure layer
// (LVN/HVN/value area) paired with the options layer in scoring. Doctrine (YYY guide / VP
// reference): LVNs are transit zones with no acceptance — bare LVNs get run through, but a
// DEFENDED options level inside an LVN produces the cleanest single-touch rejections ("sigma
// level plus LVN ... the cleanest reactions"). HVNs are acceptance — price returning to one
// slows and rotates. Built from Yahoo 5-min bars (independent of the freezable Altaris candles),
// EXCLUDING the current session: this is standing structure that existed before today.
import YahooFinance from "yahoo-finance2";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

const BIN = 0.25;            // volume-at-price bin width, QQQ points
const LVN_FRAC = 0.35;       // bin < 35% of the median bin volume = thin
const HVN_FRAC = 2.0;        // bin > 200% of the median = heavy acceptance
const MIN_ZONE_BINS = 2;     // ignore zones narrower than 0.5 pt (noise)

export interface VpZone { lo: number; hi: number }
export interface VolumeProfile {
  /** RTH sessions in the composite. */
  days: number;
  /** Point of control — the single price with the most traded volume. */
  poc: number;
  /** Value area (70% of volume around the POC). */
  vah: number;
  val: number;
  lvns: VpZone[];
  hvns: VpZone[];
}

function etOf(d: Date): { date: string; minutes: number } {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  return { date: `${g("year")}-${g("month")}-${g("day")}`, minutes: Number(g("hour")) * 60 + Number(g("minute")) };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Merge consecutive flagged bins into zones, dropping slivers narrower than MIN_ZONE_BINS. */
function zonesFrom(binIdxs: number[]): VpZone[] {
  const zones: VpZone[] = [];
  let start: number | null = null, prev: number | null = null;
  const flush = () => {
    if (start != null && prev != null && prev - start + 1 >= MIN_ZONE_BINS) {
      zones.push({ lo: r2(start * BIN), hi: r2((prev + 1) * BIN) });
    }
  };
  for (const b of binIdxs.sort((a, x) => a - x)) {
    if (prev != null && b === prev + 1) { prev = b; continue; }
    flush();
    start = b; prev = b;
  }
  flush();
  return zones;
}

/**
 * Composite RTH volume profile from the last ~`days` sessions BEFORE `excludeDate`.
 * Bar volume is distributed uniformly across the bar's high-low range (standard OHLCV approx).
 */
export async function buildRecentProfile(excludeDate: string, days = 5): Promise<VolumeProfile | null> {
  const now = new Date();
  const start = new Date(now.getTime() - (days + 6) * 24 * 3600 * 1000);
  const res = await yf.chart("QQQ", { period1: start, period2: now, interval: "5m" });

  // First pass: which RTH sessions are available before excludeDate; keep only the last `days`.
  const rth = res.quotes.filter((q) => {
    if (q.high == null || q.low == null || !q.volume) return false;
    const { date, minutes } = etOf(q.date);
    return date < excludeDate && minutes >= 570 && minutes < 960;
  });
  const keep = new Set([...new Set(rth.map((q) => etOf(q.date).date))].sort().slice(-days));

  const bins = new Map<number, number>();
  for (const q of rth) {
    if (!keep.has(etOf(q.date).date)) continue;
    const lo = Math.floor(q.low! / BIN), hi = Math.floor(q.high! / BIN);
    const per = q.volume! / (hi - lo + 1);
    for (let b = lo; b <= hi; b++) bins.set(b, (bins.get(b) ?? 0) + per);
  }
  const dates = keep;
  if (bins.size < 20 || dates.size === 0) return null;

  const entries = [...bins.entries()].sort((a, b) => a[0] - b[0]);
  const total = entries.reduce((s, [, v]) => s + v, 0);

  // POC + 70% value area (expand from POC toward the heavier neighbor, the standard algorithm).
  let pocIdx = 0;
  entries.forEach(([, v], i) => { if (v > entries[pocIdx]![1]) pocIdx = i; });
  let loI = pocIdx, hiI = pocIdx, acc = entries[pocIdx]![1];
  while (acc < 0.7 * total && (loI > 0 || hiI < entries.length - 1)) {
    const below = loI > 0 ? entries[loI - 1]![1] : -1;
    const above = hiI < entries.length - 1 ? entries[hiI + 1]![1] : -1;
    if (above >= below) { hiI++; acc += entries[hiI]![1]; } else { loI--; acc += entries[loI]![1]; }
  }

  const vols = entries.map(([, v]) => v).sort((a, b) => a - b);
  const median = vols[Math.floor(vols.length / 2)]!;
  const lvnBins = entries.filter(([, v]) => v < LVN_FRAC * median).map(([b]) => b);
  const hvnBins = entries.filter(([, v]) => v > HVN_FRAC * median).map(([b]) => b);

  return {
    days: dates.size,
    poc: r2((entries[pocIdx]![0] + 0.5) * BIN),
    vah: r2((entries[hiI]![0] + 1) * BIN),
    val: r2(entries[loI]![0] * BIN),
    lvns: zonesFrom(lvnBins),
    hvns: zonesFrom(hvnBins),
  };
}

/** Which node type (if any) a price sits inside. */
export function vpTagAt(profile: VolumeProfile | null | undefined, price: number): "LVN" | "HVN" | null {
  if (!profile) return null;
  if (profile.lvns.some((z) => price >= z.lo && price < z.hi)) return "LVN";
  if (profile.hvns.some((z) => price >= z.lo && price < z.hi)) return "HVN";
  return null;
}
