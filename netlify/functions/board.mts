// Cloud deterministic board: serves freshly *calculated* levels when the scoring PC is off.
//
// When the box is down, web/dashboard.json is frozen at the last deploy — the levels stop moving.
// The AI scorer can't run in the cloud (it shells out to Claude Code on the Max plan), but the
// RULE-BASED scorer is pure math. This function reuses the EXACT same `scoreBoardDeterministic`,
// `detectMany`, and `buildDashboard` the local loop uses (esbuild bundles the TS from src/), so
// there's zero logic drift: the only difference from a live board is scoring_method:"rule".
//
// Input is the latest snapshot that capture.mjs stored in Blobs + live Altaris candles (for the
// Yahoo-equivalent reversal grading we instead use Altaris's own 15-min candle feed, same as the
// US path of market.ts). Result is cached 5 min in Blobs so viewer polls don't hammer Altaris.
//
// The frontend hits this only when the published board is stale during RTH (box offline); the
// levels then keep updating, flagged rule-based (lower confidence) instead of frozen. Env:
// ALTARIS_USER / ALTARIS_PASS (same as capture.mjs) — fetchCandles auto-logs-in via src/auth.ts.
import { connectLambda, getStore } from "@netlify/blobs";
import { detectMany } from "../../src/detect.js";
import { scoreBoardDeterministic } from "../../src/score.js";
import { buildDashboard } from "../../src/dashboard.js";
import { fetchCandles } from "../../src/altaris.js";
import { config, RTH_MIN, type SessionDef } from "../../src/config.js";
import type { AltarisCandlesResponse, Bar, CaptureRecord, DataSnapshot } from "../../src/types.js";

const CACHE_MS = 5 * 60_000;
const US_SESSION: SessionDef = { name: "US", source: "QQQ", startMin: RTH_MIN.start, endMin: RTH_MIN.end };

/** ET date (YYYY-MM-DD), matching the keys capture.mjs writes. */
function etDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

/** RTH-windowed bars from the Altaris candle feed (mirrors the US branch of market.ts). */
function rthBars(resp: AltarisCandlesResponse, date: string): Bar[] {
  return resp.candles
    .filter((c) => {
      if (!c.t.startsWith(date)) return false;
      const m = /T(\d{2}):(\d{2})/.exec(c.t);
      if (!m) return false;
      const min = Number(m[1]) * 60 + Number(m[2]);
      return min >= RTH_MIN.start && min <= RTH_MIN.end;
    })
    .map((c) => ({ ts: c.t, open: c.o, high: c.h, low: c.l, close: c.c, volume: c.v, delta: c.d }));
}

const GEX_THRESHOLD = 50e6; // mirrors run.ts GEX_WALL_THRESHOLD

/** Named walls + near-spot high-GEX strikes — the universe the detector grades (mirrors run.ts). */
function candidateStrikes(data: DataSnapshot, spot: number): number[] {
  const explicit = [
    data.call_wall, data.put_wall, data.major_wall, data.max_pain, data.zero_gamma, data.vol_trigger,
    data.call_wall_0dte, data.put_wall_0dte, data.major_wall_0dte, ...data.call_walls, ...data.put_walls,
  ].filter((n) => Number.isFinite(n) && n > 0);
  const band = config.nearSpotBandPct * spot;
  const nearGex = Object.entries(data.gex_bar ?? {})
    .filter(([, gex]) => Math.abs(gex) >= GEX_THRESHOLD)
    .map(([s]) => Number(s))
    .filter((k) => Math.abs(k - spot) <= band);
  return [...new Set([...explicit, ...nearGex])];
}

const json = (body: unknown, code = 200) => ({
  statusCode: code,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
  body: JSON.stringify(body),
});

export const handler = async (event: unknown) => {
  try {
    connectLambda(event as never); // wire Blobs context (classic Lambda-signature function)
    const cache = getStore("board");

    // Serve the cached board if it's fresh enough — the snapshot only changes every 15 min anyway.
    const cached = (await cache.get("latest", { type: "json" }).catch(() => null)) as
      | { ts: number; data: unknown } | null;
    if (cached && Date.now() - cached.ts < CACHE_MS) return json(cached.data);

    // Latest cloud-captured snapshot — today first, then yesterday (covers early-Asia after midnight ET).
    const captures = getStore("captures");
    let { blobs } = await captures.list({ prefix: `${etDate()}/` });
    if (!blobs.length) {
      const res = await captures.list({ prefix: `${etDate(-1)}/` });
      blobs = res.blobs;
    }
    if (!blobs.length) return json({ error: "no capture found (today or yesterday)" }, 503);
    const latestKey = blobs.map((b) => b.key).sort().at(-1)!;
    const cap = (await captures.get(latestKey, { type: "json" })) as
      | (Pick<CaptureRecord, "capturedAt" | "data" | "iv">) | null;
    if (!cap) return json({ error: "capture unreadable" }, 503);

    // Fetch 2 days so the yesterday-fallback path also has candles to grade against.
    const candles = await fetchCandles(2);
    // Use the capture's own date (not today's) — if yesterday's capture is loaded, grade
    // yesterday's wicks against yesterday's levels, not an empty set of today's bars.
    const capDate = cap.capturedAt.slice(0, 10);
    const bars = rthBars(candles, capDate);
    const spot = bars.at(-1)?.close ?? cap.data.spot; // freshest price we have
    const detected = detectMany(bars, candidateStrikes(cap.data, spot));

    const history: CaptureRecord[] = [{ capturedAt: cap.capturedAt, data: cap.data, iv: cap.iv }];
    const board = await scoreBoardDeterministic(history, null, detected, US_SESSION, spot);
    const dash = { ...buildDashboard(board, detected, "US"), cloud: true }; // rule-based, box-offline

    await cache.setJSON("latest", { ts: Date.now(), data: dash });
    return json(dash);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("board.mts error:", msg);
    return json({ error: msg }, 500);
  }
};
