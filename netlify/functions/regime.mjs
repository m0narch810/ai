// Market-regime service — runs server-side on Netlify so the Regime tab stays live even when
// the local scoring box is OFF. It's pure math on public data (Yahoo prices + the dealer-gamma
// label already in dashboard.json), so it has no business in the local loop. On-demand with a
// 15-min Netlify-Blobs cache: the heavy compute (GARCH fit, topology, RV percentile) happens at
// most once per 15 min regardless of how many viewers poll.
//
// Pillars (all estimator-grade, parameter-free — no curve-fitting):
//   1. GARCH(1,1) variance-targeted MLE on DAILY returns → conditional vol + persistence (α+β).
//   2. Yang-Zhang realized vol (gap/drift-aware) ranked to a PERCENTILE over ~3y.
//   3. VXN implied vol → variance risk premium (implied − same-horizon realized), percentile-ranked.
//   4. 0-dim persistent homology (topographic prominence) on intraday closes → S/R pivots.
//   5. Kaufman efficiency ratio + Anis-Lloyd-corrected Hurst (trend vs mean-reversion).
// Dealer gamma comes from the published board (static off-RTH, which is correct).
import { connectLambda, getStore } from "@netlify/blobs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
const CACHE_TTL_MS = 15 * 60 * 1000;

