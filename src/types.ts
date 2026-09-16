// Types for the Altaris API responses and our derived structures.
// Field names verified against live /api/data and /api/greek_timeseries responses.

/** Per-strike calls/puts pair (open interest or volume). */
export interface StrikePair {
  calls: number;
  puts: number;
}

/** Maps keyed by strike-as-string (e.g. "729.0"). */
export type StrikeMap<T> = Record<string, T>;

/**
 * A greek's exposure at one strike, split by time-to-expiry instead of collapsed to a single
 * total. Same total GEX means very different things by tenor: a strike whose gamma is mostly d0
 * pins hard TODAY then evaporates; the same number sitting in `m` (monthly+) is durable structure.
 * d0 = same-day (0DTE), w1 = this week (1-7 DTE), w2 = next week (8-14 DTE), m = 15+ DTE.
 */
export interface TermBuckets {
  d0: number;
  w1: number;
  w2: number;
  m: number;
}

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
  /** Days-to-expiry of the front expiration that `iv_skew` came from — needed to build the RND. */
  iv_skew_dte?: number;
  /**
   * 0DTE-ISOLATED greeks — the same-day-expiry slice of the strike×expiration heatmaps (not the
   * all-expiration `*_bar` aggregates). Into the cash close 0DTE positioning dominates pinning/charm,
   * so these isolate the slice that actually holds price to the tick. Nearest expiry if no true 0DTE.
   */
  gex_0dte_bar?: StrikeMap<number>;
  charm_0dte_bar?: StrikeMap<number>;
  vanna_0dte_bar?: StrikeMap<number>;
  /** 0DTE theta: on expiry day decay concentrates at the ATM strike — the theta-harvest pin
   * (dealers scalp price ONTO the strike to collect decay into the close). The blended tex_bar
   * dilutes this across expiries and can rank the pin strike second (seen 2026-07-08 at 710). */
  tex_0dte_bar?: StrikeMap<number>;
  /** 0DTE delta & vega slices — same-day isolation for the remaining greeks (YYY /heatmap grids). */
  dex_0dte_bar?: StrikeMap<number>;
  vex_0dte_bar?: StrikeMap<number>;
  /**
   * Per-strike greek exposure split by tenor (0DTE / this-week / next-week / monthly+),
   * from the raw strike×expiration heatmaps. Lets the scorer read the TERM STRUCTURE of a
   * level — durable multi-expiry structure vs a same-day pin that fades after today.
   * Under YYY, ladders come from /heatmap (8 front expiries ≈ 0-8 DTE): the `m` bucket is
   * structurally empty and `w2` is the deepest durability horizon the feed can see.
   */
  gex_term?: StrikeMap<TermBuckets>;
  charm_term?: StrikeMap<TermBuckets>;
  vanna_term?: StrikeMap<TermBuckets>;
  dex_term?: StrikeMap<TermBuckets>;
  vex_term?: StrikeMap<TermBuckets>;
  tex_term?: StrikeMap<TermBuckets>;
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
  /**
   * Net gamma-flip strike from /api/ladder net positioning — may differ from zero_gamma (which uses
   * the raw heatmap). Both represent where net dealer gamma crosses zero; ladder version uses the
   * full net calls/puts positioning across all greeks.
   */
  net_gex_flip?: number;
  /**
   * Dollar premium (calls + puts notional, $) per strike from /api/ladder — where real money is
   * anchored. High premium_bar at a strike means significant capital has its P&L reference there;
   * those participants have strong incentive to defend or react at this price.
   */
  premium_bar?: StrikeMap<number>;
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

