// Always-updating market-regime read. Pure builder + a writer; no network (run.ts fetches the
// bars and hands them in, mirroring dashboard.ts). Combines four classical, explainable pillars
// — nothing fitted to backtest PnL:
//   1. GARCH(1,1) conditional volatility  → expanding vs contracting vol (variance-targeted MLE).
//   2. 0-dim persistent homology of the close path → topographic-prominence pivots (= levels).
//   3. Kaufman efficiency ratio + Hurst exponent → trend vs mean-reversion.
//   4. Dealer-gamma regime from the options snapshot → vol-amplifying vs vol-suppressing.
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import type { Bar, Board, DataSnapshot, Regime, RegimeGauge, RegimePivot, Side } from "./types.js";

// ── small stats helpers ──────────────────────────────────────────────────────────
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
function variance(xs: number[]): number {
  const m = mean(xs);
  return xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length || 1);
}
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function logReturns(closes: number[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const a = closes[i - 1]!, b = closes[i]!;
    if (a > 0 && b > 0) r.push(Math.log(b / a));
  }
  return r;
}

function slope(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const mx = mean(xs), my = mean(ys);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i]! - mx) * (ys[i]! - my); den += (xs[i]! - mx) ** 2; }
  return den === 0 ? 0 : num / den;
}

// ── GARCH(1,1), variance-targeted MLE ─────────────────────────────────────────────
interface GarchFit { alpha: number; beta: number; sigma2Next: number; uncondVar: number; }

/** Gaussian negative log-likelihood of the GARCH filter for a given (alpha, beta). */
function garchNll(r: number[], uncondVar: number, alpha: number, beta: number): number {
  const omega = uncondVar * (1 - alpha - beta);
  if (omega <= 0) return Infinity;
  let s2 = uncondVar, nll = 0;
  for (let i = 0; i < r.length; i++) {
    const ri = r[i]!;
    nll += 0.5 * (Math.log(s2) + (ri * ri) / s2);
    s2 = omega + alpha * ri * ri + beta * s2;
  }
  return nll;
}

/**
 * Fit GARCH(1,1) by variance targeting (omega pinned to the sample variance) + a coarse grid
 * over (alpha, beta) refined locally. Deterministic and dependency-free; good enough to read
 * whether conditional vol is above or below its long-run level and how persistent shocks are.
 */
function fitGarch(returns: number[]): GarchFit {
  const m = mean(returns);
  const r = returns.map((x) => x - m);
  const uncondVar = Math.max(variance(r), 1e-12);

  let best = { alpha: 0.08, beta: 0.9, nll: Infinity };
  for (let a = 0.01; a < 0.4; a += 0.02) {
    for (let b = 0.4; b < 0.985; b += 0.02) {
      if (a + b >= 0.995) continue;
      const nll = garchNll(r, uncondVar, a, b);
      if (nll < best.nll) best = { alpha: a, beta: b, nll };
    }
  }
  let fine = { ...best };
  for (let a = best.alpha - 0.018; a <= best.alpha + 0.018; a += 0.006) {
    for (let b = best.beta - 0.018; b <= best.beta + 0.018; b += 0.006) {
      if (a <= 0 || b < 0 || a + b >= 0.999) continue;
      const nll = garchNll(r, uncondVar, a, b);
      if (nll < fine.nll) fine = { alpha: a, beta: b, nll };
    }
  }

  const { alpha, beta } = fine;
  const omega = uncondVar * (1 - alpha - beta);
  let s2 = uncondVar;
  for (let i = 0; i < r.length; i++) { const ri = r[i]!; s2 = omega + alpha * ri * ri + beta * s2; }
  return { alpha, beta, sigma2Next: s2, uncondVar };
}

// ── topology: 0-dim persistent homology via topographic prominence ────────────────
// For a 1-D price path, the persistence of a local minimum (support) is how far price must
// RISE before it connects to a deeper minimum; for a local maximum (resistance), how far it
// must FALL before a higher one. That rise/fall is the topographic prominence — exactly the
// 0-dim persistence pairing for a Morse function. Prominent pivots are robust S/R levels.
interface Extremum { idx: number; price: number; prominence: number; }

