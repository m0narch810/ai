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

/** One OHLCV bar, timestamped in ET. Delta is net buyer-minus-seller volume for the bar (from Altaris). */
export interface Bar {
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Net delta for the bar (Altaris candles). Undefined for NQ/Yahoo bars. */
  delta?: number;
}

/** One 15-min candle from /api/candles. */
export interface AltarisCandle {
  t: string;   // ET ISO, e.g. "2026-06-18T09:30:00"
  o: number; h: number; l: number; c: number; v: number;
  d?: number;  // net delta (buyer minus seller volume)
}

/** Full response shape from GET /api/candles[?days=N]. */
export interface AltarisCandlesResponse {
  ticker: string;
  candles: AltarisCandle[];
  emas: { t: string; e20: number; e50: number }[];
  vwap_z: { t: string; vwap: number; z: number; c: number }[];
  delta_profile: { price: number; delta: number }[];
  levels: {
    spot: number;
    call_wall: number; put_wall: number; major_wall: number;
    max_pain: number; zero_gamma: number; vol_trigger: number;
    gex_top5: { strike: number; gex: number }[];
    gex_profile: { s: number; g: number }[];
    [key: string]: unknown;
  };
}

export type Side = "support" | "resistance";

/** A single scored level the AI produced. */
export interface ScoredLevel {
  strike: number;
  /** 0-100, conditional: P(reversal >= min move to a far named level | price reaches this strike). */
  reversal_prob: number;
  side: Side;
  /** One short line of the confluences driving the score. */
  why: string;
  /** 2-4 terse confluence tags for the dashboard chips (e.g. "Call Wall", "GEX +1.7B"). */
  tags?: string[];
  /**
   * Predicted CHARACTER of the touch — decides if it's tradeable to the tick.
   * "clean" = instant touch-and-reject; "chop" = grinds/oscillates with drawdown; "mixed" = unclear.
   */
  reaction?: "clean" | "chop" | "mixed";
  /**
   * The specific far structural level price is expected to reach on a successful reversal here.
   * Must be >= min_reversal_move_pts away. Defines the "ping pong" target.
   */
  target_strike?: number;
}

/** The board the AI returns each tick. */
export interface Board {
  as_of: string;
  /** Absolute epoch ms the levels were scored — timezone-proof staleness (as_of is ET wall-clock). */
  scored_at?: number;
  spot: number;
  regime: string;
  /** One-line institutional read: where price is headed next + the level to fade it at. */
  read?: string;
  levels: ScoredLevel[];
  /** Current IV regime, surfaced for the dashboard hero. */
  iv?: { current: number; direction: string };
  /** Expected daily move (points), surfaced for the dashboard hero. */
  expected_move?: number;
  /** How this board was scored: "ai" = Claude, "rule" = deterministic fallback. */
  scoring_method?: "ai" | "rule";
  /** Near-spot GEX distribution for the dashboard GEX chart. */
  gex_profile?: { strike: number; gex_m: number }[];
}

// ── Pre-open narrative (dxrk: market-open prediction + RTH macro bias) ────────────

/** One macro series reading with direction vs its prior value. */
export interface MacroReading {
  last: number;
  prev: number;
  chg: number;
  /** Short-term velocity (recent move), when an intraday series is available. */
  velocity?: number;
  dir: "rising" | "falling" | "flat";
  asOf?: string;
}

/**
 * Cross-asset / commodity readings for the correlation + event overlay. All keyless via
 * Yahoo; `dir` here is computed on a % threshold (not absolute), so it's comparable across
 * very different price scales. A fast move in oil/VIX/dollar is the "geopolitics-as-a-number"
 * signal — e.g. a Strait-of-Hormuz oil spike shows up as brent rising fast.
 */
export interface CrossAssetSnapshot {
  brent?: MacroReading;   // BZ=F  — oil (Brent); energy/geopolitics shock detector
  wti?: MacroReading;     // CL=F  — oil (WTI)
  gold?: MacroReading;    // GC=F  — haven bid
  copper?: MacroReading;  // HG=F  — global-growth proxy
  dxy?: MacroReading;     // DX-Y.NYB — US dollar (up = risk-off / tightening)
  vix?: MacroReading;     // ^VIX  — equity fear gauge
  btc?: MacroReading;     // BTC-USD — risk appetite
  hyg?: MacroReading;     // HYG   — high-yield credit (down = risk-off)
}

/** One recent market-moving headline (GDELT keyless news feed). */
export interface NewsEvent {
  title: string;
  source: string;     // publishing domain, e.g. "reuters.com"
  when: string;       // GDELT seendate (UTC), human-ish
  url?: string;
}

