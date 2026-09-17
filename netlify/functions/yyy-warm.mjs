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
import { EP, fetchUpstream, cacheKey, tapeKey } from "./yyy.mjs";
import { sampleFrom } from "../../web/lib/ivtape.js";
import { liveIvWalls } from "../../web/lib/ivwalls.js";

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
  const names = Object.keys(EP).filter((n) => n !== "ivtape");
  const results = { ok: [], err: [] };
  const vals = {};

  // Bounded parallelism: YYY is one small Railway box; thirty simultaneous requests is rude.
  let i = 0;
  const worker = async () => {
    while (i < names.length) {
      const name = names[i++];
      try {
        const val = await fetchUpstream(name, TICKER);
        vals[name] = val;
        await store.setJSON(cacheKey(name, TICKER), { at: Date.now(), val });
        results.ok.push(name);
      } catch (e) {
        results.err.push(`${name}: ${String(e?.message ?? e).slice(0, 60)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // IV TAPE: one ATM-IV sample per run inside the cash session, plus the OPEN-FROZEN IV-wall
  // bracket (the spec's fixed bracket; the live one shrinks ~4x through the day). Studies in
  // data/study/ — see web/lib/ivtape.js for what the tape is used for.
  let tapeNote = "";
  try {
    const nv = vals.net_iv;
    const spot = nv?.spot ?? vals.gex?.spot;
    if (nv && Number.isFinite(spot) && t.minutes >= 571 && t.minutes <= 960) {
      const tstore = getStore("ivtape");
      const key = tapeKey(TICKER, t.date);
      let tape = null;
      try { tape = await tstore.get(key, { type: "json" }); } catch { tape = null; }
      if (!tape || tape.date !== t.date) {
        tape = { date: t.date, samples: [], open_walls: null, open_at: null, prev_close: null };
        // The prior session's LAST sample (its 16:00 ATM IV), so the client can print the
        // close→open IV gap from the first sample at 09:31 (untested, information only).
        for (let back = 1; back <= 5 && !tape.prev_close; back++) {
          const d = new Date(Date.now() - back * 86_400_000);
          const pd = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
          let prev = null;
          try { prev = await tstore.get(tapeKey(TICKER, pd), { type: "json" }); } catch { prev = null; }
          const last = prev?.samples?.[prev.samples.length - 1];
          if (last && Number.isFinite(last.atm)) tape.prev_close = { date: pd, atm: last.atm, t: last.t, spot: last.spot ?? null };
        }
      }
      const s = sampleFrom(nv, spot);
      if (s) { tape.samples.push(s); if (tape.samples.length > 200) tape.samples.shift(); }
      if (!tape.open_walls) {
        const w = liveIvWalls(nv, spot, t.minutes);
        if (w) { tape.open_walls = w; tape.open_at = new Date().toISOString(); }
      }
      await tstore.setJSON(key, tape);
      tapeNote = ` · ivtape ${tape.samples.length} samples${tape.open_walls ? " · open walls frozen" : ""}`;
    }
  } catch (e) { tapeNote = ` · ivtape failed: ${String(e?.message ?? e).slice(0, 60)}`; }

  // FLOW TAPE (added 2026-09-17): snapshot the day's traded-flow so it accumulates a history we can test.
  // /dealer_anomalies returns the WHOLE session's 5-min bar_deltas (net traded delta, ±1-ish) + prices each call,
  // so we just overwrite the day's blob with the latest full snapshot — no append needed. This is the churn/
  // absorption input the ABSORPTION lead needs (data/study/flow_report.md); it was never stored before, so the
  // history starts now. Store `flow` blob per ET date; keep HIRO alongside for direction.
  let flowNote = "";
  try {
    const da = vals.dealer_anomalies;
    if (da && Array.isArray(da.times) && Array.isArray(da.bar_deltas) && t.minutes >= 555 && t.minutes <= 965) {
      const fstore = getStore("flow");
      await fstore.setJSON(tapeKey(TICKER, t.date), {
        date: t.date, at: Date.now(),
        times: da.times, bar_deltas: da.bar_deltas, prices: da.prices ?? null,
        anomalies: da.anomalies ?? null, imbalance: da.imbalance ?? null,
        buy_count: da.buy_count ?? null, sell_count: da.sell_count ?? null, current_z: da.current_z ?? null,
        hiro_dir: vals.flow?.sentiment ?? null, hiro_m: vals.hiro?.current_hiro_m ?? null,
      });
      flowNote = ` · flow ${da.bar_deltas.length} bars`;
    }
  } catch (e) { flowNote = ` · flow failed: ${String(e?.message ?? e).slice(0, 60)}`; }

  const body = `warmed ${results.ok.length}/${names.length}` + (results.err.length ? ` · failed: ${results.err.join("; ")}` : "") + tapeNote + flowNote;
  console.log("[yyy-warm]", body);
  return { statusCode: 200, body };
};