function prominentExtrema(closes: number[], kind: "max" | "min"): Extremum[] {
  const n = closes.length;
  const out: Extremum[] = [];
  const isMax = kind === "max";
  for (let i = 1; i < n - 1; i++) {
    const v = closes[i]!, prev = closes[i - 1]!, next = closes[i + 1]!;
    const localMax = v >= prev && v > next;
    const localMin = v <= prev && v < next;
    if (isMax ? !localMax : !localMin) continue;

    // Scan each side to the nearest higher peak (max) / lower trough (min), tracking the col.
    let leftCol = v, rightCol = v;
    for (let j = i - 1; j >= 0; j--) {
      const cj = closes[j]!;
      if (isMax ? cj > v : cj < v) break;
      leftCol = isMax ? Math.min(leftCol, cj) : Math.max(leftCol, cj);
    }
    for (let j = i + 1; j < n; j++) {
      const cj = closes[j]!;
      if (isMax ? cj > v : cj < v) break;
      rightCol = isMax ? Math.min(rightCol, cj) : Math.max(rightCol, cj);
    }
    const keyCol = isMax ? Math.max(leftCol, rightCol) : Math.min(leftCol, rightCol);
    const prominence = isMax ? v - keyCol : keyCol - v;
    if (prominence > 0) out.push({ idx: i, price: v, prominence });
  }
  return out.sort((a, b) => b.prominence - a.prominence);
}

/** Cluster near-equal pivots (within tol points) so we don't list the same level twice. */
function dedupePivots(xs: Extremum[], tol: number, take: number): Extremum[] {
  const kept: Extremum[] = [];
  for (const e of xs) {
    if (kept.some((k) => Math.abs(k.price - e.price) <= tol)) continue;
    kept.push(e);
    if (kept.length >= take) break;
  }
  return kept;
}

function topoPivots(closes: number[], board: Board | null): RegimePivot[] {
  const tol = Math.max((closes[closes.length - 1] ?? 0) * 0.0006, 0.05); // ~0.06% cluster width
  const maxima = dedupePivots(prominentExtrema(closes, "max"), tol, 4);
  const minima = dedupePivots(prominentExtrema(closes, "min"), tol, 4);
  const boardStrikes = board?.levels?.map((l) => l.strike) ?? [];
  const make = (e: Extremum, side: Side): RegimePivot => ({
    price: Math.round(e.price * 100) / 100,
    side,
    persistence: Math.round(e.prominence * 100) / 100,
    confluence: boardStrikes.some((s) => Math.abs(s - e.price) <= 0.6),
  });
  return [
    ...maxima.map((e) => make(e, "resistance")),
    ...minima.map((e) => make(e, "support")),
  ].sort((a, b) => b.persistence - a.persistence);
}

// ── trend pillars ─────────────────────────────────────────────────────────────────
/** Kaufman efficiency ratio: |net move| / total path length over the recent window. */
function efficiencyRatio(closes: number[], window = 120): number {
  const seg = closes.slice(-window);
  if (seg.length < 3) return 0;
  const net = Math.abs(seg[seg.length - 1]! - seg[0]!);
  let path = 0;
  for (let i = 1; i < seg.length; i++) path += Math.abs(seg[i]! - seg[i - 1]!);
  return path > 0 ? net / path : 0;
}

/** Hurst exponent via rescaled-range (R/S) regression across chunk sizes. */
function hurst(returns: number[]): number {
  const xs = returns.slice(-256);
  if (xs.length < 32) return 0.5;
  const sizes = [8, 16, 32, 64, 128].filter((s) => s <= xs.length);
  const logN: number[] = [], logRS: number[] = [];
  for (const s of sizes) {
    const chunks = Math.floor(xs.length / s);
    let rsSum = 0, cnt = 0;
    for (let c = 0; c < chunks; c++) {
      const seg = xs.slice(c * s, c * s + s);
      const m = mean(seg);
      let cum = 0, mn = Infinity, mx = -Infinity;
      for (const v of seg) { cum += v - m; mn = Math.min(mn, cum); mx = Math.max(mx, cum); }
      const S = Math.sqrt(variance(seg));
      if (S > 0) { rsSum += (mx - mn) / S; cnt++; }
    }
    if (cnt > 0) { logN.push(Math.log(s)); logRS.push(Math.log(rsSum / cnt)); }
  }
  return clamp(slope(logN, logRS), 0, 1);
}