/** Dealer hedge pressure from /api/hedge_pressure — which greek is mechanically driving dealer flows. */
export interface HedgePressureSummary {
  score: number;          // -1..1, negative = downside/put pressure, positive = upside/call
  label: string;          // e.g. "Neutral Hedge Balance", "Gamma Dominated"
  sensitivity: string;    // "gamma" | "vanna" | "charm" | "iv" — primary driver of dealer hedging
  gamma_pct: number;      // % contribution from gamma hedging flow
  vanna_pct: number;      // % contribution from vanna hedging flow
  charm_pct: number;      // % contribution from charm hedging flow
  momentum: number;       // velocity of hedge flow change (negative = building downside pressure)
  acceleration: number;   // rate of change of momentum (negative = accelerating downward)
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
  /**
   * GARCH-implied PRICE bands from spot: ±1σ/±2σ over the rest of TODAY ("0") and 1 day ("1").
   * Statistical-exhaustion levels — a wall at/beyond the band edge has mechanics AND statistics
   * aligned (the large-reversal origin archetype).
   */
  ranges?: Record<string, { vol_pct: number; low_1s: number; high_1s: number; low_2s: number; high_2s: number }>;
  /** 10-day conditional-vol forecast path, slimmed: day-1 vs day-10 (rising = vol regime worsening). */
  forecast?: { d1_vol_pct: number; d10_vol_pct: number; dir: "cooling" | "steady" | "heating" };
}

/** /api/anomalies — z-scored 5-min return anomalies (capitulation/exhaustion prints). */
export interface AnomalySummary {
  /** |z| threshold the engine flags at. */
  threshold: number;
  /** Anomalous up/down 5-min returns TODAY (session date). */
  today_up: number;
  today_down: number;
  /** Most recent anomaly in the feed (any day). */
  last: { time: string; dir: "up" | "down"; ret_pct: number } | null;
}

/** /api/put_call_skew — risk-reversal (put IV − call IV) term structure. */
export interface PcSkewSummary {
  /** Front-expiry 5%-OTM risk reversal (positive = put skew = hedging demand). */
  current_rr: number;
  /** Altaris's read, e.g. "MODERATE PUT SKEW - HEDGING". */
  bias: string;
  /** RR per expiration (front 4) — how far out the hedging demand extends. */
  term: { dte: number; rr: number }[];
}

/** /api/skew_index — SKEW-index-style tail-risk measure computed on the QQQ chain. */
export interface SkewIndexSummary {
  current_skew: number; // ~100 = flat, higher = more tail-risk premium
  risk_level: string;   // e.g. "LOW TAIL RISK"
  /** Front-expiry OTM-put/ATM IV ratio — how expensive crash protection is today. */
  front_put_skew_ratio: number | null;
}

/** /api/vol_regime_score — mean-revert / breakout / no-trend scores with driver reasoning. */
export interface VolRegimeScoreSummary {
  label: string;      // "MR" | "BO" | "NT"
  mr_score: number;
  bo_score: number;
  nt_score: number;
  confidence: number;
  reasoning: string;  // e.g. "BO (38%MR/55%BO/11%NT) | drivers: vrp→BO(70%)…"
  /** % of the 252d calibration history the engine has — LOW means discount this block. */
  history_pct_complete: number;
}

/** /api/regime_intraday — 5-min-bar intraday regime engine with an execution hint. Slow (~35s). */
export interface RegimeIntradaySummary {
  structural_state: string;   // CALM | TRANSITION | STRESS
  structural_confidence: number;
  behavioral_regime: string;  // MR | BO
  mean_reversion_score: number;
  breakout_score: number;
  signal_clarity: number;
  model_certainty: number;
  reasoning: string;
  /** e.g. { action: "WEAK_MR", size_scalar: 0.33 } — the engine's own sizing suggestion. */
  execution_hint: { action: string; size_scalar: number } | null;
}

/** /api/oi365 — OI mass by EXPIRATION (where positioning lives in time). */
export interface Oi365Summary {
  /** Front expirations by date: total OI + put/call ratio each. */
  expirations: { label: string; dte: number; total_oi: number; pc: number }[];
}

