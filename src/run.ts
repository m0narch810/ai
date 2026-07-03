import fs, { open } from "node:fs/promises";
import path from "node:path";
import cron from "node-cron";
import { getStore } from "@netlify/blobs";
import { activeSession, config, isAiScoreTime, nowInSessionTz, RTH_MIN, type SessionDef } from "./config.js";
import { captureTick, compactSnapshot, loadDayGreek, loadDaySnapshots } from "./capture.js";
import { computeDayGate } from "./dayGate.js";
import { detectMany, gradeTradeCall } from "./detect.js";
import { fetchSessionBars, liveQqqEquivSpot, liveQqqSpot } from "./market.js";
import { buildNarrative, narrativeJsonPath, writeNarrative } from "./narrative.js";
import { deploySite, publish } from "./publish.js";
import { dayContextFromNarrative, scoreBoard, scoreBoardDeterministic } from "./score.js";
import { fetchCloudCaptures, type CloudTick } from "./cloudCaptures.js";
import type { Bar, Board, CaptureRecord, DataSnapshot, DetectedLevel, GreekTimeseries, Narrative, RegimeSummary } from "./types.js";

/** ~90 min of context at a 15-min cadence — enough to read trend without diluting deltas. */
const LOOKBACK = 6;

// Cross-process file lock: prevents two concurrent npm start instances from double-scoring
// the same tick. O_EXCL is atomic on Windows NTFS — only one process can create the file.
const LOCK_FILE = path.join(path.resolve("data", "scored"), ".scoring.lock");

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function acquireLock(): Promise<boolean> {
  // Check for an existing lock; reclaim it if it's stale (dead process or too old).
  try {
    const existing = JSON.parse(await fs.readFile(LOCK_FILE, "utf8")) as { pid: number; ts: number };
    const ageMs = Date.now() - existing.ts;
    // A lock held by a LIVE process is only stealable once it's implausibly old (a wedged
    // process, not just a slow tick) — 4 intervals, not 2, so a slow deploy can't be raced.
    const staleMs = config.scoreIntervalMin * (isPidAlive(existing.pid) ? 4 : 2) * 60_000;
    if (ageMs < staleMs && isPidAlive(existing.pid)) {
      return false; // lock is held by a live, plausibly-working process
    }
    // Stale lock (dead PID or older than 2 intervals): unlink it so the O_EXCL
    // create below can succeed. Without this, a lock left by a killed/crashed
    // process deadlocks every future tick — open("wx") keeps failing with EEXIST.
    await fs.unlink(LOCK_FILE).catch(() => {});
    console.warn(`[${new Date().toISOString()}] reclaimed stale scoring lock (pid ${existing.pid}, age ${Math.round(ageMs / 1000)}s)`);
  } catch {
    // no lock file exists yet (or it was unreadable) — proceed to create
  }
  try {
    const fh = await open(LOCK_FILE, "wx"); // O_EXCL: fails if file already exists
    await fh.writeFile(JSON.stringify({ pid: process.pid, ts: Date.now() }));
    await fh.close();
    return true;
  } catch {
    return false; // another process created it between our check and our write
  }
}

async function releaseLock() {
  await fs.unlink(LOCK_FILE).catch(() => {});
}

/** Manual --once / --fixture runs outside any session default to a US frame. */
const US_SESSION: SessionDef = { name: "US", source: "QQQ", startMin: RTH_MIN.start, endMin: RTH_MIN.end };

// Unlisted strikes with |GEX| >= this rival the named walls and must be candidates.
const GEX_WALL_THRESHOLD = 50e6;

function named(snap: DataSnapshot): number[] {
  const explicit = [
    snap.call_wall, snap.put_wall, snap.major_wall, snap.max_pain, snap.zero_gamma, snap.vol_trigger,
    snap.call_wall_0dte, snap.put_wall_0dte, snap.major_wall_0dte,
    ...snap.call_walls, ...snap.put_walls,
  ].filter((n) => Number.isFinite(n) && n > 0);

  const fromGex = Object.entries(snap.gex_bar ?? {})
    .filter(([, gex]) => Math.abs(gex) >= GEX_WALL_THRESHOLD)
    .map(([s]) => parseFloat(s))
    .filter((s) => Number.isFinite(s) && s > 0);

  return [...new Set([...explicit, ...fromGex])];
}

