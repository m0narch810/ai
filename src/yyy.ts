// YYY data-provider adapter.
//
// Fetches the YYY research backend (the engine behind the yyy-bias-web board) and reshapes it into
// the EXACT same CaptureRecord/DataSnapshot the rest of the pipeline already consumes from Altaris —
// so detect/score/publish need no changes. YYY is the primary capture source; Altaris backs it up
// (see captureTick in src/capture.ts). All YYY endpoints are public (no auth).
//
// Provider notes discovered from the live API (2026-07-17):
//  - /gex_surface /charm_surface /vanna_surface: per-strike, per-DTE points, QQQ-denominated.
//    GEX is SIGNED (calls +, puts −), so net per-strike = sum of all points at that strike.
//  - /dex_ladder: net_dex per strike (QQQ).
//  - /flow.sentiment_data: per-strike QQQ OI + volume by side → oi_bar / vol_bar.
//  - /net_iv: per-strike IV matrix across expiries → iv_skew (front/0DTE column).
//  - /levels: RND+entropy-σ+OI-exposure+PC-skew confluence-scored HOD/LOD → level_assessment.
//  - /bias: an internal DIFFERENT price scale (~10.79× QQQ) — use only its scale-free reads
//    (direction, votes, gamma_env, entropy, Hurst), NEVER its strike levels.
//  - /probability: 886-day empirical distribution + σ price bands → garch.ranges.
//  - /heatmap: ALL SIX greek grids (gex, dex, vex=vega, tex=theta, cex=charm, vegaex) as
//    strike × expiry matrices over the 8 front expiries (≈ 0-8 DTE). This is the canonical
//    per-strike greek source: aggregate bars, 0DTE slices, and tenor ladders for every greek.
//    The `m` (15d+) tenor bucket is structurally empty at this depth — w2 is the horizon cap.
//    Surfaces (/gex_surface /charm_surface /vanna_surface, 0-3 DTE) remain the fallback; vanna
//    has no heatmap grid so it always comes from /vanna_surface.
//  - UNITS: YYY quotes exposures in $M-family units per greek (magnitudes are internally
//    consistent WITHIN one greek, not comparable ACROSS greeks). The pipeline convention
//    (Altaris) is raw dollars with /1e6 display — so every bar is scaled ×1e6 at this
//    boundary. Skipping that scale zeroes out every greek magnitude downstream (live bug
//    2026-07-17→19: gex_profile/term_profile/gex_m all rendered 0).
//  - opex_gravity, liquidity, unusual_activity, day-over-day oi_change have NO YYY source —
//    left undefined; Altaris backup covers them if needed.

import { config, nowInSessionTz } from "./config.js";
import type {
  AnomalySummary, AssessedLevel, CaptureRecord, DataSnapshot, EntropySummary, GarchSummary,
  GreekTimeseries, HiroSummary, HurstSummary, IvSummary, LevelAssessmentSummary, PcSkewSummary,
  RegimeV2Summary, StrikeMap, StrikePair, TermBuckets,
} from "./types.js";

const numOr = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const key = (strike: number) => strike.toFixed(1);

