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
  /**
   * Per-strike implied vol (%) for the nearest expiration, from /api/vol_skew_multi — the IV smile/skew.
   * A local IV bump at a strike = concentrated demand/dealer-defense there (stronger, cleaner node);
   * elevated OTM-put vs OTM-call IV (risk reversal) = downside hedging. Optional (enrichment).
   */
  iv_skew?: StrikeMap<number>;
  /**
   * 0DTE-ISOLATED greeks — the same-day-expiry slice of the strike×expiration heatmaps (not the
   * all-expiration `*_bar` aggregates). Into the cash close 0DTE positioning dominates pinning/charm,
   * so these isolate the slice that actually holds price to the tick. Nearest expiry if no true 0DTE.
   */
  gex_0dte_bar?: StrikeMap<number>;
  charm_0dte_bar?: StrikeMap<number>;
  vanna_0dte_bar?: StrikeMap<number>;
  /** Day-over-day OI change per strike (calls/puts) from /api/oi_change — where walls are BUILDING. */
  oi_day_bar?: StrikeMap<StrikePair>;
  /**
   * Put/call volume ratio across all strikes — total puts vol / total calls vol.
   * >1.2 = heavy put hedging (fear; supports hold harder); <0.7 = speculative call chasing
   * (resistance faces more buying pressure). YYY guide: sentiment modifier on directional bias.
   */
  pc_ratio?: number;
  /**
   * Fraction of total |GEX| that expires today (0DTE slice / all expirations), 0-1.
   * >0.6 = most of today's gamma is same-day → strong close-of-day pinning;
   * <0.3 = multi-expiry book → less same-day sensitivity.
   */
  gex_0dte_ratio?: number;
}

/** /api/oi_change — day-over-day OI by strike (where positioning is building/unwinding). */
export interface OiChangeResponse {
  ticker: string;
  spot: number;
  has_previous: boolean;
  prev_date?: string;
  nodes: { strike: number; delta_calls: number; delta_puts: number; delta_total: number; pct_change: number; status: string }[];
}

