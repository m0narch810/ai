import fs from "node:fs/promises";
import path from "node:path";
import cron from "node-cron";
import { activeSession, config, nowInSessionTz, RTH_MIN, type SessionDef } from "./config.js";
import { captureTick, compactSnapshot, loadDaySnapshots } from "./capture.js";
import { detectMany } from "./detect.js";
import { fetchSessionBars, liveQqqEquivSpot } from "./market.js";
import { publish } from "./publish.js";
import { scoreBoard } from "./score.js";
import type { Board, CaptureRecord, DataSnapshot, DetectedLevel } from "./types.js";

/** ~90 min of context at a 15-min cadence — enough to read trend without diluting deltas. */
const LOOKBACK = 6;

/** Manual --once / --fixture runs outside any session default to a US frame. */
const US_SESSION: SessionDef = { name: "US", source: "QQQ", startMin: RTH_MIN.start, endMin: RTH_MIN.end };

function named(snap: DataSnapshot): number[] {
  return [
    snap.call_wall, snap.put_wall, snap.major_wall, snap.max_pain, snap.zero_gamma, snap.vol_trigger,
    snap.call_wall_0dte, snap.put_wall_0dte, snap.major_wall_0dte,
    ...snap.call_walls, ...snap.put_walls,
  ].filter((n) => Number.isFinite(n) && n > 0);
}

async function loadLatestBoard(date: string): Promise<Board | null> {
  try {
    const b = JSON.parse(await fs.readFile(path.join(config.paths.scored, "latest.json"), "utf8")) as Board;
    return b.as_of.startsWith(date) ? b : null; // ignore yesterday's board
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
  const [detected, spot] = await Promise.all([
    detectForSession(session, candidateStrikes),
    effectiveSpot(session, cur.spot),
  ]);

  const board = await scoreBoard(history.slice(-LOOKBACK), prior, detected, session, spot);
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

/** Live tick: capture, then score for the active session. */
async function liveTick(session: SessionDef) {
  const { date } = nowInSessionTz();
  console.log(`[${new Date().toISOString()}] [${session.name}] capturing...`);
  await captureTick();
  const history = await loadDaySnapshots(date);
  await scoreFromHistory(date, history, session);
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
  if (arg === "--once") return liveTick(activeSession() ?? US_SESSION);

  // Scheduled mode — runs in both the US and Asia windows.
  const expr = `*/${config.scoreIntervalMin} * * * *`;
  console.log(`Scheduler armed: every ${config.scoreIntervalMin}m. US ${config.sessionStart}-${config.sessionEnd}, Asia ${config.asiaStart}-${config.asiaEnd} ${config.sessionTz}.`);
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
