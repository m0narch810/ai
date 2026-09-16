// VOL — implied vol surface, term structure, skew and the forward distribution.
//
// The IV smile lives here and is the reason this tab exists. The old build had an "IV SMILE"
// canvas wired to the scored board's `coverage[]`, which is empty off-RTH and empty whenever
// the box is off — so the panel was blank essentially always. It is now driven by YYY's
// /iv_surface grid (moneyness × dte, computed upstream from the live chain), which needs
// nothing from the desk.

import { el, isNum, fmt, compactSigned, strikeLabel } from "../util.js";
import { panel, tag, statGrid, nodata } from "../ui.js";
import { smile, lineChart, bars, cone, matrix, stat, emptyPanel, surface3d, heatSurface } from "../draw.js";
import { smileCurves } from "../data.js";
import { findIvAnomalies } from "../ivanom.js";
import { asciiBar } from "../util.js";

export const ID = "vol";
export const LABEL = "VOL";
export const JP = "波";
export const EPS = ["iv_surface", "net_iv", "expected_move", "probability", "vol_forecast", "flow", "zero_dte"];

export function render(host, ctx) {
  const { ok, err } = ctx.yyy;
  const anom = findIvAnomalies({ net_iv: ok.net_iv, flow: ok.flow, spot: ctx.spot });
  host.replaceChildren(
    statePanel(ok, ctx),
    anomalyPanel(anom, ctx),
    surfacePanel(ok.iv_surface, anom, ctx),
    smilePanel(ok.iv_surface, err, ctx),
    termPanel(ok.net_iv),
    ivGridPanel(ok.net_iv, ctx.spot),
    conePanel(ok.probability, ctx.spot),
    distPanel(ok.probability),
    forecastPanel(ok.vol_forecast),
  );
}

/* ── V0 STATE ────────────────────────────────────────────────────────────── */

function statePanel(ok, ctx) {
  const em = ok.expected_move, fl = ok.flow, vf = ok.vol_forecast, z = ok.zero_dte;
  if (!em && !fl && !vf) return panel({ idx: "V0", title: "VOL STATE", jp: JP, body: ctx.wait("expected_move", "stats", 6) || ctx.wait("flow", "stats", 6) || nodata("NO VOL FEED") });

  const cells = [
    stat("ATM IV", isNum(em?.atm_iv) ? `${em.atm_iv.toFixed(2)}%` : "—", { sub: isNum(em?.iv_percentile) ? `${em.iv_percentile.toFixed(0)}th percentile` : null }),
    stat("0DTE IV", isNum(z?.atm_iv) ? `${z.atm_iv.toFixed(2)}%` : "—", { sub: isNum(z?.dte_hours) ? `${z.dte_hours}h left` : null }),
    stat("VIX", fmt(em?.vix ?? fl?.current_vix, 2), { sub: fl?.vix_regime ? `${fl.vix_regime} · 30d mean ${fmt(fl.vix_mean_30d, 1)}` : null, tone: (fl?.current_vix ?? 0) > (fl?.vix_mean_30d ?? 0) ? "hot" : "cool" }),
    stat("REALIZED", fmt(vf?.current_vol, 2), { sub: vf ? `${vf.vol_regime ?? ""} · ${vf.vol_trend ?? ""}`.trim() : null }),
    stat("SKEW", fmt(fl?.avg_skew, 3), { sub: fl?.skew_regime || null, tone: fl?.skew_regime === "GREED" ? "cool" : fl?.skew_regime === "FEAR" ? "hot" : "" }),
    stat("P/C OI", fmt(fl?.pcr, 2), { sub: fl?.pcr_signal || null }),
  ];

  const notes = [fl?.skew_note, fl?.sentiment_note].filter(Boolean);
  const sentiment = fl?.sentiment
    ? el("div.vsent", null, [
        tag(fl.sentiment, /BEAR/i.test(fl.sentiment) ? "hot" : /BULL/i.test(fl.sentiment) ? "cool" : "mute"),
        el("span.vsent-note", { text: notes.join(" · ") }),
        el("span.vsent-iv", { text: `call ${fmt(fl.avg_call_iv, 1)}% / put ${fmt(fl.avg_put_iv, 1)}% · ratio ${fmt(fl.iv_ratio, 3)}` }),
      ])
    : null;

  const wings = isNum(fl?.put_25d_skew) || isNum(fl?.call_25d_skew)
    ? el("div.wings", null, [
        el("div.wing", null, [el("span.wing-k", { text: "25Δ PUT" }), el("span", { class: `wing-v ${fl.put_25d_skew >= 0 ? "n" : "p"}`, text: compactSigned(fl.put_25d_skew, 2) })]),
        el("div.wing", null, [el("span.wing-k", { text: "25Δ CALL" }), el("span", { class: `wing-v ${fl.call_25d_skew >= 0 ? "p" : "n"}`, text: compactSigned(fl.call_25d_skew, 2) })]),
      ])
    : null;

  return panel({ idx: "V0", title: "VOL STATE", jp: JP, body: [statGrid(cells), sentiment, wings] });
}

