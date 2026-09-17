// REGIME — the "should I be trading at all today" tab.
//
// Two things were cut from the old version of this tab and are not coming back:
//   · TOPOLOGY PIVOTS — a persistence-ranked list of prices from the regime engine. It sat
//     beside the GEX walls and the desk levels saying different numbers, and nothing in the
//     trading spec ever consumed it.
//   · THE MONITORS BLOCK — a Hurst oscillator, a regime radar and an "IV smile" that was fed
//     the scored board's coverage array. Two of the three were usually empty and the smile was
//     always empty. The Hurst read survives here on YYY's own series; the smile moved to VOL
//     where it is drawn from the live surface.

import { el, isNum, fmt, pct, compactSigned, agoText } from "../util.js";
import { panel, tag, statGrid, nodata, rule } from "../ui.js";
import { lineChart, stat, meter, biMeter } from "../draw.js";

export const ID = "regime";
export const LABEL = "REGIME";
export const JP = "局面";
export const EPS = ["flux", "bias", "hurst", "history", "macro", "macro_extended", "levels"];

export function render(host, ctx) {
  const { ok, err } = ctx.yyy;
  host.replaceChildren(...[
    statePanel(ok.flux, ok.bias, ok.levels, err, ctx),
    factorPanel(ok.flux),
    votePanel(ok.bias),
    hurstPanel(ok.hurst),
    entropyPanel(ok.history, ok.bias),
    deskVolPanel(ctx.regime),
    pulsePanel(ctx.macro),
    macroPanel(ok.macro, ok.macro_extended),
  ].filter(Boolean));
}

/* ── R0 STATE ────────────────────────────────────────────────────────────── */

function statePanel(flux, bias, lvls, err, ctx) {
  if (!flux && !bias) {
    return panel({ idx: "R0", title: "STATE", jp: JP, body: ctx.wait("flux", "stats", 4) || ctx.wait("bias", "stats", 4) || nodata(err?.flux ? `flux: ${err.flux}` : "NO REGIME FEED") });
  }
  const b = bias?.bias;
  const killed = flux?.killed || b?.killed;

  const verdict = el("div.verdict", null, [
    el("div", { class: `vd-main${killed ? " is-killed" : ""}`, text: flux?.direction || b?.direction || "—" }),
    el("div.vd-side", null, [
      el("span", { class: `vd-size ${sizeTone(b?.size_rule)}`, text: b?.size_rule ? `SIZE: ${b.size_rule}` : "" }),
      el("span.vd-comp", { text: isNum(flux?.composite) ? `FLUX ${flux.composite}/5 · ${flux.composite_label ?? ""}` : "" }),
    ]),
  ]);

  const cells = [
    stat("CONVICTION", isNum(b?.conviction) ? b.conviction.toFixed(1) : "—", { sub: "out of 10" }),
    stat("REGIME", lvls?.regime || bias?.topology?.regime || "—", { tone: /UNCHARTED/i.test(lvls?.regime || "") ? "warn" : "" }),
    stat("ENTROPY", bias?.entropy?.status || "—", { sub: bias?.entropy?.trend ? `${bias.entropy.trend}` : null, tone: bias?.entropy?.status === "NORMAL" ? "cool" : "hot" }),
    stat("HURST", fmt(bias?.topology?.h64, 3), { sub: bias?.topology?.hurst_regime || null, tone: (bias?.topology?.h64 ?? 0.5) > 0.55 ? "cool" : (bias?.topology?.h64 ?? 0.5) < 0.45 ? "hot" : "" }),
  ];

  const narrative = flux?.summary || b?.narrative;

  return panel({
    idx: "R0", title: "STATE", jp: JP,
    tools: killed ? [tag("KILLED", "neg")] : null,
    body: [verdict, statGrid(cells), narrative ? el("p.reg-narr", { text: narrative }) : null,
      b?.kill_reason ? el("div.reg-kill", { text: b.kill_reason }) : null],
  });
}

const sizeTone = (r) => (r === "NO TRADE" ? "hot" : r === "FULL" ? "cool" : "warn");

/* ── R1 FLUX FACTORS ─────────────────────────────────────────────────────── */

function factorPanel(flux) {
  const f = flux?.factors;
  if (!f) return null;
  const order = ["regime", "positioning", "volatility", "macro"];
  const items = order.filter((k) => f[k]).map((k) => {
    const x = f[k];
    return meter({
      label: k.toUpperCase(),
      value: `${x.score ?? "—"}/5 · ${x.label ?? ""}`,
      pct: ((x.score ?? 0) / 5) * 100,
      tone: x.color === "bullish" ? "cool" : x.color === "bearish" ? "hot" : "",
      note: x.description || "",
    });
  });
  return panel({ idx: "R1", title: "FLUX FACTORS", jp: "要因", cls: "half", body: el("div.meters", null, items) });
}

