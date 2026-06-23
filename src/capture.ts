import fs from "node:fs/promises";
import path from "node:path";
import { config, nowInSessionTz } from "./config.js";
import { fetchData, fetchGreekTimeseries, fetchIvTracker, fetchOiChange, fetchVolSkewMulti } from "./altaris.js";
import type { CaptureRecord, DataSnapshot, GreekTimeseries, IvSummary, OiChangeResponse, StrikeMap, StrikePair, VolSkewResponse } from "./types.js";

interface Heatmap { expirations?: { label: string; dte: number }[]; rows?: { strike: number; cells: number[] }[] }

/** Collapse a strike×expiration heatmap to per-strike totals (sum across expirations). */
function aggregateHm(hm: Heatmap | undefined): StrikeMap<number> {
  const out: StrikeMap<number> = {};
  for (const r of hm?.rows ?? []) out[r.strike.toFixed(1)] = r.cells.reduce((a, b) => a + (b ?? 0), 0);
  return out;
}

/**
 * Isolate the 0DTE (same-day-expiry) column of a strike×expiration heatmap — `cells` align to the
 * `expirations` array, so we take the cell at dte===0 (or the nearest expiry if there's no 0DTE
 * today, e.g. a weekend). This is the slice that dominates pinning/charm into the cash close.
 */
function zeroDteSlice(hm: Heatmap | undefined): StrikeMap<number> {
  const exps = hm?.expirations;
  if (!exps?.length || !hm?.rows) return {};
  let idx = exps.findIndex((e) => e.dte === 0);
  if (idx < 0) { // no 0DTE today → nearest expiry
    let min = Infinity;
    exps.forEach((e, i) => { if (e.dte < min) { min = e.dte; idx = i; } });
  }
  const out: StrikeMap<number> = {};
  for (const r of hm.rows) out[r.strike.toFixed(1)] = r.cells?.[idx] ?? 0;
  return out;
}

/**
 * Keep only the fields we use; the *_hm heatmaps are huge — but charm (cex_hm) and
 * theta (tex_hm) have no per-strike *_bar, so we aggregate them to per-strike totals.
 */
export function compactSnapshot(raw: DataSnapshot & Record<string, unknown>): DataSnapshot {
  return {
    ticker: raw.ticker, spot: raw.spot, timestamp: raw.timestamp,
    call_wall: raw.call_wall, put_wall: raw.put_wall, major_wall: raw.major_wall,
    max_pain: raw.max_pain, zero_gamma: raw.zero_gamma,
    vol_trigger: raw.vol_trigger, total_vol_trigger: raw.total_vol_trigger,
    call_wall_0dte: raw.call_wall_0dte, put_wall_0dte: raw.put_wall_0dte, major_wall_0dte: raw.major_wall_0dte,
    call_walls: raw.call_walls, put_walls: raw.put_walls,
    oi_bar: raw.oi_bar, vol_bar: raw.vol_bar,
    gex_bar: raw.gex_bar, dex_bar: raw.dex_bar, vex_bar: raw.vex_bar, rex_bar: raw.rex_bar,
    charm_bar: aggregateHm(raw.cex_hm as Heatmap), tex_bar: aggregateHm(raw.tex_hm as Heatmap),
    vanna_bar: aggregateHm(raw.vannex_hm as Heatmap),
    // 0DTE-isolated gamma/charm/vanna (the slice that dominates pinning into the close).
    gex_0dte_bar: zeroDteSlice(raw.gex_hm as Heatmap),
    charm_0dte_bar: zeroDteSlice(raw.cex_hm as Heatmap),
    vanna_0dte_bar: zeroDteSlice(raw.vannex_hm as Heatmap),
    atm_iv: raw.atm_iv, expected_move: raw.expected_move, atm_iv_avg: raw.atm_iv_avg,
    gex_regime: raw.gex_regime, realized_vol: raw.realized_vol, net_vanna: raw.net_vanna,
  };
}