/** One graded strike from /api/level_assessment — Altaris's own level engine. */
export interface AssessedLevel {
  strike: number;
  /** Positioning zone the strike sits in (e.g. "P" put-supported, "C" call-supported). */
  zone: string;
  /** Structural quality grade (A/B/C) from the Altaris engine. */
  grade: string;
  /** Expected-reaction archetype: "The Bedrock" = solid hold; "The Trapdoor" = liquidity gap (plunges through). */
  archetype: string;
  /** "SAFE" | "NEUTRAL" | ... — the engine's tradability call. */
  level_type: string;
  /** 0-1: how well dealer hedging aligns with the level holding. */
  hedge_score: number;
  /** 0-1 weight rank among all assessed levels (1 = most significant). */
  rank_pct: number;
  oi: number;
  /** e.g. "Lean bullish alignment, stabilizing" — dealer-hedge alignment read. */
  hedge_desc: string;
  /** e.g. "Vanna-dominated; Charm-heavy" — which greeks drive the level. */
  drivers_desc: string;
}

/** /api/level_assessment — the terminal's own per-strike level grading (near-spot slice). */
export interface LevelAssessmentSummary {
  gamma_flip: number | null;
  /** Where spot sits, e.g. "Z — Zero Gamma (at Gamma Flip)". */
  zone_label: string;
  /** The strike the engine ranks most significant right now. */
  dominant: { strike: number; zone: string; grade: string; archetype: string } | null;
  levels: AssessedLevel[];
}

/** /api/opex_gravity — front-expiry max-pain pinning mechanics. */
export interface OpexGravitySummary {
  expiry_label: string;
  dte: number;
  hours_to_expiry: number;
  /** FRONT-expiry max pain (can differ from the all-expiration max_pain in named_levels). */
  max_pain: number;
  /** 0-100: strength of the max-pain magnet today. */
  pin_score: number;
  total_oi: number;
  /** Near-spot strikes exerting OI pull, strongest first. */
  gravity_strikes: { strike: number; call_oi: number; put_oi: number; pull_strength: number }[];
}

/** /api/oi_analytics — chain-wide OI positioning shape. */
export interface OiAnalyticsSummary {
  /** OI-based put/call ratio (standing positioning; the volume pc_ratio is today's flow). */
  pc_ratio_oi: number;
  /** % of total OI in the top-5 strikes — high = concentrated walls, low = diffuse. */
  concentration_top5_pct: number;
  /** The strike total OI mass centers on — a mean-reversion magnet in pinning regimes. */
  oi_center_of_gravity: number;
  max_pain_all: number;
  /** [lo, hi] price band where puts dominate OI. */
  put_heavy_zone: number[] | null;
  call_heavy_zone: number[] | null;
}

/** /api/liquidity_map — front-expiry per-strike OI/volume (the lived-in check at 0DTE granularity). */
export interface LiquiditySummary {
  expiry_label: string;
  dte: number;
  /** Near-spot strikes ranked by total front-expiry OI. */
  top: { strike: number; call_oi: number; put_oi: number; call_vol: number; put_vol: number }[];
}

/** One sweep/block alert from /api/unusual_activity — aggressive initiative flow. */
export interface UnusualAlert {
  strike: number;
  dte: number;
  option_type: string; // "call" | "put"
  volume: number;
  oi: number;
  vol_oi_ratio: number;
  premium_m: number; // $M spent
  signal: string;    // e.g. "SWEEP"
}

/** /api/hiro — live dealer-hedging impact tape (net mechanical flow from option trades). */
export interface HiroSummary {
  direction: string;      // "BUY PRESSURE" | "SELL PRESSURE" | ...
  current_hiro_m: number;
  total_gex_m: number;
  call_gex_m: number;
  put_gex_m: number;
  /** Sum of the last ~30 min of 5-min hiro prints — the recent flow impulse. */
  last_30m_hiro: number | null;
}

/** /api/heston_surface — where option premium is rich/cheap vs a calibrated Heston surface. */
export interface HestonSummary {
  rmse: number;
  feller: boolean;
  pct_rich: number;
  pct_cheap: number;
  mean_spread: number;
  richest: { strike: number; dte: number; z: number }[];
  cheapest: { strike: number; dte: number; z: number }[];
}

