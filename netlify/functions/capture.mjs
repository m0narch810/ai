// Cloud capture: a scheduled function that snapshots Altaris option-flow even when the PC is off.
//
// Why it exists: the local scoring loop (capture→detect→score→publish) runs as a Windows
// scheduled task ON the PC. If the box is off (you're out), nothing is captured — and the
// Altaris flow at that moment is gone forever, so a reversal that happened while you were away
// can never be calibrated. AI scoring is NOT needed to *preserve* the data: all you need saved
// is the Altaris snapshot (positioning) + greeks; reversal grading runs later off Yahoo OHLC,
// which is historical and never lost. This function captures the perishable half into Netlify
// Blobs every 15 min during RTH, so `npm run backfill` can reconstruct the missed window.
//
// It deliberately does the minimum: log in, fetch the three endpoints, compact, store. No
// detection, no AI — that's the PC's job when it comes back. Stored shape per tick mirrors a
// local CaptureRecord (+ the as-of greek timeseries) so backfill needs zero re-parsing.
//
// Env (Netlify → Site settings → Environment variables):
//   ALTARIS_USER, ALTARIS_PASS  (required) — same credentials as the local .env.
//   ALTARIS_BASE_URL            (optional) — defaults to the Railway terminal.
import { connectLambda, getStore } from "@netlify/blobs";

const BASE = (process.env.ALTARIS_BASE_URL?.trim() || "https://altaris.up.railway.app/api").replace(/\/$/, "");
const USER = process.env.ALTARIS_USER?.trim();
const PASS = process.env.ALTARIS_PASS?.trim();

const LOGIN_HEADERS = {
  accept: "application/json",
  "content-type": "application/json",
  referer: "https://altaris.up.railway.app/login",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
};
const BROWSER_HEADERS = {
  accept: "*/*",
  referer: "https://altaris.up.railway.app/",
  "user-agent": LOGIN_HEADERS["user-agent"],
};

/** ET wall-clock parts, matching nowInSessionTz() in src/config.ts. */
function etParts(d = new Date()) {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(d);
  const g = (t) => p.find((x) => x.type === t)?.value ?? "00";
  const wdName = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(d);
  const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const date = `${g("year")}-${g("month")}-${g("day")}`;
  const hh = g("hour"), mm = g("minute"), ss = g("second");
  return { date, hh, mm, iso: `${date}T${hh}:${mm}:${ss}`, minutes: Number(hh) * 60 + Number(mm), wd: WD[wdName] ?? 0 };
}

// Capture 09:00–16:00 ET, Mon–Fri — the window where the local loop scores boards (09:15 AI start,
// plus the 09:00 pre-open snapshot). Off-hours positioning is static prior-close; no need to store it.
const inCaptureWindow = ({ wd, minutes }) => wd >= 1 && wd <= 5 && minutes >= 540 && minutes <= 960;

/** Pull `altaris_session=<token>` out of the login response's Set-Cookie header(s). */
function extractCookie(res) {
  const raw = typeof res.headers.getSetCookie === "function"
    ? res.headers.getSetCookie()
    : [res.headers.get("set-cookie") ?? ""];
  for (const line of raw) {
    const m = /(?:^|;\s*)altaris_session=([^;]+)/.exec(line);
    if (m?.[1]) return `altaris_session=${m[1]}`;
  }
  return null;
}

async function login() {
  const res = await fetch(`${BASE}/login`, {
    method: "POST", headers: LOGIN_HEADERS,
    body: JSON.stringify({ email: USER, password: PASS }),
  });
  if (!res.ok) throw new Error(`Altaris login HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}`);
  const cookie = extractCookie(res);
  if (!cookie) throw new Error("Altaris login succeeded but returned no altaris_session cookie.");
  return cookie;
}

async function getJson(endpoint, cookie) {
  const res = await fetch(`${BASE}/${endpoint}`, { headers: { ...BROWSER_HEADERS, cookie } });
  if (!res.ok) throw new Error(`GET ${endpoint} HTTP ${res.status}`);
  return res.json();
}

