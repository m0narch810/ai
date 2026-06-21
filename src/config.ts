import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

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

/** Normalize the cookie env into a full `altaris_session=<token>` header value. */
function normalizeCookie(raw: string): string {
  const v = raw.trim();
  return v.includes("=") ? v : `altaris_session=${v}`;
}

const baseUrl = (process.env.ALTARIS_BASE_URL?.trim() || "https://altaris.up.railway.app/api").replace(/\/$/, "");
const rawCookie = process.env.ALTARIS_COOKIE?.trim();

export const config = {
  baseUrl,
  // A pasted cookie is now optional: if ALTARIS_USER/PASS are set we log in for it.
  cookie: rawCookie ? normalizeCookie(rawCookie) : "",
  // Credentials for auto-login + cookie refresh on expiry (src/auth.ts).
  altarisUser: process.env.ALTARIS_USER?.trim() || "",
  altarisPass: process.env.ALTARIS_PASS?.trim() || "",
  loginUrl: `${baseUrl}/login`,
  symbol: process.env.ALTARIS_SYMBOL?.trim() || "QQQ",

  sessionTz: process.env.SESSION_TZ?.trim() || "America/New_York",
  sessionStart: process.env.SESSION_START?.trim() || "08:30",
  sessionEnd: process.env.SESSION_END?.trim() || "17:00",
  // Asia overnight window (ET, wraps midnight). Price comes from NQ futures, converted to QQQ.
  asiaStart: process.env.ASIA_START?.trim() || "20:00",
  asiaEnd: process.env.ASIA_END?.trim() || "04:00",
  scoreIntervalMin: num("SCORE_INTERVAL_MIN", 15),
  // AI re-scoring runs RTH only (Mon–Fri 09:15–16:00 ET). Outside this the loop holds the
  // last RTH board's levels but still refreshes spot + reversal outcomes — no AI call.
  aiScoreStart: process.env.AI_SCORE_START?.trim() || "09:15",
  aiScoreEnd: process.env.AI_SCORE_END?.trim() || "16:00",

  // Scoring runs through Claude Code headless on the Max subscription — no API key.
  // model is a CLI alias ("opus"/"sonnet") or a full id.
  model: process.env.ANTHROPIC_MODEL?.trim() || "sonnet",

  // Min take-profit floor: ~100 NQ points at current QQQ/NQ ratio (~41.5:1) ≈ 2.5 QQQ pts ≈ 0.34% of spot.
  // Used in AI prompt as min_reversal_move_pts; only levels with a far structural target this far away score high.
  tpMinPct: num("TP_MIN_PCT", 0.0034),
  // Swing size that confirms a level actually reversed (a "hold", not a poke).
  // Set above the TP min so minor chop near a level doesn't count as a reversal.
  reversalSwingPct: num("REVERSAL_SWING_PCT", 0.005),
  touchTolerancePct: num("TOUCH_TOLERANCE_PCT", 0.0010),
  breakBufferPct: num("BREAK_BUFFER_PCT", 0.0015),
  nearSpotBandPct: num("NEAR_SPOT_BAND_PCT", 0.025),

  // Reversal grading in ABSOLUTE QQQ POINTS, sized to the trader's MNQ-futures method
  // (entries are limit orders at the exact strike; ~41.5 MNQ pts per QQQ pt).
  // hardStopPts ≈ the 20-MNQ-point stop (20 / ~41.5). A turn within cleanReversalPts
  // (~4 MNQ pts) is a clean, near-to-the-tick reversal; beyond the stop = broken.
  hardStopPts: num("HARD_STOP_PTS", 0.48),
  cleanReversalPts: num("CLEAN_REVERSAL_PTS", 0.10),
  // How close price must actually trade to a level to count as TESTED — a resting limit
  // only fills if price reaches the strike. Coming within ~a point is not a touch.
  fillTolPts: num("FILL_TOL_PTS", 0.08),

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
 *  Asia — Sun–Thu evenings 20:00 → Mon–Fri 04:00 ET; QQQ is stale, price from NQ futures converted.
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
  const { minutes } = nowInSessionTz(d);
  const s = hhmmToMinutes(config.aiScoreStart), e = hhmmToMinutes(config.aiScoreEnd);
  return wd >= 1 && wd <= 5 && minutes >= s && minutes <= e;
}