/** /api/regime_v2 — the terminal's multi-model regime consensus (TVTP-MS, MS-GARCH, HDP-HMM, BOCPD…). */
export interface RegimeV2Summary {
  consensus: string;       // e.g. "STRESS / REGIME BREAK WARNING"
  interpretation: string;
  agreement: string;       // "N/M models agree"
  p_change: number;        // P(regime change)
  expected_dwell: number;  // expected days the current regime persists
  expected_move_pct: number;
  rv30: number;
  atm_iv: number;
  votes: { model: string; vote: string; confidence: number }[];
}

/** /api/vol_stats — the terminal's vol dashboard (HV ladder, IV rank, VRP, VIX term structure). */
export interface VolStatsSummary {
  hv10: number;
  hv20: number;
  hv30: number;
  atm_iv: number;
  /** IV rank (percentile of ATM IV vs its own history). */
  ivr: number;
  /** IV − RV: negative = realized running above implied (under-hedged → continuation prior). */
  vol_premium: number;
  regime: string;
  vix9d: number;
  vix: number;
  vix3m: number;
  /** "CONTANGO" (calm) | "BACKWARDATION" (stressed — don't fade large moves) | "FLAT". */
  ts_shape: string;
}

/**
 * The cloud Regime tab's output (netlify/functions/regime.mjs, cached in Blobs).
 * This is the SAME regime read the dashboard displays — fed to the AI scorer so the
 * regime you see governs the board. Yang-Zhang RV, GARCH, VXN VRP, topology pivots.
 */
export interface RegimeSummary {
  as_of: string;
  scored_at: number;
  state: string;   // e.g. "VOL EXPANSION · TREND", "RANGE · PINNED", "CHOP · UNSTABLE"
  read: string;    // the narrative line shown on the tab
  bias: string;    // "up" | "down" | "neutral"
  confidence: number; // 0-100
  vol: { rv: number; rvPercentile: number; garchAnn: number; persistence: number; trend: string; level: string; sticky: boolean };
  impliedVol: { vxn: number; rv21: number; vrp: number; vrpPercentile: number; premium: string } | null;
  trend: { er: number; hurst: number; direction: string };
  gamma: { regime: string; note: string };
  /** Topology (persistent-homology) support/resistance pivots — actual price levels. */
  pivots: Array<{ price: number; side: string; persistence: number; confluence?: boolean }>;
}

/** One factor degrading the day gate. Severity is the ONLY parameter (no numeric weights —
 *  point magnitudes would be pseudo-precision, and fitting them would be curve-fitting). */
export interface DayGateReason {
  /** "major" = the mechanism alone breaks the fade-at-levels edge; "minor" = corroborating. */
  severity: "major" | "minor";
  label: string;
}

/**
 * The DAY GATE — a deterministic, advisory "should I rest limits at levels today at all?"
 * verdict composed from the expiration calendar × live flow state × regime. Count rule:
 * 2 majors (or 1 major + 3 minors) → STAND DOWN; 1 major or 3 minors → SELECTIVE; else TAKE.
 * Display-layer: it never blocks scoring or caps the AI. See src/dayGate.ts.
 */