/* ── R2 BIAS VOTES ───────────────────────────────────────────────────────── */

function votePanel(bias) {
  const v = bias?.bias?.votes;
  if (!v) return null;
  const entries = Object.entries(v).filter(([, val]) => isNum(val));
  if (!entries.length) return null;
  const scale = Math.max(1, ...entries.map(([, val]) => Math.abs(val)));

  return panel({
    idx: "R2", title: "BIAS VOTES", jp: "票", cls: "half",
    tools: [tag(isNum(bias.bias.score) ? `SCORE ${bias.bias.score.toFixed(3)}` : "", "mute")],
    body: el("div.meters", null, entries
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
      .map(([k, val]) => biMeter({
        label: k.toUpperCase(),
        value: compactSigned(val, 2),
        frac: val / scale,
        tone: val > 0 ? "cool" : val < 0 ? "hot" : "",
      }))),
    note: "each component's directional vote · right of centre is bullish",
  });
}

/* ── R3 HURST ────────────────────────────────────────────────────────────── */

function hurstPanel(h) {
  if (!h || !Array.isArray(h.h64) || !h.h64.length) return null;
  const host = el("div.chart-host");

  // Keep the chart to the recent window; 462 points across a phone width is a smear.
  const n = 240;
  const series = h.h64.slice(-n);
  const times = (h.times || []).slice(-n);

  queueMicrotask(() => lineChart(host, {
    series: [{ name: "h64", values: series, tone: "ink", fill: false }],
    xTips: times.map((t) => String(t).slice(5, 16)),
    marks: [{ value: 0.5, label: "RANDOM", tone: "mute" }],
    bands: [
      { from: 0.55, to: Math.max(0.75, ...series), tone: "cool" },
      { from: Math.min(0.25, ...series), to: 0.45, tone: "hot" },
    ],
    fmtY: (v) => v.toFixed(2),
    xLabels: [times[0]?.slice(5, 10) ?? "", "", times[times.length - 1]?.slice(5, 16) ?? ""],
    height: 160,
  }));

  const cur = h.current_h64;
  return panel({
    idx: "R3", title: "HURST · H64", jp: "記憶", cls: "half",
    tools: [tag(h.current_regime || "—", cur > 0.55 ? "cool" : cur < 0.45 ? "hot" : "mute")],
    body: [host, el("div.hnote", { text: `current ${fmt(cur, 4)} · above 0.55 trends and continuation is favoured, below 0.45 mean-reverts and fades are favoured` })],
  });
}

/* ── R4 ENTROPY / TOPOLOGY ───────────────────────────────────────────────── */

function entropyPanel(hist, bias) {
  if (!hist || !Array.isArray(hist.entropy)) return null;
  const host = el("div.chart-host");
  const pcaHost = el("div.chart-host");

  queueMicrotask(() => {
    lineChart(host, {
      series: [
        { name: "entropy", values: hist.entropy, tone: "ink" },
        { name: "threshold", values: hist.threshold, tone: "warn", dot: false },
      ],
      fmtY: (v) => v.toFixed(4),
      height: 150,
    });
    lineChart(pcaHost, {
      series: [
        { name: "pca1", values: hist.pca1, tone: "cool" },
        { name: "pca2", values: hist.pca2, tone: "warn", dot: false },
        { name: "vol z", values: hist.vol_z, tone: "hot", dot: false },
      ],
      marks: [{ value: 0, tone: "mute" }],
      fmtY: (v) => v.toFixed(1),
      height: 150,
    });
  });

  const e = bias?.entropy, t = bias?.topology;
  const cells = [
    stat("ENTROPY", fmt(e?.entropy, 6), { sub: `threshold ${fmt(e?.threshold, 6)}`, tone: (e?.entropy ?? 0) > (e?.threshold ?? 1) ? "hot" : "cool" }),
    stat("RHO", fmt(e?.rho, 3), { sub: e?.trend || null }),
    stat("PCA1 / PCA2", `${fmt(t?.pca1, 2)} / ${fmt(t?.pca2, 2)}`, { sub: t?.aligned ? "aligned" : "unaligned", tone: t?.aligned ? "cool" : "warn" }),
    stat("VOL Z", fmt(t?.vol_z, 2), { sub: `dist ${fmt(t?.dist, 2)}` }),
  ];

  return panel({
    idx: "R4", title: "ENTROPY · TOPOLOGY", jp: "位相",
    body: [
      statGrid(cells),
      el("div.twin", null, [
        el("div.twin-cell", null, [el("div.twin-lbl", { text: "ENTROPY vs THRESHOLD" }), host]),
        el("div.twin-cell", null, [el("div.twin-lbl", { text: "PCA1 / PCA2 / VOL-Z" }), pcaHost]),
      ]),
    ],
    note: "entropy above its threshold means the state space is unstable — that is the size-rule kill switch, not a direction call",
  });
}