/* ── V0a IV ANOMALIES ────────────────────────────────────────────────────── */

/**
 * The strikes the surface is kinked at, mapped onto a ladder. See ivanom.js for the three
 * reads; here each strike shows its combined score as a glyph bar, its tilt (rich = the
 * market is paying up there, cheap = it is being sold), and one chip per reason.
 */
function anomalyPanel(anom, ctx) {
  const inflight = ctx.wait("net_iv", "rows", 8) || ctx.wait("flow", "rows", 8);
  if (!anom.byStrike.length && inflight) {
    return panel({ idx: "V0", title: "IV ANOMALIES", body: inflight });
  }
  const spot = ctx.spot;
  const top = anom.byStrike.slice(0, 14).sort((a, b) => b.strike - a.strike);
  const maxScore = Math.max(1, ...top.map((s) => s.score));

  let railDone = false;
  const rows = top.map((s) => {
    const rail = !railDone && isNum(spot) && s.strike <= spot;
    if (rail) railDone = true;
    const chips = s.hits.slice(0, 4).map((h) => {
      if (h.kind === "surface") return tag(`SURF ${h.dte}d ${h.z > 0 ? "+" : "−"}${Math.abs(h.z).toFixed(1)}σ ${(h.r * 100).toFixed(1)}vp`, h.z > 0 ? "cool" : "hot");
      if (h.kind === "skew")    return tag(`SKEW ${h.dir === "call" ? "CALL BID" : "PUT BID"} ${Math.abs(h.z).toFixed(1)}σ`, h.dir === "call" ? "cool" : "hot");
      return tag(`IVZ ${String(h.side || "").toUpperCase()} ${h.z > 0 ? "+" : "−"}${Math.abs(h.z).toFixed(1)}`, h.z > 0 ? "cool" : "hot");
    });
    return el(`div.anl-row${rail ? ".is-rail" : ""}`, null, [
      el("span", { class: `anl-k ${s.dir}`, text: strikeLabel(s.strike) }),
      el("span", { class: `anl-bar ${s.dir}`, text: asciiBar(s.score / maxScore, 8), title: `score ${s.score.toFixed(2)}` }),
      el("span.anl-why", null, [tag(s.dir.toUpperCase(), s.dir === "rich" ? "cool" : s.dir === "cheap" ? "hot" : "mute"), ...chips]),
    ]);
  });

  const c = anom.counts;
  return panel({
    idx: "V0", title: "IV ANOMALIES",
    tools: [tag(`${c.surface} SURF`, "mute"), tag(`${c.skew} SKEW`, "mute"), tag(`${c.ivz} IVZ`, "mute")],
    body: rows.length ? el("div.anl", null, rows) : el("div.anl-empty", { text: "surface is smooth — no strike is kinked past 2σ right now" }),
    note: "rich = IV above the smile its neighbours draw (someone paying up there) · cheap = below it · surface residuals are per-expiry quadratic fits in log-moneyness, skew residuals per-expiry linear, IVZ is the feed's own z · strikes scoring ≥ 2 are added to LEVELS",
  });
}

/* ── V0b IV SURFACE ──────────────────────────────────────────────────────── */