/** GET JSON with the shared fetch timeout. YYY is unauthenticated. */
async function getJson<T = Record<string, unknown>>(path: string): Promise<T> {
  const url = `${config.yyyBaseUrl}${path}${path.includes("?") ? "&" : "?"}ticker=${encodeURIComponent(config.symbol)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.fetchTimeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`YYY ${path} → HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

// ── raw YYY response shapes (only the fields we read) ──────────────────────────────
interface SurfacePoint { strike: number; dte: number; is_put: boolean; gex?: number; charm?: number; vanna?: number }
interface GexSurface { spot: number; call_wall: number; put_wall: number; points: SurfacePoint[] }
interface Surface { spot: number; points: SurfacePoint[] }
interface DexLadder { spot: number; ladder: { strike: number; net_dex: number }[] }
interface FlowResp {
  spot: number; pcr?: number; avg_call_iv?: number; avg_put_iv?: number;
  put_25d_skew?: number; call_25d_skew?: number; skew_regime?: string; skew_note?: string;
  sentiment_data?: { strike: number; side: string; volume?: number; oi?: number }[];
}
interface NetIvResp { rows?: { strike: number; cells: number[] }[]; dte_list?: number[] }
interface ExpectedMove {
  atm_iv?: number; iv_percentile?: number;
  moves?: Record<string, { move_pts?: number; move_pct?: number }>;
}
interface LevelsResp {
  spot: number; regime?: string; atm_iv?: number; daily_move_est?: number; asymmetry_label?: string;
  hod?: { price: number; methods: string[]; confluence: number; confidence: number }[];
  lod?: { price: number; methods: string[]; confluence: number; confidence: number }[];
}
interface ProbabilityResp {
  sigma_daily_pct?: number; sigma_ann_pct?: number; mu_ann_pct?: number;
  bands_1d?: Record<string, [number, number]>;
}
interface VolForecast { persistence?: number; vol_regime?: string; vol_trend?: string; realized_20?: number; current_vol?: number }
interface BiasResp {
  bias?: { direction?: string; conviction?: number; size_rule?: string; score?: number; narrative?: string;
    votes?: Record<string, number>; killed?: boolean; low_confidence?: boolean };
  topology?: { h16?: number; h32?: number; h64?: number; hurst_regime?: string; pca1?: number; pca2?: number };
  entropy?: { entropy?: number; threshold?: number; status?: string };
  gex?: { gamma_env?: string; net_gex_bn?: number; expected_move_pct?: number; atm_iv?: number };
}
interface DealerAnomalies {
  imbalance?: string; current_z?: number; buy_count?: number; sell_count?: number; z_threshold?: number;
  bar_deltas?: number[];
  anomalies?: { time: string; z: number; price: number; direction: string; magnitude: string; bar_delta: number }[];
}
interface HeatmapGrid { rows?: { strike: number; cells: number[] }[] }
interface HeatmapResp {
  spot?: number;
  expiries?: { date?: string; label?: string; dte?: number }[];
  grids?: {
    gex?: HeatmapGrid; dex?: HeatmapGrid; vex?: HeatmapGrid;
    tex?: HeatmapGrid; cex?: HeatmapGrid; vegaex?: HeatmapGrid;
  };
}

// ── per-strike surface reducers ───────────────────────────────────────────────────

// YYY exposures are $M-family; the pipeline convention is raw dollars (/1e6 for display).
// Applied in every reducer so no bar ever leaves this module unscaled.
const M_TO_RAW = 1e6;
// The /vanna_surface quotes in a much smaller unit base (per-strike range ~0.0001-2.2): scaled
// harder so vanna survives the downstream /1e6 + 1-decimal display without collapsing to 0.0.
// Magnitudes stay internally consistent within vanna — the only comparison the scorer makes.
const VANNA_SCALE = 1e9;

/** Net signed exposure per strike (sum across all DTEs). `field` is gex|charm|vanna. */
function netBar(points: SurfacePoint[], field: "gex" | "charm" | "vanna", scale = M_TO_RAW): StrikeMap<number> {
  const out: StrikeMap<number> = {};
  for (const p of points) out[key(p.strike)] = (out[key(p.strike)] ?? 0) + numOr(p[field]) * scale;
  return out;
}

/** Same-day (dte===0) slice per strike; nearest expiry if there is no true 0DTE today. */
function zeroDteBar(points: SurfacePoint[], field: "gex" | "charm" | "vanna", scale = M_TO_RAW): StrikeMap<number> {
  const dtes = [...new Set(points.map((p) => p.dte))];
  if (!dtes.length) return {};
  const target = dtes.includes(0) ? 0 : Math.min(...dtes);
  const out: StrikeMap<number> = {};
  for (const p of points) if (p.dte === target) out[key(p.strike)] = (out[key(p.strike)] ?? 0) + numOr(p[field]) * scale;
  return out;
}

/** Per-strike exposure split into tenor buckets (d0 / w1 1-7 / w2 8-14 / m 15+). */
function termBar(points: SurfacePoint[], field: "gex" | "charm" | "vanna", scale = M_TO_RAW): StrikeMap<TermBuckets> {
  const out: StrikeMap<TermBuckets> = {};
  for (const p of points) {
    const k = key(p.strike);
    const b = (out[k] ??= { d0: 0, w1: 0, w2: 0, m: 0 });
    const bucket: keyof TermBuckets = p.dte <= 0 ? "d0" : p.dte <= 7 ? "w1" : p.dte <= 14 ? "w2" : "m";
    b[bucket] += numOr(p[field]) * scale;
  }
  return out;
}

/**
 * Reduce one /heatmap grid (strike rows × expiry columns) into the three per-strike views:
 * aggregate bar, 0DTE slice (min-DTE column set), and tenor ladder. One pass, scaled to raw $.
 */
function gridBars(
  grid: HeatmapGrid | undefined,
  expiries: { dte?: number }[],
): { bar: StrikeMap<number>; d0: StrikeMap<number>; term: StrikeMap<TermBuckets> } | null {
  const rows = grid?.rows;
  if (!rows?.length || !expiries.length) return null;
  const dtes = expiries.map((e) => numOr(e.dte, 0));
  const minDte = Math.min(...dtes);
  const bar: StrikeMap<number> = {}, d0: StrikeMap<number> = {}, term: StrikeMap<TermBuckets> = {};
  for (const r of rows) {
    if (!Number.isFinite(r.strike) || !Array.isArray(r.cells)) continue;
    const k = key(r.strike);
    const b = (term[k] ??= { d0: 0, w1: 0, w2: 0, m: 0 });
    for (let i = 0; i < r.cells.length && i < dtes.length; i++) {
      const v = numOr(r.cells[i]) * M_TO_RAW;
      if (v === 0) continue;
      bar[k] = (bar[k] ?? 0) + v;
      const dte = dtes[i]!;
      if (dte === minDte) d0[k] = (d0[k] ?? 0) + v;
      b[dte <= 0 ? "d0" : dte <= 7 ? "w1" : dte <= 14 ? "w2" : "m"] += v;
    }
  }
  return Object.keys(bar).length ? { bar, d0, term } : null;
}

/**
 * Net-GEX flip strike: scanning low→high, the price where cumulative net dealer gamma crosses zero.
 * YYY has no explicit zero_gamma/vol_trigger in QQQ units, so we derive it from the signed gex_bar.
 */
function netGexFlip(gexBar: StrikeMap<number>, spot: number): number {
  const strikes = Object.keys(gexBar).map(Number).sort((a, b) => a - b);
  if (!strikes.length) return spot;
  let cum = 0;
  for (const k of strikes) {
    const prev = cum;
    cum += gexBar[key(k)] ?? 0;
    if (prev !== 0 && Math.sign(cum) !== Math.sign(prev)) return k;
  }
  return spot; // never flips → fall back to spot
}

/** Strikes ranked by exposure (calls = most positive gex, puts = most negative), nearest-spot first tiebreak. */
function wallStrikes(gexBar: StrikeMap<number>, side: "call" | "put", n = 3): number[] {
  const entries = Object.entries(gexBar).map(([k, v]) => ({ s: Number(k), v }));
  const sorted = side === "call"
    ? entries.filter((e) => e.v > 0).sort((a, b) => b.v - a.v)
    : entries.filter((e) => e.v < 0).sort((a, b) => a.v - b.v);
  return sorted.slice(0, n).map((e) => e.s);
}

// ── optional-summary mappers ──────────────────────────────────────────────────────

function toGarch(prob: ProbabilityResp | null, vf: VolForecast | null): GarchSummary | undefined {
  if (!prob && !vf) return undefined;
  const persistence = numOr(vf?.persistence, 0.9);
  const b1 = prob?.bands_1d?.["68"];
  const b2 = prob?.bands_1d?.["95"];
  const ranges = b1 && b2
    ? { "0": { vol_pct: numOr(prob?.sigma_daily_pct), low_1s: b1[0], high_1s: b1[1], low_2s: b2[0], high_2s: b2[1] } }
    : undefined;
  return {
    daily_vol_pct: numOr(prob?.sigma_daily_pct),
    annual_vol_pct: numOr(prob?.sigma_ann_pct, numOr(vf?.realized_20)),
    alpha: 0, beta: 0,
    persistence,
    half_life: persistence < 1 ? Math.log(0.5) / Math.log(persistence) : 0,
    z_score: 0,
    current_regime: (vf?.vol_regime || "normal").toLowerCase(),
    ranges,
  };
}

function toRegimeV2(bias: BiasResp | null): RegimeV2Summary | undefined {
  const b = bias?.bias;
  if (!b) return undefined;
  const votes = Object.entries(bias?.bias?.votes ?? {}).map(([model, v]) => ({
    model, vote: v > 0.1 ? "bull" : v < -0.1 ? "bear" : "neutral", confidence: Math.min(1, Math.abs(v)),
  }));
  return {
    consensus: `${b.direction ?? "NEUTRAL"} / ${b.size_rule ?? "—"}`,
    interpretation: b.narrative ?? "",
    agreement: `${votes.filter((v) => v.vote !== "neutral").length}/${votes.length} models directional`,
    p_change: b.low_confidence ? 0.6 : 0.3,
    expected_dwell: 0,
    expected_move_pct: numOr(bias?.gex?.expected_move_pct),
    rv30: 0,
    atm_iv: numOr(bias?.gex?.atm_iv),
    votes,
  };
}

function toEntropy(bias: BiasResp | null): EntropySummary | undefined {
  const e = bias?.entropy;
  if (!e || e.entropy == null) return undefined;
  return { current_entropy: numOr(e.entropy), threshold: numOr(e.threshold), status: e.status ?? "UNKNOWN" };
}

function toHurst(bias: BiasResp | null): HurstSummary | undefined {
  const t = bias?.topology;
  if (!t || t.h64 == null) return undefined;
  return { hurst: numOr(t.h64), label: t.hurst_regime ?? "", rolling_50: numOr(t.h32, 0), rolling_100: numOr(t.h64, 0) };
}

/** YYY /levels confluence engine → the terminal-style per-strike level grading. */
function toLevelAssessment(lv: LevelsResp | null): LevelAssessmentSummary | undefined {
  if (!lv || (!lv.hod?.length && !lv.lod?.length)) return undefined;
  const grade = (c: number) => (c >= 0.7 ? "A" : c >= 0.4 ? "B" : "C");
  const mk = (e: { price: number; methods: string[]; confluence: number; confidence: number }, zone: string): AssessedLevel => ({
    strike: e.price, zone, grade: grade(e.confidence),
    archetype: e.confluence >= 4 ? "The Bedrock" : e.confluence <= 1 ? "The Trapdoor" : "Standard",
    level_type: e.confidence >= 0.5 ? "SAFE" : "NEUTRAL",
    hedge_score: e.confidence, rank_pct: e.confidence, oi: 0,
    hedge_desc: `${e.confluence}-method confluence`, drivers_desc: e.methods.join(", "),
  });
  const levels = [...(lv.hod ?? []).map((e) => mk(e, "R")), ...(lv.lod ?? []).map((e) => mk(e, "S"))];
  const dom = levels.slice().sort((a, b) => b.rank_pct - a.rank_pct)[0] ?? null;
  return {
    gamma_flip: null,
    zone_label: lv.regime ? `Regime: ${lv.regime}` : "",
    dominant: dom ? { strike: dom.strike, zone: dom.zone, grade: dom.grade, archetype: dom.archetype } : null,
    levels,
  };
}

/** Dealer-flow anomaly tape → HIRO-style live impulse read. */
function toHiro(da: DealerAnomalies | null): HiroSummary | undefined {
  if (!da) return undefined;
  const z = numOr(da.current_z);
  const last30 = (da.bar_deltas ?? []).slice(-6).reduce((s, d) => s + numOr(d), 0);
  return {
    direction: z > 1 ? "BUY PRESSURE" : z < -1 ? "SELL PRESSURE" : "BALANCED",
    current_hiro_m: z, total_gex_m: 0, call_gex_m: 0, put_gex_m: 0,
    last_30m_hiro: (da.bar_deltas?.length ?? 0) ? last30 : null,
  };
}

function toAnomalies(da: DealerAnomalies | null, date: string): AnomalySummary | undefined {
  if (!da?.anomalies) return undefined;
  const today = da.anomalies.filter((a) => a.time?.startsWith(date));
  const last = da.anomalies[da.anomalies.length - 1] ?? null;
  return {
    threshold: numOr(da.z_threshold, 2),
    today_up: today.filter((a) => a.direction === "BUY" || a.bar_delta > 0).length,
    today_down: today.filter((a) => a.direction === "SELL" || a.bar_delta < 0).length,
    last: last ? { time: last.time, dir: last.bar_delta >= 0 ? "up" : "down", ret_pct: numOr(last.z) } : null,
  };
}

function toPcSkew(flow: FlowResp | null): PcSkewSummary | undefined {
  if (!flow || (flow.put_25d_skew == null && flow.call_25d_skew == null)) return undefined;
  const rr = numOr(flow.put_25d_skew) - numOr(flow.call_25d_skew);
  return { current_rr: rr, bias: flow.skew_regime ?? flow.skew_note ?? "", term: [] };
}

function toIv(em: ExpectedMove | null, vf: VolForecast | null): IvSummary | undefined {
  const cur = numOr(em?.atm_iv);
  if (!cur) return undefined;
  const dir = (vf?.vol_trend || "").toUpperCase();
  return {
    current_iv: cur, session_start_iv: cur, iv_change: 0,
    direction: dir.includes("RIS") || dir.includes("HEAT") ? "RISING" : dir.includes("FALL") || dir.includes("COOL") ? "FALLING" : "STABLE",
    vanna_note: "",
  };
}

// ── snapshot assembly ─────────────────────────────────────────────────────────────

/** Per-strike OI + volume by side from /flow.sentiment_data (QQQ-denominated). */
function oiVolBars(flow: FlowResp | null): { oi: StrikeMap<StrikePair>; vol: StrikeMap<StrikePair> } {
  const oi: StrikeMap<StrikePair> = {}, vol: StrikeMap<StrikePair> = {};
  for (const s of flow?.sentiment_data ?? []) {
    const k = key(s.strike);
    const isCall = s.side === "call";
    (oi[k] ??= { calls: 0, puts: 0 });
    (vol[k] ??= { calls: 0, puts: 0 });
    if (isCall) { oi[k].calls += numOr(s.oi); vol[k].calls += numOr(s.volume); }
    else { oi[k].puts += numOr(s.oi); vol[k].puts += numOr(s.volume); }
  }
  return { oi, vol };
}

/** Per-strike front/0DTE IV (%) from the /net_iv matrix. */
function ivSkewFromNetIv(net: NetIvResp | null): { iv_skew?: StrikeMap<number>; iv_skew_dte?: number } {
  const rows = net?.rows;
  const dtes = net?.dte_list;
  if (!rows?.length || !dtes?.length) return {};
  let idx = dtes.indexOf(0);
  if (idx < 0) idx = dtes.indexOf(Math.min(...dtes));
  const out: StrikeMap<number> = {};
  for (const r of rows) {
    const cell = r.cells?.[idx];
    if (Number.isFinite(r.strike) && typeof cell === "number" && Number.isFinite(cell)) out[key(r.strike)] = cell * 100; // decimal → %
  }
  return Object.keys(out).length ? { iv_skew: out, iv_skew_dte: Math.max(0, dtes[idx] ?? 0) } : {};
}

/**
 * Fetch all YYY endpoints and assemble a CaptureRecord + synthesized GreekTimeseries in the exact
 * Altaris shape. Throws if the critical GEX surface is degraded (spot/gex missing) — the caller
 * (captureTick) treats that as a signal to fall back to the Altaris backup.
 */
export async function buildYyyRecord(): Promise<{ record: CaptureRecord; greek: GreekTimeseries }> {
  const { iso, date } = nowInSessionTz();

  // Wave 1: the critical GEX surface — everything else is enrichment.
  const gexSurf = await getJson<GexSurface>("/gex_surface");
  if (typeof gexSurf?.spot !== "number" || !Array.isArray(gexSurf.points) || !gexSurf.points.length) {
    throw new Error(`YYY /gex_surface degraded (spot=${gexSurf?.spot}, points=${gexSurf?.points?.length ?? 0})`);
  }

  // Wave 2: the rest, all best-effort (a dark optional feed must not fail the tick).
  const [heatmap, charmSurf, vannaSurf, dexLadder, flow, netIv, expMove, levels, prob, volFc, bias, dealer] =
    await Promise.all([
      getJson<HeatmapResp>("/heatmap").catch(() => null),
      getJson<Surface>("/charm_surface").catch(() => null),
      getJson<Surface>("/vanna_surface").catch(() => null),
      getJson<DexLadder>("/dex_ladder").catch(() => null),
      getJson<FlowResp>("/flow").catch(() => null),
      getJson<NetIvResp>("/net_iv").catch(() => null),
      getJson<ExpectedMove>("/expected_move").catch(() => null),
      getJson<LevelsResp>("/levels").catch(() => null),
      getJson<ProbabilityResp>("/probability").catch(() => null),
      getJson<VolForecast>("/vol_forecast").catch(() => null),
      getJson<BiasResp>("/bias").catch(() => null),
      getJson<DealerAnomalies>("/dealer_anomalies").catch(() => null),
    ]);

  const missing = [
    ["heatmap", heatmap], ["charm_surface", charmSurf], ["vanna_surface", vannaSurf], ["dex_ladder", dexLadder],
    ["flow", flow], ["net_iv", netIv], ["expected_move", expMove], ["levels", levels],
    ["probability", prob], ["vol_forecast", volFc], ["bias", bias], ["dealer_anomalies", dealer],
  ].filter(([, v]) => v == null).map(([k]) => k);
  if (missing.length) console.warn(`[${iso}] YYY capture: optional feeds unavailable: ${missing.join(", ")}`);

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
  let dexBar: StrikeMap<number>;
  if (hmDex) {
    dexBar = hmDex.bar;
  } else {
    dexBar = {};
    for (const l of dexLadder?.ladder ?? []) dexBar[key(l.strike)] = numOr(l.net_dex) * M_TO_RAW;
  }

  const gex0dte = hmGex?.d0 ?? zeroDteBar(gexSurf.points, "gex");
  const { oi, vol } = oiVolBars(flow);
  const { iv_skew, iv_skew_dte } = ivSkewFromNetIv(netIv);

  // Derived structural levels YYY doesn't name in QQQ units.
  const flip = netGexFlip(gexBar, spot);
  const majorWall = Object.entries(gexBar).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0]?.[0];
  const gex0dteSlice = Object.entries(gex0dte);
  const cw0 = gex0dteSlice.filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])[0]?.[0];
  const pw0 = gex0dteSlice.filter(([, v]) => v < 0).sort((a, b) => a[1] - b[1])[0]?.[0];
  const mw0 = gex0dteSlice.slice().sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0]?.[0];

  // pc_ratio: prefer today's volume; fall back to the OI PCR YYY reports.
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

  const data: DataSnapshot = {
    ticker: config.symbol, spot, timestamp: iso,
    call_wall: numOr(gexSurf.call_wall), put_wall: numOr(gexSurf.put_wall),
    major_wall: majorWall ? Number(majorWall) : spot,
    max_pain: majorWall ? Number(majorWall) : spot, // best QQQ-scale proxy (bias.max_pain is a different scale)
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
    realized_vol: numOr(prob?.sigma_ann_pct, numOr(volFc?.realized_20)),
    net_vanna: netVanna,
    iv_skew, iv_skew_dte,
    pc_ratio, gex_0dte_ratio,
    net_gex_flip: flip,
  };

  // Reject a degraded snapshot BEFORE it reaches the scorer (mirrors the Altaris guard).
  if (!Number.isFinite(data.spot) || Object.keys(data.gex_bar).length === 0) {
    throw new Error(`YYY snapshot degraded (spot=${data.spot}, gex strikes=${Object.keys(data.gex_bar).length})`);
  }

  const record: CaptureRecord = {
    capturedAt: iso,
    data,
    iv: toIv(expMove, volFc),
    entropy: toEntropy(bias),
    hurst: toHurst(bias),
    garch: toGarch(prob, volFc),
    level_assessment: toLevelAssessment(levels),
    hiro: toHiro(dealer),
    anomalies: toAnomalies(dealer, date),
    pc_skew: toPcSkew(flow),
    regime_v2: toRegimeV2(bias),
  };

  // YYY has no /greek_timeseries equivalent; synthesize a single current-point tape so downstream
  // net_gex / intraday reads still resolve. Bars are already scaled to raw $ by the reducers.
  const netGex = Object.values(gexBar).reduce((s, v) => s + v, 0);
  const netDex = Object.values(dexBar).reduce((s, v) => s + v, 0);
  const greek: GreekTimeseries = {
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

  return { record, greek };
}
