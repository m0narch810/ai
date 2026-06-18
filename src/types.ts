// Types for the Altaris API responses and our derived structures.
// Field names verified against live /api/data and /api/greek_timeseries responses.

/** Per-strike calls/puts pair (open interest or volume). */
export interface StrikePair {
  calls: number;
  puts: number;
}

/** Maps keyed by strike-as-string (e.g. "729.0"). */
export type StrikeMap<T> = Record<string, T>;

/** The subset of /api/data we persist and use. The *_hm heatmaps are dropped. */
export interface DataSnapshot {
  ticker: string;
  spot: number;
  /** UTC-naive ISO string from Altaris. */
  timestamp: string;

  call_wall: number;
  put_wall: number;
  major_wall: number;
  max_pain: number;
  zero_gamma: number;
  vol_trigger: number;
  total_vol_trigger: number;
  call_wall_0dte: number;
  put_wall_0dte: number;
  major_wall_0dte: number;
  call_walls: number[];
  put_walls: number[];

  oi_bar: StrikeMap<StrikePair>;
  vol_bar: StrikeMap<StrikePair>;
  gex_bar: StrikeMap<number>;
  dex_bar: StrikeMap<number>;
  /** Vega exposure per strike (Altaris VEX = vega; vanna is vanna_bar/vannex). */
  vex_bar: StrikeMap<number>;
  /** Rho exposure per strike. */
  rex_bar: StrikeMap<number>;
  /** Aggregated from cex_hm (charm exposure) at capture time — per-strike total. */
  charm_bar: StrikeMap<number>;
  /** Aggregated from tex_hm (theta exposure) at capture time — per-strike total. */
  tex_bar: StrikeMap<number>;
  /** Aggregated from vannex_hm (vanna exposure) at capture time — per-strike total. */
  vanna_bar: StrikeMap<number>;

  atm_iv: number;
  expected_move: number;
  atm_iv_avg: number;
  gex_regime: string;
  realized_vol: number;
  net_vanna: number;
}

/** One row of the intraday aggregate tape (greek_timeseries.history[]). */
export interface GreekHistoryPoint {
  ts: string;
  spot: number;
  net_gex: number;
  call_gex: number;
  put_gex: number;
  net_dex: number;
  net_vanna: number;
  net_charm: number;
  call_wall: number;
  put_wall: number;
  major_wall: number;
}

export interface GreekTimeseries {
  history: GreekHistoryPoint[];
  cumulative_dex: { ts: string; spot: number; cum_total: number; cum_call: number; cum_put: number }[];
  dex_flow: { ts: string; strike: number; delta: number }[];
}

/** IV regime summary from /api/iv_tracker. */
export interface IvSummary {
  current_iv: number;
  session_start_iv: number;
  iv_change: number;
  direction: string; // RISING | FALLING | STABLE
  /** Altaris's own guidance on how much vanna hedging matters right now. */
  vanna_note: string;
}

/** One captured poll, appended to data/raw/<date>.data.jsonl. */
export interface CaptureRecord {
  /** Our capture time, normalized to ET ISO. */
  capturedAt: string;
  data: DataSnapshot;
  iv?: IvSummary;
}

/** One OHLCV bar (from Yahoo), timestamped in ET. */
export interface Bar {
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type Side = "support" | "resistance";

/** A single scored level the AI produced. */
export interface ScoredLevel {
  strike: number;
  /** 0-100, conditional: P(reversal >= min move | price reaches this strike). */
  reversal_prob: number;
  side: Side;
  /** One short line of the confluences driving the score. */
  why: string;
}

/** The board the AI returns each tick. */
export interface Board {
  as_of: string;
  spot: number;
  regime: string;
  levels: ScoredLevel[];
}

/** Detector outcome for a level over the day's spot path. */
export type ReversalOutcome = "reversed" | "broke" | "pending" | "untouched";

export interface DetectedLevel {
  strike: number;
  side: Side;
  touched: boolean;
  outcome: ReversalOutcome;
  /** ET ISO of first touch, if any. */
  touchedAt?: string;
  /** ET ISO the outcome resolved, if resolved. */
  resolvedAt?: string;
  /** For a reversed level: how far price retraced off it, as a fraction of the level. */
  reversalPct?: number;
}
