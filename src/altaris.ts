import { config } from "./config.js";
import { getCookie, hasCredentials, refreshCookie } from "./auth.js";
import type { AltarisCandlesResponse, DataSnapshot, EntropySummary, GarchSummary, GreekTimeseries, HedgePressureSummary, HestonSummary, HiroSummary, HurstSummary, LevelAssessmentSummary, LiquiditySummary, OiAnalyticsSummary, OiChangeResponse, OpexGravitySummary, RegimeV2Summary, StrikeMap, UnusualAlert, VolSkewResponse, VolStatsSummary } from "./types.js";

const BROWSER_HEADERS = {
  accept: "*/*",
  referer: "https://altaris.up.railway.app/",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
};

const fetchRaw = (endpoint: string, cookie: string, timeoutMs = config.fetchTimeoutMs) =>
  fetch(`${config.baseUrl}/${endpoint}`, {
    headers: { ...BROWSER_HEADERS, cookie },
    // Without a timeout a connected-but-silent endpoint hangs the whole capture
    // (Promise.all waits forever) and holds the scoring lock. AbortSignal.timeout
    // makes every endpoint self-limiting and lets the .catch(()=>null) guards work.
    signal: AbortSignal.timeout(timeoutMs),
  });

/**
 * GET an Altaris endpoint. If the session cookie is missing or rejected (401/403)
 * and we have credentials, log in once to refresh it and retry — so an expired
 * cookie self-heals instead of needing a manual re-paste.
 */
