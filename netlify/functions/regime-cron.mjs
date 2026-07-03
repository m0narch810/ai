// Scheduled regime refresh: keeps the regime-cache blob fresh during RTH so the HEADLESS
// scorer always has a live regime to obey. Without this, the regime only recomputed when a
// human opened the Regime tab (the HTTP function is on-demand + 15-min cache), so the board's
// "highest-order governing context" could be hours stale — and the scorer's staleness gate
// (loadRegime in src/run.ts, 30-min max age) would silently drop it every tick.
//
// Window: 09:10–16:05 ET Mon–Fri — a fresh regime exists just before the 09:15 AI window opens
// and through the close. Off-hours the blob ages out naturally (the scorer ignores it).
import { connectLambda, getStore } from "@netlify/blobs";
import { computeRegime } from "./regime.mjs";

/** ET wall-clock parts (mirrors capture.mjs). */
function etParts(d = new Date()) {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d);
  const g = (t) => p.find((x) => x.type === t)?.value ?? "00";
  const wdName = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(d);
  const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const date = `${g("year")}-${g("month")}-${g("day")}`;
  return { date, minutes: Number(g("hour")) * 60 + Number(g("minute")), wd: WD[wdName] ?? 0 };
}

// US market holidays (observed) — keep in sync with US_MARKET_HOLIDAYS in src/config.ts.
const HOLIDAYS = new Set([
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19",
  "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18",
  "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
]);

const inWindow = ({ date, wd, minutes }) =>
  wd >= 1 && wd <= 5 && minutes >= 550 && minutes <= 965 && !HOLIDAYS.has(date);

export const handler = async (event) => {
  connectLambda(event);
  const t = etParts();
  if (!inWindow(t)) return { statusCode: 200, body: `outside regime window (${t.date} ${t.minutes}m)` };
  try {
    const regime = await computeRegime(getStore("regime-cache"));
    return { statusCode: 200, body: `regime refreshed: ${regime.state}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("regime-cron failed:", msg);
    return { statusCode: 200, body: `regime-cron failed: ${msg}` }; // 200 so the cron isn't marked failing
  }
};
