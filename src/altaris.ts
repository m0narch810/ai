import { config } from "./config.js";
import { getCookie, hasCredentials, refreshCookie } from "./auth.js";
import type { AltarisCandlesResponse, DataSnapshot, GreekTimeseries, OiChangeResponse, VolSkewResponse } from "./types.js";

const BROWSER_HEADERS = {
  accept: "*/*",
  referer: "https://altaris.up.railway.app/",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
};

const fetchRaw = (endpoint: string, cookie: string) =>
  fetch(`${config.baseUrl}/${endpoint}`, { headers: { ...BROWSER_HEADERS, cookie } });

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