async function getJson<T>(endpoint: string, timeoutMs?: number): Promise<T> {
  let cookie = getCookie();
  if (!cookie && hasCredentials()) cookie = await refreshCookie();

  let res = await fetchRaw(endpoint, cookie, timeoutMs);
  if ((res.status === 401 || res.status === 403) && hasCredentials()) {
    cookie = await refreshCookie();
    res = await fetchRaw(endpoint, cookie, timeoutMs);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GET ${endpoint} -> HTTP ${res.status}. ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export const fetchData = () => getJson<DataSnapshot>("data");
export const fetchGreekTimeseries = () => getJson<GreekTimeseries>("greek_timeseries");
export const fetchIvTracker = () => getJson<Record<string, unknown>>("iv_tracker");
/** GET /api/vol_skew_multi — per-strike IV smile across expirations. */
export const fetchVolSkewMulti = () => getJson<VolSkewResponse>("vol_skew_multi");
/** GET /api/oi_change — day-over-day OI change by strike (where positioning is building). */
export const fetchOiChange = () => getJson<OiChangeResponse>("oi_change");
/** GET /api/candles[?days=N] — 15-min OHLCV + delta per bar, plus levels/emas/vwap_z/delta_profile. */
export const fetchCandles = (days?: number) =>
  getJson<AltarisCandlesResponse>(days ? `candles?days=${days}` : "candles");
/** GET /api/entropy — flow entropy: disorder of the options positioning path vs a stability threshold. */
export const fetchEntropy = () => getJson<{ current_entropy: number; threshold: number; status: string; path: number[][]; current: number[] }>("entropy");
/** GET /api/hurst — Hurst exponent: persistent/trending (>0.5) vs mean-reverting (<0.5) character. */
export const fetchHurst = () => getJson<{ hurst: number; label: string; rolling: Record<string, { dates: string[]; values: number[] }>; surface: unknown }>("hurst");
/** GET /api/garch — GARCH(1,1) conditional vol: persistence (α+β), half-life, z_score, regime label. */
export const fetchGarch = () => getJson<GarchSummary & { spot: number; lr_annual_pct: number; omega: number; thresholds: unknown; regime_days: unknown; total_days: number; garch_series: number[] }>("garch");

/** Distil the raw entropy response into the compact summary the scorer needs. */
export function compactEntropy(raw: { current_entropy: number; threshold: number; status: string }): EntropySummary {
  return { current_entropy: raw.current_entropy, threshold: raw.threshold, status: raw.status };
}

/** Distil the raw Hurst response into the compact summary the scorer needs. */
export function compactHurst(raw: { hurst: number; label: string; rolling: Record<string, { dates: string[]; values: number[] }> }): HurstSummary {
  const last = (w: string) => {
    const r = raw.rolling[w];
    return r?.values?.[r.values.length - 1] ?? null;
  };
  return { hurst: raw.hurst, label: raw.label, rolling_50: last("50"), rolling_100: last("100") };
}

/** Distil the raw GARCH response into the compact summary (+ sigma-band price levels + vol forecast). */
export function compactGarch(raw: GarchSummary & { ranges?: Record<string, { vol_pct: number; low_1s: number; high_1s: number; low_2s: number; high_2s: number }>; forecast_10d?: { day: number; vol_pct: number }[] }): GarchSummary {
  // GARCH-implied ±1σ/±2σ PRICE bands for today ("0") and tomorrow ("1") — statistical-exhaustion
  // levels the scorer crosses with walls (wall at band edge = mechanics + statistics aligned).
  const ranges: GarchSummary["ranges"] = {};
  for (const k of ["0", "1"]) {
    const r = raw.ranges?.[k];
    if (r && [r.low_1s, r.high_1s, r.low_2s, r.high_2s].every((x) => typeof x === "number" && Number.isFinite(x))) {
      ranges[k] = { vol_pct: r.vol_pct, low_1s: r.low_1s, high_1s: r.high_1s, low_2s: r.low_2s, high_2s: r.high_2s };
    }
  }
  const f = raw.forecast_10d;
  const d1 = f?.[0]?.vol_pct, d10 = f?.[f.length - 1]?.vol_pct;
  const forecast: GarchSummary["forecast"] = (typeof d1 === "number" && typeof d10 === "number")
    ? { d1_vol_pct: d1, d10_vol_pct: d10, dir: d10 < d1 - 0.5 ? "cooling" : d10 > d1 + 0.5 ? "heating" : "steady" }
    : undefined;
  return {
    daily_vol_pct: raw.daily_vol_pct, annual_vol_pct: raw.annual_vol_pct, alpha: raw.alpha, beta: raw.beta,
    persistence: raw.persistence, half_life: raw.half_life, z_score: raw.z_score, current_regime: raw.current_regime,
    ranges: Object.keys(ranges).length ? ranges : undefined,
    forecast,
  };
}

/** GET /api/ladder — per-strike greek ladder by DTE; includes net_gex_flip + dollar premium per strike. */
export const fetchLadder = () => getJson<Record<string, unknown>>("ladder");
/** GET /api/hedge_pressure — composite dealer hedge flow: which greek drives hedging, directional score, momentum. */
export const fetchHedgePressure = () => getJson<HedgePressureSummary & { timeseries: unknown[]; color: string; gamma_raw: number; vanna_raw: number; charm_raw: number; rv: number; per_interval: number }>("hedge_pressure");

/** Extract net_gex_flip and dollar premium per strike from the raw /api/ladder response. */
export function compactLadder(raw: Record<string, unknown>): { net_gex_flip: number | null; premium_bar: StrikeMap<number> } {
  const levels = raw.levels as Record<string, number | null> | undefined;
  const net_gex_flip = (typeof levels?.net_gex_flip === "number" && Number.isFinite(levels.net_gex_flip))
    ? levels.net_gex_flip : null;
  const rawPremium = raw.premium as Record<string, { calls: number; puts: number; net: number }> | undefined;
  const premium_bar: StrikeMap<number> = {};
  for (const [k, v] of Object.entries(rawPremium ?? {})) {
    if (Number.isFinite(v?.net)) premium_bar[k] = v.net;
  }
  return { net_gex_flip, premium_bar };
}

/** Distil the raw hedge_pressure response into the compact summary the scorer needs (no timeseries). */
export function compactHedgePressure(raw: { score: number; label: string; sensitivity: string; gamma_pct: number; vanna_pct: number; charm_pct: number; momentum: number; acceleration: number }): HedgePressureSummary {
  return {
    score: raw.score,
    label: raw.label,
    sensitivity: raw.sensitivity,
    gamma_pct: raw.gamma_pct,
    vanna_pct: raw.vanna_pct,
    charm_pct: raw.charm_pct,
    momentum: raw.momentum,
    acceleration: raw.acceleration,
  };
}

// ── Untapped-terminal endpoints (level engine, pinning, liquidity, sweeps, hiro, rich/cheap, regime) ──

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const r2 = (n: number) => Math.round(n * 100) / 100;

/** GET /api/level_assessment — the terminal's own per-strike level grading engine. */
export const fetchLevelAssessment = () => getJson<Record<string, unknown>>("level_assessment");
/** GET /api/opex_gravity — front-expiry max-pain pinning: pin_score + per-strike OI pull. */
export const fetchOpexGravity = () => getJson<Record<string, unknown>>("opex_gravity");
/** GET /api/oi_analytics — chain-wide OI shape: OI P/C, concentration, center of gravity, heavy zones. */
export const fetchOiAnalytics = () => getJson<Record<string, unknown>>("oi_analytics");
/** GET /api/liquidity_map — front-expiry per-strike OI/volume/spreads. */
export const fetchLiquidityMap = () => getJson<Record<string, unknown>>("liquidity_map");
/** GET /api/unusual_activity — sweep/block alerts (vol/OI multiples, premium). Slow-ish (~10s). */
export const fetchUnusualActivity = () => getJson<Record<string, unknown>>("unusual_activity");
/** GET /api/hiro — live dealer-hedging impact tape (5-min series + current direction). */
export const fetchHiro = () => getJson<Record<string, unknown>>("hiro");
/** GET /api/heston_surface — rich/cheap vs calibrated Heston. Server calibrates on demand (~20s+),
 *  so it gets its own generous timeout instead of the global one; failures stay non-fatal. */
export const fetchHestonSurface = () => getJson<Record<string, unknown>>("heston_surface", 45000);
/** GET /api/regime_v2 — multi-model regime consensus (TVTP-MS, MS-GARCH, HDP-HMM, BOCPD…). */
export const fetchRegimeV2 = () => getJson<Record<string, unknown>>("regime_v2");
/** GET /api/vol_stats — vol dashboard: HV ladder, IV rank, VRP, VIX term structure. */
export const fetchVolStats = () => getJson<Record<string, unknown>>("vol_stats");

/**
 * Compact /api/level_assessment: keep every graded strike within the near-spot band, plus
 * A/B-grade strikes out to 2× the band (strong distant magnets still matter as targets).
 */
export function compactLevelAssessment(raw: Record<string, unknown>, spot: number): LevelAssessmentSummary {
  const band = config.nearSpotBandPct * spot;
  const rows = Array.isArray(raw.levels) ? (raw.levels as Record<string, unknown>[]) : [];
  const levels = rows
    .filter((l) => {
      const d = Math.abs(num(l.strike) - spot);
      return d <= band || (d <= 2 * band && /^[AB]/.test(str(l.grade)));
    })
    .map((l) => ({
      strike: num(l.strike),
      zone: str(l.zone),
      grade: str(l.grade),
      archetype: str(l.reaction_name),
      level_type: str(l.level_type),
      hedge_score: r2(num(l.hedge_score)),
      rank_pct: r2(num(l.rank_pct)),
      oi: Math.round(num(l.oi)),
      hedge_desc: str(l.hedge_desc),
      drivers_desc: str(l.drivers_desc),
    }))
    .sort((a, b) => a.strike - b.strike);
  const dom = raw.dominant as Record<string, unknown> | undefined;
  return {
    gamma_flip: typeof raw.gamma_flip === "number" ? raw.gamma_flip : null,
    zone_label: str(raw.zone_label),
    dominant: dom ? { strike: num(dom.strike), zone: str(dom.zone), grade: str(dom.grade), archetype: str(dom.name) } : null,
    levels,
  };
}

/** Compact /api/opex_gravity: summary + the near-spot gravity strikes (strongest pull first). */
export function compactOpexGravity(raw: Record<string, unknown>, spot: number): OpexGravitySummary {
  const band = 2 * config.nearSpotBandPct * spot; // gravity reaches further than the entry band
  const rows = Array.isArray(raw.gravity_strikes) ? (raw.gravity_strikes as Record<string, unknown>[]) : [];
  const gravity_strikes = rows
    .filter((g) => Math.abs(num(g.strike) - spot) <= band)
    .sort((a, b) => num(b.pull_strength) - num(a.pull_strength))
    .slice(0, 8)
    .map((g) => ({
      strike: num(g.strike),
      call_oi: Math.round(num(g.call_oi)),
      put_oi: Math.round(num(g.put_oi)),
      pull_strength: Math.round(num(g.pull_strength)),
    }));
  return {
    expiry_label: str(raw.expiry_label),
    dte: num(raw.dte),
    hours_to_expiry: r2(num(raw.hours_to_expiry)),
    max_pain: num(raw.max_pain),
    pin_score: r2(num(raw.pin_score)),
    total_oi: Math.round(num(raw.total_oi)),
    gravity_strikes,
  };
}

/** Compact /api/oi_analytics to its scalar shape (per-strike OI already lives in oi_bar). */
export function compactOiAnalytics(raw: Record<string, unknown>): OiAnalyticsSummary {
  const zone = (v: unknown) => (Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === "number") ? (v as number[]) : null);
  return {
    pc_ratio_oi: r2(num(raw.pc_ratio)),
    concentration_top5_pct: r2(num(raw.concentration_top5_pct)),
    oi_center_of_gravity: r2(num(raw.oi_center_of_gravity)),
    max_pain_all: num(raw.max_pain),
    put_heavy_zone: zone(raw.put_heavy_zone),
    call_heavy_zone: zone(raw.call_heavy_zone),
  };
}

/** Compact /api/liquidity_map: the near-spot strikes with the deepest front-expiry OI. */
export function compactLiquidityMap(raw: Record<string, unknown>, spot: number): LiquiditySummary {
  const band = config.nearSpotBandPct * spot;
  const rows = Array.isArray(raw.strikes) ? (raw.strikes as Record<string, unknown>[]) : [];
  const top = rows
    .filter((s) => Math.abs(num(s.strike) - spot) <= band)
    .sort((a, b) => num(b.total_oi) - num(a.total_oi))
    .slice(0, 10)
    .map((s) => ({
      strike: num(s.strike),
      call_oi: Math.round(num(s.call_oi)),
      put_oi: Math.round(num(s.put_oi)),
      call_vol: Math.round(num(s.call_vol)),
      put_vol: Math.round(num(s.put_vol)),
    }));
  return { expiry_label: str(raw.expiry_label), dte: num(raw.dte), top };
}

/** Compact /api/unusual_activity: near-term, biggest-premium sweeps (institutional initiative flow). */
export function compactUnusualActivity(raw: Record<string, unknown>, spot: number): UnusualAlert[] {
  const rows = Array.isArray(raw.alerts) ? (raw.alerts as Record<string, unknown>[]) : [];
  return rows
    .filter((a) => num(a.dte) <= 7 && Math.abs(num(a.strike) - spot) <= 0.08 * spot)
    .sort((a, b) => num(b.premium) - num(a.premium))
    .slice(0, 10)
    .map((a) => ({
      strike: num(a.strike),
      dte: num(a.dte),
      option_type: str(a.option_type),
      volume: Math.round(num(a.volume)),
      oi: Math.round(num(a.oi)),
      vol_oi_ratio: r2(num(a.vol_oi_ratio)),
      premium_m: r2(num(a.premium) / 1e6),
      signal: str(a.signal),
    }));
}

/** Compact /api/hiro: current direction/magnitude + the last ~30 min net impulse from the 5-min series. */
export function compactHiro(raw: Record<string, unknown>): HiroSummary {
  const series = Array.isArray(raw.series) ? (raw.series as Record<string, unknown>[]) : [];
  const recent = series.slice(-6).map((p) => num(p.hiro));
  return {
    direction: str(raw.direction),
    current_hiro_m: r2(num(raw.current_hiro_m)),
    total_gex_m: r2(num(raw.total_gex_m)),
    call_gex_m: r2(num(raw.call_gex_m)),
    put_gex_m: r2(num(raw.put_gex_m)),
    last_30m_hiro: recent.length ? r2(recent.reduce((a, b) => a + b, 0)) : null,
  };
}

/** Compact /api/heston_surface to the imbalance summary + the extreme rich/cheap pockets. */
export function compactHestonSurface(raw: Record<string, unknown>): HestonSummary {
  const imb = (raw.imbalance ?? {}) as Record<string, unknown>;
  const pocket = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]) : [])
    .slice(0, 4)
    .map((p) => ({
      strike: Math.round(num(p.strike) * 10) / 10,
      dte: Math.round(num(p.expiry) * 365), // expiry arrives in years
      z: r2(num(p.z_score)),
    }));
  return {
    rmse: r2(num(raw.rmse) * 1000) / 1000,
    feller: raw.feller === true,
    pct_rich: r2(num(imb.pct_rich)),
    pct_cheap: r2(num(imb.pct_cheap)),
    mean_spread: Math.round(num(imb.mean_spread) * 1000) / 1000,
    richest: pocket(imb.richest),
    cheapest: pocket(imb.cheapest),
  };
}

