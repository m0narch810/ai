import { config } from "./config.js";
import { getCookie, hasCredentials, refreshCookie } from "./auth.js";
import type { AltarisCandlesResponse, DataSnapshot, EntropySummary, GarchSummary, GreekTimeseries, HedgePressureSummary, HurstSummary, OiChangeResponse, StrikeMap, VolSkewResponse } from "./types.js";

const BROWSER_HEADERS = {
  accept: "*/*",
  referer: "https://altaris.up.railway.app/",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
};

const fetchRaw = (endpoint: string, cookie: string) =>
  fetch(`${config.baseUrl}/${endpoint}`, {
    headers: { ...BROWSER_HEADERS, cookie },
    // Without a timeout a connected-but-silent endpoint hangs the whole capture
    // (Promise.all waits forever) and holds the scoring lock. AbortSignal.timeout
    // makes every endpoint self-limiting and lets the .catch(()=>null) guards work.
    signal: AbortSignal.timeout(config.fetchTimeoutMs),
  });

/**
 * GET an Altaris endpoint. If the session cookie is missing or rejected (401/403)
 * and we have credentials, log in once to refresh it and retry — so an expired
 * cookie self-heals instead of needing a manual re-paste.
 */
async function getJson<T>(endpoint: string): Promise<T> {
  let cookie = getCookie();
  if (!cookie && hasCredentials()) cookie = await refreshCookie();

  let res = await fetchRaw(endpoint, cookie);
  if ((res.status === 401 || res.status === 403) && hasCredentials()) {
    cookie = await refreshCookie();
    res = await fetchRaw(endpoint, cookie);
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

/** Distil the raw GARCH response into the compact summary. */
export function compactGarch(raw: GarchSummary): GarchSummary {
  return { daily_vol_pct: raw.daily_vol_pct, annual_vol_pct: raw.annual_vol_pct, alpha: raw.alpha, beta: raw.beta, persistence: raw.persistence, half_life: raw.half_life, z_score: raw.z_score, current_regime: raw.current_regime };
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