function surfacePanel(ivSurface, anom, ctx) {
  const s = smileCurves(ivSurface);
  if (!s) {
    return panel({ idx: "V1", title: "IV SURFACE", body: ctx.wait("iv_surface", "chart") || nodata("NO IV SURFACE") });
  }
  const spot = isNum(s.spot) ? s.spot : ctx.spot;
  const curves = s.curves.map((c) => ({ ...c, dteIdx: c.rank }));
  // Surface hits are keyed by net_iv's expiry index; map them onto the surface's dte list.
  const dteToIdx = new Map(curves.map((c) => [c.dte, c.dteIdx]));
  const marks = anom.surface
    .filter((h) => dteToIdx.has(h.dte) && isNum(spot))
    .map((h) => ({ dteIdx: dteToIdx.get(h.dte), m: h.strike / spot, iv: h.iv, cheap: h.dir === "cheap" }));

  const ridgeHost = el("div.chart-host");
  const heatHost = el("div.chart-host");
  queueMicrotask(() => {
    surface3d(ridgeHost, { moneyness: s.moneyness, curves, marks, spot });
    heatSurface(heatHost, { moneyness: s.moneyness, curves, marks, spot });
  });

  return panel({
    idx: "V1", title: "IV SURFACE",
    tools: [tag(isNum(s.atm) ? `ATM ${(s.atm * 100).toFixed(2)}%` : "", "mute"), tag(`${marks.length} MARKED`, marks.length ? "cool" : "mute")],
    body: [
      el("div.twin-lbl", { text: "SURFACE \u00b7 moneyness across, expiry into the page, IV up" }),
      ridgeHost,
      el("div.twin-lbl", { text: "GRID · expiry × moneyness, lit by IV level" }),
      heatHost,
    ],
    note: "hover any cell for the exact IV \u00b7 marks are surface anomalies (filled = rich, hollow = cheap) \u00b7 a steep left shoulder that persists into the back rows is structural put demand; a lift that exists only on the front edge is today's positioning",
  });
}

/* ── V1 SMILE ────────────────────────────────────────────────────────────── */

function smilePanel(ivSurface, err, ctx) {
  const s = smileCurves(ivSurface);
  if (!s) {
    return panel({
      idx: "V2", title: "IV SMILE", cls: "half",
      body: ctx.wait("iv_surface", "chart") || nodata(err?.iv_surface ? `iv_surface: ${err.iv_surface}` : "NO IV SURFACE"),
    });
  }

  const host = el("div.chart-host");
  queueMicrotask(() => smile(host, { moneyness: s.moneyness, curves: s.curves, height: 250, spot: ctx.spot }));

  const legend = el("div.smile-key", null, s.curves.map((c) => el("span", {
    class: `sk${c.dte === 0 ? " is-0dte" : ""}`,
    style: `--o:${(1 - Math.min(0.62, c.rank * 0.11)).toFixed(2)}`,
    text: c.dte === 0 ? "0DTE" : `${c.dte}d`,
  })));

  return panel({
    idx: "V2", title: "IV SMILE", cls: "half",
    tools: [tag(isNum(s.atm) ? `ATM ${(s.atm * 100).toFixed(2)}%` : "", "mute")],
    body: [host, legend],
    note: "one curve per expiry, nearest in solid · a steep left wing is paid downside protection; a lifted right wing is call demand",
  });
}

/* ── V2 TERM STRUCTURE + SKEW ────────────────────────────────────────────── */

function termPanel(nv) {
  const ts = nv?.term_structure || [];
  const sk = nv?.skew || [];
  if (!ts.length && !sk.length) return null;

  const termHost = el("div.chart-host");
  const skewHost = el("div.chart-host");

  queueMicrotask(() => {
    if (ts.length) {
      lineChart(termHost, {
        series: [{ name: "atm iv", values: ts.map((r) => (isNum(r.atm_iv) ? r.atm_iv * 100 : NaN)), tone: "cool", fill: true }],
        xTips: ts.map((r) => r.label ?? `${r.dte}d`),
        xLabels: ts.map((r) => (isNum(r.dte) ? `${r.dte}d` : "")),
        fmtY: (n) => `${n.toFixed(0)}%`,
        height: 150,
      });
    } else emptyPanel(termHost);

    if (sk.length) {
      bars(skewHost, {
        values: sk.map((r) => (isNum(r.skew) ? r.skew * 100 : 0)),
        xLabels: sk.map((r) => (isNum(r.dte) ? `${r.dte}d` : "")),
        fmtY: (n) => `${n.toFixed(1)}`,
        tones: sk.map((r) => ((r.skew ?? 0) > 0 ? "n" : "p")),  // put wing over call wing = fear
        tips: sk.map((r) => `${r.label ?? r.dte + "d"} \u00b7 put ${(r.put_wing * 100).toFixed(1)}% / call ${(r.call_wing * 100).toFixed(1)}%`),
        height: 150,
      });
    } else emptyPanel(skewHost);
  });

  const front = ts[0]?.atm_iv, back = ts[ts.length - 1]?.atm_iv;
  const shape = isNum(front) && isNum(back)
    ? (front > back * 1.02 ? "BACKWARDATION" : back > front * 1.02 ? "CONTANGO" : "FLAT")
    : null;

  return panel({
    idx: "V2", title: "TERM STRUCTURE · SKEW", jp: "期間構造", cls: "half",
    tools: shape ? [tag(shape, shape === "BACKWARDATION" ? "hot" : "cool")] : null,
    body: el("div.twin", null, [
      el("div.twin-cell", null, [el("div.twin-lbl", { text: "ATM IV BY EXPIRY" }), termHost]),
      el("div.twin-cell", null, [el("div.twin-lbl", { text: "PUT WING − CALL WING" }), skewHost]),
    ]),
    note: "backwardation = the front is bid, event or stress pricing · positive skew bars = puts paid over calls",
  });
}