/** Compact /api/regime_v2: consensus + transition odds + each model's vote. */
export function compactRegimeV2(raw: Record<string, unknown>): RegimeV2Summary {
  const votes = (Array.isArray(raw.model_votes) ? (raw.model_votes as Record<string, unknown>[]) : [])
    .map((v) => ({ model: str(v.model), vote: str(v.vote), confidence: r2(num(v.confidence)) }));
  return {
    consensus: str(raw.consensus_regime),
    interpretation: str(raw.interpretation),
    agreement: `${Math.round(num(raw.agreement_count))}/${Math.round(num(raw.total_models))} models agree`,
    p_change: r2(num(raw.p_change)),
    expected_dwell: r2(num(raw.expected_dwell)),
    expected_move_pct: r2(num(raw.expected_move)),
    rv30: r2(num(raw.rv30)),
    atm_iv: r2(num(raw.atm_iv)),
    votes,
  };
}

/** GET /api/macro — the terminal's Macro tab: FRED panels, hawk/dove regime, event calendar,
 *  event-risk score, VIX fair-value model, net liquidity, sector rotation. One fast endpoint. */
export const fetchMacroPanel = () => getJson<Record<string, unknown>>("macro");
/** GET /api/anomalies — z-scored 5-min return anomalies (capitulation/exhaustion prints). */
export const fetchAnomalies = () => getJson<Record<string, unknown>>("anomalies");
/** GET /api/put_call_skew — risk-reversal term structure across expirations. */
export const fetchPutCallSkew = () => getJson<Record<string, unknown>>("put_call_skew");
/** GET /api/skew_index — SKEW-index-style tail-risk measure on the QQQ chain. */
export const fetchSkewIndex = () => getJson<Record<string, unknown>>("skew_index");
/** GET /api/vol_regime_score — MR/BO/NT vol-regime scores with driver reasoning. */
export const fetchVolRegimeScore = () => getJson<Record<string, unknown>>("vol_regime_score");
/** GET /api/regime_intraday — 5-min intraday regime engine + execution hint. SLOW (~35s server
 *  compute) — own generous timeout, local capture only, always non-fatal. */