async function loadLatestBoard(date: string): Promise<Board | null> {
  try {
    const b = JSON.parse(await fs.readFile(path.join(config.paths.scored, "latest.json"), "utf8")) as Board;
    return b.as_of.startsWith(date) ? b : null; // ignore yesterday's board
  } catch {
    return null;
  }
}

/** The most recent scored board regardless of date — what overnight holds onto. */
async function loadLatestBoardAny(): Promise<Board | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(config.paths.scored, "latest.json"), "utf8")) as Board;
  } catch {
    return null;
  }
}

/**
 * Read the cloud Regime tab's latest output from Netlify Blobs (the SAME data the dashboard
 * shows). Fed to the AI scorer so the displayed regime governs the board. Best-effort: if
 * Blobs creds are missing or the cache is empty, returns null and scoring proceeds without it.
 */
async function loadRegime(): Promise<RegimeSummary | null> {
  const siteID = process.env.NETLIFY_SITE_ID?.trim();
  const token = process.env.NETLIFY_AUTH_TOKEN?.trim();
  if (!siteID || !token) return null;
  try {
    const r = await getStore({ name: "regime-cache", siteID, token }).get("latest", { type: "json" }) as (RegimeSummary & { scored_at?: number; state?: string }) | null;
    if (!r || !Array.isArray(r.pivots)) return null;
    // Never let a placeholder or stale blob GOVERN the board (the prompt treats this block as
    // highest-order context). Stale regime = worse than none: the scorer has an explicit
    // fall-back path (Altaris gex_regime + Hurst + GARCH) when the block is null.
    if (r.state === "INSUFFICIENT DATA") return null;
    const ageMin = (Date.now() - (r.scored_at ?? 0)) / 60_000;
    if (ageMin > 30) {
      console.warn(`regime blob stale (${Math.round(ageMin)}m old) — scoring without it`);
      return null;
    }
    return r;
  } catch (err) {
    console.warn("regime read failed (scoring continues without it):", err instanceof Error ? err.message : err);
    return null;
  }
}

/** Today's pre-open narrative, if one was generated for this date (used to tilt scoring). */
async function loadTodayNarrative(date: string): Promise<Narrative | null> {
  try {
    const n = JSON.parse(await fs.readFile(narrativeJsonPath, "utf8")) as Narrative;
    return n.as_of.startsWith(date) ? n : null;
  } catch {
    return null;
  }
}

async function persist(date: string, board: Board, detected: unknown, bars?: Bar[]) {
  await fs.mkdir(config.paths.scored, { recursive: true });
  // Atomic write: `npm run publish` (and anything else) reads latest.json concurrently —
  // a plain writeFile can be read half-written and blow up its JSON.parse.
  const latest = path.join(config.paths.scored, "latest.json");
  await fs.writeFile(latest + ".tmp", JSON.stringify(board, null, 2), "utf8");
  await fs.rename(latest + ".tmp", latest);
  await fs.appendFile(path.join(config.paths.scored, `${date}.boards.jsonl`), JSON.stringify(board) + "\n", "utf8");
  await fs.appendFile(
    path.join(config.paths.scored, `${date}.calibration.jsonl`),
    JSON.stringify({ as_of: board.as_of, detected }) + "\n",
    "utf8",
  );
  await persistCalls(date, board, bars);
}

/**
 * THE CALLS LEDGER — the tape's one committed trade per tick, persisted as its own calibration
 * object and re-graded every tick like a real resting order (fill → target-before-stop, strictly
 * sequential). This is the number that answers "if I took every call, how accurate is it?" —
 * one decided call per tick, not a probability menu. AI boards only (the rule fallback has no tape).
 */