export interface DayGate {
  verdict: "TAKE" | "SELECTIVE" | "STAND DOWN";
  majors: number;
  minors: number;
  reasons: DayGateReason[];
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
  /** Dealer hedge pressure from /api/hedge_pressure — which greek drives flows, directional score, momentum. */
  hedge_pressure?: HedgePressureSummary;
  /** Altaris's own per-strike level grading from /api/level_assessment (near-spot slice). */
  level_assessment?: LevelAssessmentSummary;
  /** Front-expiry max-pain pinning from /api/opex_gravity. */
  opex_gravity?: OpexGravitySummary;
  /** Chain-wide OI positioning shape from /api/oi_analytics. */
  oi_analytics?: OiAnalyticsSummary;
  /** Front-expiry per-strike liquidity from /api/liquidity_map. */
  liquidity?: LiquiditySummary;
  /** Sweep/block alerts from /api/unusual_activity (largest premium first). */
  unusual_activity?: UnusualAlert[];
  /** Live dealer-hedging impact tape from /api/hiro. */
  hiro?: HiroSummary;
  /** Rich/cheap option-pricing surface from /api/heston_surface (slow endpoint; often absent). */
  heston?: HestonSummary;
  /** Multi-model regime consensus from /api/regime_v2. */
  regime_v2?: RegimeV2Summary;
  /** Vol dashboard from /api/vol_stats (HV ladder, IVR, VRP, VIX term structure). */
  vol_stats?: VolStatsSummary;
  /** Z-scored 5-min return anomalies from /api/anomalies. */
  anomalies?: AnomalySummary;
  /** Risk-reversal term structure from /api/put_call_skew. */
  pc_skew?: PcSkewSummary;
  /** Tail-risk skew index from /api/skew_index. */
  skew_index?: SkewIndexSummary;
  /** MR/BO/NT vol-regime scores from /api/vol_regime_score. */
  vol_regime_score?: VolRegimeScoreSummary;
  /** Intraday regime engine from /api/regime_intraday (slow endpoint; local capture only). */
  regime_intraday?: RegimeIntradaySummary;
  /** OI by expiration from /api/oi365. */
  oi365?: Oi365Summary;
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
  // NOTE (2026-08-15): `target_strike` was removed. The bracket is fixed at 80 MNQ pts on every
  // call, so a per-level destination is neither chosen nor published. Historical boards on disk
  // still carry the field; nothing reads it.
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
  /** Risk-neutral P(%) the underlying FINISHES in this strike's bin (Breeden–Litzenberger; see density.ts). */
  rnd?: number;
  /** True if price already broke this strike today (hard-stopped) — de-rated to ~zero. */
  broken?: boolean;
}

/** One waypoint in the tape's expected path — every strike ahead classified by what it does to the move. */
export interface TapeWaypoint {
  strike: number;
  /**
   * "reversal" = turns the move for a full tradeable leg; "chop" = pauses/oscillates, pressure then
   * decides; "speed_bump" = brief pause then CONTINUATION through; "accelerate" = breaks and speeds up.
   */
  expect: "reversal" | "chop" | "speed_bump" | "accelerate";
  why: string;
}

/**
 * The continuous first-person tape read — the desk's committed play-by-play of the session.
 * This is where pass-through levels (excluded from levels[] by ACTIONABILITY) live, classified
 * honestly as chop/speed bumps/accelerants in the story. AI boards only; the rule fallback omits it.
 */
export interface BoardTape {
  /** What price is DOING right now, one line ("Selling down from the 710 rejection, delta one-way"). */
  now: string;
  /** The current leg's committed direction — where dealer/hedging pressure is pushing. */
  direction: "down" | "up" | "ranging";
  /** The strikes price meets next, in order, each classified. */
  path: TapeWaypoint[];
  /**
   * THE trade this read implies — the "set a limit here" call. Null = no-trade read.
   * No `target`: the bracket is fixed (config.callTpPts / config.hardStopPts), so the only
   * decisions left are side and entry strike.
   */
  trade: { side: "long" | "short"; entry: number; why: string } | null;
  /** The full flowing narrative paragraph, first person, committed. */
  narrative: string;
}

/**
 * The four IV wall levels for the session — the ~19-delta (|Δ| = 0.1925) strikes of the front
 * expiry on each wing (inner walls) plus fixed-width outer brackets, computed once from the
 * session's first usable chain and FROZEN for the day. Chain-derived structure (the option
 * market's own priced move-edge), not a statistical band. See src/ivWalls.ts + the spec PDF.
 */
