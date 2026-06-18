// Builds the single JSON the static dashboard reads, by merging the scored Board
// with the detector's per-level outcomes. Pure builder + a writer; no network.
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { activeSession } from "./config.js";
import type { Board, DetectedLevel, ReversalOutcome, ScoredLevel } from "./types.js";

/** A scored level annotated with how it has played out on today's tape. */
export interface DashboardLevel extends ScoredLevel {
  /** "none" = no detector match for this strike yet. */
  outcome: ReversalOutcome | "none";
  touched: boolean;
  touchedAt?: string;
  /** Adverse overshoot beyond the level, in points (for the clean/grind display). */
  overshoot?: number;
  /** Whether the reversal/hold stayed within the clean tolerance. */
  clean?: boolean;
}

/** Everything the static page renders, in one fetchable object. */
export interface DashboardData {
  as_of: string;
  /** Absolute epoch ms the levels were scored (timezone-proof staleness). */
  scored_at?: number;
  generated_at: string;
  session: string | null;
  spot: number;
  regime: string;
  /** Points beyond a level that count as a hard break (lets the live spot flag breaks). */
  hard_stop_pts: number;
  /** Points beyond a level still considered a clean reversal. */
  clean_reversal_pts: number;
  /** IV regime + expected daily move, for the hero. */
  iv?: { current: number; direction: string };
  expected_move?: number;
  levels: DashboardLevel[];
}

/** Board strikes are round (735); detector strikes can be exact (730.24) — match by nearest. */
const MATCH_TOL_PTS = 0.75;
const OUTCOME_RANK: Record<ReversalOutcome, number> = { reversed: 4, broke: 3, pending: 2, untouched: 1 };

type LevelOutcome = Pick<DashboardLevel, "outcome" | "touched" | "touchedAt" | "overshoot" | "clean">;

/** Pick the most-resolved detector outcome at/near a board strike. */
function outcomeFor(strike: number, detected: DetectedLevel[]): LevelOutcome {
  const near = detected.filter((d) => Math.abs(d.strike - strike) <= MATCH_TOL_PTS);
  if (near.length === 0) return { outcome: "none", touched: false };
  const best = near.reduce((a, b) => (OUTCOME_RANK[b.outcome] > OUTCOME_RANK[a.outcome] ? b : a));
  return { outcome: best.outcome, touched: best.touched, touchedAt: best.touchedAt, overshoot: best.overshoot, clean: best.clean };
}

export function buildDashboard(board: Board, detected: DetectedLevel[], session?: string | null): DashboardData {
  return {
    as_of: board.as_of,
    scored_at: board.scored_at,
    generated_at: new Date().toISOString(),
    session: session ?? activeSession()?.name ?? null,
    spot: board.spot,
    regime: board.regime,
    hard_stop_pts: config.hardStopPts,
    clean_reversal_pts: config.cleanReversalPts,
    iv: board.iv,
    expected_move: board.expected_move,
    levels: board.levels.map((l) => ({ ...l, ...outcomeFor(l.strike, detected) })),
  };
}

/** Path of the JSON the static page fetches. */
export const dashboardJsonPath = path.join(config.paths.root, "web", "dashboard.json");

/** Write web/dashboard.json (the file the static dashboard reads). */
export async function writeDashboard(data: DashboardData): Promise<void> {
  await fs.mkdir(path.dirname(dashboardJsonPath), { recursive: true });
  await fs.writeFile(dashboardJsonPath, JSON.stringify(data, null, 2), "utf8");
}
