import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

// import.meta.url may be absent in CJS-bundled environments (e.g. Netlify esbuild output).
// Fall back to cwd() — board.mts never writes files so config.paths is unused there.
let ROOT: string;
try {
  ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
} catch {
  ROOT = process.cwd();
}

function req(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`Missing required env var: ${name}`);
  return v.trim();
}
function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`Env var ${name} must be a number, got "${v}"`);
  return n;
}


// The bracket is specified in MNQ points (what the trader executes) and converted once here, so
// every consumer — scorer prompt, calls ledger, detector, dashboard — reads the SAME QQQ numbers.
const MNQ_PER_QQQ = num("MNQ_PTS_PER_QQQ_PT", 40.7);
const STOP_MNQ = num("STOP_MNQ_PTS", 40);
const TARGET_MNQ = num("TARGET_MNQ_PTS", 80);

export const config = {
  // The ONLY options-flow provider. YYY is the public research backend behind yyy-bias-web —
  // unauthenticated, and it computes the same per-strike GEX/DEX/charm/vanna surface plus its own
  // level/bias engine. Altaris was retired 2026-09-01 (Railway app deleted; every path 404s), so
  // there is no provider switch and no credentials any more.
  yyyBaseUrl: (process.env.YYY_BASE_URL?.trim() || "https://web-production-8a6973.up.railway.app").replace(/\/$/, ""),
  symbol: process.env.SYMBOL?.trim() || "QQQ",

  sessionTz: process.env.SESSION_TZ?.trim() || "America/New_York",
  sessionStart: process.env.SESSION_START?.trim() || "08:30",
  sessionEnd: process.env.SESSION_END?.trim() || "17:00",
  // Asia overnight window (ET, wraps midnight). Starts at 18:00 ET (NQ maintenance ends,
  // futures open) so spot + rule scoring are live as soon as NQ is tradeable.
  asiaStart: process.env.ASIA_START?.trim() || "18:00",
  asiaEnd: process.env.ASIA_END?.trim() || "04:00",
  scoreIntervalMin: num("SCORE_INTERVAL_MIN", 15),
  // AI re-scoring runs RTH only (Mon–Fri 09:15–16:00 ET). Outside this the loop holds the
  // last RTH board's levels but still refreshes spot + reversal outcomes — no AI call.
  aiScoreStart: process.env.AI_SCORE_START?.trim() || "09:15",
  aiScoreEnd: process.env.AI_SCORE_END?.trim() || "16:00",
  // Pre-open day-narrative pass (dxrk macro bias + open-type), once per weekday at this ET time.
  narrativeTime: process.env.NARRATIVE_TIME?.trim() || "09:00",
  // Stale-feed guard: if the Altaris chain's spot diverges from the live market by more than
  // this fraction during the US session, the options chain is frozen/corrupt (e.g. premarket
  // before the chain wakes, or a feed outage). Skip scoring rather than publish phantom levels.
  staleFeedMaxPct: num("STALE_FEED_MAX_PCT", 0.02),

  // Fast-move override: the 15-min grid can leave a converging level with only one tick of
  // lead time (a level 6+ pts away doesn't even appear until the tick that lands 1-2 pts out).
  // A cheap spot-only poll (no capture/AI) runs every fastPollSec during RTH; if live spot has
  // moved fastTickMovePct since the last scored board, it fires an out-of-schedule full tick
  // early instead of waiting for the grid boundary. fastTickCooldownSec prevents back-to-back
  // AI calls while price keeps trending through the threshold.
  fastTickMovePct: num("FAST_TICK_MOVE_PCT", 0.0025),
  // Approach trigger: an early tick also fires when live spot CONVERGES on a level the last
  // board called (was outside this window at score time, inside it now) — a sub-threshold
  // drift can still walk straight into a called strike (2026-07-10: 722.44 -> 724 = 0.22%).
  fastTickApproachPts: num("FAST_TICK_APPROACH_PTS", 1.25),
  fastPollSec: num("FAST_POLL_SEC", 60),
  fastTickCooldownSec: num("FAST_TICK_COOLDOWN_SEC", 180),

  // Scoring runs through Claude Code headless on the Max subscription — no API key.
  // model is a CLI alias ("opus"/"sonnet") or a full id.
  model: process.env.ANTHROPIC_MODEL?.trim() || "sonnet",

  // Per-request HTTP timeout (ms) for ALL outbound fetches (Altaris, login, Yahoo).
  // Without this, a fetch that connects but never responds hangs the whole capture
  // forever and holds the scoring lock — the historical cause of stalled ticks.
  fetchTimeoutMs: num("FETCH_TIMEOUT_MS", 20000),

  // Let the (once-per-day, pre-open) narrative pass use WebSearch/WebFetch to read live
  // breaking macro/geopolitics (Fed commentary, oil shocks). The per-tick scorer stays
  // fully tool-locked. Set NARRATIVE_WEBSEARCH=false to force the deterministic path.
  narrativeWebSearch: (process.env.NARRATIVE_WEBSEARCH?.trim() ?? "true") !== "false",

  touchTolerancePct: num("TOUCH_TOLERANCE_PCT", 0.0010),
  breakBufferPct: num("BREAK_BUFFER_PCT", 0.0015),
  // Candidate universe for level nomination, ± this fraction of spot. WAS 0.025 (±2.5% ≈ ±18
  // QQQ pts ≈ ±745 MNQ pts) — far wider than a day's range, so the ranking (alignment tier,
  // then raw gamma magnitude) kept nominating the biggest structural walls near the edge of the
  // band instead of strikes price could actually reach. Median published level sat 7.8 pts from
  // spot and 93% of graded levels were never touched (Jun 17 - Aug 14 calibration). ±1.0% keeps
  // the whole plausible session range in play and nothing beyond it. This also re-bases the
  // band-relative role classification (bandStats) onto a REACHABLE window, so "dominant" now
  // means dominant among strikes in play, not among every wall within 2.5%.
  nearSpotBandPct: num("NEAR_SPOT_BAND_PCT", 0.010),

  // ── THE BRACKET (user spec 2026-08-15) ────────────────────────────────────────────────
  // Fixed, symmetric-in-nothing, denominated in MNQ POINTS because that is what the trader
  // actually executes: rest a limit at the exact strike, 40 MNQ stop, 80 MNQ target. There is
  // no per-level target SELECTION any more — the bracket is the same on every call, so the only
  // job left for the scorer is judging greek alignment AT a strike.
  // Prior spec (Jul 13 - Aug 15) was 0.5 QQQ stop / 3.0 QQQ target (≈20 MNQ / 122 MNQ, 1:6).
  mnqPtsPerQqqPt: MNQ_PER_QQQ,
  stopMnqPts: STOP_MNQ,
  targetMnqPts: TARGET_MNQ,
  /** 40 MNQ pts in QQQ terms (~0.98). Doubles as the level-BREAK threshold in detect.ts: a level
   *  has broken exactly when price went far enough past it to take the stop. */
  hardStopPts: STOP_MNQ / MNQ_PER_QQQ,
  /** 80 MNQ pts in QQQ terms (~1.97). The booked take-profit AND the swing the detector requires
   *  before it will grade a touch as "reversed" — ledger and calibration agree by construction. */
  callTpPts: TARGET_MNQ / MNQ_PER_QQQ,
  cleanReversalPts: num("CLEAN_REVERSAL_PTS", 0.10),
  // How close price must actually trade to a level to count as TESTED. Expanded to 0.15 pts
  // to catch near-miss reversals (e.g. price reaches 743.85 before reversing off a 744 strike).
  // Reversals 0.5+ pts short of a strike belong to the next nearby strike, not this one.
  fillTolPts: num("FILL_TOL_PTS", 0.15),

  // Reversal detection uses Yahoo OHLC bars (wicks), not the Altaris spot tape.
  marketInterval: process.env.MARKET_INTERVAL?.trim() || "1m",
  marketRthOnly: (process.env.MARKET_RTH_ONLY?.trim() ?? "true") !== "false",

  paths: {
    root: ROOT,
    raw: path.join(ROOT, "data", "raw"),
    scored: path.join(ROOT, "data", "scored"),
    fixtures: path.join(ROOT, "fixtures"),
  },
} as const;

