// YYY terminal proxy — the single cloud data path for the front end.
//
// WHY THIS EXISTS: the scoring PC is almost never on any more, so a board that only renders
// `dashboard.json` shows a frozen snapshot for days at a time. YYY is public and unauthenticated
// at the source, so the browser can have the WHOLE options-flow surface live with the box off —
// it just can't call YYY directly (no CORS headers, and the upstream URL stays out of client JS).
//
//   GET /.netlify/functions/yyy?ep=gex,dex,charm&ticker=QQQ
//   → { at, ticker, ok: { gex: {...}, dex: {...} }, err: { charm: "timeout" }, meta: { gex: {src, age} } }
//
// Endpoints are ALLOWLISTED (EP map below) — the client picks names, never URLs.
//
// CACHE (added 2026-09-16, the load-time fix): three layers, cheapest first.
//   1. per-container memo (20s) — same lambda, back-to-back requests.
//   2. Netlify Blobs "yyy-cache" (75s) — SHARED across every lambda instance and every viewer,
//      and kept warm during market hours by yyy-warm.mjs. This is what makes a cold page load
//      answer in well under a second instead of waiting on a 10–15s upstream route.
//   3. upstream YYY — on a miss, or when the blob is older than the TTL. A successful fetch
//      refreshes the blob. If upstream fails and a blob exists (up to 30 min old), the stale
//      blob is served with `meta.src = "stale"` so a wobble upstream never blanks the terminal.
// Env: YYY_BASE_URL (same var capture.mjs uses).
import { createHmac, timingSafeEqual } from "node:crypto";
import { getStore } from "@netlify/blobs";

const BASE = () => (process.env.YYY_BASE_URL || "https://web-production-8a6973.up.railway.app").replace(/\/$/, "");

function verifyToken(authHeader) {
  const token = (authHeader ?? "").replace(/^Bearer\s+/, "");
  if (!token || !process.env.AUTH_SECRET) return false;
  const dot = token.lastIndexOf(".");
  if (dot < 0) return false;
  const payload = token.slice(0, dot), sig = token.slice(dot + 1);
  const expected = createHmac("sha256", process.env.AUTH_SECRET).update(payload).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  try { const { exp } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); return Number.isFinite(exp) && Date.now() < exp; }
  catch { return false; }
}

/**
 * Allowlist: name → path builder. `t` is the ticker.
 * Anything not in here is rejected, so the client can never point this at an arbitrary URL.
 */
export const EP = {
  // ── per-strike greeks. All nine share one shape: {spot, total, call_total, put_total,
  //    expiries[8], rows[{strike, call_cells[8], put_cells[8], total}]} — which is exactly what
  //    the spine charts consume. /gex and /theta are the two that deviate.
  gex:        (t) => `/gex?ticker=${t}`,
  dex:        (t) => `/dex?ticker=${t}`,
  charm:      (t) => `/charm?ticker=${t}`,
  vanna:      (t) => `/vanna?ticker=${t}`,
  vega:       (t) => `/vega?ticker=${t}`,
  theta:      (t) => `/theta?ticker=${t}`,
  veta:       (t) => `/veta?ticker=${t}`,
  vomma:      (t) => `/vomma?ticker=${t}`,
  rho:        (t) => `/rho?ticker=${t}`,
  // ── vol surface
  //    NOT wired: /heatmap's six aggregate grids. Its column names are a known trap here
  //    (`vex` is vega, `cex` is charm, `vegaex` is unidentified) and the per-greek routes
  //    above already carry the same strike x expiry cells unambiguously.
  iv_surface: (t) => `/iv_surface?ticker=${t}`,
  net_iv:     (t) => `/net_iv?ticker=${t}`,
  // ── vol / probability
  expected_move: (t) => `/expected_move?ticker=${t}`,
  probability:   (t) => `/probability?ticker=${t}`,
  zero_dte:      (t) => `/zero_dte?ticker=${t}`,
  vol_forecast:  () => `/vol_forecast`,
  atr:           (t) => `/atr?ticker=${t}`,
  // ── flow / dealer
  flow:            (t) => `/flow?ticker=${t}`,
  dealer_delta:    (t) => `/dealer_delta?ticker=${t}`,
  dealer_anomalies:(t) => `/dealer_anomalies?ticker=${t}`,
  dex_ladder:      (t) => `/dex_ladder?ticker=${t}`,
  option_matrix:   (t) => `/option-matrix?ticker=${t}`,
  // ── regime / context
  levels:     (t) => `/levels?ticker=${t}`,
  hurst:      () => `/hurst`,
  history:    () => `/history`,
  flux:       () => `/flux`,
  bias:       () => `/bias`,
  macro:      () => `/macro`,
  macro_extended: () => `/macro_extended`,
  scanner:    () => `/scanner`,
  chart:      (t) => `/chart?ticker=${t}&interval=5min`,
};