/* ── V3 IV BY STRIKE × EXPIRY ────────────────────────────────────────────── */

function ivGridPanel(nv, spot) {
  const rows = (nv?.rows || []).filter((r) => isNum(r?.strike) && Array.isArray(r.cells) && r.cells.some(isNum));
  const exps = nv?.expiries || [];
  if (!rows.length || !exps.length) return null;

  // Window to the tradable band; the full 84-strike ladder is mostly nulls in the wings.
  const near = [...rows]
    .sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))
    .slice(0, 24)
    .sort((a, b) => b.strike - a.strike);

  const cols = exps.map((e, i) => {
    const m = String(e).match(/^\s*([\d-]+)/);
    return { label: m ? m[1] : String(e), sub: isNum(nv.dte_list?.[i]) ? `${nv.dte_list[i]}d` : "" };
  });

  // Centre each column on ITS OWN expiry's at-the-money, not on the front month's. IV rises
  // sharply into expiry, so a shared 0DTE baseline would paint every back-month column
  // uniformly "cheap" and hide the actual smile shape inside each tenor.
  const atmByExp = exps.map((_, i) => nv.term_structure?.[i]?.atm_iv);
  const frontAtm = atmByExp.find(isNum);
  let railDone = false;
  const mrows = near.map((r) => {
    const rail = !railDone && r.strike <= spot;
    if (rail) railDone = true;
    return {
      label: strikeLabel(r.strike),
      rail,
      cells: r.cells.map((v, i) => {
        if (!isNum(v)) return 0;
        const atm = atmByExp[i];
        return isNum(atm) ? (v - atm) * 100 : v * 100;
      }),
    };
  });

  const host = el("div.chart-host");
  queueMicrotask(() => matrix(host, {
    rows: mrows, cols, showValues: true,
    fmtCell: (n) => (Math.abs(n) >= 10 ? n.toFixed(0) : n.toFixed(1)),
  }));

  return panel({
    idx: "V3", title: "IV vs ATM", jp: "偏差", body: host, flush: true,
    tools: isNum(frontAtm) ? [tag(`FRONT ATM ${(frontAtm * 100).toFixed(1)}%`, "mute")] : null,
    note: "vol points above (hot) or below (cool) that expiry's OWN at-the-money · each column scaled on its own",
  });
}

/* ── V4 CONE ─────────────────────────────────────────────────────────────── */

function conePanel(p, spot) {
  if (!p?.sigma_bands || !p?.dte_grid) return null;
  const sb = p.sigma_bands, pb = p.percentile_bands || {};
  const host = el("div.chart-host");

  queueMicrotask(() => cone(host, {
    spot,
    xTips: (p.dte_grid || []).map((d) => `${d}d forward`),
    xLabel: `FORWARD DAYS → ${p.dte_grid[p.dte_grid.length - 1] ?? ""}d`,
    height: 230,
    bands: [
      { upper: sb["2s"], lower: sb.m2s, label: "2σ" },
      { upper: sb["1s"], lower: sb.m1s, label: "1σ" },
      { upper: pb.p75, lower: pb.p25, label: "P25–75" },
    ].filter((b) => Array.isArray(b.upper) && Array.isArray(b.lower)),
  }));

  const b1 = p.bands_1d || {}, b5 = p.bands_1w || {};
  const tbl = el("div.bandtbl", null, [
    el("div.bandtbl-row.is-head", null, [el("span", { text: "" }), el("span", { text: "1 DAY" }), el("span", { text: "1 WEEK" })]),
    ...["68", "90", "95", "99"].map((k) => el("div.bandtbl-row", null, [
      el("span.bt-k", { text: `${k}%` }),
      el("span.bt-v", { text: b1[k] ? `${fmt(b1[k][0], 1)} – ${fmt(b1[k][1], 1)}` : "—" }),
      el("span.bt-v", { text: b5[k] ? `${fmt(b5[k][0], 1)} – ${fmt(b5[k][1], 1)}` : "—" }),
    ])),
  ]);

  return panel({
    idx: "V4", title: "FORWARD CONE", jp: "確率", cls: "half",
    tools: [tag(`σ ${fmt(p.sigma_daily_pct, 2)}%/d`, "mute")],
    body: [host, tbl],
    note: `drift ${fmt(p.mu_daily_pct, 3)}%/day, fitted on ${p.n_days ?? "—"} sessions`,
  });
}

