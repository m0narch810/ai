// Cloud deterministic board: serves freshly *calculated* levels when the scoring PC is off.
//
// When the box is down, web/dashboard.json is frozen at the last deploy — the levels stop moving.
// The AI scorer can't run in the cloud (it shells out to Claude Code on the Max plan), but the
// RULE-BASED scorer is pure math. This function reuses the EXACT same `scoreBoardDeterministic`,
// `detectMany`, and `buildDashboard` the local loop uses (esbuild bundles the TS from src/), so
// there's zero logic drift: the only difference from a live board is scoring_method:"rule".
//
// Input is the latest snapshot that capture.mjs stored in Blobs + Yahoo QQQ bars for reversal
// grading — the exact same `fetchSessionBars` the local loop uses, so there is no source drift.
// Result is cached 5 min in Blobs so viewer polls stay cheap.
//
// The frontend hits this only when the published board is stale during RTH (box offline); the
// levels then keep updating, flagged rule-based (lower confidence) instead of frozen. Env:
// No credentials needed: bars come from Yahoo via src/market.ts (Altaris was retired 2026-09-01).
import { connectLambda, getStore } from "@netlify/blobs";
import { createHmac, timingSafeEqual } from "node:crypto";
function verifyToken(authHeader: string | undefined): boolean {
  const token = (authHeader ?? "").replace(/^Bearer\s+/, "");
  if (!token || !process.env.AUTH_SECRET) return false;
  const dot = token.lastIndexOf(".");
  if (dot < 0) return false;
  const payload = token.slice(0, dot), sig = token.slice(dot + 1);
  const expected = createHmac("sha256", process.env.AUTH_SECRET).update(payload).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  try { const { exp } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); return Number.isFinite(exp) && Date.now() < exp; }
  catch { return false; }
}
import { detectMany } from "../../src/detect.js";
import { computeDayGate } from "../../src/dayGate.js";
import { scoreBoardDeterministic } from "../../src/score.js";
import { buildDashboard } from "../../src/dashboard.js";
import { fetchSessionBars } from "../../src/market.js";
import { config, RTH_MIN, type SessionDef } from "../../src/config.js";
import { computeIvWalls, tYearsFor } from "../../src/ivWalls.js";
import type { CaptureRecord, DataSnapshot, IvWalls } from "../../src/types.js";

const CACHE_MS = 5 * 60_000;
const US_SESSION: SessionDef = { name: "US", source: "QQQ", startMin: RTH_MIN.start, endMin: RTH_MIN.end };

/** ET date (YYYY-MM-DD), matching the keys capture.mjs writes. */
function etDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
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

/**
 * The day's frozen IV walls for the cloud path. The local pipeline freezes them to
 * data/scored/<date>.ivwalls.json, which the cloud can't read — so recompute them here from the
 * *first* capture of the date (the 09:00 ET cloud snapshot), never the latest one: the walls are a
 * frozen pre-session bracket, so the answer must not depend on what time a viewer happens to load
 * the board. Cached per date in Blobs so it's one extra fetch a day. Best-effort — the board still
 * serves without walls.
 */
async function ivWallsForCloud(
  cache: ReturnType<typeof getStore>,
  captures: ReturnType<typeof getStore>,
  date: string,
  firstKey: string,
): Promise<IvWalls | null> {
  const key = `ivwalls-${date}`;
  const cached = (await cache.get(key, { type: "json" }).catch(() => null)) as IvWalls | null;
  if (cached && Number.isFinite(cached.u_inner) && Number.isFinite(cached.l_inner)) return cached;

  const first = (await captures.get(firstKey, { type: "json" }).catch(() => null)) as
    | Pick<CaptureRecord, "capturedAt" | "data"> | null;
  const skew = first?.data?.iv_skew;
  const spot = first?.data?.spot;
  if (!skew || !(typeof spot === "number" && spot > 0)) return null;

  const at = first!.capturedAt;
  const minutes = Number(at.slice(11, 13)) * 60 + Number(at.slice(14, 16));
  const walls = computeIvWalls(skew, spot, tYearsFor(first!.data.iv_skew_dte, minutes), at, first!.data.iv_skew_dte ?? 0);
  if (!walls) return null;
  await cache.setJSON(key, walls).catch(() => { /* recomputed next call */ });
  return walls;
}

const json = (body: unknown, code = 200) => ({
  statusCode: code,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
  body: JSON.stringify(body),
});

export const handler = async (event: unknown) => {
  const ev = event as Record<string, Record<string, string>>;
  if (!verifyToken(ev?.headers?.["authorization"] ?? ev?.headers?.["Authorization"])) {
    return { statusCode: 401, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }, body: JSON.stringify({ error: "Unauthorized" }) };
  }
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
    const keys = blobs.map((b) => b.key).sort();
    const latestKey = keys.at(-1)!;
    const cap = (await captures.get(latestKey, { type: "json" })) as
      | (Pick<CaptureRecord, "capturedAt" | "data" | "iv" | "entropy" | "hurst" | "garch" | "hedge_pressure">) | null;
    if (!cap) return json({ error: "capture unreadable" }, 503);

    // Use the capture's own date (not today's) — if yesterday's capture is loaded, grade
    // yesterday's wicks against yesterday's levels, not an empty set of today's bars.
    const capDate = cap.capturedAt.slice(0, 10);
    const bars = await fetchSessionBars(US_SESSION, capDate);
    const spot = bars.at(-1)?.close ?? cap.data.spot; // freshest price we have
    const detected = detectMany(bars, candidateStrikes(cap.data, spot));

    const history: CaptureRecord[] = [{
      capturedAt: cap.capturedAt, data: cap.data, iv: cap.iv,
      // Round-trip the context blocks the cloud capture now stores, so the cloud board carries
      // entropy_state etc. exactly like a local board.
      entropy: cap.entropy, hurst: cap.hurst, garch: cap.garch, hedge_pressure: cap.hedge_pressure,
    }];
    const board = await scoreBoardDeterministic(history, null, detected, US_SESSION, spot);
    try { board.day_gate = computeDayGate(history[0]!, spot); } catch { /* advisory — board still serves */ }
    // The board's frozen IV walls — without this the "V · IV WALLS" panel vanishes from the
    // dashboard the moment the published board goes stale and the frontend swaps to this board.
    const ivWalls = await ivWallsForCloud(cache, captures, capDate, keys[0]!)
      .catch(() => null);
    if (ivWalls) board.iv_walls = ivWalls;

    const dash = { ...buildDashboard(board, detected, "US"), cloud: true }; // rule-based, box-offline

    await cache.setJSON("latest", { ts: Date.now(), data: dash });
    return json(dash);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("board.mts error:", msg);
    return json({ error: msg }, 500);
  }
};