async function yahoo(symbol, range, interval) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
  const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" } });
  if (!res.ok) throw new Error(`yahoo ${symbol} ${interval} -> HTTP ${res.status}`);
  return res.json();
}
function closeSeries(j) {
  const c = j?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [];
  return c.filter((x) => x != null && Number.isFinite(x));
}
/** Aligned daily OHLC (drops any row with a null leg) — for the Yang-Zhang vol estimator. */
function ohlcSeries(j) {
  const q = j?.chart?.result?.[0]?.indicators?.quote?.[0] ?? {};
  const o = q.open ?? [], h = q.high ?? [], l = q.low ?? [], c = q.close ?? [];
  const O = [], H = [], L = [], C = [];
  for (let i = 0; i < c.length; i++) {
    if ([o[i], h[i], l[i], c[i]].every((x) => x != null && Number.isFinite(x) && x > 0)) {
      O.push(o[i]); H.push(h[i]); L.push(l[i]); C.push(c[i]);
    }
  }
  return { o: O, h: H, l: L, c: C };
}
function etIso() {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const g = (t) => p.find((x) => x.type === t)?.value ?? "00";
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}:${g("second")}`;
}

// ── stats ──
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const variance = (xs) => { const m = mean(xs); return xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length || 1); };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const ordinal = (n) => { const v = n % 100; return n + (["th", "st", "nd", "rd"][(v - 20) % 10] || ["th", "st", "nd", "rd"][v] || "th"); };
function logReturns(c) { const r = []; for (let i = 1; i < c.length; i++) { const a = c[i - 1], b = c[i]; if (a > 0 && b > 0) r.push(Math.log(b / a)); } return r; }
function slope(xs, ys) { const n = xs.length; if (n < 2) return 0; const mx = mean(xs), my = mean(ys); let num = 0, den = 0; for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; } return den === 0 ? 0 : num / den; }

// ── GARCH(1,1), variance-targeted MLE ──
function garchNll(r, uv, a, b) {
  const w = uv * (1 - a - b); if (w <= 0) return Infinity;
  let s2 = uv, nll = 0;
  for (let i = 0; i < r.length; i++) { const ri = r[i]; nll += 0.5 * (Math.log(s2) + (ri * ri) / s2); s2 = w + a * ri * ri + b * s2; }
  return nll;
}
function fitGarch(ret) {
  const m = mean(ret), r = ret.map((x) => x - m), uv = Math.max(variance(r), 1e-12);
  let best = { a: 0.08, b: 0.9, nll: Infinity };
  for (let a = 0.01; a < 0.4; a += 0.02) for (let b = 0.4; b < 0.985; b += 0.02) {
    if (a + b >= 0.995) continue; const nll = garchNll(r, uv, a, b); if (nll < best.nll) best = { a, b, nll };
  }
  let fine = { ...best };
  for (let a = best.a - 0.018; a <= best.a + 0.018; a += 0.006) for (let b = best.b - 0.018; b <= best.b + 0.018; b += 0.006) {
    if (a <= 0 || b < 0 || a + b >= 0.999) continue; const nll = garchNll(r, uv, a, b); if (nll < fine.nll) fine = { a, b, nll };
  }
  const { a, b } = fine, w = uv * (1 - a - b); let s2 = uv;
  for (let i = 0; i < r.length; i++) { const ri = r[i]; s2 = w + a * ri * ri + b * s2; }
  return { alpha: a, beta: b, sigma2Next: s2 };
}

// ── realized vol (Yang-Zhang) + percentile ──
// Yang-Zhang: overnight var + k·open-to-close var + (1-k)·Rogers-Satchell var. Drift-independent
// and gap-aware, ~5-14× more efficient than close-to-close. k is the YZ-derived optimal weight,
// not a fitted parameter, so this stays calibration-free. Rolling, annualized %.
function yangZhangSeries(o, h, l, c, win) {
  const out = [];
  for (let end = win; end < c.length; end++) {
    const s = end - win + 1;            // window [s..end]; uses c[s-1] as the first prior close
    if (s < 1) continue;
    const ovn = [], oc = []; let rs = 0;
    for (let i = s; i <= end; i++) {
      ovn.push(Math.log(o[i] / c[i - 1]));
      oc.push(Math.log(c[i] / o[i]));
      rs += Math.log(h[i] / c[i]) * Math.log(h[i] / o[i]) + Math.log(l[i] / c[i]) * Math.log(l[i] / o[i]);
    }
    const N = win;
    const mo = mean(ovn), mc = mean(oc);
    const vOvn = ovn.reduce((a, x) => a + (x - mo) ** 2, 0) / (N - 1);
    const vOc = oc.reduce((a, x) => a + (x - mc) ** 2, 0) / (N - 1);
    const vRs = rs / N;
    const k = 0.34 / (1.34 + (N + 1) / (N - 1));
    const yzVar = vOvn + k * vOc + (1 - k) * vRs;
    out.push(Math.sqrt(Math.max(yzVar, 0) * 252) * 100);
  }
  return out;
}
function percentileRank(s, v) { if (!s.length) return 50; const b = s.reduce((n, x) => n + (x <= v ? 1 : 0), 0); return Math.round((b / s.length) * 100); }

// ── trend ──
function efficiencyRatio(c, win = 120) { const seg = c.slice(-win); if (seg.length < 3) return 0; const net = Math.abs(seg[seg.length - 1] - seg[0]); let path = 0; for (let i = 1; i < seg.length; i++) path += Math.abs(seg[i] - seg[i - 1]); return path > 0 ? net / path : 0; }
// Anis-Lloyd/Peters expected (R/S)_n under the no-memory null — used to de-bias the estimate.
function expectedRS(n) {
  let s = 0;
  for (let i = 1; i <= n - 1; i++) s += Math.sqrt((n - i) / i);
  return ((n - 0.5) / n) * (1 / Math.sqrt((n * Math.PI) / 2)) * s;
}
function hurst(ret) {
  const xs = ret.slice(-256); if (xs.length < 32) return 0.5;
  const sizes = [8, 16, 32, 64, 128].filter((s) => s <= xs.length), lN = [], lRS = [], lE = [];
  for (const s of sizes) {
    const ch = Math.floor(xs.length / s); let sum = 0, cnt = 0;
    for (let c = 0; c < ch; c++) {
      const seg = xs.slice(c * s, c * s + s), m = mean(seg); let cum = 0, mn = Infinity, mx = -Infinity;
      for (const v of seg) { cum += v - m; mn = Math.min(mn, cum); mx = Math.max(mx, cum); }
      const S = Math.sqrt(variance(seg)); if (S > 0) { sum += (mx - mn) / S; cnt++; }
    }
    if (cnt > 0) { lN.push(Math.log(s)); lRS.push(Math.log(sum / cnt)); lE.push(Math.log(expectedRS(s))); }
  }
  // Corrected Hurst: 0.5 + (observed R/S slope − theoretical-null R/S slope). Raw R/S overstates
  // persistence on short series; subtracting the null's finite-sample slope removes that bias.
  return clamp(0.5 + slope(lN, lRS) - slope(lN, lE), 0, 1);
}

// ── topology: 0-dim persistent homology via topographic prominence ──
function prominentExtrema(c, kind) {
  const n = c.length, out = [], isMax = kind === "max";
  for (let i = 1; i < n - 1; i++) {
    const v = c[i], p = c[i - 1], nx = c[i + 1];
    if (isMax ? !(v >= p && v > nx) : !(v <= p && v < nx)) continue;
    let L = v, R = v;
    for (let j = i - 1; j >= 0; j--) { const cj = c[j]; if (isMax ? cj > v : cj < v) break; L = isMax ? Math.min(L, cj) : Math.max(L, cj); }
    for (let j = i + 1; j < n; j++) { const cj = c[j]; if (isMax ? cj > v : cj < v) break; R = isMax ? Math.min(R, cj) : Math.max(R, cj); }
    const key = isMax ? Math.max(L, R) : Math.min(L, R), prom = isMax ? v - key : key - v;
    if (prom > 0) out.push({ price: v, prom });
  }
  return out.sort((a, b) => b.prom - a.prom);
}
function dedupe(xs, tol, take) { const k = []; for (const e of xs) { if (k.some((x) => Math.abs(x.price - e.price) <= tol)) continue; k.push(e); if (k.length >= take) break; } return k; }
function topoPivots(c, boardStrikes) {
  const tol = Math.max((c[c.length - 1] ?? 0) * 0.0006, 0.05);
  const mk = (e, side) => ({ price: Math.round(e.price * 100) / 100, side, persistence: Math.round(e.prom * 100) / 100, confluence: boardStrikes.some((s) => Math.abs(s - e.price) <= 0.6) });
  return [
    ...dedupe(prominentExtrema(c, "max"), tol, 4).map((e) => mk(e, "resistance")),
    ...dedupe(prominentExtrema(c, "min"), tol, 4).map((e) => mk(e, "support")),
  ].sort((a, b) => b.persistence - a.persistence);
}
const volLevel = (p) => (p >= 80 ? "high" : p >= 55 ? "elevated" : p >= 25 ? "normal" : "low");

function buildRegime({ spot, intraday, daily, vxn, gammaRegime, boardStrikes }) {
  const now = Date.now();
  const series = intraday.filter((c) => Number.isFinite(c) && c > 0).slice(-480);
  const returns = logReturns(series);
  const dailyRet = logReturns(daily.c); // close-to-close, for the GARCH return model
  const negGamma = /neg/i.test(gammaRegime), posGamma = /pos/i.test(gammaRegime);

  if (returns.length < 30 || dailyRet.length < 40) {
    return {
      as_of: etIso(), generated_at: new Date(now).toISOString(), scored_at: now, spot,
      state: "INSUFFICIENT DATA", read: "Not enough recent data to read the regime yet.",
      bias: "neutral", confidence: 0,
      vol: { rv: 0, rvPercentile: 50, garchAnn: 0, persistence: 0, trend: "steady", level: "normal", sticky: false },
      impliedVol: null,
      trend: { er: 0, hurst: 0.5, direction: "flat" },
      gamma: { regime: gammaRegime || "—", note: "" }, gauges: [], pivots: [], method: "topology+garch",
    };
  }

  const rv10 = yangZhangSeries(daily.o, daily.h, daily.l, daily.c, 10);
  const rv30 = yangZhangSeries(daily.o, daily.h, daily.l, daily.c, 30);
  const rv = rv10[rv10.length - 1] ?? 0, rv30Last = rv30[rv30.length - 1] ?? rv;
  const rvPercentile = percentileRank(rv10, rv);
  const volTrend = rv > rv30Last * 1.08 ? "expanding" : rv < rv30Last * 0.92 ? "contracting" : "steady";
  const gd = fitGarch(dailyRet.slice(-504));
  const persistence = gd.alpha + gd.beta;
  const garchAnn = Math.sqrt(gd.sigma2Next) * Math.sqrt(252) * 100;
  const sticky = persistence > 0.9, level = volLevel(rvPercentile);
  const highVol = rvPercentile >= 75, lowVol = rvPercentile <= 30;

  // ── IMPLIED vol context: VXN (Nasdaq-100 implied vol, ~30d) vs same-horizon realized ──
  // The variance risk premium (implied − realized) is the key read: implied RICH vs realized =
  // protection overpriced → fade/premium-sell regime; implied CHEAP vs realized = the move is
  // under-hedged → continuation/stress. Ranked vs its own ~3y history. VXN matches QQQ's index.
  let impliedVol = null, vrpNote = "";
  if (vxn && vxn.length > 30) {
    const rv21s = yangZhangSeries(daily.o, daily.h, daily.l, daily.c, 21); // ~30 calendar days
    const L = Math.min(vxn.length, rv21s.length);
    const vxnT = vxn.slice(-L), rvT = rv21s.slice(-L);
    const vrpSeries = vxnT.map((iv, i) => iv - rvT[i]);
    const iv = vxn[vxn.length - 1], rv21 = rv21s[rv21s.length - 1] ?? 0, vrp = iv - rv21;
    const vrpPercentile = percentileRank(vrpSeries, vrp);
    const cheap = vrpPercentile <= 30, rich = vrpPercentile >= 70;
    impliedVol = { vxn: Math.round(iv * 10) / 10, rv21: Math.round(rv21 * 10) / 10, vrp: Math.round(vrp * 10) / 10, vrpPercentile, premium: cheap ? "cheap" : rich ? "rich" : "fair" };
    vrpNote = cheap
      ? ` Implied vol (VXN ${iv.toFixed(0)}) is cheap vs realized — the move looks under-hedged; lean continuation and respect breaks.`
      : rich
        ? ` Implied vol (VXN ${iv.toFixed(0)}) is rich vs realized — protection is overpriced; fades and premium-selling are favored.`
        : ` Implied (VXN ${iv.toFixed(0)}) ≈ realized — vol is roughly fairly priced.`;
  }

  const er = efficiencyRatio(series), h = hurst(returns);
  const win = series.slice(-120), wFirst = win[0] ?? 0, wLast = win[win.length - 1] ?? 0;
  const netPct = win.length > 1 && wFirst ? ((wLast - wFirst) / wFirst) * 100 : 0;
  const direction = netPct > 0.15 ? "up" : netPct < -0.15 ? "down" : "flat";
  const trending = er > 0.45, ranging = er < 0.30;

  const stick = sticky ? " and the reading is persistent (slow to decay)" : "";
  let state, read;
  if (negGamma && (trending || highVol) && volTrend === "expanding") {
    state = "VOL EXPANSION · TREND";
    read = `Short-gamma dealers and realized vol expanding (${ordinal(rvPercentile)} pct)${stick} — momentum runs. Trade with the move; reversals at levels are lower-percentage and need wider stops.`;
  } else if (posGamma && ranging && (lowVol || volTrend !== "expanding")) {
    state = "RANGE · PINNED";
    read = `Positive dealer gamma with compressed realized vol (${ordinal(rvPercentile)} pct) — fade the edges. Rest limit orders at the persistent pivots; breakouts tend to fail here.`;
  } else if (negGamma && ranging) {
    state = "CHOP · UNSTABLE";
    read = `Short-gamma but no clean trend, vol ${ordinal(rvPercentile)} pct — whippy and two-sided. Cut size; only the highest-persistence pivots.`;
  } else if (trending && (posGamma || !negGamma)) {
    state = "GRIND · ORDERLY";
    read = `An orderly, supported trend with vol at the ${ordinal(rvPercentile)} pct — dips toward the pivots get bought back. Favour with-trend limits over fading.`;
  } else if (highVol && sticky) {
    state = "VOL STRESS · STICKY";
    read = `Realized vol is rich (${ordinal(rvPercentile)} pct) and persistent — expect range expansion to continue. Widen stops; respect breaks over fades.`;
  } else {
    state = "BALANCED · TRANSITIONAL";
    read = `No single force dominates — mixed structure, vol ${ordinal(rvPercentile)} pct. Let price pick a side at the pivots before committing.`;
  }

  read += vrpNote; // surface the implied-vs-realized read on every regime

  const bias = direction === "up" ? "up" : direction === "down" ? "down" : "neutral";
  const structureClarity = clamp(Math.abs(er - 0.36) / 0.36, 0, 1);
  const volClarity = clamp(Math.abs(rvPercentile - 50) / 50, 0, 1);
  const gammaClarity = posGamma || negGamma ? 0.75 : 0.3;
  const vrpClarity = impliedVol ? clamp(Math.abs(impliedVol.vrpPercentile - 50) / 50, 0, 1) : 0.4;
  const confidence = Math.round(clamp(100 * (0.3 * structureClarity + 0.25 * volClarity + 0.25 * gammaClarity + 0.2 * vrpClarity), 20, 95));

  const gauges = [
    { label: "Realized Vol", value: `${rv.toFixed(0)}% · ${ordinal(rvPercentile)} pct`, pct: clamp(rvPercentile, 2, 100), tone: highVol ? "amber" : lowVol ? "blue" : "" },
    { label: "GARCH Forward", value: `${garchAnn.toFixed(0)}% · ${volTrend}`, pct: clamp((garchAnn / 50) * 100, 2, 100), tone: volTrend === "expanding" ? "amber" : volTrend === "contracting" ? "blue" : "" },
    { label: "Vol Memory · α+β", value: `${persistence.toFixed(2)} · ${sticky ? "sticky" : "fast decay"}`, pct: clamp(persistence * 100, 2, 100), tone: sticky ? "amber" : "" },
    ...(impliedVol ? [
      { label: "Implied · VXN", value: `${impliedVol.vxn}% · 30d`, pct: clamp((impliedVol.vxn / 50) * 100, 2, 100), tone: impliedVol.vxn >= 28 ? "amber" : "" },
      { label: "Vol Risk Premium", value: `${impliedVol.vrp >= 0 ? "+" : ""}${impliedVol.vrp} · ${ordinal(impliedVol.vrpPercentile)} pct`, pct: clamp(impliedVol.vrpPercentile, 2, 100), tone: impliedVol.premium === "cheap" ? "red" : impliedVol.premium === "rich" ? "blue" : "" },
    ] : []),
    { label: "Trend · ER", value: `${er.toFixed(2)} · ${trending ? "trend" : ranging ? "range" : "mixed"}`, pct: clamp(er * 100, 2, 100), tone: trending ? "green" : ranging ? "blue" : "" },
    { label: "Trend Memory · Hurst", value: `${h.toFixed(2)} · ${h > 0.55 ? "trending" : h < 0.45 ? "mean-rev" : "random"}`, pct: clamp(h * 100, 2, 100), tone: h > 0.55 ? "green" : h < 0.45 ? "blue" : "" },
    { label: "Dealer Gamma", value: posGamma ? "Positive · suppressing" : negGamma ? "Negative · amplifying" : (gammaRegime || "—"), pct: posGamma ? 30 : negGamma ? 90 : 55, tone: negGamma ? "red" : posGamma ? "blue" : "" },
  ];

  return {
    as_of: etIso(), generated_at: new Date(now).toISOString(), scored_at: now, spot: Math.round(spot * 100) / 100,
    state, read, bias, confidence,
    vol: { rv: Math.round(rv * 10) / 10, rvPercentile, garchAnn: Math.round(garchAnn * 10) / 10, persistence: Math.round(persistence * 1000) / 1000, trend: volTrend, level, sticky },
    impliedVol,
    trend: { er: Math.round(er * 1000) / 1000, hurst: Math.round(h * 1000) / 1000, direction },
    gamma: { regime: gammaRegime || "—", note: negGamma ? "amplifies moves (trend)" : posGamma ? "suppresses moves (mean-revert)" : "neutral" },
    gauges, pivots: topoPivots(series, boardStrikes), method: "topology+garch",
  };
}

const json = (statusCode, body) => ({
  statusCode,
  headers: { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store, max-age=0" },
  body: JSON.stringify(body),
});

export const handler = async (event) => {
  connectLambda(event); // wire Blobs context from the event (classic Lambda-signature function)
  const force = event?.queryStringParameters?.force === "1";
  const store = getStore("regime-cache");

  if (!force) {
    const cached = await store.get("latest", { type: "json" }).catch(() => null);
    if (cached && Date.now() - (cached.scored_at || 0) < CACHE_TTL_MS) return json(200, cached);
  }

  try {
    // Dealer-gamma label + board strikes come from the published board (static off-RTH = correct).
    let gammaRegime = "", boardStrikes = [];
    try {
      const dres = await fetch(`${process.env.URL}/dashboard.json?t=${Date.now()}`, { headers: { "cache-control": "no-store" } });
      if (dres.ok) { const d = await dres.json(); gammaRegime = d.regime || ""; boardStrikes = (d.levels || []).map((l) => l.strike); }
    } catch { /* board optional — regime still computes from price alone */ }

    const [intraJ, dailyJ, vxnJ] = await Promise.all([
      yahoo("QQQ", "1mo", "15m"),
      yahoo("QQQ", "3y", "1d"),
      yahoo("^VXN", "3y", "1d").catch(() => null), // implied vol — tolerate a miss
    ]);
    const intraday = closeSeries(intraJ), daily = ohlcSeries(dailyJ);
    const vxn = vxnJ ? closeSeries(vxnJ) : [];
    const regime = buildRegime({ spot: intraday[intraday.length - 1] ?? 0, intraday, daily, vxn, gammaRegime, boardStrikes });
    await store.setJSON("latest", regime);
    return json(200, regime);
  } catch (err) {
    // On a Yahoo hiccup, serve the last good cached regime rather than nothing.
    const cached = await store.get("latest", { type: "json" }).catch(() => null);
    if (cached) return json(200, cached);
    return json(502, { error: err instanceof Error ? err.message : String(err) });
  }
};
