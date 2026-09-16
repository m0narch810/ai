// Cloud capture: a scheduled function that snapshots the YYY options-flow surface even when the
// PC is off — the box-off backup for the local scoring loop.
//
// Why it exists: the local scoring loop (capture→detect→score→publish) runs as a Windows
// scheduled task ON the PC. If the box is off (you're out), nothing is captured — and the
// options flow at that moment is gone forever, so a reversal that happened while you were away
// can never be calibrated. AI scoring is NOT needed to *preserve* the data: all you need saved
// is the flow snapshot (positioning) + greeks; reversal grading runs later off Yahoo OHLC, which
// is historical and never lost. This function captures the perishable half into Netlify Blobs
// every 15 min during RTH, so `npm run backfill` can reconstruct the missed window.
//
// PROVIDER: YYY (the public research backend behind yyy-bias-web). Mirrors buildYyyRecord() in
// src/yyy.ts so the stored blob is byte-for-byte a local CaptureRecord — keep the two IN SYNC if
// either changes. YYY is unauthenticated, so unlike the old Altaris path there is no login/cookie.
//
// Env (Netlify → Site settings → Environment variables):
//   YYY_BASE_URL  (optional) — defaults to the public Railway backend.
import { connectLambda, getStore } from "@netlify/blobs";

const BASE = (process.env.YYY_BASE_URL?.trim() || "https://web-production-8a6973.up.railway.app").replace(/\/$/, "");
const SYMBOL = process.env.SYMBOL?.trim() || "QQQ";
// Per-request timeout: a connected-but-silent endpoint must not hang the whole scheduled
// invocation (mirrors config.fetchTimeoutMs in the local loop).
const FETCH_TIMEOUT_MS = 20000;

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

