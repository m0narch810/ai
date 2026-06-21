import fs from "node:fs/promises";
import path from "node:path";
import cron from "node-cron";
import { activeSession, config, isAiScoreTime, nowInSessionTz, RTH_MIN, type SessionDef } from "./config.js";
import { captureTick, compactSnapshot, loadDayGreek, loadDaySnapshots } from "./capture.js";
import { detectMany } from "./detect.js";
import { fetchSessionBars, liveQqqEquivSpot } from "./market.js";
import { publish } from "./publish.js";
import { scoreBoard, scoreBoardDeterministic } from "./score.js";
import type { Board, CaptureRecord, DataSnapshot, DetectedLevel } from "./types.js";

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

/** One full scoring cycle for a given capture history (oldest..current). */
async function scoreFromHistory(date: string, history: CaptureRecord[], session: SessionDef) {
  const cur = history[history.length - 1]!.data;
  const prior = await loadLatestBoard(date);

  const candidateStrikes = [...named(cur), ...(prior?.levels.map((l) => l.strike) ?? [])];
  const [detected, spot, greek] = await Promise.all([
    detectForSession(session, candidateStrikes),
    effectiveSpot(session, cur.spot),
    loadDayGreek(date),
  ]);

  let board: Board;
  try {
    board = await scoreBoard(history.slice(-LOOKBACK), prior, detected, session, spot, greek ?? undefined);
  } catch (err) {
    console.warn("AI scoring failed, falling back to rule-based scorer:", err instanceof Error ? err.message : err);
    board = await scoreBoardDeterministic(history.slice(-LOOKBACK), prior, detected, session, spot);
  }
  await persist(date, board, detected);
  printBoard(board, session, spot);

  // Hybrid model: scoring is local, the board auto-publishes to the phone dashboard.
  // A publish/deploy hiccup must never lose us a scored board.
  try {
    await publish(board, detected, session.name);
  } catch (err) {
    console.warn("publish failed (board still saved locally):", err instanceof Error ? err.message : err);
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

async function main() {
  const arg = process.argv[2];

  if (arg === "--fixture") return fixtureRun();
  if (arg === "--once") return liveTick(activeSession() ?? US_SESSION, true); // manual run always scores

  // Scheduled mode — runs in the US and Asia windows; AI-scores only during RTH.
  const expr = `*/${config.scoreIntervalMin} * * * *`;
  console.log(`Scheduler armed: every ${config.scoreIntervalMin}m. AI score ${config.aiScoreStart}-${config.aiScoreEnd} (RTH); off-RTH = spot+reversal refresh. Windows US ${config.sessionStart}-${config.sessionEnd}, Asia ${config.asiaStart}-${config.asiaEnd} ${config.sessionTz}.`);
  cron.schedule(expr, async () => {
    const session = activeSession();
    if (!session) return;
    try {
      await liveTick(session);
    } catch (err) {
      console.error("tick failed:", err instanceof Error ? err.message : err);
    }
  }, { timezone: config.sessionTz });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
