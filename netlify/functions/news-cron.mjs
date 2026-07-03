// Red-folder news watchdog: pushes an ntfy alert ahead of every high-impact USD economic
// release (NFP, CPI, FOMC, etc.) so a print like the 8:30 jobs report doesn't catch you
// off guard mid-session. Same alerting channel as watchdog.mjs — reuses NTFY_TOPIC/NTFY_SERVER.
//
// Source: the public JSON feed behind ForexFactory's embeddable calendar widget
// (https://nfs.faireconomy.media/ff_calendar_thisweek.json) — no scraping, no auth, updates
// weekly. Each event's `date` already carries an ET offset, so no timezone conversion needed.
//
// Flow (Netlify Blobs holds one state blob per day, "news-watchdog" store):
//   first run of the day → fetch the week's feed, keep today's USD "High" events, store them
//     with fired=false, send ONE morning digest ntfy listing today's times.
//   every run after → for each un-fired event, if now is within the lead window before it,
//     send a "T-minus" ntfy alert and mark it fired. Events already past when first seen
//     (e.g. this function was just deployed) are marked fired silently — no stale alerts.
import { connectLambda, getStore } from "@netlify/blobs";

const NTFY_SERVER = (process.env.NTFY_SERVER || "https://ntfy.sh").replace(/\/$/, "");
const NTFY_TOPIC = process.env.NTFY_TOPIC?.trim();
const LEAD_MIN = Number(process.env.NEWS_LEAD_MIN || 20); // fire this many minutes before the release
const FEED_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";

/** ET wall-clock parts (mirrors watchdog.mjs / regime-cron.mjs). */
function etNow() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    wd: WD[get("weekday")] ?? 0,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
    date: `${get("year")}-${get("month")}-${get("day")}`,
  };
}

// US market holidays (observed) — keep in sync with US_MARKET_HOLIDAYS in src/config.ts.
const HOLIDAYS = new Set([
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19",
  "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18",
  "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
]);

// Watch premarket through the close: 06:00–16:00 ET, Mon-Fri. Covers 08:30 releases (NFP/CPI),
// 10:00 prints (ISM), and 14:00 FOMC statements.
const isWatchWindow = (wd, minutes, date) => wd >= 1 && wd <= 5 && minutes >= 360 && minutes <= 960 && !HOLIDAYS.has(date);

async function notify(title, message, priority, tags) {
  if (!NTFY_TOPIC) return;
  await fetch(`${NTFY_SERVER}/${encodeURIComponent(NTFY_TOPIC)}`, {
    method: "POST",
    headers: { Title: title, Priority: priority, Tags: tags },
    body: message,
  });
}

function etTimeLabel(iso) {
  return new Date(iso).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
}

export const handler = async (event) => {
  connectLambda(event);
  if (!NTFY_TOPIC) return { statusCode: 200, body: "NTFY_TOPIC not set — nothing to do" };

  const { wd, minutes, date } = etNow();
  if (!isWatchWindow(wd, minutes, date)) return { statusCode: 200, body: "outside watch window" };

  const store = getStore("news-watchdog");
  let day = await store.get(date, { type: "json" }).catch(() => null);

  if (!day) {
    // First run of the day: pull the feed, keep today's USD high-impact events.
    let events = [];
    try {
      const res = await fetch(FEED_URL, { headers: { "cache-control": "no-store" } });
      if (!res.ok) throw new Error(`feed HTTP ${res.status}`);
      const all = await res.json();
      events = all
        .filter((e) => e.country === "USD" && e.impact === "High" && e.date.startsWith(date))
        .map((e) => ({ title: e.title, date: e.date, forecast: e.forecast, previous: e.previous, fired: false }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("news feed fetch failed:", msg);
      return { statusCode: 200, body: `feed fetch failed: ${msg}` };
    }

    // Anything already past by the time we first see it today (e.g. cold start mid-morning)
    // gets marked fired up front so it doesn't fire a stale "T-minus" alert.
    const now = Date.now();
    for (const e of events) {
      if (Date.parse(e.date) - LEAD_MIN * 60_000 <= now) e.fired = true;
    }

    day = { events };
    await store.setJSON(date, day);

    if (events.length) {
      const lines = events.map((e) => `${etTimeLabel(e.date)} — ${e.title}${e.forecast ? ` (fc ${e.forecast}, prev ${e.previous})` : ""}`);
      await notify(
        "Red-folder news today",
        lines.join("\n"),
        "default", "calendar,newspaper",
      );
    }
    return { statusCode: 200, body: `seeded ${events.length} event(s) for ${date}` };
  }

  // Subsequent runs: fire T-minus alerts for anything now inside the lead window.
  const now = Date.now();
  let changed = false;
  for (const e of day.events) {
    if (e.fired) continue;
    const t = Date.parse(e.date);
    if (now >= t - LEAD_MIN * 60_000) {
      const mins = Math.round((t - now) / 60_000);
      await notify(
        "Red-folder news incoming",
        `${e.title} at ${etTimeLabel(e.date)} ET${mins > 0 ? ` (~${mins} min)` : " (now)"}${e.forecast ? ` — fc ${e.forecast}, prev ${e.previous}` : ""}`,
        "high", "rotating_light",
      );
      e.fired = true;
      changed = true;
    }
  }
  if (changed) await store.setJSON(date, day);

  return { statusCode: 200, body: `checked ${day.events.length} event(s), ${day.events.filter((e) => e.fired).length} fired` };
};