async function persistCalls(date: string, board: Board, bars?: Bar[]) {
  const callsFile = path.join(config.paths.scored, `${date}.calls.jsonl`);
  const t = board.tape?.trade;
  if (t && board.scoring_method === "ai" && Number.isFinite(t.entry) && Number.isFinite(t.target)) {
    // Append only DISTINCT calls (same side/entry/target repeated across ticks is one standing call).
    let isNew = true;
    try {
      const lines = (await fs.readFile(callsFile, "utf8")).trim().split("\n").filter(Boolean);
      const prev = lines.length ? (JSON.parse(lines[lines.length - 1]!) as { side: string; entry: number; target: number }) : null;
      if (prev && prev.side === t.side && prev.entry === t.entry && prev.target === t.target) isNew = false;
    } catch { /* first call of the day */ }
    if (isNew) {
      await fs.appendFile(callsFile, JSON.stringify({ as_of: board.as_of, side: t.side, entry: t.entry, target: t.target, why: t.why, spot: board.spot }) + "\n", "utf8");
    }
  }
  // Re-grade every call made today against the bars SINCE each call (no look-back fills).
  if (!bars?.length) return;
  try {
    const calls = (await fs.readFile(callsFile, "utf8")).trim().split("\n").filter(Boolean)
      .map((l) => JSON.parse(l) as { as_of: string; side: "long" | "short"; entry: number; target: number; why: string; spot: number });
    const graded = calls.map((c) => ({ ...c, grade: gradeTradeCall(bars.filter((b) => b.ts >= c.as_of), c.side, c.entry, c.target) }));
    const gradedFile = path.join(config.paths.scored, `${date}.calls.graded.json`);
    await fs.writeFile(gradedFile + ".tmp", JSON.stringify(graded, null, 1), "utf8");
    await fs.rename(gradedFile + ".tmp", gradedFile);
  } catch { /* no calls yet today */ }
}

function printBoard(board: Board, session: SessionDef, spot: number) {
  console.log(`\n  QQQ reversal board  ${board.as_of}  [${session.name}]  spot=${spot.toFixed(2)}  regime=${board.regime}`);
  console.log("  ----------------------------------------------------------");
  for (const l of board.levels) {
    const bar = l.reversal_prob >= 70 ? "HIGH" : l.reversal_prob >= 50 ? "mid " : "low ";
    console.log(`  $${l.strike.toFixed(2).padEnd(8)} ${String(l.reversal_prob).padStart(3)}%  ${bar}  ${l.side.padEnd(10)} ${l.why}`);
  }
  console.log("");
}

/** Reversal detection runs on session OHLC bars (real wicks); a fetch failure must not block scoring.
 *  Returns the bars too — the calls ledger re-grades the day's tape trades against them. */
async function detectForSession(session: SessionDef, strikes: number[], date?: string): Promise<{ bars: Bar[]; detected: DetectedLevel[] }> {
  try {
    const bars = await fetchSessionBars(session, date);
    return { bars, detected: detectMany(bars, strikes) };
  } catch (err) {
    console.warn("market data unavailable, skipping reversal detection:", err instanceof Error ? err.message : err);
    return { bars: [], detected: [] };
  }
}

/**
 * In Asia the Altaris/QQQ spot is stale (US options closed), so the effective spot is the
 * live NQ price converted to QQQ-equiv. In the US session the Altaris spot is live.
 */
async function effectiveSpot(session: SessionDef, altarisSpot: number): Promise<number> {
  if (session.name !== "Asia") return altarisSpot;
  try {
    return await liveQqqEquivSpot();
  } catch {
    return altarisSpot;
  }
}

/**
 * One full scoring cycle for a given capture history (oldest..current).
 *
 * Options let the backfill path override the live defaults: an explicit `prior` board (so a
 * recovered morning tick chains off the *previous morning* board, never a later afternoon one),
 * an explicit `greek` (the tick's as-of timeseries, not whatever's on disk now), and `publish:
 * false` (score many recovered ticks, deploy once at the end instead of per tick).
 */