/** Day-over-day OI change (calls/puts) per strike from /api/oi_change — undefined if no prior day. */
export function oiChangeToBar(oc: OiChangeResponse | null | undefined): StrikeMap<StrikePair> | undefined {
  if (!oc?.has_previous || !Array.isArray(oc.nodes) || !oc.nodes.length) return undefined;
  const out: StrikeMap<StrikePair> = {};
  for (const n of oc.nodes) {
    if (Number.isFinite(n.strike)) out[n.strike.toFixed(1)] = { calls: n.delta_calls ?? 0, puts: n.delta_puts ?? 0 };
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Collapse /api/vol_skew_multi to a per-strike IV map for the NEAREST expiration (the 0DTE/front
 * skew the trader actually fades). Returns undefined if the payload is empty/unusable.
 */
export function skewToStrikeMap(skew: VolSkewResponse | null | undefined): StrikeMap<number> | undefined {
  const exps = skew?.expirations;
  if (!exps?.length) return undefined;
  const front = exps.reduce((a, b) => (b.dte < a.dte ? b : a));
  const out: StrikeMap<number> = {};
  for (const { strike, iv } of front.data ?? []) {
    if (Number.isFinite(strike) && Number.isFinite(iv)) out[strike.toFixed(1)] = iv;
  }
  return Object.keys(out).length ? out : undefined;
}

const numOr = (v: unknown, d = 0) => (typeof v === "number" ? v : d);
const strOr = (v: unknown, d = "") => (typeof v === "string" ? v : d);

export function summarizeIv(iv: Record<string, unknown>): IvSummary {
  return {
    current_iv: numOr(iv.current_iv),
    session_start_iv: numOr(iv.session_start_iv),
    iv_change: numOr(iv.iv_change),
    direction: strOr(iv.direction, "UNKNOWN"),
    vanna_note: strOr(iv.vanna_detail),
  };
}

function rawDataFile(date: string) { return path.join(config.paths.raw, `${date}.data.jsonl`); }
function rawGreekFile(date: string) { return path.join(config.paths.raw, `${date}.greek.json`); }

/**
 * Fetch /api/data + /api/greek_timeseries, persist them, and return both.
 * - data snapshot is appended (compacted) to <date>.data.jsonl
 * - greek_timeseries is cumulative-for-the-day, so it overwrites <date>.greek.json
 */
export async function captureTick(): Promise<{ record: CaptureRecord; greek: GreekTimeseries }> {
  await fs.mkdir(config.paths.raw, { recursive: true });
  const { date, iso } = nowInSessionTz();

  const [rawData, greek, ivRaw, skewRaw, oiChangeRaw] = await Promise.all([
    fetchData(),
    fetchGreekTimeseries(),
    fetchIvTracker().catch(() => null), // IV regime is enrichment; don't fail the tick on it
    fetchVolSkewMulti().catch(() => null), // per-strike IV skew is enrichment too
    fetchOiChange().catch(() => null), // day-over-day OI change is enrichment too
  ]);
  const data = compactSnapshot(rawData as DataSnapshot & Record<string, unknown>);
  data.iv_skew = skewToStrikeMap(skewRaw);
  data.oi_day_bar = oiChangeToBar(oiChangeRaw);
  const record: CaptureRecord = {
    capturedAt: iso,
    data,
    iv: ivRaw ? summarizeIv(ivRaw) : undefined,
  };

  await fs.appendFile(rawDataFile(date), JSON.stringify(record) + "\n", "utf8");
  await fs.writeFile(rawGreekFile(date), JSON.stringify(greek), "utf8");

  return { record, greek };
}

/** Load all capture records for a session date (chronological). */
export async function loadDaySnapshots(date: string): Promise<CaptureRecord[]> {
  try {
    const txt = await fs.readFile(rawDataFile(date), "utf8");
    return txt.split("\n").filter(Boolean).map((l) => JSON.parse(l) as CaptureRecord);
  } catch {
    return [];
  }
}

export async function loadDayGreek(date: string): Promise<GreekTimeseries | null> {
  try {
    return JSON.parse(await fs.readFile(rawGreekFile(date), "utf8")) as GreekTimeseries;
  } catch {
    return null;
  }
}