export const fetchRegimeIntraday = () => getJson<Record<string, unknown>>("regime_intraday", 50000);
/** GET /api/oi365 — OI by expiration (where positioning lives in time). */
export const fetchOi365 = () => getJson<Record<string, unknown>>("oi365");

/** Compact /api/anomalies: today's up/down anomaly counts + the most recent print. */
export function compactAnomalies(raw: Record<string, unknown>, etDate: string): import("./types.js").AnomalySummary {
  type P = { time?: string; val?: number };
  const ups = (Array.isArray(raw.anomalies_up) ? (raw.anomalies_up as P[]) : []);
  const downs = (Array.isArray(raw.anomalies_down) ? (raw.anomalies_down as P[]) : []);
  const isToday = (p: P) => (p.time ?? "").startsWith(etDate);
  const all = [...ups.map((p) => ({ ...p, dir: "up" as const })), ...downs.map((p) => ({ ...p, dir: "down" as const }))]
    .filter((p) => p.time)
    .sort((a, b) => (a.time! < b.time! ? -1 : 1));
  const last = all[all.length - 1];
  return {
    threshold: num(raw.threshold),
    today_up: ups.filter(isToday).length,
    today_down: downs.filter(isToday).length,
    last: last ? { time: last.time!, dir: last.dir, ret_pct: r2(num(last.val) * 100) } : null,
  };
}