/* ── R5 DESK VOL ENGINE ──────────────────────────────────────────────────── */

/**
 * The cloud regime function's Yang-Zhang / GARCH gauges. Kept because YYY has no GARCH read;
 * its pivots list is deliberately not rendered.
 */
function deskVolPanel(reg) {
  if (!reg || !Array.isArray(reg.gauges) || !reg.gauges.length) return null;
  const age = reg.scored_at ? Date.now() - reg.scored_at : NaN;
  const old = Number.isFinite(age) && age > 60 * 60_000;

  return panel({
    idx: "R5", title: "VOL ENGINE", jp: "分析", cls: old ? "p-desk half is-old" : "p-desk half",
    tools: [tag(reg.state || "—", "mute"), tag(agoText(reg.scored_at).toUpperCase(), old ? "warn" : "pos")],
    body: [
      reg.read ? el("p.reg-narr", { text: reg.read }) : null,
      el("div.meters", null, reg.gauges.map((g) => meter({
        label: g.label, value: g.value, pct: g.pct,
        tone: g.tone === "amber" ? "warn" : g.tone === "green" ? "cool" : g.tone === "blue" ? "cool" : "",
      }))),
    ],
    note: `${reg.method || "garch"} · recomputed server-side, independent of the scoring box`,
  });
}

/* ── R6 MACRO PULSE (desk feeds) ─────────────────────────────────────────── */

/**
 * The desk's own macro read — FRED yields and liquidity, COT positioning, VIX term structure
 * and the cross-asset basket, scored into a bias. This is desk CODE running in the cloud on a
 * 5-minute cache, not desk OUTPUT, so it stays current with the box off and is presented as
 * live. It goes deeper than YYY's /macro (which has no COT, no VIX9D term, no carry read), so
 * both are kept and this one leads.
 */
function pulsePanel(m) {
  if (!m) return null;

  const rate = (r, label, invert = false) => {
    if (!r) return null;
    const fast = Math.abs(r.velocity ?? 0) >= 0.03;
    const up = (r.chg ?? 0) >= 0;
    return stat(label, fmt(r.last, 3), {
      sub: `${up ? "+" : "−"}${Math.abs(r.chg ?? 0).toFixed(3)}${fast ? " · fast" : ""}`,
      tone: (invert ? !up : up) ? "hot" : "cool",
    });
  };

  const cross = m.cross || {};
  const cells = [
    rate(m.us2y, "US 2Y"),
    rate(m.us10y, "US 10Y"),
    isNum(m.curve2s10s) ? stat("2s10s", m.curve2s10s.toFixed(3), { sub: m.curve2s10s < 0 ? "inverted" : "positive", tone: m.curve2s10s < 0 ? "hot" : "cool" }) : null,
    m.usdjpy ? stat("USD/JPY", fmt(m.usdjpy.last, 2), { sub: `${m.usdjpy.dir ?? ""} · carry`, tone: m.usdjpy.dir === "falling" ? "hot" : "cool" }) : null,
    m.vix_term ? stat("VIX TERM", fmt(m.vix_term.ratio, 3), { sub: m.vix_term.structure || null, tone: m.vix_term.structure === "backwardation" ? "hot" : "cool" }) : null,
    m.cot ? stat("COT", isNum(m.cot.percentile) ? `${m.cot.percentile}th` : "—", { sub: isNum(m.cot.netPct) ? `net ${m.cot.netPct}%` : null, tone: (m.cot.percentile ?? 50) > 80 ? "hot" : (m.cot.percentile ?? 50) < 50 ? "cool" : "" }) : null,
    cross.dxy ? stat("DXY", fmt(cross.dxy.last, 2), { sub: cross.dxy.dir || null, tone: cross.dxy.dir === "rising" ? "hot" : "cool" }) : null,
    cross.oil ? stat("OIL", fmt(cross.oil.last, 2), { sub: cross.oil.dir || null }) : null,
  ].filter(Boolean);

  const drivers = (m.drivers || []).filter((d) => d?.label);
  const list = drivers.length
    ? el("div.ndrv", null, drivers.map((d) => el(`div.ndrv-row.is-${d.lean || "neutral"}`, null, [
        el("span.nd-k", { text: d.label }),
        el("span", { class: `nd-lean ${d.lean === "bull" ? "cool" : d.lean === "bear" ? "hot" : "mute"}`, text: String(d.lean || "flat").toUpperCase() }),
        el("span.nd-r", { text: d.reading || "" }),
      ])))
    : null;

  const biasTone = m.bias === "bull" ? "cool" : m.bias === "bear" ? "hot" : "mute";

  return panel({
    idx: "R6", title: "MACRO PULSE", jp: "脈",
    tools: [
      tag(String(m.bias ?? "—").toUpperCase(), biasTone),
      isNum(m.bias_score) ? tag(`SCORE ${m.bias_score}`, "mute") : null,
      tag(agoText(m.scored_at).toUpperCase(), "mute"),
      m.auction_today ? tag("AUCTION TODAY", "warn") : null,
    ].filter(Boolean),
    body: [
      statGrid(cells),
      list ? el("div", null, [rule("DRIVERS"), list]) : null,
      (m.notes || []).length ? el("ul.limits", null, m.notes.map((t) => el("li", { text: t }))) : null,
    ],
    note: "FRED + COT + cross-asset, recomputed server-side every 5 minutes — independent of the scoring box",
  });
}