async function getJson(endpoint) {
  const url = `${BASE}/${endpoint}${endpoint.includes("?") ? "&" : "?"}ticker=${encodeURIComponent(SYMBOL)}`;
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GET ${endpoint} HTTP ${res.status}`);
  return res.json();
}

// --- mapping: mirrors buildYyyRecord()/its helpers in src/yyy.ts so the stored blob is a local
// CaptureRecord. Keep these in sync if the local versions change. ---
const numOr = (v, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const key = (s) => s.toFixed(1);

// YYY exposures are $M-family; the pipeline convention is raw dollars (/1e6 for display).
const M_TO_RAW = 1e6;
// /vanna_surface quotes in a much smaller unit base — scaled harder so vanna survives the
// downstream /1e6 + 1-decimal display (internally consistent within vanna; see src/yyy.ts).
const VANNA_SCALE = 1e9;

/** Net signed exposure per strike (sum across all DTEs). field = gex|charm|vanna. */
function netBar(points, field, scale = M_TO_RAW) {
  const out = {};
  for (const p of points ?? []) out[key(p.strike)] = (out[key(p.strike)] ?? 0) + numOr(p[field]) * scale;
  return out;
}
/** Same-day (dte===0) slice per strike; nearest expiry if there is no true 0DTE today. */
function zeroDteBar(points, field, scale = M_TO_RAW) {
  const dtes = [...new Set((points ?? []).map((p) => p.dte))];
  if (!dtes.length) return {};
  const target = dtes.includes(0) ? 0 : Math.min(...dtes);
  const out = {};
  for (const p of points) if (p.dte === target) out[key(p.strike)] = (out[key(p.strike)] ?? 0) + numOr(p[field]) * scale;
  return out;
}
/** Per-strike exposure split into tenor buckets (d0 / w1 1-7 / w2 8-14 / m 15+). */
function termBar(points, field, scale = M_TO_RAW) {
  const out = {};
  for (const p of points ?? []) {
    const k = key(p.strike);
    const b = (out[k] ??= { d0: 0, w1: 0, w2: 0, m: 0 });
    const bucket = p.dte <= 0 ? "d0" : p.dte <= 7 ? "w1" : p.dte <= 14 ? "w2" : "m";
    b[bucket] += numOr(p[field]) * scale;
  }
  return out;
}
/** Reduce one /heatmap grid (strike rows × expiry columns) into bar + 0DTE slice + tenor ladder. */
function gridBars(grid, expiries) {
  const rows = grid?.rows;
  if (!rows?.length || !expiries?.length) return null;
  const dtes = expiries.map((e) => numOr(e.dte, 0));
  const minDte = Math.min(...dtes);
  const bar = {}, d0 = {}, term = {};
  for (const r of rows) {
    if (!Number.isFinite(r.strike) || !Array.isArray(r.cells)) continue;
    const k = key(r.strike);
    const b = (term[k] ??= { d0: 0, w1: 0, w2: 0, m: 0 });
    for (let i = 0; i < r.cells.length && i < dtes.length; i++) {
      const v = numOr(r.cells[i]) * M_TO_RAW;
      if (v === 0) continue;
      bar[k] = (bar[k] ?? 0) + v;
      const dte = dtes[i];
      if (dte === minDte) d0[k] = (d0[k] ?? 0) + v;
      b[dte <= 0 ? "d0" : dte <= 7 ? "w1" : dte <= 14 ? "w2" : "m"] += v;
    }
  }
  return Object.keys(bar).length ? { bar, d0, term } : null;
}
/** Net-GEX flip strike: cumulative net dealer gamma crosses zero scanning low→high. */
function netGexFlip(gexBar, spot) {
  const strikes = Object.keys(gexBar).map(Number).sort((a, b) => a - b);
  if (!strikes.length) return spot;
  let cum = 0;
  for (const k of strikes) {
    const prev = cum;
    cum += gexBar[key(k)] ?? 0;
    if (prev !== 0 && Math.sign(cum) !== Math.sign(prev)) return k;
  }
  return spot;
}
function wallStrikes(gexBar, side, n = 3) {
  const entries = Object.entries(gexBar).map(([k, v]) => ({ s: Number(k), v }));
  const sorted = side === "call"
    ? entries.filter((e) => e.v > 0).sort((a, b) => b.v - a.v)
    : entries.filter((e) => e.v < 0).sort((a, b) => a.v - b.v);
  return sorted.slice(0, n).map((e) => e.s);
}
/** Per-strike OI + volume by side from /flow.sentiment_data. */
function oiVolBars(flow) {
  const oi = {}, vol = {};
  for (const s of flow?.sentiment_data ?? []) {
    const k = key(s.strike);
    (oi[k] ??= { calls: 0, puts: 0 });
    (vol[k] ??= { calls: 0, puts: 0 });
    if (s.side === "call") { oi[k].calls += numOr(s.oi); vol[k].calls += numOr(s.volume); }
    else { oi[k].puts += numOr(s.oi); vol[k].puts += numOr(s.volume); }
  }
  return { oi, vol };
}
/** Per-strike front/0DTE IV (%) from the /net_iv matrix. */
function ivSkewFromNetIv(net) {
  const rows = net?.rows, dtes = net?.dte_list;
  if (!rows?.length || !dtes?.length) return {};
  let idx = dtes.indexOf(0);
  if (idx < 0) idx = dtes.indexOf(Math.min(...dtes));
  const out = {};
  for (const r of rows) {
    const cell = r.cells?.[idx];
    if (Number.isFinite(r.strike) && typeof cell === "number" && Number.isFinite(cell)) out[key(r.strike)] = cell * 100;
  }
  return Object.keys(out).length ? { iv_skew: out, iv_skew_dte: Math.max(0, dtes[idx] ?? 0) } : {};
}

function toGarch(prob, vf) {
  if (!prob && !vf) return undefined;
  const persistence = numOr(vf?.persistence, 0.9);
  const b1 = prob?.bands_1d?.["68"], b2 = prob?.bands_1d?.["95"];
  const ranges = b1 && b2
    ? { "0": { vol_pct: numOr(prob?.sigma_daily_pct), low_1s: b1[0], high_1s: b1[1], low_2s: b2[0], high_2s: b2[1] } }
    : undefined;
  return {
    daily_vol_pct: numOr(prob?.sigma_daily_pct), annual_vol_pct: numOr(prob?.sigma_ann_pct, numOr(vf?.realized_20)),
    alpha: 0, beta: 0, persistence,
    half_life: persistence < 1 ? Math.log(0.5) / Math.log(persistence) : 0,
    z_score: 0, current_regime: (vf?.vol_regime || "normal").toLowerCase(), ranges,
  };
}
function toRegimeV2(bias) {
  const b = bias?.bias;
  if (!b) return undefined;
  const votes = Object.entries(b.votes ?? {}).map(([model, v]) => ({
    model, vote: v > 0.1 ? "bull" : v < -0.1 ? "bear" : "neutral", confidence: Math.min(1, Math.abs(v)),
  }));
  return {
    consensus: `${b.direction ?? "NEUTRAL"} / ${b.size_rule ?? "—"}`, interpretation: b.narrative ?? "",
    agreement: `${votes.filter((v) => v.vote !== "neutral").length}/${votes.length} models directional`,
    p_change: b.low_confidence ? 0.6 : 0.3, expected_dwell: 0,
    expected_move_pct: numOr(bias?.gex?.expected_move_pct), rv30: 0, atm_iv: numOr(bias?.gex?.atm_iv), votes,
  };
}
function toEntropy(bias) {
  const e = bias?.entropy;
  if (!e || e.entropy == null) return undefined;
  return { current_entropy: numOr(e.entropy), threshold: numOr(e.threshold), status: e.status ?? "UNKNOWN" };
}
function toHurst(bias) {
  const t = bias?.topology;
  if (!t || t.h64 == null) return undefined;
  return { hurst: numOr(t.h64), label: t.hurst_regime ?? "", rolling_50: numOr(t.h32, 0), rolling_100: numOr(t.h64, 0) };
}
function toLevelAssessment(lv) {
  if (!lv || (!lv.hod?.length && !lv.lod?.length)) return undefined;
  const grade = (c) => (c >= 0.7 ? "A" : c >= 0.4 ? "B" : "C");
  const mk = (e, zone) => ({
    strike: e.price, zone, grade: grade(e.confidence),
    archetype: e.confluence >= 4 ? "The Bedrock" : e.confluence <= 1 ? "The Trapdoor" : "Standard",
    level_type: e.confidence >= 0.5 ? "SAFE" : "NEUTRAL",
    hedge_score: e.confidence, rank_pct: e.confidence, oi: 0,
    hedge_desc: `${e.confluence}-method confluence`, drivers_desc: (e.methods ?? []).join(", "),
  });
  const levels = [...(lv.hod ?? []).map((e) => mk(e, "R")), ...(lv.lod ?? []).map((e) => mk(e, "S"))];
  const dom = levels.slice().sort((a, b) => b.rank_pct - a.rank_pct)[0] ?? null;
  return {
    gamma_flip: null, zone_label: lv.regime ? `Regime: ${lv.regime}` : "",
    dominant: dom ? { strike: dom.strike, zone: dom.zone, grade: dom.grade, archetype: dom.archetype } : null,
    levels,
  };
}
function toHiro(da) {
  if (!da) return undefined;
  const z = numOr(da.current_z);
  const recent = (da.bar_deltas ?? []).slice(-6);
  return {
    direction: z > 1 ? "BUY PRESSURE" : z < -1 ? "SELL PRESSURE" : "BALANCED",
    current_hiro_m: z, total_gex_m: 0, call_gex_m: 0, put_gex_m: 0,
    last_30m_hiro: recent.length ? recent.reduce((s, d) => s + numOr(d), 0) : null,
  };
}
function toAnomalies(da, etDate) {
  if (!da?.anomalies) return undefined;
  const today = da.anomalies.filter((a) => (a.time ?? "").startsWith(etDate));
  const last = da.anomalies[da.anomalies.length - 1] ?? null;
  return {
    threshold: numOr(da.z_threshold, 2),
    today_up: today.filter((a) => a.direction === "BUY" || a.bar_delta > 0).length,
    today_down: today.filter((a) => a.direction === "SELL" || a.bar_delta < 0).length,
    last: last ? { time: last.time, dir: last.bar_delta >= 0 ? "up" : "down", ret_pct: numOr(last.z) } : null,
  };
}
function toPcSkew(flow) {
  if (!flow || (flow.put_25d_skew == null && flow.call_25d_skew == null)) return undefined;
  return { current_rr: numOr(flow.put_25d_skew) - numOr(flow.call_25d_skew), bias: flow.skew_regime ?? flow.skew_note ?? "", term: [] };
}
function toIv(em, vf) {
  const cur = numOr(em?.atm_iv);
  if (!cur) return undefined;
  const dir = (vf?.vol_trend || "").toUpperCase();
  return {
    current_iv: cur, session_start_iv: cur, iv_change: 0,
    direction: dir.includes("RIS") || dir.includes("HEAT") ? "RISING" : dir.includes("FALL") || dir.includes("COOL") ? "FALLING" : "STABLE",
    vanna_note: "",
  };
}

/** Assemble the YYY CaptureRecord + synthesized greek tape. Mirrors buildYyyRecord() in src/yyy.ts. */
function buildRecord(surfaces, iso, etDate) {
  const { gexSurf, heatmap, charmSurf, vannaSurf, dexLadder, flow, netIv, expMove, levels, prob, volFc, bias, dealer } = surfaces;
  const spot = gexSurf.spot;

  // Canonical per-strike greeks: the /heatmap grids (all six greeks, 8 expiries deep).
  // Surfaces (0-3 DTE) are the per-greek fallback; vanna has no grid so it is always surface-fed.
  const hmExp = heatmap?.expiries ?? [];
  const hmGex = gridBars(heatmap?.grids?.gex, hmExp);
  const hmDex = gridBars(heatmap?.grids?.dex, hmExp);
  const hmVex = gridBars(heatmap?.grids?.vex, hmExp);
  const hmTex = gridBars(heatmap?.grids?.tex, hmExp);
  const hmCharm = gridBars(heatmap?.grids?.cex, hmExp);

  const gexBar = hmGex?.bar ?? netBar(gexSurf.points, "gex");
  const charmBar = hmCharm?.bar ?? (charmSurf ? netBar(charmSurf.points, "charm") : {});
  const vannaBar = vannaSurf ? netBar(vannaSurf.points, "vanna", VANNA_SCALE) : {};
  let dexBar;
  if (hmDex) {
    dexBar = hmDex.bar;
  } else {
    dexBar = {};
    for (const l of dexLadder?.ladder ?? []) dexBar[key(l.strike)] = numOr(l.net_dex) * M_TO_RAW;
  }

  const gex0dte = hmGex?.d0 ?? zeroDteBar(gexSurf.points, "gex");
  const { oi, vol } = oiVolBars(flow);
  const { iv_skew, iv_skew_dte } = ivSkewFromNetIv(netIv);

  const flip = netGexFlip(gexBar, spot);
  const majorWall = Object.entries(gexBar).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0]?.[0];
  const gex0dteSlice = Object.entries(gex0dte);
  const cw0 = gex0dteSlice.filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])[0]?.[0];
  const pw0 = gex0dteSlice.filter(([, v]) => v < 0).sort((a, b) => a[1] - b[1])[0]?.[0];
  const mw0 = gex0dteSlice.slice().sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0]?.[0];

  let totC = 0, totP = 0;
  for (const v of Object.values(vol)) { totC += v.calls; totP += v.puts; }
  const pc_ratio = totC > 0 ? Math.round((totP / totC) * 100) / 100 : (flow?.pcr != null ? Math.round(flow.pcr * 100) / 100 : undefined);

  let totalGexAbs = 0, total0dteAbs = 0;
  for (const v of Object.values(gexBar)) totalGexAbs += Math.abs(v);
  for (const v of Object.values(gex0dte)) total0dteAbs += Math.abs(v);
  const gex_0dte_ratio = totalGexAbs > 0 ? Math.round((total0dteAbs / totalGexAbs) * 100) / 100 : undefined;

  const netVanna = Object.values(vannaBar).reduce((s, v) => s + v, 0);
  const atmIv = numOr(expMove?.atm_iv, numOr(levels?.atm_iv));
  const expectedMove = numOr(expMove?.moves?.["1d"]?.move_pts, numOr(levels?.daily_move_est));

  const data = {
    ticker: SYMBOL, spot, timestamp: iso,
    call_wall: numOr(gexSurf.call_wall), put_wall: numOr(gexSurf.put_wall),
    major_wall: majorWall ? Number(majorWall) : spot, max_pain: majorWall ? Number(majorWall) : spot,
    zero_gamma: flip, vol_trigger: flip, total_vol_trigger: flip,
    call_wall_0dte: cw0 ? Number(cw0) : numOr(gexSurf.call_wall),
    put_wall_0dte: pw0 ? Number(pw0) : numOr(gexSurf.put_wall),
    major_wall_0dte: mw0 ? Number(mw0) : (majorWall ? Number(majorWall) : spot),
    call_walls: wallStrikes(gexBar, "call"), put_walls: wallStrikes(gexBar, "put"),
    oi_bar: oi, vol_bar: vol,
    gex_bar: gexBar, dex_bar: dexBar, vex_bar: hmVex?.bar ?? {}, rex_bar: {},
    charm_bar: charmBar, tex_bar: hmTex?.bar ?? {}, vanna_bar: vannaBar,
    gex_0dte_bar: gex0dte,
    charm_0dte_bar: hmCharm?.d0 ?? (charmSurf ? zeroDteBar(charmSurf.points, "charm") : {}),
    vanna_0dte_bar: vannaSurf ? zeroDteBar(vannaSurf.points, "vanna", VANNA_SCALE) : {},
    tex_0dte_bar: hmTex?.d0 ?? {},
    dex_0dte_bar: hmDex?.d0 ?? {},
    vex_0dte_bar: hmVex?.d0 ?? {},
    gex_term: hmGex?.term ?? termBar(gexSurf.points, "gex"),
    charm_term: hmCharm?.term ?? (charmSurf ? termBar(charmSurf.points, "charm") : {}),
    vanna_term: vannaSurf ? termBar(vannaSurf.points, "vanna", VANNA_SCALE) : {},
    dex_term: hmDex?.term ?? {},
    vex_term: hmVex?.term ?? {},
    tex_term: hmTex?.term ?? {},
    atm_iv: atmIv, expected_move: expectedMove,
    atm_iv_avg: flow ? (numOr(flow.avg_call_iv) + numOr(flow.avg_put_iv)) / 2 : atmIv,
    gex_regime: (bias?.gex?.gamma_env || "").toLowerCase().includes("neg") ? "negative"
      : (bias?.gex?.gamma_env || "").toLowerCase().includes("pos") ? "positive" : "",
    realized_vol: numOr(prob?.sigma_ann_pct, numOr(volFc?.realized_20)), net_vanna: netVanna,
    iv_skew, iv_skew_dte, pc_ratio, gex_0dte_ratio, net_gex_flip: flip,
  };

  // Bars are already scaled to raw $ by the reducers.
  const netGex = Object.values(gexBar).reduce((s, v) => s + v, 0);
  const netDex = Object.values(dexBar).reduce((s, v) => s + v, 0);
  const greek = {
    history: [{
      ts: iso, spot, net_gex: netGex,
      call_gex: Object.values(gexBar).filter((v) => v > 0).reduce((s, v) => s + v, 0),
      put_gex: Object.values(gexBar).filter((v) => v < 0).reduce((s, v) => s + v, 0),
      net_dex: netDex, net_vanna: netVanna,
      net_charm: Object.values(charmBar).reduce((s, v) => s + v, 0),
      call_wall: data.call_wall, put_wall: data.put_wall, major_wall: data.major_wall,
    }],
    cumulative_dex: [{ ts: iso, spot, cum_total: netDex, cum_call: 0, cum_put: 0 }],
    dex_flow: [],
  };

  const record = {
    capturedAt: iso, data,
    iv: toIv(expMove, volFc), entropy: toEntropy(bias), hurst: toHurst(bias), garch: toGarch(prob, volFc),
    greek, // the as-of greek tape, so backfill scores each tick faithfully
    level_assessment: toLevelAssessment(levels), hiro: toHiro(dealer), anomalies: toAnomalies(dealer, etDate),
    pc_skew: toPcSkew(flow), regime_v2: toRegimeV2(bias),
  };
  return record;
}

export const handler = async (event) => {
  connectLambda(event); // wire Blobs context (classic Lambda-signature function)
  const t = etParts();
  if (!inCaptureWindow(t)) return { statusCode: 200, body: `outside capture window (${t.iso})` };

  try {
    // Wave 1: the critical GEX surface — everything else is enrichment.
    const gexSurf = await getJson("gex_surface");
    if (typeof gexSurf?.spot !== "number" || !Array.isArray(gexSurf.points) || !gexSurf.points.length) {
      throw new Error(`/gex_surface degraded (spot=${gexSurf?.spot}, points=${gexSurf?.points?.length ?? 0}) — not storing`);
    }
    // Wave 2: the rest, all best-effort (a dark optional feed must not fail the tick).
    const [heatmap, charmSurf, vannaSurf, dexLadder, flow, netIv, expMove, levels, prob, volFc, bias, dealer] = await Promise.all([
      getJson("heatmap").catch(() => null),
      getJson("charm_surface").catch(() => null),
      getJson("vanna_surface").catch(() => null),
      getJson("dex_ladder").catch(() => null),
      getJson("flow").catch(() => null),
      getJson("net_iv").catch(() => null),
      getJson("expected_move").catch(() => null),
      getJson("levels").catch(() => null),
      getJson("probability").catch(() => null),
      getJson("vol_forecast").catch(() => null),
      getJson("bias").catch(() => null),
      getJson("dealer_anomalies").catch(() => null),
    ]);

    const record = buildRecord(
      { gexSurf, heatmap, charmSurf, vannaSurf, dexLadder, flow, netIv, expMove, levels, prob, volFc, bias, dealer },
      t.iso, t.date,
    );
    // Reject a degraded snapshot BEFORE it lands in Blobs (mirrors the guard in src/yyy.ts).
    if (!Number.isFinite(record.data.spot) || Object.keys(record.data.gex_bar).length === 0) {
      throw new Error(`YYY snapshot degraded (spot=${record.data.spot}, gex strikes=${Object.keys(record.data.gex_bar).length}) — not storing`);
    }

    // Key by ET date/time so backfill can list a day's ticks in order via prefix.
    await getStore("captures").setJSON(`${t.date}/${t.hh}-${t.mm}`, record);
    return { statusCode: 200, body: `captured ${t.iso}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("capture failed:", msg);
    return { statusCode: 200, body: `capture failed: ${msg}` }; // 200 so the cron isn't marked failing
  }
};
