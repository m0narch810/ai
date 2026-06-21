// Cloud watchdog: a scheduled function that pings YOU when local scoring stalls.
//
// Why it lives in the cloud, not the scoring loop: if the PC is off, the internet drops,
// or the loop crashes, an alert *from* the loop can't fire. This runs on Netlify on a cron,
// reads the deployed dashboard.json, and texts via ntfy if the board has gone stale during
// market hours. It catches everything — box offline, AI failing, publish stuck.
//
// Alerting discipline (Netlify Blobs holds one tiny state blob):
//   fresh → stale : send ONE "stalled" push, mark alerted.
//   stale → fresh : send ONE "recovered" push, clear alerted.
// So a multi-hour outage is one text, not one every tick.
//
// Env (Netlify → Site settings → Environment variables):
//   NTFY_TOPIC        (required)  your private ntfy topic — subscribe to it in the ntfy app.
//   NTFY_SERVER       (optional)  default https://ntfy.sh
//   WATCHDOG_STALE_MIN(optional)  minutes old before "stale". Default 35 (≈2 missed 15-min ticks).
import { connectLambda, getStore } from "@netlify/blobs";

const NTFY_SERVER = (process.env.NTFY_SERVER || "https://ntfy.sh").replace(/\/$/, "");
const NTFY_TOPIC = process.env.NTFY_TOPIC?.trim();
const STALE_MIN = Number(process.env.WATCHDOG_STALE_MIN || 35);

/** ET weekday (0=Sun) + minutes-since-midnight, matching the rest of the system. */
function etNow() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { wd: WD[get("weekday")] ?? 0, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

// Watch 09:50–16:00 ET, Mon–Fri. Starts after 09:50 (not 09:15) so the morning's first RTH
// score has time to land — before then the board is legitimately the held overnight one.
const isWatchWindow = (wd, minutes) => wd >= 1 && wd <= 5 && minutes >= 590 && minutes <= 960;

async function notify(title, message, priority, tags) {
  if (!NTFY_TOPIC) return;
  await fetch(`${NTFY_SERVER}/${encodeURIComponent(NTFY_TOPIC)}`, {
    method: "POST",
    headers: { Title: title, Priority: priority, Tags: tags },
    body: message,
  });
}

export const handler = async (event) => {
  connectLambda(event); // wire Blobs context from the event (classic Lambda-signature function)
  if (!NTFY_TOPIC) return { statusCode: 200, body: "NTFY_TOPIC not set — nothing to do" };

  const { wd, minutes } = etNow();
  if (!isWatchWindow(wd, minutes)) return { statusCode: 200, body: "outside watch window" };

  const store = getStore("watchdog");
  const state = (await store.get("state", { type: "json" }).catch(() => null)) || { alerted: false };

  try {
    const res = await fetch(`${process.env.URL}/dashboard.json?t=${Date.now()}`, {
      headers: { "cache-control": "no-store" },
    });
    if (!res.ok) throw new Error(`dashboard.json HTTP ${res.status}`);
    const d = await res.json();

    const scoredAt = typeof d.scored_at === "number" ? d.scored_at : Date.parse(d.generated_at || "");
    const ageMin = Math.round((Date.now() - scoredAt) / 60000);
    const stale = !Number.isFinite(scoredAt) || ageMin > STALE_MIN;

    if (stale && !state.alerted) {
      await notify(
        "⚠️ Altaris scoring stalled",
        `No fresh board in ~${ageMin} min during market hours. The scoring box is likely offline — check it.`,
        "high", "warning,chart_with_downwards_trend",
      );
      await store.setJSON("state", { alerted: true, since: Date.now() });
      return { statusCode: 200, body: `ALERT sent (stale ${ageMin}m)` };
    }
    if (!stale && state.alerted) {
      await notify("✅ Altaris scoring recovered", `Board is updating again (last scored ${ageMin}m ago).`, "default", "white_check_mark");
      await store.setJSON("state", { alerted: false, since: Date.now() });
      return { statusCode: 200, body: `RECOVERED (fresh ${ageMin}m)` };
    }
    return { statusCode: 200, body: stale ? `still stale ${ageMin}m (already alerted)` : `ok, fresh ${ageMin}m` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!state.alerted) {
      await notify("⚠️ Altaris board unreachable", `Watchdog couldn't read the board: ${msg}`, "high", "warning");
      await store.setJSON("state", { alerted: true, since: Date.now() });
      return { statusCode: 200, body: `ALERT sent (unreachable: ${msg})` };
    }
    return { statusCode: 200, body: `still unreachable (already alerted): ${msg}` };
  }
};
