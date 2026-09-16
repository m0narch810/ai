// YYY terminal proxy — the single cloud data path for the redesigned front end.
//
// WHY THIS EXISTS: the scoring PC is almost never on any more (school), so a board that only
// renders `dashboard.json` shows a frozen snapshot for days at a time. YYY is public and
// unauthenticated at the source, so the browser can have the WHOLE options-flow surface live
// with the box off — it just can't call YYY directly (no CORS headers, and we don't want the
// upstream URL sitting in client JS). This function is that bridge: one authed request fans out
// to N YYY endpoints in parallel and returns them merged.
//
//   GET /.netlify/functions/yyy?ep=gex,dex,charm&ticker=QQQ
//   → { at, ticker, ok: { gex: {...}, dex: {...} }, err: { charm: "timeout" } }
//
// Endpoints are ALLOWLISTED (EP map below) — the client picks names, never URLs.
// Env: YYY_BASE_URL (same var capture.mjs uses).
import { createHmac, timingSafeEqual } from "node:crypto";

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
const EP = {
  // ── per-strike greeks. All nine share one shape: {spot, total, call_total, put_total,
  //    expiries[8], rows[{strike, call_cells[8], put_cells[8], total}]} — which is exactly what
  //    the spine charts consume. /gex and /theta are the two that deviate (see below).
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
  // iv_surface: keep the moneyness×dte grid (that's the smile we draw) and the raw points, but
  // drop points far out of the wings — 0.80–1.20 moneyness is the whole tradable smile.
  iv_surface: (d) => ({
    ...d,
    points: Array.isArray(d.points)
      ? d.points.filter((p) => p && p.moneyness >= 0.85 && p.moneyness <= 1.15)
      : d.points,
  }),
};

// Per-container memo. YYY recomputes on its own cadence and several clients poll the same
// endpoints from different tabs; 20s of reuse keeps the upstream quiet without ever showing
// a print that's meaningfully behind.
const TTL_MS = 20_000;
const memo = new Map();

async function pull(name, ticker) {
  const key = `${name}:${ticker}`;
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.val;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 22_000);
  try {
    const res = await fetch(BASE() + EP[name](ticker), { signal: ctl.signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let data = await res.json();
    if (SLIM[name]) data = SLIM[name](data);
    memo.set(key, { at: Date.now(), val: data });
    return data;
  } finally {
    clearTimeout(timer);
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

  const ok = {}, err = {};
  await Promise.all(want.map(async (name) => {
    try { ok[name] = await pull(name, ticker); }
    catch (e) { err[name] = e?.name === "AbortError" ? "timeout" : String(e?.message ?? e).slice(0, 160); }
  }));

  return json({ at: new Date().toISOString(), ticker, ok, err });
}