/** Compact /api/put_call_skew: front RR + bias + the RR term structure (front 4 expirations). */
export function compactPutCallSkew(raw: Record<string, unknown>): import("./types.js").PcSkewSummary {
  const term = (Array.isArray(raw.term_structure) ? (raw.term_structure as Record<string, unknown>[]) : [])
    .slice(0, 4)
    .map((t) => ({ dte: num(t.dte), rr: r2(num(t.rr)) }));
  return { current_rr: r2(num(raw.current_rr)), bias: str(raw.bias), term };
}

/** Compact /api/skew_index to the headline tail-risk read. */
export function compactSkewIndex(raw: Record<string, unknown>): import("./types.js").SkewIndexSummary {
  const exps = Array.isArray(raw.expirations) ? (raw.expirations as Record<string, unknown>[]) : [];
  const front = exps.length ? exps.reduce((a, b) => (num(b.dte) < num(a.dte) ? b : a)) : undefined;
  return {
    current_skew: r2(num(raw.current_skew)),
    risk_level: str(raw.risk_level),
    front_put_skew_ratio: front ? r2(num(front.put_skew_ratio)) : null,
  };
}

/** Compact /api/vol_regime_score: the MR/BO/NT vote + reasoning + how calibrated the engine is. */
export function compactVolRegimeScore(raw: Record<string, unknown>): import("./types.js").VolRegimeScoreSummary {
  const hist = raw.history_status as Record<string, unknown> | undefined;
  return {
    label: str(raw.label),
    mr_score: r2(num(raw.mr_score)),
    bo_score: r2(num(raw.bo_score)),
    nt_score: r2(num(raw.nt_score)),
    confidence: r2(num(raw.confidence)),
    reasoning: str(raw.reasoning),
    history_pct_complete: r2(num(hist?.pct_complete)),
  };
}

