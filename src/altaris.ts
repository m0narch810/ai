import { config } from "./config.js";
import type { DataSnapshot, GreekTimeseries } from "./types.js";

const BROWSER_HEADERS = {
  accept: "*/*",
  referer: "https://altaris.up.railway.app/",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
};

async function getJson<T>(endpoint: string): Promise<T> {
  const url = `${config.baseUrl}/${endpoint}`;
  const res = await fetch(url, {
    headers: { ...BROWSER_HEADERS, cookie: config.cookie },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GET ${endpoint} -> HTTP ${res.status}. ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export const fetchData = () => getJson<DataSnapshot>("data");
export const fetchGreekTimeseries = () => getJson<GreekTimeseries>("greek_timeseries");
export const fetchIvTracker = () => getJson<Record<string, unknown>>("iv_tracker");