/* ── R7 MACRO (YYY) ──────────────────────────────────────────────────────── */

function macroPanel(m, mx) {
  if (!m && !mx) return null;

  const liq = m?.reserves_rrp;
  const cells = [
    stat("NET LIQUIDITY", isNum(liq?.net_liquidity_chg) ? `${liq.net_liquidity_chg >= 0 ? "+" : "−"}${Math.abs(liq.net_liquidity_chg).toFixed(0)}B` : "—",
      { sub: liq?.liquidity_regime || null, tone: (liq?.net_liquidity_chg ?? 0) > 0 ? "cool" : "hot" }),
    stat("CREDIT OAS", isNum(m?.oas?.value) ? `${m.oas.value.toFixed(2)}%` : "—",
      { sub: m?.oas?.stress || null, tone: m?.oas?.stress === "HEALTHY" ? "cool" : "hot" }),
    stat("FED B/S", isNum(m?.walcl?.change_pct) ? `${m.walcl.change_pct >= 0 ? "+" : "−"}${Math.abs(m.walcl.change_pct).toFixed(2)}%` : "—",
      { sub: "WALCL week over week" }),
    stat("VIX", fmt(mx?.vix_dxy?.VIX?.value, 2),
      { sub: isNum(mx?.vix_dxy?.VIX?.chg_pct) ? `${mx.vix_dxy.VIX.chg_pct >= 0 ? "+" : "−"}${Math.abs(mx.vix_dxy.VIX.chg_pct).toFixed(1)}%` : null,
        tone: (mx?.vix_dxy?.VIX?.chg ?? 0) > 0 ? "hot" : "cool" }),
    stat("DXY", fmt(mx?.vix_dxy?.DXY?.value, 2),
      { sub: isNum(mx?.vix_dxy?.DXY?.chg_pct) ? `${mx.vix_dxy.DXY.chg_pct >= 0 ? "+" : "−"}${Math.abs(mx.vix_dxy.DXY.chg_pct).toFixed(2)}%` : null }),
    stat("2s10s", isNum(mx?.yields?.spread_10_2) ? `${mx.yields.spread_10_2.toFixed(2)}` : "—",
      { sub: mx?.yields?.inverted ? "inverted" : "positive", tone: mx?.yields?.inverted ? "hot" : "cool" }),
  ];

  const ys = mx?.yields?.yields || {};
  const yieldRow = Object.keys(ys).length
    ? el("div.yields", null, Object.entries(ys).map(([k, v]) => el("div.yrow", null, [
        el("span.y-k", { text: k }),
        el("span.y-v", { text: fmt(v?.value, 3) }),
        el("span", { class: `y-c ${(v?.chg ?? 0) >= 0 ? "n" : "p"}`, text: `${(v?.chg ?? 0) >= 0 ? "+" : "−"}${Math.abs(v?.chg ?? 0).toFixed(3)}` }),
      ])))
    : null;

  const notes = [m?.reserves_rrp?.liquidity_note, m?.oas?.note, m?.walcl?.note, m?.auctions?.note]
    .filter(Boolean)
    .map((t) => el("li", { text: t }));

  return panel({
    idx: "R7", title: "MACRO · YYY", jp: "宏観", cls: "half",
    tools: m?.auctions?.warning ? [tag("AUCTION AHEAD", "warn")] : null,
    body: [
      statGrid(cells),
      yieldRow ? el("div", null, [rule("TREASURY"), yieldRow]) : null,
      notes.length ? el("ul.limits", null, notes) : null,
    ],
    note: isNum(mx?.fed?.current_rate) ? `fed funds ${mx.fed.current_rate.toFixed(2)}%` : null,
  });
}