/** /api/vol_skew_multi — per-strike IV across expirations (the smile). */
export interface VolSkewResponse {
  strikes: number[];
  expirations: { label: string; dte: number; data: { strike: number; iv: number }[] }[];
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

/** Flow entropy from /api/entropy — measures disorder of the options positioning path. */
export interface EntropySummary {
  current_entropy: number;
  threshold: number;
  /** "STABLE FLOW" = orderly positioning (walls more reliable); "CHAOTIC FLOW" = erratic. */
  status: string;
}

/** Hurst exponent from /api/hurst — persistent/trending vs mean-reverting character. */
export interface HurstSummary {
  hurst: number;
  label: string; // "Strong Trend" | "Mild Trend" | "Random Walk" | "Mean Reverting"
  rolling_50: number | null;  // most recent 50-period rolling value
  rolling_100: number | null;
}

/** GARCH vol summary from /api/garch — conditional volatility + persistence. */
export interface GarchSummary {
  daily_vol_pct: number;
  annual_vol_pct: number;
  alpha: number;
  beta: number;
  persistence: number; // α+β — near 1 = long-lived vol clustering, walls need more confluence
  half_life: number;   // days for a vol shock to decay to half
  z_score: number;     // current conditional vol vs its own GARCH mean (±sigma)
  current_regime: string; // "low" | "normal" | "elevated" | "large"
}

/** One captured poll, appended to data/raw/<date>.data.jsonl. */
export interface CaptureRecord {
  /** Our capture time, normalized to ET ISO. */
  capturedAt: string;
  data: DataSnapshot;
  iv?: IvSummary;
  entropy?: EntropySummary;
  hurst?: HurstSummary;
  garch?: GarchSummary;
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

/**
 * A reversal score for ONE exact strike, computed deterministically for EVERY near-spot strike
 * (not just the curated picks) so a resting limit at any strike has a precise number. Differentiated
 * by real greek confluence: empty strikes score near zero, true nodes peak. The AI `levels` are the
 * highlighted subset on top of this; coverage guarantees no node is ever omitted.
 */
export interface CoverageLevel {
  strike: number;
  /** 0-100 reversal likelihood AT this exact strike, from its own greeks (reachability aside). */
  prob: number;
  side: Side;
  reaction: "clean" | "chop" | "mixed";
  tags: string[];
  /** Per-strike implied vol (%) from the skew, when captured — a local bump = demand/defense here. */
  iv?: number;
  /** True if price already broke this strike today (hard-stopped) — de-rated to ~zero. */
  broken?: boolean;
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
  /** Per-strike reversal score for EVERY near-spot strike (precision coverage; see CoverageLevel). */
  coverage?: CoverageLevel[];
  /** Gamma flip (zero-gamma) level — spot above = positive gamma regime, below = negative. */
  zero_gamma?: number;
  /** Vol trigger level — spot below = dealers net short underlying (procyclical sellers). */
  vol_trigger?: number;
  /** Net aggregate GEX across all strikes ($, signed). From greek_timeseries latest point. */
  net_gex?: number;
  /** Flow entropy state at score time — from /api/entropy. CRITICAL = size zero per YYY guide. */
  entropy_state?: "NORMAL" | "ELEVATED" | "CRITICAL";
  /** current_entropy / threshold ratio. */
  entropy_ratio?: number;
  /** Put/call volume ratio at score time — >1.2 = fear/hedging; <0.7 = call chasing. */
  pc_ratio?: number;
  /** Fraction of total |GEX| in the 0DTE slice at score time (0-1). */
  gex_0dte_ratio?: number;
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
  vxn?: MacroReading;     // ^VXN  — Nasdaq-specific vol (VXN/VIX spread = tech premium)
  btc?: MacroReading;     // BTC-USD — risk appetite
  hyg?: MacroReading;     // HYG   — high-yield credit (down = risk-off)
  /** CBOE SKEW index (^SKEW) — tail risk premium. >135 = elevated; >145 = extreme tail hedging. */
  skew_index?: MacroReading;
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
  /**
   * ICE BofA High Yield OAS (FRED BAMLH0A0HYM2) — YYY guide Ch.12.2 weekly layer.
   * <3% = healthy; 3-4% = mild; 4-5% = elevated stress; >5% = crisis. Credit leads equities.
   */
  oas?: MacroReading & { level: "healthy" | "mild" | "elevated" | "crisis" };
  /**
   * VIX term structure: 9-day vs 1-month VIX ratio.
   * Backwardation = front > back = stressed, don't fade large moves (YYY Ch.9.2).
   * Contango = normal vol regime, range levels more reliable.
   */
  vix_term?: { front: number; back: number; ratio: number; structure: "contango" | "backwardation" | "flat" };
  /** True if today has a 10Y/20Y/30Y treasury note/bond auction — YYY Ch.12.2: size down. */
  auction_today?: boolean;
  /** Weekly Federal Reserve bank reserve balances (FRED WRESBAL) — rising = more bank liquidity. */
  reserve_bal?: MacroReading;
  /** Federal Reserve total assets (FRED WALCL) — rising = QE/expansion; shrinking = QT. */
  walcl?: MacroReading;
  /** Copper/gold ratio — rising = growth/reflation; falling = growth fear + haven rotation. */
  copper_gold_ratio?: number;
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
  /** YYY guide Ch.12.4 — entropy gate + topology alignment → FULL / HALF / ZERO. */
  size_rule?: "FULL" | "HALF" | "ZERO";
  size_rule_reason?: string;
  /** Flow entropy gate state (CRITICAL = size zero per YYY guide). */
  entropy_state?: "NORMAL" | "ELEVATED" | "CRITICAL";
  /** current_entropy / threshold ratio (> 1.0 = ELEVATED, > 1.2 = CRITICAL). */
  entropy_ratio?: number;
  /** Topology axis alignment (PCA1 proxy = Hurst+direction; PCA2 proxy = GEX regime). */
  topology_alignment?: "aligned" | "conflicted" | "unclear";
  topology_note?: string;
  pca1_dir?: "up" | "down" | "flat";
  pca2_dir?: "amplify" | "suppress" | "neutral";
  vol_trigger_position?: "above" | "below";
  gex_key_levels?: { call_wall?: number; put_wall?: number; vol_trigger?: number; max_pain?: number; expected_move?: number };
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
    /** Current realized vol (annualized %, rolling 10-day close-to-close). */
    rv: number;
    /** Percentile of current RV within ~2y of its own history (0-100) — the core vol-regime read. */
    rvPercentile: number;
    /** GARCH(1,1) daily conditional forward vol (annualized %). */
    garchAnn: number;
    /** GARCH persistence α+β (0-1) — how slowly a vol shock decays. */
    persistence: number;
    /** Short-vs-medium realized-vol momentum. */
    trend: "expanding" | "contracting" | "steady";
    /** Vol level keyed off the RV percentile, not absolute % thresholds. */
    level: "low" | "normal" | "elevated" | "high";
    /** persistence > 0.9 — an elevated reading is likely to persist, not mean-revert. */
    sticky: boolean;
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
export type ReversalOutcome = "reversed" | "retested" | "broke" | "pending" | "untouched";

export interface DetectedLevel {
  strike: number;
  side: Side;
  touched: boolean;
  outcome: ReversalOutcome;
  /** ET ISO of first touch, if any. */
  touchedAt?: string;
  /** ET ISO the outcome resolved, if resolved. */
  resolvedAt?: string;
  /** ET ISO of the second touch (retest), when outcome is "retested" or pending-retest. */
  retestAt?: string;
  /** For a reversed/retested level: how far price retraced off it, as a fraction of the level. */
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
