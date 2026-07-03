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
// Per-request timeout: a connected-but-silent endpoint must not hang the whole scheduled
// invocation (mirrors config.fetchTimeoutMs in the local loop).
const FETCH_TIMEOUT_MS = 20000;

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

// US market holidays (observed) — keep in sync with US_MARKET_HOLIDAYS in src/config.ts.
const HOLIDAYS = new Set([
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19",
  "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18",
  "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
]);

// Capture 09:00–16:00 ET, Mon–Fri — the window where the local loop scores boards (09:15 AI start,
// plus the 09:00 pre-open snapshot). Off-hours positioning is static prior-close; no need to store it.
const inCaptureWindow = ({ date, wd, minutes }) => wd >= 1 && wd <= 5 && minutes >= 540 && minutes <= 960 && !HOLIDAYS.has(date);

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
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Altaris login HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}`);
  const cookie = extractCookie(res);
  if (!cookie) throw new Error("Altaris login succeeded but returned no altaris_session cookie.");
  return cookie;
}

async function getJson(endpoint, cookie) {
  const res = await fetch(`${BASE}/${endpoint}`, { headers: { ...BROWSER_HEADERS, cookie }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
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
/** Per-strike gamma/charm split by tenor: d0 (0DTE), w1 (1-7 DTE), w2 (8-14 DTE), m (15+ DTE). */
function bucketHmByDte(hm) {
  const exps = hm?.expirations;
  if (!exps?.length || !hm?.rows) return {};
  const bucketOf = exps.map((e) => (e.dte <= 0 ? "d0" : e.dte <= 7 ? "w1" : e.dte <= 14 ? "w2" : "m"));
  const out = {};
  for (const r of hm.rows) {
    const b = { d0: 0, w1: 0, w2: 0, m: 0 };
    r.cells?.forEach((c, i) => { const k = bucketOf[i]; if (k) b[k] += c ?? 0; });
    out[r.strike.toFixed(1)] = b;
  }
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
    gex_term: bucketHmByDte(raw.gex_hm), charm_term: bucketHmByDte(raw.cex_hm), vanna_term: bucketHmByDte(raw.vannex_hm),
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
/** DTE of the front expiration in the skew — needed to build the risk-neutral density (mirrors capture.ts). */
function frontSkewDte(skew) {
  const exps = skew?.expirations;
  if (!exps?.length) return undefined;
  const dte = exps.reduce((a, b) => (b.dte < a.dte ? b : a)).dte;
  return Number.isFinite(dte) ? dte : undefined;
}
const numOr = (v, d = 0) => (typeof v === "number" ? v : d);
const strOr = (v, d = "") => (typeof v === "string" ? v : d);
function summarizeIv(iv) {
  return {
    current_iv: numOr(iv.current_iv), session_start_iv: numOr(iv.session_start_iv),
    iv_change: numOr(iv.iv_change), direction: strOr(iv.direction, "UNKNOWN"), vanna_note: strOr(iv.vanna_detail),
  };
}

/** Extract net_gex_flip and premium_bar from /api/ladder (mirrors compactLadder in src/altaris.ts). */
function compactLadder(raw) {
  const levels = raw?.levels;
  const net_gex_flip = typeof levels?.net_gex_flip === "number" && Number.isFinite(levels.net_gex_flip)
    ? levels.net_gex_flip : null;
  const premium_bar = {};
  for (const [k, v] of Object.entries(raw?.premium ?? {})) {
    if (typeof v?.net === "number" && Number.isFinite(v.net)) premium_bar[k] = v.net;
  }
  return { net_gex_flip, premium_bar };
}
/** Distil /api/hedge_pressure to the compact summary (no timeseries). */
function compactHedgePressure(raw) {
  return {
    score: raw.score, label: raw.label, sensitivity: raw.sensitivity,
    gamma_pct: raw.gamma_pct, vanna_pct: raw.vanna_pct, charm_pct: raw.charm_pct,
    momentum: raw.momentum, acceleration: raw.acceleration,
  };
}
// --- untapped-endpoint compaction: mirrors the compact* helpers in src/altaris.ts. NOTE: the
// cloud tick deliberately SKIPS heston_surface (~22s server calibration) and unusual_activity
// (~10s) — too slow for the function's time budget; backfilled ticks just score without them. ---
const NEAR_BAND_PCT = 0.025; // mirrors config.nearSpotBandPct
const num2 = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str2 = (v) => (typeof v === "string" ? v : "");
const r2 = (n) => Math.round(n * 100) / 100;

/** Mirror compactLevelAssessment: near-band strikes + A/B grades out to 2× the band. */
function compactLevelAssessment(raw, spot) {
  const band = NEAR_BAND_PCT * spot;
  const rows = Array.isArray(raw.levels) ? raw.levels : [];
  const levels = rows
    .filter((l) => {
      const d = Math.abs(num2(l.strike) - spot);
      return d <= band || (d <= 2 * band && /^[AB]/.test(str2(l.grade)));
    })
    .map((l) => ({
      strike: num2(l.strike), zone: str2(l.zone), grade: str2(l.grade),
      archetype: str2(l.reaction_name), level_type: str2(l.level_type),
      hedge_score: r2(num2(l.hedge_score)), rank_pct: r2(num2(l.rank_pct)),
      oi: Math.round(num2(l.oi)), hedge_desc: str2(l.hedge_desc), drivers_desc: str2(l.drivers_desc),
    }))
    .sort((a, b) => a.strike - b.strike);
  const dom = raw.dominant;
  return {
    gamma_flip: typeof raw.gamma_flip === "number" ? raw.gamma_flip : null,
    zone_label: str2(raw.zone_label),
    dominant: dom ? { strike: num2(dom.strike), zone: str2(dom.zone), grade: str2(dom.grade), archetype: str2(dom.name) } : null,
    levels,
  };
}
/** Mirror compactOpexGravity. */
function compactOpexGravity(raw, spot) {
  const band = 2 * NEAR_BAND_PCT * spot;
  const rows = Array.isArray(raw.gravity_strikes) ? raw.gravity_strikes : [];
  const gravity_strikes = rows
    .filter((g) => Math.abs(num2(g.strike) - spot) <= band)
    .sort((a, b) => num2(b.pull_strength) - num2(a.pull_strength))
    .slice(0, 8)
    .map((g) => ({ strike: num2(g.strike), call_oi: Math.round(num2(g.call_oi)), put_oi: Math.round(num2(g.put_oi)), pull_strength: Math.round(num2(g.pull_strength)) }));
  return {
    expiry_label: str2(raw.expiry_label), dte: num2(raw.dte), hours_to_expiry: r2(num2(raw.hours_to_expiry)),
    max_pain: num2(raw.max_pain), pin_score: r2(num2(raw.pin_score)), total_oi: Math.round(num2(raw.total_oi)),
    gravity_strikes,
  };
}
/** Mirror compactOiAnalytics. */
function compactOiAnalytics(raw) {
  const zone = (v) => (Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === "number") ? v : null);
  return {
    pc_ratio_oi: r2(num2(raw.pc_ratio)), concentration_top5_pct: r2(num2(raw.concentration_top5_pct)),
    oi_center_of_gravity: r2(num2(raw.oi_center_of_gravity)), max_pain_all: num2(raw.max_pain),
    put_heavy_zone: zone(raw.put_heavy_zone), call_heavy_zone: zone(raw.call_heavy_zone),
  };
}
/** Mirror compactLiquidityMap. */
function compactLiquidityMap(raw, spot) {
  const band = NEAR_BAND_PCT * spot;
  const rows = Array.isArray(raw.strikes) ? raw.strikes : [];
  const top = rows
    .filter((s) => Math.abs(num2(s.strike) - spot) <= band)
    .sort((a, b) => num2(b.total_oi) - num2(a.total_oi))
    .slice(0, 10)
    .map((s) => ({ strike: num2(s.strike), call_oi: Math.round(num2(s.call_oi)), put_oi: Math.round(num2(s.put_oi)), call_vol: Math.round(num2(s.call_vol)), put_vol: Math.round(num2(s.put_vol)) }));
  return { expiry_label: str2(raw.expiry_label), dte: num2(raw.dte), top };
}
/** Mirror compactHiro. */
function compactHiro(raw) {
  const series = Array.isArray(raw.series) ? raw.series : [];
  const recent = series.slice(-6).map((p) => num2(p.hiro));
  return {
    direction: str2(raw.direction), current_hiro_m: r2(num2(raw.current_hiro_m)),
    total_gex_m: r2(num2(raw.total_gex_m)), call_gex_m: r2(num2(raw.call_gex_m)), put_gex_m: r2(num2(raw.put_gex_m)),
    last_30m_hiro: recent.length ? r2(recent.reduce((a, b) => a + b, 0)) : null,
  };
}
/** Mirror compactRegimeV2. */
function compactRegimeV2(raw) {
  const votes = (Array.isArray(raw.model_votes) ? raw.model_votes : [])
    .map((v) => ({ model: str2(v.model), vote: str2(v.vote), confidence: r2(num2(v.confidence)) }));
  return {
    consensus: str2(raw.consensus_regime), interpretation: str2(raw.interpretation),
    agreement: `${Math.round(num2(raw.agreement_count))}/${Math.round(num2(raw.total_models))} models agree`,
    p_change: r2(num2(raw.p_change)), expected_dwell: r2(num2(raw.expected_dwell)),
    expected_move_pct: r2(num2(raw.expected_move)), rv30: r2(num2(raw.rv30)), atm_iv: r2(num2(raw.atm_iv)),
    votes,
  };
}
/** Mirror compactVolStats. */
function compactVolStats(raw) {
  return {
    hv10: r2(num2(raw.hv10)), hv20: r2(num2(raw.hv20)), hv30: r2(num2(raw.hv30)),
    atm_iv: r2(num2(raw.atm_iv)), ivr: r2(num2(raw.ivr)), vol_premium: r2(num2(raw.vol_premium)),
    regime: str2(raw.regime), vix9d: r2(num2(raw.vix9d)), vix: r2(num2(raw.vix)), vix3m: r2(num2(raw.vix3m)),
    ts_shape: str2(raw.ts_shape),
  };
}

/** Compact entropy/hurst/garch — mirror compactEntropy/compactHurst/compactGarch in src/altaris.ts. */
function compactEntropy(raw) {
  return { current_entropy: raw.current_entropy, threshold: raw.threshold, status: raw.status };
}
function compactHurst(raw) {
  const last = (w) => { const r = raw.rolling?.[w]; return r?.values?.[r.values.length - 1] ?? null; };
  return { hurst: raw.hurst, label: raw.label, rolling_50: last("50"), rolling_100: last("100") };
}
function compactGarch(raw) {
  // Sigma-band price levels + vol forecast — mirrors compactGarch in src/altaris.ts.
  const ranges = {};
  for (const k of ["0", "1"]) {
    const r = raw.ranges?.[k];
    if (r && [r.low_1s, r.high_1s, r.low_2s, r.high_2s].every((x) => typeof x === "number" && Number.isFinite(x))) {
      ranges[k] = { vol_pct: r.vol_pct, low_1s: r.low_1s, high_1s: r.high_1s, low_2s: r.low_2s, high_2s: r.high_2s };
    }
  }
  const f = raw.forecast_10d;
  const d1 = f?.[0]?.vol_pct, d10 = f?.[f.length - 1]?.vol_pct;
  const forecast = (typeof d1 === "number" && typeof d10 === "number")
    ? { d1_vol_pct: d1, d10_vol_pct: d10, dir: d10 < d1 - 0.5 ? "cooling" : d10 > d1 + 0.5 ? "heating" : "steady" }
    : undefined;
  return {
    daily_vol_pct: raw.daily_vol_pct, annual_vol_pct: raw.annual_vol_pct, alpha: raw.alpha, beta: raw.beta,
    persistence: raw.persistence, half_life: raw.half_life, z_score: raw.z_score, current_regime: raw.current_regime,
    ranges: Object.keys(ranges).length ? ranges : undefined,
    forecast,
  };
}
/** Mirror compactAnomalies. */
function compactAnomalies(raw, etDate) {
  const ups = Array.isArray(raw.anomalies_up) ? raw.anomalies_up : [];
  const downs = Array.isArray(raw.anomalies_down) ? raw.anomalies_down : [];
  const isToday = (p) => (p.time ?? "").startsWith(etDate);
  const all = [...ups.map((p) => ({ ...p, dir: "up" })), ...downs.map((p) => ({ ...p, dir: "down" }))]
    .filter((p) => p.time)
    .sort((a, b) => (a.time < b.time ? -1 : 1));
  const last = all[all.length - 1];
  return {
    threshold: num2(raw.threshold),
    today_up: ups.filter(isToday).length,
    today_down: downs.filter(isToday).length,
    last: last ? { time: last.time, dir: last.dir, ret_pct: r2(num2(last.val) * 100) } : null,
  };
}
/** Mirror compactPutCallSkew. */
function compactPutCallSkew(raw) {
  const term = (Array.isArray(raw.term_structure) ? raw.term_structure : [])
    .slice(0, 4)
    .map((t) => ({ dte: num2(t.dte), rr: r2(num2(t.rr)) }));
  return { current_rr: r2(num2(raw.current_rr)), bias: str2(raw.bias), term };
}
/** Mirror compactSkewIndex. */
function compactSkewIndex(raw) {
  const exps = Array.isArray(raw.expirations) ? raw.expirations : [];
  const front = exps.length ? exps.reduce((a, b) => (num2(b.dte) < num2(a.dte) ? b : a)) : undefined;
  return {
    current_skew: r2(num2(raw.current_skew)),
    risk_level: str2(raw.risk_level),
    front_put_skew_ratio: front ? r2(num2(front.put_skew_ratio)) : null,
  };
}
/** Mirror compactVolRegimeScore. */
function compactVolRegimeScore(raw) {
  const hist = raw.history_status;
  return {
    label: str2(raw.label), mr_score: r2(num2(raw.mr_score)), bo_score: r2(num2(raw.bo_score)),
    nt_score: r2(num2(raw.nt_score)), confidence: r2(num2(raw.confidence)), reasoning: str2(raw.reasoning),
    history_pct_complete: r2(num2(hist?.pct_complete)),
  };
}
/** Mirror compactOi365. */
function compactOi365(raw) {
  const exps = (Array.isArray(raw.expirations) ? raw.expirations : [])
    .slice(0, 6)
    .map((e) => ({ label: str2(e.label), dte: num2(e.dte), total_oi: Math.round(num2(e.total_oi)), pc: r2(num2(e.pc)) }));
  return { expirations: exps };
}

export const handler = async (event) => {
  connectLambda(event); // wire Blobs context (classic Lambda-signature function)
  const t = etParts();
  if (!inCaptureWindow(t)) return { statusCode: 200, body: `outside capture window (${t.iso})` };
  if (!USER || !PASS) return { statusCode: 200, body: "ALTARIS_USER/ALTARIS_PASS not set — nothing to capture" };

  try {
    const cookie = await login();
    // STAGED like src/capture.ts: the fatal endpoints first, alone — the optional storm can
    // starve /api/data past its timeout on the server's small worker pool.
    const [data, greek] = await Promise.all([
      getJson("data", cookie),
      getJson("greek_timeseries", cookie),
    ]);
    const [ivRaw, skewRaw, oiChangeRaw, ladderRaw, hedgeRaw, entropyRaw, hurstRaw, garchRaw,
      assessRaw, opexRaw, oiAnalyticsRaw, liqRaw, hiroRaw, regimeV2Raw, volStatsRaw,
      anomaliesRaw, pcSkewRaw, skewIdxRaw, volRegimeRaw, oi365Raw] = await Promise.all([
      getJson("iv_tracker", cookie).catch(() => null), // IV is enrichment; don't fail the tick on it
      getJson("vol_skew_multi", cookie).catch(() => null), // per-strike IV skew is enrichment too
      getJson("oi_change", cookie).catch(() => null), // day-over-day OI change is enrichment too
      getJson("ladder", cookie).catch(() => null), // net_gex_flip + premium per strike
      getJson("hedge_pressure", cookie).catch(() => null), // dealer hedge flow: sensitivity, score, momentum
      getJson("entropy", cookie).catch(() => null), // flow entropy — backfilled ticks score with it
      getJson("hurst", cookie).catch(() => null), // Hurst persistence
      getJson("garch", cookie).catch(() => null), // GARCH conditional vol
      getJson("level_assessment", cookie).catch(() => null), // Altaris's own per-strike level grading
      getJson("opex_gravity", cookie).catch(() => null), // front-expiry pin mechanics
      getJson("oi_analytics", cookie).catch(() => null), // OI P/C, concentration, heavy zones
      getJson("liquidity_map", cookie).catch(() => null), // front-expiry per-strike liquidity
      getJson("hiro", cookie).catch(() => null), // live dealer-hedging impact tape
      getJson("regime_v2", cookie).catch(() => null), // multi-model regime consensus
      getJson("vol_stats", cookie).catch(() => null), // vol dashboard (IVR, VRP, VIX term)
      getJson("anomalies", cookie).catch(() => null), // z-scored return anomalies
      getJson("put_call_skew", cookie).catch(() => null), // risk-reversal term structure
      getJson("skew_index", cookie).catch(() => null), // tail-risk skew index
      getJson("vol_regime_score", cookie).catch(() => null), // MR/BO/NT vote
      getJson("oi365", cookie).catch(() => null), // OI by expiration
      // heston_surface + unusual_activity + regime_intraday deliberately skipped (too slow for the cloud tick).
    ]);
    const compact = compactSnapshot(data);
    // Reject a degraded/empty /api/data payload (200 returning {} or an HTML interstitial)
    // BEFORE it lands in Blobs — otherwise backfill and board.mts score garbage. Mirrors capture.ts.
    if (typeof compact.spot !== "number" || !Number.isFinite(compact.spot) || !compact.gex_bar || Object.keys(compact.gex_bar).length === 0) {
      throw new Error(`/api/data returned a degraded snapshot (spot=${compact.spot}, gex strikes=${Object.keys(compact.gex_bar ?? {}).length}) — not storing`);
    }
    compact.iv_skew = skewToStrikeMap(skewRaw);
    compact.iv_skew_dte = frontSkewDte(skewRaw);
    compact.oi_day_bar = oiChangeToBar(oiChangeRaw);
    if (ladderRaw) {
      const ladder = compactLadder(ladderRaw);
      if (ladder.net_gex_flip != null) compact.net_gex_flip = ladder.net_gex_flip;
      if (Object.keys(ladder.premium_bar).length) compact.premium_bar = ladder.premium_bar;
    }
    const record = {
      capturedAt: t.iso,
      data: compact,
      iv: ivRaw ? summarizeIv(ivRaw) : undefined,
      greek, // the as-of cumulative greek timeseries, so backfill scores each tick faithfully
      hedge_pressure: hedgeRaw ? compactHedgePressure(hedgeRaw) : undefined,
      entropy: entropyRaw ? compactEntropy(entropyRaw) : undefined,
      hurst: hurstRaw ? compactHurst(hurstRaw) : undefined,
      garch: garchRaw ? compactGarch(garchRaw) : undefined,
      level_assessment: assessRaw ? compactLevelAssessment(assessRaw, compact.spot) : undefined,
      opex_gravity: opexRaw ? compactOpexGravity(opexRaw, compact.spot) : undefined,
      oi_analytics: oiAnalyticsRaw ? compactOiAnalytics(oiAnalyticsRaw) : undefined,
      liquidity: liqRaw ? compactLiquidityMap(liqRaw, compact.spot) : undefined,
      hiro: hiroRaw ? compactHiro(hiroRaw) : undefined,
      regime_v2: regimeV2Raw ? compactRegimeV2(regimeV2Raw) : undefined,
      vol_stats: volStatsRaw ? compactVolStats(volStatsRaw) : undefined,
      anomalies: anomaliesRaw ? compactAnomalies(anomaliesRaw, t.date) : undefined,
      pc_skew: pcSkewRaw ? compactPutCallSkew(pcSkewRaw) : undefined,
      skew_index: skewIdxRaw ? compactSkewIndex(skewIdxRaw) : undefined,
      vol_regime_score: volRegimeRaw ? compactVolRegimeScore(volRegimeRaw) : undefined,
      oi365: oi365Raw ? compactOi365(oi365Raw) : undefined,
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
