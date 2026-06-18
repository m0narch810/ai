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

export const config = {
  baseUrl: (process.env.ALTARIS_BASE_URL?.trim() || "https://altaris.up.railway.app/api").replace(/\/$/, ""),
  cookie: normalizeCookie(req("ALTARIS_COOKIE")),
  symbol: process.env.ALTARIS_SYMBOL?.trim() || "QQQ",

  sessionTz: process.env.SESSION_TZ?.trim() || "America/New_York",
  sessionStart: process.env.SESSION_START?.trim() || "08:30",
  sessionEnd: process.env.SESSION_END?.trim() || "17:00",
  // Asia overnight window (ET, wraps midnight). Price comes from NQ futures, converted to QQQ.
  asiaStart: process.env.ASIA_START?.trim() || "20:00",
  asiaEnd: process.env.ASIA_END?.trim() || "04:00",
  scoreIntervalMin: num("SCORE_INTERVAL_MIN", 15),

  // Scoring runs through Claude Code headless on the Max subscription — no API key.
  // model is a CLI alias ("opus"/"sonnet") or a full id.
  model: process.env.ANTHROPIC_MODEL?.trim() || "sonnet",

  // Min take-profit (the 0.25% rule) — used in the AI prompt for spacing/TP.
  tpMinPct: num("TP_MIN_PCT", 0.0025),
  // Swing size that confirms a level actually reversed (a "hold", not a poke).
  // Set above the TP min so minor chop near a level doesn't count as a reversal.
  reversalSwingPct: num("REVERSAL_SWING_PCT", 0.005),
  touchTolerancePct: num("TOUCH_TOLERANCE_PCT", 0.0010),
  breakBufferPct: num("BREAK_BUFFER_PCT", 0.0015),
  nearSpotBandPct: num("NEAR_SPOT_BAND_PCT", 0.025),

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