/** Compact /api/regime_intraday: the regime read + the engine's execution hint. */
export function compactRegimeIntraday(raw: Record<string, unknown>): import("./types.js").RegimeIntradaySummary {
  const reg = (raw.regime ?? {}) as Record<string, unknown>;
  const hint = raw.execution_hint as Record<string, unknown> | undefined;
  return {
    structural_state: str(reg.structural_state),
    structural_confidence: r2(num(reg.structural_confidence)),
    behavioral_regime: str(reg.behavioral_regime),
    mean_reversion_score: r2(num(reg.mean_reversion_score)),
    breakout_score: r2(num(reg.breakout_score)),
    signal_clarity: r2(num(reg.signal_clarity)),
    model_certainty: r2(num(reg.model_certainty)),
    reasoning: str(reg.reasoning),
    execution_hint: hint ? { action: str(hint.action), size_scalar: r2(num(hint.size_scalar)) } : null,
  };
}

/** Compact /api/oi365 to the per-expiration OI ladder (front 6; per-strike detail dropped). */
export function compactOi365(raw: Record<string, unknown>): import("./types.js").Oi365Summary {
  const exps = (Array.isArray(raw.expirations) ? (raw.expirations as Record<string, unknown>[]) : [])
    .slice(0, 6)
    .map((e) => ({ label: str(e.label), dte: num(e.dte), total_oi: Math.round(num(e.total_oi)), pc: r2(num(e.pc)) }));
  return { expirations: exps };
}