// ── classification ──────────────────────────────────────────────────────────────--
function volLevel(ann: number): Regime["vol"]["level"] {
  if (ann < 12) return "low";
  if (ann < 20) return "normal";
  if (ann < 30) return "elevated";
  return "high";
}

export interface RegimeInputs {
  spot: number;
  bars: Bar[];
  /** Median minutes between bars (for annualization). */
  barMinutes: number;
  gammaRegime: string;
  board: Board | null;
  asOf: string;
}

/** Build the regime read from a recent bar series + the dealer-gamma label. Pure. */
export function buildRegime(inp: RegimeInputs): Regime {
  const now = Date.now();
  const series = inp.bars.map((b) => b.close).filter((c) => Number.isFinite(c) && c > 0).slice(-480);
  const notes: string[] = [];

  // Annualization: per-bar σ × sqrt(bars per year), using the actual bar spacing & a ~23h
  // futures session (NQ trades nearly round the clock).
  const barsPerDay = (23 * 60) / Math.max(inp.barMinutes, 1);
  const annFactor = Math.sqrt(252 * barsPerDay);

  const returns = logReturns(series);
  const negGamma = /neg/i.test(inp.gammaRegime);
  const posGamma = /pos/i.test(inp.gammaRegime);

  if (returns.length < 30) {
    notes.push("insufficient bars for stats — holding a neutral read");
    return {
      as_of: inp.asOf, generated_at: new Date(now).toISOString(), scored_at: now, spot: inp.spot,
      state: "INSUFFICIENT DATA", read: "Not enough recent bars to read the regime yet.",
      bias: "neutral", confidence: 0,
      vol: { ann: 0, longRun: 0, trend: "steady", level: "normal", persistence: 0 },
      trend: { er: 0, hurst: 0.5, direction: "flat" },
      gamma: { regime: inp.gammaRegime || "—", note: "" },
      gauges: [], pivots: [], method: "topology+garch", notes,
    };
  }

  const g = fitGarch(returns);
  const annVol = Math.sqrt(g.sigma2Next) * annFactor * 100;
  const longRun = Math.sqrt(g.uncondVar) * annFactor * 100;
  const persistence = g.alpha + g.beta;
  const volTrend: Regime["vol"]["trend"] =
    g.sigma2Next > g.uncondVar * 1.12 ? "expanding" :
    g.sigma2Next < g.uncondVar * 0.88 ? "contracting" : "steady";

  const er = efficiencyRatio(series);
  const h = hurst(returns);
  const window = series.slice(-120);
  const wFirst = window[0] ?? 0, wLast = window[window.length - 1] ?? 0;
  const net = window.length > 1 ? wLast - wFirst : 0;
  const netPct = window.length > 1 && wFirst ? (net / wFirst) * 100 : 0;
  const direction: Regime["trend"]["direction"] = netPct > 0.15 ? "up" : netPct < -0.15 ? "down" : "flat";

  // Trend vs range keys off the efficiency ratio (price-path directness, the intuitive read);
  // Hurst is surfaced as its own gauge rather than folded in, so the labels never contradict.
  const trending = er > 0.45;
  const ranging = er < 0.30;

  // Headline state + plain-English read (no desk jargon).
  let state: string, read: string;
  if (negGamma && trending && volTrend === "expanding") {
    state = "TREND · UNPINNED";
    read = "Dealers are short gamma and vol is expanding into a directional tape — momentum runs. Trade with the move; reversals at levels are lower-percentage here.";
  } else if (posGamma && ranging) {
    state = "RANGE · PINNED";
    read = "Positive dealer gamma is suppressing the range and vol is compressed — fade the edges. Rest limit orders at the persistent pivots; breakouts tend to fail.";
  } else if (negGamma && ranging) {
    state = "CHOP · UNSTABLE";
    read = "Short-gamma but no clear trend — whippy, two-sided. Cut size and only trust the highest-persistence pivots.";
  } else if (trending && (posGamma || !negGamma)) {
    state = "GRIND · ORDERLY";
    read = "An orderly, supported trend — dips toward the pivots get bought back. Favour with-trend limits over fading.";
  } else {
    state = "BALANCED · TRANSITIONAL";
    read = "No single force dominates — mixed trend and vol. Let price pick a side at the pivots before committing.";
  }

  const bias: Regime["bias"] =
    direction === "up" ? "up" : direction === "down" ? "down" : "neutral";

  // Confidence = how cleanly the three structural axes agree.
  const structureClarity = clamp(Math.abs(er - 0.36) / 0.36, 0, 1);
  const gammaClarity = posGamma || negGamma ? 0.75 : 0.3;
  const volClarity = volTrend === "steady" ? 0.4 : 0.75;
  const confidence = Math.round(clamp(100 * (0.4 * structureClarity + 0.3 * gammaClarity + 0.3 * volClarity), 20, 95));

  const gauges: RegimeGauge[] = [
    {
      label: "Vol · GARCH",
      value: `${annVol.toFixed(0)}% ann · ${volTrend}`,
      pct: clamp((annVol / 40) * 100, 4, 100),
      tone: volTrend === "expanding" ? "amber" : volTrend === "contracting" ? "blue" : "",
    },
    {
      label: "Trend · ER",
      value: `${er.toFixed(2)} · ${trending ? "trend" : ranging ? "range" : "mixed"}`,
      pct: clamp(er * 100, 2, 100),
      tone: trending ? "green" : ranging ? "blue" : "",
    },
    {
      label: "Persistence · Hurst",
      value: `${h.toFixed(2)} · ${h > 0.55 ? "trending" : h < 0.45 ? "mean-rev" : "random"}`,
      pct: clamp(h * 100, 2, 100),
      tone: h > 0.55 ? "green" : h < 0.45 ? "blue" : "",
    },
    {
      label: "Dealer Gamma",
      value: posGamma ? "Positive · suppressing" : negGamma ? "Negative · amplifying" : (inp.gammaRegime || "—"),
      pct: posGamma ? 30 : negGamma ? 90 : 55,
      tone: negGamma ? "red" : posGamma ? "blue" : "",
    },
    {
      label: "Vol Shock Memory",
      value: `α+β ${persistence.toFixed(2)} · ${persistence > 0.92 ? "sticky" : "fast decay"}`,
      pct: clamp(persistence * 100, 2, 100),
      tone: "",
    },
  ];

  return {
    as_of: inp.asOf,
    generated_at: new Date(now).toISOString(),
    scored_at: now,
    spot: Math.round(inp.spot * 100) / 100,
    state, read, bias, confidence,
    vol: {
      ann: Math.round(annVol * 10) / 10,
      longRun: Math.round(longRun * 10) / 10,
      trend: volTrend,
      level: volLevel(annVol),
      persistence: Math.round(persistence * 1000) / 1000,
    },
    trend: { er: Math.round(er * 1000) / 1000, hurst: Math.round(h * 1000) / 1000, direction },
    gamma: {
      regime: inp.gammaRegime || "—",
      note: negGamma ? "amplifies moves (trend)" : posGamma ? "suppresses moves (mean-revert)" : "neutral",
    },
    gauges,
    pivots: topoPivots(series, inp.board),
    method: "topology+garch",
    notes: notes.length ? notes : undefined,
  };
}

/** Path of the regime JSON the static page fetches. */
export const regimeJsonPath = path.join(config.paths.root, "web", "regime.json");

/** Write web/regime.json (shipped with the rest of web/ on the next deploy). */
export async function writeRegime(r: Regime): Promise<void> {
  await fs.mkdir(path.dirname(regimeJsonPath), { recursive: true });
  await fs.writeFile(regimeJsonPath, JSON.stringify(r, null, 2), "utf8");
}

/** Convenience: snapshot supplies the dealer-gamma regime label. */
export function gammaRegimeFromSnapshot(snap: DataSnapshot | null | undefined, board: Board | null): string {
  return snap?.gex_regime || board?.regime || "";
}
