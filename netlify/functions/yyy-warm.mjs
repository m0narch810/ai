// Cache warmer for the YYY proxy.
//
// Every five minutes during the extended US session it refreshes every allowlisted endpoint
// into the shared "yyy-cache" Blobs store, so a page opened at any point in the day answers
// from a blob that is at most a few minutes old instead of waiting on upstream. The proxy's
// own 75s TTL still triggers a live fetch when someone is actually watching, so the warmer
// only ever sets the floor on freshness, never the ceiling.
//
// Window: 08:30–16:30 ET Mon–Fri, skipping US market holidays. Off-hours the chain is static
// and the blobs age gracefully (the proxy serves them stale-on-error up to 30 min, then live).
import { connectLambda, getStore } from "@netlify/blobs";
import { EP, fetchUpstream, cacheKey } from "./yyy.mjs";

function etParts(d = new Date()) {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d);
  const g = (t) => p.find((x) => x.type === t)?.value ?? "00";
  const wdName = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(d);
  const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { date: `${g("year")}-${g("month")}-${g("day")}`, minutes: Number(g("hour")) % 24 * 60 + Number(g("minute")), wd: WD[wdName] ?? 0 };
}

// Keep in sync with US_MARKET_HOLIDAYS in src/config.ts.
const HOLIDAYS = new Set([
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19",
  "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18",
  "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
]);

const inWindow = ({ date, wd, minutes }) =>
  wd >= 1 && wd <= 5 && minutes >= 510 && minutes <= 990 && !HOLIDAYS.has(date);

const TICKER = "QQQ";
const CONCURRENCY = 6;

export const handler = async (event) => {
  connectLambda(event);
  const t = etParts();
  if (!inWindow(t)) return { statusCode: 200, body: `outside warm window (${t.date} ${t.minutes}m)` };

  const store = getStore("yyy-cache");
  const names = Object.keys(EP);
  const results = { ok: [], err: [] };

  // Bounded parallelism: YYY is one small Railway box; thirty simultaneous requests is rude.
  let i = 0;
  const worker = async () => {
    while (i < names.length) {
      const name = names[i++];
      try {
        const val = await fetchUpstream(name, TICKER);
        await store.setJSON(cacheKey(name, TICKER), { at: Date.now(), val });
        results.ok.push(name);
      } catch (e) {
        results.err.push(`${name}: ${String(e?.message ?? e).slice(0, 60)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const body = `warmed ${results.ok.length}/${names.length}` + (results.err.length ? ` · failed: ${results.err.join("; ")}` : "");
  console.log("[yyy-warm]", body);
  return { statusCode: 200, body };
};