/** Compact /api/macro to what complements our direct FRED/Treasury/CFTC feeds (see type docs). */
export function compactAltarisMacro(raw: Record<string, unknown>): import("./types.js").AltarisMacroSummary {
  const panels = (raw.panels ?? {}) as Record<string, unknown>;
  const panel = (name: string) => (Array.isArray(panels[name]) ? (panels[name] as Record<string, unknown>[]) : []);
  const val = (name: string, id: string): number | null => {
    const row = panel(name).find((r) => r.id === id);
    return row && typeof row.value === "number" ? row.value : null;
  };
  const yoy = (id: string): number | null => {
    const row = panel("regime").find((r) => r.id === id);
    return row && typeof row.yoy === "number" ? row.yoy : (row && typeof row.value === "number" ? row.value : null);
  };

  const reg = raw.regime as Record<string, unknown> | undefined;
  const er = raw.event_risk as Record<string, unknown> | undefined;
  const vi = raw.vix_intel as Record<string, unknown> | undefined;

  const inflation: Record<string, number> = {};
  for (const [key, id] of [["cpi_yoy", "CPIAUCSL"], ["core_cpi_yoy", "CPILFESL"], ["core_pce_yoy", "PCEPILFE"]] as const) {
    const v = yoy(id);
    if (v != null) inflation[key] = r2(v);
  }
  for (const [key, id] of [["nfp_k", "PAYEMS"], ["unemployment", "UNRATE"]] as const) {
    const row = panel("regime").find((r) => r.id === id);
    if (row && typeof row.chg_1d === "number" && key === "nfp_k") inflation[key] = r2(row.chg_1d);
    else if (row && typeof row.value === "number" && key === "unemployment") inflation[key] = r2(row.value);
  }

  const sectors = Array.isArray(raw.sectors) ? (raw.sectors as Record<string, unknown>[]) : [];
  const bySector = [...sectors].sort((a, b) => num(b.score) - num(a.score));

  return {
    regime: reg ? { score: num(reg.score), label: str(reg.label), factors: (reg.factors ?? {}) as Record<string, string> } : null,
    events: (Array.isArray(raw.events) ? (raw.events as Record<string, unknown>[]) : [])
      .filter((e) => str(e.date) !== "") // the feed pads with dateless stubs (e.g. PPI "")
      .map((e) => ({ name: str(e.name), date: str(e.date), days: num(e.days) })),
    event_risk: er ? {
      score: r2(num(er.score)),
      label: str(er.label),
      in_window: (Array.isArray(er.events_in_window) ? (er.events_in_window as Record<string, unknown>[]) : []).map((e) => `${str(e.name)} ${num(e.days)}d`),
    } : null,
    vix_intel: vi ? {
      vix: r2(num(vi.vix)), percentile: r2(num(vi.vix_pct)), regime: str(vi.regime),
      fair_value: r2(num(vi.fair_value)), mispricing: r2(num(vi.mispricing)), signal: str(vi.vol_trade),
    } : null,
    net_liquidity: typeof raw.net_liquidity === "number" ? raw.net_liquidity : null,
    real_yields: { tips_10y: val("real_yields", "DFII10"), breakeven_10y: val("real_yields", "T10YIE") },
    fin_cond: {
      nfci: val("fin_cond", "NFCI"),
      // Stress index id varies (STLFSI revision suffix) — match by label instead.
      stress: (() => { const row = panel("fin_cond").find((r) => /stress/i.test(str(r.label))); return row && typeof row.value === "number" ? row.value : null; })(),
      hy_spread: val("fin_cond", "BAMLH0A0HYM2"),
      dxy_twi: val("fin_cond", "DTWEXBGS"),
    },
    inflation,
    // Rotation is only meaningful when the scores differentiate (they zero out off-hours).
    sectors: bySector.some((s) => num(s.score) !== 0) ? {
      leading: bySector.slice(0, 3).map((s) => `${str(s.sym)} ${num(s.score) >= 0 ? "+" : ""}${r2(num(s.score))}`),
      lagging: bySector.slice(-3).reverse().map((s) => `${str(s.sym)} ${r2(num(s.score))}`),
    } : { leading: [], lagging: [] },
  };
}

/** Compact /api/vol_stats to its scalars (charts dropped). */
export function compactVolStats(raw: Record<string, unknown>): VolStatsSummary {
  return {
    hv10: r2(num(raw.hv10)),
    hv20: r2(num(raw.hv20)),
    hv30: r2(num(raw.hv30)),
    atm_iv: r2(num(raw.atm_iv)),
    ivr: r2(num(raw.ivr)),
    vol_premium: r2(num(raw.vol_premium)),
    regime: str(raw.regime),
    vix9d: r2(num(raw.vix9d)),
    vix: r2(num(raw.vix)),
    vix3m: r2(num(raw.vix3m)),
    ts_shape: str(raw.ts_shape),
  };
}
