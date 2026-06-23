import fs from "node:fs/promises";
import path from "node:path";
import cron from "node-cron";
import { activeSession, config, isAiScoreTime, nowInSessionTz, RTH_MIN, type SessionDef } from "./config.js";
import { captureTick, compactSnapshot, loadDayGreek, loadDaySnapshots } from "./capture.js";
import { detectMany } from "./detect.js";
import { fetchSessionBars, liveQqqEquivSpot } from "./market.js";
import { buildNarrative, narrativeJsonPath, writeNarrative } from "./narrative.js";
import { deploySite, publish } from "./publish.js";
import { dayContextFromNarrative, scoreBoard, scoreBoardDeterministic } from "./score.js";
import { fetchCloudCaptures, type CloudTick } from "./cloudCaptures.js";
import type { Board, CaptureRecord, DataSnapshot, DetectedLevel, GreekTimeseries, Narrative } from "./types.js";

/** ~90 min of context at a 15-min cadence — enough to read trend without diluting deltas. */
const LOOKBACK = 6;

/** Manual --once / --fixture runs outside any session default to a US frame. */
const US_SESSION: SessionDef = { name: "US", source: "QQQ", startMin: RTH_MIN.start, endMin: RTH_MIN.end };

// Unlisted strikes with |GEX| >= this rival the named walls and must be candidates.
const GEX_WALL_THRESHOLD = 100e6;

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

/** Today's pre-open narrative, if one was generated for this date (used to tilt scoring). */
async function loadTodayNarrative(date: string): Promise<Narrative | null> {
  try {
    const n = JSON.parse(await fs.readFile(narrativeJsonPath, "utf8")) as Narrative;
    return n.as_of.startsWith(date) ? n : null;
  } catch {
    return null;
  }
}

async function persist(date: string, board: Board, detected: unknown) {
  await fs.mkdir(config.paths.scored, { recursive: true });
  await fs.writeFile(path.join(config.paths.scored, "latest.json"), JSON.stringify(board, null, 2), "utf8");
  await fs.appendFile(path.join(config.paths.scored, `${date}.boards.jsonl`), JSON.stringify(board) + "\n", "utf8");
  await fs.appendFile(
    path.join(config.paths.scored, `${date}.calibration.jsonl`),
    JSON.stringify({ as_of: board.as_of, detected }) + "\n",
    "utf8",
  );
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

/** Reversal detection runs on Yahoo OHLC bars (real wicks); a fetch failure must not block scoring. */
async function detectForSession(session: SessionDef, strikes: number[]): Promise<DetectedLevel[]> {
  try {
    return detectMany(await fetchSessionBars(session), strikes);
  } catch (err) {
    console.warn("market data unavailable, skipping reversal detection:", err instanceof Error ? err.message : err);
    return [];
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
interface ScoreOpts { prior?: Board | null; greek?: GreekTimeseries | null; publish?: boolean }
async function scoreFromHistory(date: string, history: CaptureRecord[], session: SessionDef, opts: ScoreOpts = {}) {
  const cur = history[history.length - 1]!.data;
  const prior = opts.prior !== undefined ? opts.prior : await loadLatestBoard(date);

  const candidateStrikes = [...named(cur), ...(prior?.levels.map((l) => l.strike) ?? [])];
  const [detected, spot, greek, narrative] = await Promise.all([
    detectForSession(session, candidateStrikes),
    effectiveSpot(session, cur.spot),
    opts.greek !== undefined ? Promise.resolve(opts.greek) : loadDayGreek(date),
    loadTodayNarrative(date),
  ]);
  const dayContext = dayContextFromNarrative(narrative); // tilt scoring toward the pre-open call

  let board: Board;
  try {
    board = await scoreBoard(history.slice(-LOOKBACK), prior, detected, session, spot, greek ?? undefined, dayContext);
  } catch (err) {
    console.warn("AI scoring failed, falling back to rule-based scorer:", err instanceof Error ? err.message : err);
    board = await scoreBoardDeterministic(history.slice(-LOOKBACK), prior, detected, session, spot);
  }
  await persist(date, board, detected);
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
  const [detected, spot] = await Promise.all([
    detectForSession(session, strikes),
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
  const { date } = nowInSessionTz();
  if (force || isAiScoreTime()) {
    console.log(`[${new Date().toISOString()}] [${session.name}] capture + AI score (RTH)...`);
    await captureTick();
    const history = await loadDaySnapshots(date);
    await scoreFromHistory(date, history, session);
  } else {
    console.log(`[${new Date().toISOString()}] [${session.name}] off-RTH refresh — spot + reversals only...`);
    await refreshTick(session);
  }
}

async function fixtureRun() {
  console.log("Fixture mode: scoring against fixtures/ (no Altaris call).");
  const raw = JSON.parse(await fs.readFile(path.join(config.paths.fixtures, "data.sample.json"), "utf8")) as DataSnapshot & Record<string, unknown>;
  const record: CaptureRecord = { capturedAt: nowInSessionTz().iso, data: compactSnapshot(raw) };
  await scoreFromHistory(nowInSessionTz().date, [record], activeSession() ?? US_SESSION);
}

/**
 * Pre-open day narrative (dxrk PDF 1 + PDF 2). Captures a fresh snapshot, pulls macro,
 * combines them through Claude into one narrative, writes web/narrative.json, deploys.
 * Runs once ~09:00 ET (before the 09:15 AI score window) so the board can then tilt to it.
 */
async function narrativeTick(session: SessionDef) {
  const { date, iso } = nowInSessionTz();
  console.log(`[${new Date().toISOString()}] [${session.name}] building pre-open narrative...`);
  await captureTick();
  const history = await loadDaySnapshots(date);
  const cur = history[history.length - 1]?.data;
  if (!cur) { console.warn("narrative skipped — no snapshot captured."); return; }
  const [spot, board] = await Promise.all([effectiveSpot(session, cur.spot), loadLatestBoardAny()]);
  const narrative = await buildNarrative(cur, spot, board, iso);
  await writeNarrative(narrative);
  console.log(`  narrative: ${narrative.macro_bias} bias · ${narrative.open_type_label} · expansion ${narrative.expansion_direction}`);
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
    await fs.writeFile(path.join(config.paths.scored, "latest.json"), JSON.stringify(final, null, 2), "utf8");
    try {
      const detected = await detectForSession(session, final.levels.map((l) => l.strike));
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
  const expr = `*/${config.scoreIntervalMin} * * * *`;
  console.log(`Scheduler armed: every ${config.scoreIntervalMin}m. AI score ${config.aiScoreStart}-${config.aiScoreEnd} (RTH); off-RTH = spot+reversal refresh. Pre-open narrative ${config.narrativeTime} ET (Mon-Fri). Windows US ${config.sessionStart}-${config.sessionEnd}, Asia ${config.asiaStart}-${config.asiaEnd} ${config.sessionTz}.`);
  cron.schedule(expr, async () => {
    const session = activeSession();
    if (!session) return;
    try {
      await liveTick(session);
    } catch (err) {
      console.error("tick failed:", err instanceof Error ? err.message : err);
    }
  }, { timezone: config.sessionTz });

  // Pre-open narrative: once per weekday at config.narrativeTime ET (default 09:00), before RTH scoring.
  const [nh, nm] = config.narrativeTime.split(":").map(Number);
  cron.schedule(`${nm ?? 0} ${nh ?? 9} * * 1-5`, async () => {
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