/* ── V5 RETURN DISTRIBUTION ──────────────────────────────────────────────── */

function distPanel(p) {
  const centers = p?.return_hist_centers, counts = p?.return_hist_counts;
  if (!Array.isArray(centers) || !Array.isArray(counts) || !counts.length) return null;

  const host = el("div.chart-host");
  const zeroIdx = centers.reduce((best, v, i) => (Math.abs(v) < Math.abs(centers[best]) ? i : best), 0);
  queueMicrotask(() => bars(host, {
    values: counts, height: 150, mark: zeroIdx, gap: 0.88,
    tones: centers.map((c) => (c < 0 ? "n" : "p")),
    tips: centers.map((c) => `return ${c.toFixed(2)}%`),
    fmtY: (n) => n.toFixed(2),
    xLabels: centers.map((c, i) => (i % 12 === 0 ? `${c.toFixed(1)}%` : "")),
  }));

  const cells = [
    stat("SKEWNESS", fmt(p.skewness, 3), { tone: (p.skewness ?? 0) < 0 ? "hot" : "cool", sub: (p.skewness ?? 0) < 0 ? "left tail heavier" : "right tail heavier" }),
    stat("EXCESS KURT", fmt(p.excess_kurtosis, 2), { sub: p.fat_tails ? "fat tails" : "near-normal tails", tone: p.fat_tails ? "hot" : "" }),
    stat("BEYOND 2σ", isNum(p.days_beyond_2s_pct) ? `${p.days_beyond_2s_pct.toFixed(1)}%` : "—", { sub: isNum(p.normal_expect_2s_pct) ? `normal expects ${p.normal_expect_2s_pct.toFixed(1)}%` : null }),
    stat("ANN σ", isNum(p.sigma_ann_pct) ? `${p.sigma_ann_pct.toFixed(1)}%` : "—", { sub: isNum(p.mu_ann_pct) ? `drift ${p.mu_ann_pct.toFixed(1)}%` : null }),
  ];

  return panel({
    idx: "V5", title: "RETURN DISTRIBUTION", jp: "分布", cls: "half",
    body: [host, statGrid(cells)],
    note: `${p.n_days ?? "—"} daily returns · the marker is zero`,
  });
}

/* ── V6 REALIZED VOL FORECAST ────────────────────────────────────────────── */

function forecastPanel(vf) {
  if (!vf || (!Array.isArray(vf.hist_vol) && !Array.isArray(vf.raw_vol))) return null;
  const host = el("div.chart-host");

  const hist = (vf.hist_vol || []).filter(isNum);
  const raw = (vf.raw_vol || []).filter(isNum);

  queueMicrotask(() => lineChart(host, {
    series: [
      hist.length ? { name: "history", values: hist, tone: "cool", fill: true } : null,
      raw.length ? { name: "intraday", values: raw, tone: "warn", dot: false } : null,
    ].filter(Boolean),
    marks: isNum(vf.long_run_vol) ? [{ value: vf.long_run_vol, label: "LONG RUN", tone: "mute" }] : [],
    fmtY: (n) => n.toFixed(1),
    height: 150,
  }));

  const fc = vf.forecasts || {};
  const cells = [
    stat("CURRENT", fmt(vf.current_vol, 2), { sub: vf.method || null }),
    stat("RV 20D", fmt(vf.realized_20, 2)),
    stat("RV 60D", fmt(vf.realized_60, 2)),
    stat("PERSISTENCE", fmt(vf.persistence, 2), { sub: (vf.persistence ?? 0) > 0.95 ? "sticky" : "mean-reverting" }),
  ];

  const ladder = el("div.fcrow", null, Object.entries(fc).map(([k, v]) =>
    el("span.fc", null, [el("i", { text: `${k}d` }), el("b", { text: fmt(v, 2) })])));

  return panel({
    idx: "V6", title: "REALIZED VOL", jp: "実現",
    tools: [tag(vf.vol_regime || "", vf.vol_regime === "HIGH" ? "hot" : "cool"), tag(vf.vol_trend || "", "mute")],
    body: [host, statGrid(cells), ladder],
    note: "cool = the longer history, amber = today's intraday path",
  });
}