/** Current time formatted in the session timezone. */
export function nowInSessionTz(d = new Date()): { iso: string; date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: config.sessionTz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  const hh = Number(get("hour"));
  const mm = Number(get("minute"));
  return { iso: `${date}T${get("hour")}:${get("minute")}:${get("second")}`, date, minutes: hh * 60 + mm };
}

function hhmmToMinutes(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
function etWeekday(d: Date): number {
  const s = new Intl.DateTimeFormat("en-US", { timeZone: config.sessionTz, weekday: "short" }).format(d);
  return WD[s] ?? 0;
}

/** RTH for the OHLC detector, ET minutes (used for the US session bar filter). */
export const RTH_MIN = { start: 9 * 60 + 30, end: 16 * 60 };

/**
 * US market holidays (observed dates) — no options trading, chain frozen, AI scoring pointless.
 * Keep in sync with the HOLIDAYS sets in netlify/functions/capture.mjs / watchdog.mjs / regime-cron.mjs.
 * Extend annually (NYSE calendar): New Year, MLK, Presidents, Good Friday, Memorial, Juneteenth,
 * July 4th, Labor, Thanksgiving, Christmas.
 */
export const US_MARKET_HOLIDAYS = new Set([
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19",
  "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18",
  "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
]);

export interface SessionDef {
  name: "US" | "Asia";
  source: "QQQ" | "NQ=F";
  /** ET minute window used to filter detection bars. */
  startMin: number;
  endMin: number;
}

/**
 * Which trading session (if any) is active now.
 *  US   — Mon–Fri 08:30–17:00 ET; price/levels from QQQ directly.
 *  Asia — Sun–Thu evenings 18:00 → Mon–Fri 04:00 ET; QQQ is stale, price from NQ futures converted.
 */
export function activeSession(d = new Date()): SessionDef | null {
  const wd = etWeekday(d);
  const { minutes } = nowInSessionTz(d);

  const usS = hhmmToMinutes(config.sessionStart), usE = hhmmToMinutes(config.sessionEnd);
  if (wd >= 1 && wd <= 5 && minutes >= usS && minutes <= usE) {
    return { name: "US", source: "QQQ", startMin: RTH_MIN.start, endMin: RTH_MIN.end };
  }

  const aS = hhmmToMinutes(config.asiaStart), aE = hhmmToMinutes(config.asiaEnd);
  const evening = minutes >= aS && wd >= 0 && wd <= 4; // Sun–Thu nights
  const morning = minutes <= aE && wd >= 1 && wd <= 5; // Mon–Fri early hours
  if (evening || morning) return { name: "Asia", source: "NQ=F", startMin: aS, endMin: aE };

  return null;
}

/**
 * Whether the AI scorer should run now: RTH only (Mon–Fri 09:15–16:00 ET by default).
 * Outside this window the loop refreshes spot + reversal outcomes but reuses the last
 * RTH board's levels instead of re-scoring (overnight positioning is the prior close).
 */
export function isAiScoreTime(d = new Date()): boolean {
  const wd = etWeekday(d);
  const { date, minutes } = nowInSessionTz(d);
  if (US_MARKET_HOLIDAYS.has(date)) return false; // chain frozen — nothing real to score
  const s = hhmmToMinutes(config.aiScoreStart), e = hhmmToMinutes(config.aiScoreEnd);
  return wd >= 1 && wd <= 5 && minutes >= s && minutes <= e;
}