interface ScoreOpts { prior?: Board | null; greek?: GreekTimeseries | null; publish?: boolean; persist?: boolean }
async function scoreFromHistory(date: string, history: CaptureRecord[], session: SessionDef, opts: ScoreOpts = {}) {
  const cur = history[history.length - 1]!.data;
  const prior = opts.prior !== undefined ? opts.prior : await loadLatestBoard(date);

  const candidateStrikes = [...named(cur), ...(prior?.levels.map((l) => l.strike) ?? [])];
  const [{ bars, detected }, spot, greek, narrative, regime] = await Promise.all([
    detectForSession(session, candidateStrikes, date),
    effectiveSpot(session, cur.spot),
    opts.greek !== undefined ? Promise.resolve(opts.greek) : loadDayGreek(date),
    loadTodayNarrative(date),
    isAiScoreTime() ? loadRegime() : Promise.resolve(null), // regime only feeds the AI pass
  ]);
  const dayContext = dayContextFromNarrative(narrative); // tilt scoring toward the pre-open call

  // Stale-feed guard (US only — in Asia the Altaris chain is intentionally prior-close and we
  // already source spot from NQ). If the chain's spot has drifted far from the live market, the
  // whole greek layer (walls/GEX/charm/vanna) is frozen/corrupt; scoring it just publishes
  // phantom levels. Skip the cycle so the board goes honestly stale (watchdog will alert).
  if (session.name !== "Asia") {
    try {
      const live = await liveQqqSpot();
      const drift = Math.abs(cur.spot - live) / live;
      if (drift > config.staleFeedMaxPct) {
        const msg = `[${new Date().toISOString()}] [${session.name}] stale-feed guard: Altaris chain spot ${cur.spot} vs live QQQ ${live.toFixed(2)} (${(drift * 100).toFixed(1)}% drift > ${(config.staleFeedMaxPct * 100).toFixed(1)}%). Chain frozen — skipping score.`;
        console.warn(msg);
        await fs.appendFile(path.join(config.paths.scored, "scoring-errors.log"), msg + "\n\n", "utf8").catch(() => {});
        return prior ?? (await loadLatestBoardAny());
      }
    } catch (err) {
      // Live reference unavailable — don't block scoring on a Yahoo hiccup; proceed normally.
      console.warn("stale-feed guard skipped (no live reference):", err instanceof Error ? err.message : err);
    }
  }

  let board: Board;
  if (isAiScoreTime()) {
    try {
      board = await scoreBoard(history.slice(-LOOKBACK), prior, detected, session, spot, greek ?? undefined, dayContext, regime ?? undefined);
    } catch (err) {
      console.warn("AI scoring failed, falling back to rule-based scorer:", err instanceof Error ? err.message : err);
      // Persist the full error so recurring fallbacks are diagnosable after the fact,
      // even when the scheduled task doesn't capture stdout/stderr.
      const detail = `[${new Date().toISOString()}] [${session.name}] AI scoring failed:\n${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n\n`;
      await fs.appendFile(path.join(config.paths.scored, "scoring-errors.log"), detail, "utf8").catch(() => {});
      board = await scoreBoardDeterministic(history.slice(-LOOKBACK), prior, detected, session, spot);
    }
  } else {
    board = await scoreBoardDeterministic(history.slice(-LOOKBACK), prior, detected, session, spot);
  }
  // Advisory day gate (calendar × flow × regime): "should I rest limits at all today?"
  // Computed on every board (AI or rule) so the dashboard always carries a verdict.
  try {
    board.day_gate = computeDayGate(history[history.length - 1]!, spot, dayContext);
  } catch (err) {
    console.warn("day gate computation failed (board publishes without it):", err instanceof Error ? err.message : err);
  }
  if (opts.persist !== false) await persist(date, board, detected, bars);
  printBoard(board, session, spot);

  // Hybrid model: scoring is local, the board auto-publishes to the phone dashboard.
  // A publish/deploy hiccup must never lose us a scored board.
  if (opts.publish !== false) {
    try {
      await publish(board, detected, session.name);
    } catch (err) {
      console.warn("publish failed (board still saved locally):", err instanceof Error ? err.message : err);
    }
  }
  return board;
}