/**
 * Per-endpoint trimming. A few payloads carry grids the terminal never draws and that would
 * otherwise dominate the response (probability's 80×60 terminal-density heatmap is ~4,800
 * numbers on its own). Everything else passes through untouched.
 */
const SLIM = {
  probability: (d) => { const { heatmap, normal_fit_x, normal_fit_y, ...rest } = d; return rest; },
  iv_surface: (d) => ({
    ...d,
    points: Array.isArray(d.points)
      ? d.points.filter((p) => p && p.moneyness >= 0.85 && p.moneyness <= 1.15)
      : d.points,
  }),
};

const MEMO_MS  = 20_000;
const BLOB_MS  = 75_000;
const STALE_MS = 30 * 60_000;
const memo = new Map();

let _store = undefined;
/** Blobs handle, or null when the store is unavailable (local dev, missing context). */
function blobs() {
  if (_store !== undefined) return _store;
  try { _store = getStore("yyy-cache"); } catch { _store = null; }
  return _store;
}

export const cacheKey = (name, ticker) => `${ticker}/${name}`;

/** Straight to YYY, trimmed. Exported so the warmer uses exactly the same fetch. */
export async function fetchUpstream(name, ticker) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 22_000);
  try {
    const res = await fetch(BASE() + EP[name](ticker), { signal: ctl.signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let data = await res.json();
    if (SLIM[name]) data = SLIM[name](data);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function pull(name, ticker) {
  const key = cacheKey(name, ticker);
  const now = Date.now();

  const m = memo.get(key);
  if (m && now - m.at < MEMO_MS) return { val: m.val, src: "memo", age: now - m.at };

  const store = blobs();
  let blob = null;
  if (store) {
    try { blob = await store.get(key, { type: "json" }); } catch { blob = null; }
    if (blob && typeof blob.at === "number" && now - blob.at < BLOB_MS) {
      memo.set(key, { at: blob.at, val: blob.val });
      return { val: blob.val, src: "blob", age: now - blob.at };
    }
  }

  try {
    const val = await fetchUpstream(name, ticker);
    memo.set(key, { at: now, val });
    if (store) store.setJSON(key, { at: now, val }).catch(() => {});
    return { val, src: "live", age: 0 };
  } catch (e) {
    if (blob && typeof blob.at === "number" && now - blob.at < STALE_MS) {
      return { val: blob.val, src: "stale", age: now - blob.at };
    }
    throw e;
  }
}

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
  },
});

export default async function handler(req) {
  if (!verifyToken(req.headers.get("authorization"))) return json({ error: "Unauthorized" }, 401);

  const url = new URL(req.url);
  const ticker = (url.searchParams.get("ticker") || "QQQ").toUpperCase().replace(/[^A-Z0-9.=^-]/g, "").slice(0, 10) || "QQQ";
  const want = (url.searchParams.get("ep") || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && Object.prototype.hasOwnProperty.call(EP, s));

  if (!want.length) return json({ error: "no valid ep= given", available: Object.keys(EP) }, 400);
  if (want.length > 20) return json({ error: "too many endpoints in one call (max 20)" }, 400);

  const ok = {}, err = {}, meta = {};
  await Promise.all(want.map(async (name) => {
    try {
      const r = await pull(name, ticker);
      ok[name] = r.val;
      meta[name] = { src: r.src, age: r.age };
    } catch (e) {
      err[name] = e?.name === "AbortError" ? "timeout" : String(e?.message ?? e).slice(0, 160);
    }
  }));

  return json({ at: new Date().toISOString(), ticker, ok, err, meta });
}