export interface IvWalls {
  u_inner: number;
  u_outer: number;
  l_inner: number;
  l_outer: number;
  /** Spot the walls were computed from (frozen; live spot will drift off it). */
  spot_at_calc: number;
  /** ATM IV (%) of the chain at compute time — reference context. */
  sigma_atm_pct: number;
  /** |Δ| threshold used for the inner walls (0.1925 per the spec). */
  delta: number;
  /** ET ISO of the computation — walls are frozen from here for the rest of the session. */
  computed_at: string;
  /** DTE of the chain used (0 = today's expiry). */
  dte: number;
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
  /** The continuous action narrative (committed play-by-play + expected path + the trade). */
  tape?: BoardTape;
  levels: ScoredLevel[];
  /** Current IV regime, surfaced for the dashboard hero. */
  iv?: { current: number; direction: string };
  /** Expected daily move (points), surfaced for the dashboard hero. */
  expected_move?: number;
  /** Advisory day-quality verdict (calendar × flow × regime) — see src/dayGate.ts. */
  day_gate?: DayGate;
  /** Per-strike × tenor gamma/charm surfaces ($M) for the dashboard's 3D topography. */
  term_profile?: { strike: number; gex: [number, number, number, number]; charm: [number, number, number, number] }[];
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
  /** Gamma-Theta Breakeven Range: daily % move at which dealer gamma P&L offsets today's theta
   * decay. Inside = theta dominates, dealers pin/range; broken = gamma P&L overtakes theta and
   * forced rebalancing amplifies the move. See gtbrPct() in score.ts. */
  gtbr_pct?: number;
  /** GTBR converted to QQQ points at the scored spot. */
  gtbr_pts?: number;
  /** The day's frozen IV wall brackets (19Δ wings of the front expiry) — see IvWalls. */
  iv_walls?: IvWalls;
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

/**
 * LIVE MACRO PULSE — the lightweight intraday refresher fed to the per-tick scorer (the full
 * MacroSnapshot below is pre-open only). Direction + ~30-min velocity of the handful of
 * cross-asset series that can run price THROUGH options structure mid-session: 2Y/10Y yields,
 * carry (USD/JPY), oil, dollar, VIX/VXN/VIX9D + term structure — plus today's scheduled
 * high-impact USD releases with minutes-until (the event clock). Best-effort; never throws.
 */
export interface MacroPulse {
  asOf: string;
  us2y?: MacroReading;
  us10y?: MacroReading;
  curve2s10s?: number;
  usdjpy?: MacroReading;
  oil?: MacroReading;
  dxy?: MacroReading;
  vix?: MacroReading;
  vxn?: MacroReading;
  vix9d?: MacroReading;
  vix_term?: { front: number; back: number; ratio: number; structure: "contango" | "backwardation" | "flat" };
  /** Today's USD "High"-impact releases (ForexFactory feed): negative minutes_until = already printed. */
  events_today?: { name: string; time_et: string; minutes_until: number }[];
  notes: string[];
}

/** The macro inputs behind dxrk's RTH bias (yields, liquidity, carry, crowding). */
export interface MacroSnapshot {
  asOf: string;
  /**
   * Week-ahead USD high-impact releases with days-out (0 = today), from the public ForexFactory
   * calendar. Replaced the Altaris macro panel's FRED release calendar when Altaris was retired
   * 2026-09-01. Feeds DayContext.upcoming_events → the day gate's FOMC/CPI/NFP factors.
   */
  events?: { name: string; days: number }[];
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
  // Committed rotation call: signals AGREE there is no directional expansion (pinning dominates).
  // Distinct from "unclear", which means the signals conflict and the call is to wait.
  | "chop_day"
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
  /**
   * Max favorable run after the reversal confirmed (fraction of the level), frozen at any later
   * hard-stop break. THE calibration number for the board's objective: >= 0.005 = the minimum
   * tradeable reversal; >= 0.01 = the ideal large reversal the system hunts.
   */
  maxRunPct?: number;
  /** Worst adverse excursion BEYOND the level, in points (how far price overshot it). */
  overshoot?: number;
  /**
   * True only if price reversed/held within CLEAN_REVERSAL_PTS of the level — i.e. a
   * tight reversal, not a grind through it. False = it held but sloppily; for grading,
   * a non-clean "reversed" should be treated as a weak signal, not a model win.
   */
  clean?: boolean;
}