/**
 * Off-RTH refresh: keep the last RTH board's LEVELS (overnight = prior-close positioning,
 * not re-scored), but still update the live spot and re-grade reversal outcomes on the
 * current tape. No AI call. The board's as_of stays frozen so the dashboard honestly shows
 * the levels as held-from-RTH, not freshly scored.
 */
async function refreshTick(session: SessionDef) {
  const prior = await loadLatestBoardAny();
  if (!prior?.levels?.length) {
    console.log(`[${new Date().toISOString()}] [${session.name}] refresh skipped — no prior board to hold.`);
    return;
  }
  const strikes = prior.levels.map((l) => l.strike);
  const today = nowInSessionTz().date;
  const [{ detected }, spot] = await Promise.all([
    detectForSession(session, strikes, today),
    effectiveSpot(session, prior.spot),
  ]);
  const board: Board = { ...prior, spot }; // hold as_of / regime / levels; only spot moves

  // Grade overnight outcomes too, under the held board's as_of (for calibration history).
  await fs.mkdir(config.paths.scored, { recursive: true });
  await fs.appendFile(
    path.join(config.paths.scored, `${prior.as_of.slice(0, 10)}.calibration.jsonl`),
    JSON.stringify({ as_of: board.as_of, detected, refresh: true }) + "\n",
    "utf8",
  );
  printBoard(board, session, spot);

  try {
    await publish(board, detected, session.name);
  } catch (err) {
    console.warn("publish failed (refresh):", err instanceof Error ? err.message : err);
  }
}

/**
 * One scheduled tick. During RTH (or a forced manual run) capture + AI-score; otherwise
 * just refresh spot + reversal outcomes against the held board.
 */
async function liveTick(session: SessionDef, force = false) {
  if (!await acquireLock()) {
    console.warn(`[${new Date().toISOString()}] [${session.name}] another process holds the scoring lock — skipping tick`);
    return;
  }
  try {
    await liveTickInner(session, force);
  } finally {
    await releaseLock();
  }
}

async function liveTickInner(session: SessionDef, force = false) {
  let { date } = nowInSessionTz();
  if (force || isAiScoreTime()) {
    console.log(`[${new Date().toISOString()}] [${session.name}] capture + AI score (RTH)...`);
    // A transient capture failure (network blip, degraded /api/data payload) must not abort
    // the whole RTH tick — score from the snapshots we already have so the board stays live.
    try { await captureTick(); } catch (err) {
      console.warn("RTH capture failed, scoring from last available data:", err instanceof Error ? err.message : err);
    }
    const history = await loadDaySnapshots(date);
    if (history.length) {
      await scoreFromHistory(date, history, session);
    } else {
      console.warn("no captures available for today — falling back to refresh");
      await refreshTick(session);
    }
  } else {
    console.log(`[${new Date().toISOString()}] [${session.name}] off-RTH rule score...`);
    try { await captureTick(); } catch (err) {
      console.warn("off-RTH capture failed, scoring from last available data:", err instanceof Error ? err.message : err);
    }
    let history = await loadDaySnapshots(date);
    if (!history.length) {
      // Early-Asia after midnight ET — today has no captures yet; use prior day's data.
      const yesterday = new Date(Date.now() - 86_400_000);
      date = nowInSessionTz(yesterday).date;
      history = await loadDaySnapshots(date);
    }
    if (history.length) {
      await scoreFromHistory(date, history, session);
    } else {
      // Absolute fallback: no captures at all — hold the last board with live spot.
      console.warn("no captures found for today or yesterday, falling back to refresh");
      await refreshTick(session);
    }
  }
}