// --- compaction: mirrors compactSnapshot() / summarizeIv() in src/capture.ts so the stored blob
// is byte-for-byte a local CaptureRecord. Keep these in sync if the local versions change. ---
function aggregateHm(hm) {
  const out = {};
  for (const r of hm?.rows ?? []) out[r.strike.toFixed(1)] = r.cells.reduce((a, b) => a + (b ?? 0), 0);
  return out;
}
/** 0DTE (same-day) column of a strike×expiration heatmap — nearest expiry if no true 0DTE. */
function zeroDteSlice(hm) {
  const exps = hm?.expirations;
  if (!exps?.length || !hm?.rows) return {};
  let idx = exps.findIndex((e) => e.dte === 0);
  if (idx < 0) { let min = Infinity; exps.forEach((e, i) => { if (e.dte < min) { min = e.dte; idx = i; } }); }
  const out = {};
  for (const r of hm.rows) out[r.strike.toFixed(1)] = r.cells?.[idx] ?? 0;
  return out;
}
/** Day-over-day OI change (calls/puts) per strike from /api/oi_change. */
function oiChangeToBar(oc) {
  if (!oc?.has_previous || !Array.isArray(oc.nodes) || !oc.nodes.length) return undefined;
  const out = {};
  for (const n of oc.nodes) if (Number.isFinite(n.strike)) out[n.strike.toFixed(1)] = { calls: n.delta_calls ?? 0, puts: n.delta_puts ?? 0 };
  return Object.keys(out).length ? out : undefined;
}
function compactSnapshot(raw) {
  const gex_0dte_bar = zeroDteSlice(raw.gex_hm);
  // P/C ratio: total put volume / total call volume — sentiment read.
  let totC = 0, totP = 0;
  for (const v of Object.values(raw.vol_bar ?? {})) { totC += v?.calls ?? 0; totP += v?.puts ?? 0; }
  const pc_ratio = totC > 0 ? Math.round((totP / totC) * 100) / 100 : undefined;
  // 0DTE GEX ratio: 0DTE slice / all expirations |GEX|.
  let totalGexAbs = 0, total0dteAbs = 0;
  for (const v of Object.values(raw.gex_bar ?? {})) totalGexAbs += Math.abs(v ?? 0);
  for (const v of Object.values(gex_0dte_bar)) total0dteAbs += Math.abs(v ?? 0);
  const gex_0dte_ratio = totalGexAbs > 0 ? Math.round((total0dteAbs / totalGexAbs) * 100) / 100 : undefined;
  return {
    ticker: raw.ticker, spot: raw.spot, timestamp: raw.timestamp,
    call_wall: raw.call_wall, put_wall: raw.put_wall, major_wall: raw.major_wall,
    max_pain: raw.max_pain, zero_gamma: raw.zero_gamma,
    vol_trigger: raw.vol_trigger, total_vol_trigger: raw.total_vol_trigger,
    call_wall_0dte: raw.call_wall_0dte, put_wall_0dte: raw.put_wall_0dte, major_wall_0dte: raw.major_wall_0dte,
    call_walls: raw.call_walls, put_walls: raw.put_walls,
    oi_bar: raw.oi_bar, vol_bar: raw.vol_bar,
    gex_bar: raw.gex_bar, dex_bar: raw.dex_bar, vex_bar: raw.vex_bar, rex_bar: raw.rex_bar,
    charm_bar: aggregateHm(raw.cex_hm), tex_bar: aggregateHm(raw.tex_hm), vanna_bar: aggregateHm(raw.vannex_hm),
    gex_0dte_bar, charm_0dte_bar: zeroDteSlice(raw.cex_hm), vanna_0dte_bar: zeroDteSlice(raw.vannex_hm),
    atm_iv: raw.atm_iv, expected_move: raw.expected_move, atm_iv_avg: raw.atm_iv_avg,
    gex_regime: raw.gex_regime, realized_vol: raw.realized_vol, net_vanna: raw.net_vanna,
    pc_ratio,
    gex_0dte_ratio,
  };
}
/** Collapse /api/vol_skew_multi to a per-strike IV map for the nearest expiration (mirrors capture.ts). */
function skewToStrikeMap(skew) {
  const exps = skew?.expirations;
  if (!exps?.length) return undefined;
  const front = exps.reduce((a, b) => (b.dte < a.dte ? b : a));
  const out = {};
  for (const { strike, iv } of front.data ?? []) {
    if (Number.isFinite(strike) && Number.isFinite(iv)) out[strike.toFixed(1)] = iv;
  }
  return Object.keys(out).length ? out : undefined;
}
const numOr = (v, d = 0) => (typeof v === "number" ? v : d);
const strOr = (v, d = "") => (typeof v === "string" ? v : d);
function summarizeIv(iv) {
  return {
    current_iv: numOr(iv.current_iv), session_start_iv: numOr(iv.session_start_iv),
    iv_change: numOr(iv.iv_change), direction: strOr(iv.direction, "UNKNOWN"), vanna_note: strOr(iv.vanna_detail),
  };
}

export const handler = async (event) => {
  connectLambda(event); // wire Blobs context (classic Lambda-signature function)
  const t = etParts();
  if (!inCaptureWindow(t)) return { statusCode: 200, body: `outside capture window (${t.iso})` };
  if (!USER || !PASS) return { statusCode: 200, body: "ALTARIS_USER/ALTARIS_PASS not set — nothing to capture" };

  try {
    const cookie = await login();
    const [data, greek, ivRaw, skewRaw, oiChangeRaw] = await Promise.all([
      getJson("data", cookie),
      getJson("greek_timeseries", cookie),
      getJson("iv_tracker", cookie).catch(() => null), // IV is enrichment; don't fail the tick on it
      getJson("vol_skew_multi", cookie).catch(() => null), // per-strike IV skew is enrichment too
      getJson("oi_change", cookie).catch(() => null), // day-over-day OI change is enrichment too
    ]);
    const compact = compactSnapshot(data);
    compact.iv_skew = skewToStrikeMap(skewRaw);
    compact.oi_day_bar = oiChangeToBar(oiChangeRaw);
    const record = {
      capturedAt: t.iso,
      data: compact,
      iv: ivRaw ? summarizeIv(ivRaw) : undefined,
      greek, // the as-of cumulative greek timeseries, so backfill scores each tick faithfully
    };
    // Key by ET date/time so backfill can list a day's ticks in order via prefix.
    await getStore("captures").setJSON(`${t.date}/${t.hh}-${t.mm}`, record);
    return { statusCode: 200, body: `captured ${t.iso}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("capture failed:", msg);
    return { statusCode: 200, body: `capture failed: ${msg}` }; // 200 so the cron isn't marked failing
  }
};
