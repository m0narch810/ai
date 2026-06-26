// Builds the single JSON the static dashboard reads, by merging the scored Board
// with the detector's per-level outcomes. Pure builder + a writer; no network.
import fs from "node:fs/promises";
import path from "node:path";
import { activeSession, config } from "./config.js";
import type { Board, CoverageLevel, DetectedLevel, ReversalOutcome, ScoredLevel, Side } from "./types.js";

/** A scored level annotated with how it has played out on today's tape. */
export interface DashboardLevel extends ScoredLevel {
  /** "none" = no detector match for this strike yet. */
  outcome: ReversalOutcome | "none";
  touched: boolean;
  touchedAt?: string;
  /** ET ISO of the second touch when outcome is "retested" or pending-retest. */
  retestAt?: string;
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
  /** One-line institutional read (path + the level to fade). */
  read?: string;
  /** Points beyond a level that count as a hard break (lets the live spot flag breaks). */
  hard_stop_pts: number;
  /** Points beyond a level still considered a clean reversal. */
  clean_reversal_pts: number;
  /** IV regime + expected daily move, for the hero. */
  iv?: { current: number; direction: string };
  expected_move?: number;
  scoring_method?: "ai" | "rule";
  /** Near-spot GEX distribution for the dashboard GEX bar chart. */
  gex_profile?: { strike: number; gex_m: number }[];
  /** Per-strike reversal score for EVERY near-spot strike (precision coverage). */
  coverage?: CoverageLevel[];
  /** Gamma flip level — spot above = positive gamma regime, below = negative. */
  zero_gamma?: number;
  /** Vol trigger — spot below = dealers net short underlying. */
  vol_trigger?: number;
  /** Net aggregate GEX ($, signed). Negative = dealers amplify moves. */
  net_gex?: number;
  /** Put/call volume ratio across all strikes at score time (>1.2 = fear; <0.7 = call chasing). */
  pc_ratio?: number;
  /** Fraction of total |GEX| expiring today (0DTE ratio). >0.6 = strong close pin. */
  gex_0dte_ratio?: number;
  /** Entropy gate state at score time ("NORMAL" | "ELEVATED" | "CRITICAL"). */
  entropy_state?: "NORMAL" | "ELEVATED" | "CRITICAL";
  /** Entropy ratio at score time (current / threshold, rounded to 2 dp). */
  entropy_ratio?: number;
  levels: DashboardLevel[];
}

/** Board strikes are round (735); detector strikes can be exact (730.24) — match by nearest. */
const MATCH_TOL_PTS = 0.75;
const OUTCOME_RANK: Record<ReversalOutcome, number> = { reversed: 5, retested: 4, broke: 3, pending: 2, untouched: 1 };

type LevelOutcome = Pick<DashboardLevel, "outcome" | "touched" | "touchedAt" | "retestAt" | "overshoot" | "clean">;

/**
 * Pick the most-resolved detector outcome at a board strike — but only when the detector
 * graded that strike on the SAME side. A 737.5 that rejected as resistance must not stamp
 * "held" on a 737.5 the board is showing as support; as support, nothing happened there.
 */
function outcomeFor(strike: number, side: Side, detected: DetectedLevel[]): LevelOutcome {
  const near = detected.filter((d) => d.side === side && Math.abs(d.strike - strike) <= MATCH_TOL_PTS);
  if (near.length === 0) return { outcome: "none", touched: false };
  const best = near.reduce((a, b) => (OUTCOME_RANK[b.outcome] > OUTCOME_RANK[a.outcome] ? b : a));
  return { outcome: best.outcome, touched: best.touched, touchedAt: best.touchedAt, retestAt: best.retestAt, overshoot: best.overshoot, clean: best.clean };
}

export function buildDashboard(board: Board, detected: DetectedLevel[], session?: string | null): DashboardData {
  return {
    as_of: board.as_of,
    scored_at: board.scored_at,
    generated_at: new Date().toISOString(),
    session: session ?? activeSession()?.name ?? null,
    spot: board.spot,
    regime: board.regime,
    read: board.read,
    hard_stop_pts: config.hardStopPts,
    clean_reversal_pts: config.cleanReversalPts,
    iv: board.iv,
    expected_move: board.expected_move,
    scoring_method: board.scoring_method,
    gex_profile: board.gex_profile,
    coverage: board.coverage,
    zero_gamma: board.zero_gamma,
    vol_trigger: board.vol_trigger,
    net_gex: board.net_gex,
    pc_ratio: board.pc_ratio,
    gex_0dte_ratio: board.gex_0dte_ratio,
    entropy_state: board.entropy_state,
    entropy_ratio: board.entropy_ratio,
    levels: board.levels.map((l) => ({ ...l, ...outcomeFor(l.strike, l.side, detected) })),
  };
}

/** Path of the JSON the static page fetches. */
export const dashboardJsonPath = path.join(config.paths.root, "web", "dashboard.json");

/** Write web/dashboard.json (the file the static dashboard reads). */
export async function writeDashboard(data: DashboardData): Promise<void> {
  await fs.mkdir(path.dirname(dashboardJsonPath), { recursive: true });
  await fs.writeFile(dashboardJsonPath, JSON.stringify(data, null, 2), "utf8");
}