async function fixtureRun() {
  console.log("Fixture mode: scoring against fixtures/ (no Altaris call).");
  const raw = JSON.parse(await fs.readFile(path.join(config.paths.fixtures, "data.sample.json"), "utf8")) as DataSnapshot & Record<string, unknown>;
  const record: CaptureRecord = { capturedAt: nowInSessionTz().iso, data: compactSnapshot(raw) };
  // Pure smoke test: never persist a fixture board into data/scored (a later `npm run publish`
  // would ship the fixture to the phone) and never publish/deploy from here.
  await scoreFromHistory(nowInSessionTz().date, [record], activeSession() ?? US_SESSION, { publish: false, persist: false });
}

/**
 * Pre-open day narrative (dxrk PDF 1 + PDF 2). Captures a fresh snapshot, pulls macro,
 * combines them through Claude into one narrative, writes web/narrative.json, deploys.
 * Runs once ~09:00 ET (before the 09:15 AI score window) so the board can then tilt to it.
 */
async function narrativeTick(session: SessionDef) {
  // Serialize with the scoring tick: at 09:00 both crons fire together — without the lock the
  // two captureTick() calls interleave appends to the same data.jsonl and the two Netlify
  // deploys race each other.
  if (!await acquireLock()) {
    console.warn(`[${new Date().toISOString()}] [${session.name}] scoring lock held — narrative waiting one minute...`);
    await new Promise((r) => setTimeout(r, 60_000));
    if (!await acquireLock()) {
      console.warn("scoring lock still held — skipping narrative tick (retry manually with npm run narrative)");
      return;
    }
  }
  try {
    await narrativeTickInner(session);
  } finally {
    await releaseLock();
  }
}

async function narrativeTickInner(session: SessionDef) {
  const { date, iso } = nowInSessionTz();
  console.log(`[${new Date().toISOString()}] [${session.name}] building pre-open narrative...`);
  await captureTick();
  const history = await loadDaySnapshots(date);
  const cur = history[history.length - 1]?.data;
  if (!cur) { console.warn("narrative skipped — no snapshot captured."); return; }
  const [spot, board] = await Promise.all([effectiveSpot(session, cur.spot), loadLatestBoardAny()]);
  const lastCapture = history[history.length - 1]!;
  const narrative = await buildNarrative(cur, spot, board, iso, {
    entropy: lastCapture.entropy,
    hurst: lastCapture.hurst,
    garch: lastCapture.garch,
  });
  await writeNarrative(narrative);
  console.log(`  narrative: ${narrative.macro_bias} bias · ${narrative.open_type_label} · expansion ${narrative.expansion_direction}`);
  // Push to Netlify Blobs so the cloud /narrative endpoint stays live even when the deploy is stale.
  try {
    const siteID = process.env.NETLIFY_SITE_ID?.trim();
    const token = process.env.NETLIFY_AUTH_TOKEN?.trim();
    if (siteID && token) {
      await getStore({ name: "narrative", siteID, token }).setJSON("latest", narrative);
      console.log("  narrative → Netlify Blobs");
    }
  } catch (err) {
    console.warn("narrative Blobs write failed (static file still updated):", err instanceof Error ? err.message : err);
  }
  try {
    await deploySite();
  } catch (err) {
    console.warn("narrative publish failed (saved locally):", err instanceof Error ? err.message : err);
  }
}

// --- Backfill: recover a window the PC missed from the cloud-captured snapshots ---------------

async function loadBoardsForDate(date: string): Promise<Board[]> {
  try {
    const txt = await fs.readFile(path.join(config.paths.scored, `${date}.boards.jsonl`), "utf8");
    return txt.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Board);
  } catch {
    return [];
  }
}

/** The board immediately preceding `asOf` on `date` — the correct `prior` for a recovered tick. */
async function priorBoardBefore(date: string, asOf: string): Promise<Board | null> {
  const before = (await loadBoardsForDate(date))
    .filter((b) => b.as_of < asOf)
    .sort((a, b) => a.as_of.localeCompare(b.as_of));
  return before.at(-1) ?? null;
}