/** The macro inputs behind dxrk's RTH bias (yields, liquidity, carry, crowding). */
export interface MacroSnapshot {
  asOf: string;
  us2y?: MacroReading;
  us10y?: MacroReading;
  /** 10y − 2y, in basis-point-style points (same units as the yield series). */
  curve2s10s?: number;
  usdjpy?: MacroReading;
  /** Treasury General Account level (FRED WTREGEN) — falling = liquidity in = bullish. */
  tga?: MacroReading;
  /** Overnight reverse repo (FRED RRPONTSYD) — draining = liquidity in = bullish. */
  rrp?: MacroReading;
  /** COT speculator crowding for Nasdaq-100, as a 0–100 percentile of net positioning. */
  cot?: { netPct: number; percentile: number; market: string } | null;
  /** Cross-asset / commodity basket — correlation + event (geopolitics) overlay. */
  cross?: CrossAssetSnapshot;
  /** Recent market-moving headlines (GDELT, keyless) — the deterministic event backstop. */
  headlines?: NewsEvent[];
  /** Any source that failed to load, for honest display. */
  notes: string[];
}

export type OpenType =
  | "manip_down_real_up"
  | "manip_up_real_down"
  | "real_pump"
  | "real_dump"
  | "unclear";

export interface NarrativeZone {
  price: number;
  side: Side;
  note: string;
}

export interface NarrativeDriver {
  label: string;
  reading: string;
  lean: "bull" | "bear" | "neutral";
}

/** The full pre-open day narrative the Narrative tab renders. */
export interface Narrative {
  as_of: string;
  generated_at: string;
  scored_at: number;
  spot: number;
  /** RTH macro bias (dxrk PDF 2). */
  macro_bias: "bullish" | "bearish" | "neutral";
  macro_bias_score?: number; // -100..100
  macro_drivers: NarrativeDriver[];
  /** Open-type verdict (dxrk PDF 1). */
  open_type: OpenType;
  open_type_label: string;
  expansion_direction: "up" | "down" | "two-sided";
  targeted_level?: number;
  move_extent?: string;
  completion_signal?: string;
  next_target?: number;
  clean_or_choppy: "clean" | "choppy";
  manipulation_tell?: string;
  /** Where major reversal(s) can happen — tied to the board's scored strikes. */
  reversal_zones: NarrativeZone[];
  /** One-paragraph day story. */
  summary: string;
  /** Breaking macro/geopolitical events the AI weighed (web search + GDELT), with impact. */
  news_events?: { headline: string; impact: "bullish" | "bearish" | "neutral"; source?: string }[];
  scoring_method: "ai" | "unavailable";
  macro?: MacroSnapshot;
}

// ── Market regime (topology + GARCH + dealer-gamma) ──────────────────────────────

/** A topologically-persistent pivot (0-dim persistent homology of the price path). */
export interface RegimePivot {
  price: number;
  side: Side;
  /** Topographic prominence in QQQ points = persistence of the feature (robustness). */
  persistence: number;
  /** True when a scored board level sits on this pivot (structure × flow confluence). */
  confluence?: boolean;
}

/** One labelled gauge for the Regime tab (reuses the prob-track meter visual). */
export interface RegimeGauge {
  label: string;
  value: string;
  /** 0-100 fill for the meter bar. */
  pct: number;
  tone?: "blue" | "amber" | "green" | "red" | "";
}

/**
 * The always-updating market-regime read. Computed every tick from the price path
 * (no AI call), so it refreshes overnight too. Combines:
 *  - GARCH(1,1) conditional volatility (expanding vs contracting),
 *  - 0-dim persistent homology of the close series (structural pivots + dispersion),
 *  - Kaufman efficiency ratio + Hurst exponent (trend vs mean-reversion),
 *  - the dealer-gamma regime from the options snapshot (amplifying vs suppressing).
 */
export interface Regime {
  as_of: string;
  generated_at: string;
  scored_at: number;
  spot: number;
  /** Headline label, e.g. "RANGE · PINNED", "TREND · UNPINNED". */
  state: string;
  /** One plain-English line on how to trade it — no jargon. */
  read: string;
  bias: "up" | "down" | "neutral";
  /** 0-100 agreement across the axes. */
  confidence: number;
  vol: {
    /** Annualized GARCH conditional vol (%), next bar. */
    ann: number;
    /** Annualized long-run (unconditional) vol (%). */
    longRun: number;
    trend: "expanding" | "contracting" | "steady";
    level: "low" | "normal" | "elevated" | "high";
    /** GARCH persistence α+β — how sticky vol shocks are (0-1). */
    persistence: number;
  };
  trend: {
    /** Kaufman efficiency ratio 0-1 (1 = pure trend, 0 = pure chop). */
    er: number;
    /** Hurst exponent (>0.5 trending/persistent, <0.5 mean-reverting). */
    hurst: number;
    direction: "up" | "down" | "flat";
  };
  gamma: { regime: string; note: string };
  gauges: RegimeGauge[];
  /** Topological support + resistance pivots, persistence-ranked. */
  pivots: RegimePivot[];
  method: "topology+garch";
  notes?: string[];
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
  /** Worst adverse excursion BEYOND the level, in points (how far price overshot it). */
  overshoot?: number;
  /**
   * True only if price reversed/held within CLEAN_REVERSAL_PTS of the level — i.e. a
   * tight reversal, not a grind through it. False = it held but sloppily; for grading,
   * a non-clean "reversed" should be treated as a weak signal, not a model win.
   */
  clean?: boolean;
}