/** Fold cloud snapshots into data/raw, union-by-time, so the local stages see the full day. */
async function mergeCloudIntoRaw(date: string, cloud: CloudTick[]) {
  await fs.mkdir(config.paths.raw, { recursive: true });
  const existing = await loadDaySnapshots(date); // pre-merge local records
  const byTime = new Map(existing.map((r) => [r.capturedAt, r]));
  for (const t of cloud) if (!byTime.has(t.record.capturedAt)) byTime.set(t.record.capturedAt, t.record);
  const merged = [...byTime.values()].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  await fs.writeFile(path.join(config.paths.raw, `${date}.data.jsonl`), merged.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");

  // greek.json is cumulative-for-day — keep the most complete copy (the latest tick's greek).
  const haveLocal = await loadDayGreek(date);
  const latestCloudGreek = [...cloud].reverse().find((t) => t.greek)?.greek ?? null;
  const cloudIsNewer = (cloud.at(-1)?.record.capturedAt ?? "") >= (existing.at(-1)?.capturedAt ?? "");
  if (latestCloudGreek && (!haveLocal || cloudIsNewer)) {
    await fs.writeFile(path.join(config.paths.raw, `${date}.greek.json`), JSON.stringify(latestCloudGreek), "utf8");
  }
}

/** Recovered boards get appended after the day's existing ones — re-sort the logs into time order. */
async function resortDayLogs(date: string) {
  for (const suffix of ["boards.jsonl", "calibration.jsonl"]) {
    const file = path.join(config.paths.scored, `${date}.${suffix}`);
    try {
      const rows = (await fs.readFile(file, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
      rows.sort((a, b) => String(a.as_of).localeCompare(String(b.as_of)));
      await fs.writeFile(file, rows.map((o) => JSON.stringify(o)).join("\n") + "\n", "utf8");
    } catch {
      /* log may not exist for this date — nothing to sort */
    }
  }
}

/**
 * Recover a day the PC missed. Pulls the cloud-captured snapshots (netlify/functions/capture.mjs),
 * merges them into data/raw, then AI-scores ONLY the ticks that have no board yet — grading
 * reversals against Yahoo OHLC, which is historical and complete. Each recovered tick chains off
 * the chronologically-previous board (never look-ahead from a board that came later in the day).
 * Finally it re-sorts the day's logs into time order and publishes the latest board.
 *
 * Same-day is the design target ("I was out this morning, the box is on now"): reversal detection
 * reads today's session bars. Backfilling an older date still recovers + scores the snapshots, but
 * grades their reversals on the current tape — flagged with a warning.
 */
async function backfillDay(dateArg?: string) {
  const today = nowInSessionTz().date;
  const date = dateArg ?? today;
  if (date !== today) {
    console.warn(`Backfilling ${date} (not today): snapshots + scores recover, but reversal grading uses today's bars.`);
  }

  const cloud = await fetchCloudCaptures(date);
  if (!cloud.length) {
    console.log(`No cloud captures for ${date}. (Is capture.mjs deployed, and were you in the 09:00-16:00 ET window?)`);
    return;
  }
  console.log(`Found ${cloud.length} cloud snapshot(s) for ${date}.`);

  await mergeCloudIntoRaw(date, cloud);

  const existing = new Set((await loadBoardsForDate(date)).map((b) => b.as_of));
  const gap = cloud.filter((t) => !existing.has(t.record.capturedAt));
  if (!gap.length) {
    console.log("Every cloud tick already has a board — raw merged, nothing to score.");
    return;
  }
  console.log(`Scoring ${gap.length} recovered tick(s) the box missed...`);

  const merged = await loadDaySnapshots(date); // now includes the cloud ticks, chronological
  const session = activeSession() ?? US_SESSION;
  let prior = await priorBoardBefore(date, gap[0]!.record.capturedAt);
  for (const tick of gap) {
    const history = merged.filter((r) => r.capturedAt <= tick.record.capturedAt);
    prior = await scoreFromHistory(date, history, session, { prior, greek: tick.greek, publish: false });
  }

  await resortDayLogs(date);
  const final = (await loadBoardsForDate(date)).at(-1);
  if (final) {
    const latest = path.join(config.paths.scored, "latest.json");
    await fs.writeFile(latest + ".tmp", JSON.stringify(final, null, 2), "utf8");
    await fs.rename(latest + ".tmp", latest);
    try {
      const { detected } = await detectForSession(session, final.levels.map((l) => l.strike), nowInSessionTz().date);
      await publish(final, detected, session.name);
      console.log("Published the recovered day's latest board.");
    } catch (err) {
      console.warn("publish failed (boards still saved locally):", err instanceof Error ? err.message : err);
    }
  }
  console.log(`Backfill complete: ${gap.length} tick(s) recovered + scored for ${date}.`);
}

async function main() {
  const arg = process.argv[2];

  if (arg === "--backfill") return backfillDay(process.argv[3]);

  if (arg === "--fixture") return fixtureRun();
  if (arg === "--once") return liveTick(activeSession() ?? US_SESSION, true); // manual run always scores
  if (arg === "--narrative") return narrativeTick(activeSession() ?? US_SESSION); // manual pre-open narrative

  // Scheduled mode — runs in the US and Asia windows; AI-scores only during RTH.
  //
  // SINGLE-INSTANCE TAKEOVER: Stop-ScheduledTask does NOT kill the spawned npm/node tree
  // (observed live: nine stale loop instances stacked up, the oldest — running outdated
  // code — kept winning the scoring lock). Instead of relying on external kills, the newest
  // instance claims ownership by writing its PID here; every older instance notices on its
  // next cron fire and exits itself. Restart procedure is therefore just Start-ScheduledTask.
  const LOOP_PID_FILE = path.join(path.resolve("data"), ".loop.pid");
  await fs.mkdir(path.resolve("data"), { recursive: true });
  await fs.writeFile(LOOP_PID_FILE, String(process.pid), "utf8");
  const stillOwner = async (): Promise<boolean> => {
    try { return (await fs.readFile(LOOP_PID_FILE, "utf8")).trim() === String(process.pid); }
    catch { return true; } // unreadable file must not kill the only live loop
  };

  const expr = `*/${config.scoreIntervalMin} * * * *`;
  console.log(`Scheduler armed: every ${config.scoreIntervalMin}m. AI score ${config.aiScoreStart}-${config.aiScoreEnd} (RTH); off-RTH = spot+reversal refresh. Pre-open narrative ${config.narrativeTime} ET (Mon-Fri). Windows US ${config.sessionStart}-${config.sessionEnd}, Asia ${config.asiaStart}-${config.asiaEnd} ${config.sessionTz}.`);
  let tickRunning = false;
  cron.schedule(expr, async () => {
    if (!await stillOwner()) {
      console.warn(`[${new Date().toISOString()}] newer loop instance took over — this one (pid ${process.pid}) exits.`);
      process.exit(0);
    }
    const session = activeSession();
    if (!session) return;
    if (tickRunning) {
      console.warn(`[${new Date().toISOString()}] previous tick still running — skipping this cron fire`);
      return;
    }
    tickRunning = true;
    try {
      await liveTick(session);
    } catch (err) {
      console.error("tick failed:", err instanceof Error ? err.message : err);
    } finally {
      tickRunning = false;
    }
  }, { timezone: config.sessionTz });

  // Pre-open narrative: once per weekday at config.narrativeTime ET (default 09:00), before RTH scoring.
  const [nh, nm] = config.narrativeTime.split(":").map(Number);
  cron.schedule(`${nm ?? 0} ${nh ?? 9} * * 1-5`, async () => {
    if (!await stillOwner()) return; // superseded — the main cron will exit the process
    try {
      await narrativeTick(activeSession() ?? US_SESSION);
    } catch (err) {
      console.error("narrative tick failed:", err instanceof Error ? err.message : err);
    }
  }, { timezone: config.sessionTz });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
