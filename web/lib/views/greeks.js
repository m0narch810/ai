// GREEKS — every greek YYY exposes, as a spine and as a tenor grid.
//
// YYY serves nine per-strike greek routes that all share one envelope, so the terminal treats
// them uniformly: pick a greek, get its ladder; pick an expiry, isolate that column. Four
// panels, in the order a positioning read actually goes:
//
//   G0  BOOK       — all nine at once: net / call / put, a centre-out bar, a tenor sparkline.
//   G1  ALIGNMENT  — the strikes around spot × all nine greeks. This is the project's actual
//                    question ("is every greek pointing the same way at this strike?") and the
//                    only panel that puts the answer on one screen.
//   G2  LADDER     — the selected greek, full per-strike spine.
//   G3  TENOR      — the selected greek, strike × expiry, 0DTE first.

import { el, isNum, compact, compactSigned, strikeLabel, asciiSpine, asciiSpark, sum, nearestBy } from "../util.js";
import { panel, tag, segmented, nodata, rule } from "../ui.js";
import { spine, termMatrix, matrix, stat } from "../draw.js";
import { GREEKS, GREEK_BY_KEY, greek, termGrid, levelMarks, boardMarks } from "../data.js";

export const ID = "greeks";
export const LABEL = "GREEKS";
export const JP = "希臘";
export const EPS = [...GREEKS.map((g) => g.key), "levels"];

let sel = "gex";
let expIdx = null;

const refresh = () => document.dispatchEvent(new CustomEvent("view:refresh"));

export function render(host, ctx) {
  const { ok, err } = ctx.yyy;
  const spot = ctx.spot;

  // Normalise every greek once; each panel below is a different projection of this.
  const all = GREEKS.map((g) => ({ meta: g, chain: greek(g.key, ok[g.key], null), raw: ok[g.key] }));
  const live = all.filter((a) => a.chain.ok);

  if (!live.length) {
    host.replaceChildren(panel({
      idx: "G0", title: "GREEK BOOK", jp: JP,
      body: nodata(err ? `UPSTREAM: ${Object.values(err)[0] ?? "unreachable"}` : "NO GREEK DATA"),
    }));
    return;
  }

  const marks = new Set([
    ...levelMarks(greek("gex", ok.gex, null).levels),
    ...boardMarks(ctx.desk?.board),
  ]);

  host.replaceChildren(
    bookPanel(live, spot),
    alignPanel(all, spot, marks),
    ladderPanel(ok, spot, marks, err),
    tenorPanel(ok, spot),
  );
}

/* ── G0 BOOK ─────────────────────────────────────────────────────────────── */

function bookPanel(live, spot) {
  const rows = live.map(({ meta, chain, raw }) => {
    const t = chain.totals;
    // Centre-out bar: how lopsided is this greek, call side vs put side.
    const denom = Math.abs(t.call ?? 0) + Math.abs(t.put ?? 0);
    const tilt = denom ? ((Math.abs(t.call ?? 0) - Math.abs(t.put ?? 0)) / denom) : 0;
    // Tenor sparkline: the whole-chain net of each expiry column, 0DTE leftmost.
    const term = (chain.expiries || []).map((_, i) => {
      const gi = greek(meta.key, raw, i);
      return gi.ok ? sum(gi.rows.map((r) => r.net)) : NaN;
    });
    // The strike closest to spot — where the trade actually sits.
    const atSpot = nearestBy(chain.rows, spot);

    return el("div.gbook-row", {
      "data-on": meta.key === sel ? "" : null,
      onClick: () => { sel = meta.key; expIdx = null; refresh(); },
      title: meta.sign,
    }, [
      el("span.gb-name", null, [el("b", { text: meta.name }), el("i.gb-jp", { text: meta.jp })]),
      el("span", { class: `gb-net ${sgn(t.net)}`, text: compactSigned(t.net, 2) }),
      el("span.gb-bar", { text: asciiSpine(tilt, 7) }),
      el("span", { class: `gb-side ${sgn(t.call)}`, text: `C ${compact(t.call, 1)}` }),
      el("span", { class: `gb-side ${sgn(t.put)}`, text: `P ${compact(t.put, 1)}` }),
      el("span.gb-term", { text: asciiSpark(term), title: "net by expiry, 0DTE first" }),
      el("span", { class: `gb-spot ${sgn(atSpot?.net)}`, text: atSpot ? compactSigned(atSpot.net, 1) : "—" }),
    ]);
  });

  const head = el("div.gbook-row.is-head", null, [
    el("span.gb-name", { text: "GREEK" }),
    el("span.gb-net", { text: "NET" }),
    el("span.gb-bar", { text: "◀ PUT │ CALL ▶" }),
    el("span.gb-side", { text: "CALLS" }),
    el("span.gb-side", { text: "PUTS" }),
    el("span.gb-term", { text: "TENOR" }),
    el("span.gb-spot", { text: "@SPOT" }),
  ]);

  return panel({
    idx: "G0", title: "GREEK BOOK", jp: JP,
    tools: [tag(`${live.length} / ${GREEKS.length} LIVE`, "mute")],
    body: el("div.gbook", null, [head, ...rows]),
    note: "click a row to load it below · magnitudes are comparable WITHIN a greek only, never across",
  });
}

const sgn = (v) => (!isNum(v) || v === 0 ? "z" : v > 0 ? "p" : "n");

/* ── G1 ALIGNMENT ────────────────────────────────────────────────────────── */

/**
 * The strikes around spot, scored by every greek at once, each column on its own scale.
 * A strike where the whole row leans one colour is aligned; a row that alternates is a
 * battleground, which is the shape that produces the reflex-bounce-then-break.
 */
function alignPanel(all, spot, marks) {
  const live = all.filter((a) => a.chain.ok);
  if (!live.length || !isNum(spot)) return null;

  // Build the strike axis from the densest chain available, windowed tight around spot.
  const densest = live.reduce((a, b) => (b.chain.rows.length > a.chain.rows.length ? b : a));
  const strikes = [...new Set(densest.chain.rows.map((r) => r.strike))]
    .sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot))
    .slice(0, 15)
    .sort((a, b) => b - a);
  if (!strikes.length) return null;

  const cols = live.map((a) => ({ label: a.meta.name.slice(0, 5), sub: a.meta.key.toUpperCase() }));
  const byKey = Object.fromEntries(live.map((a) => [a.meta.key, new Map(a.chain.rows.map((r) => [r.strike, r.net]))]));

  let railDone = false;
  const rows = strikes.map((k) => {
    const rail = !railDone && k <= spot;
    if (rail) railDone = true;
    return {
      label: strikeLabel(k),
      strong: marks.has(k),
      rail,
      cells: live.map((a) => byKey[a.meta.key].get(k) ?? 0),
    };
  });

  const host = el("div.chart-host");
  queueMicrotask(() => matrix(host, { rows, cols, showValues: false }));

  // A one-line alignment verdict per strike, next to the grid.
  const verdicts = rows.map((r) => {
    const vals = r.cells.filter((v) => isNum(v) && v !== 0);
    const pos = vals.filter((v) => v > 0).length, neg = vals.length - pos;
    const lean = vals.length ? Math.abs(pos - neg) / vals.length : 0;
    const word = lean >= 0.7 ? (pos > neg ? "ALIGNED +" : "ALIGNED −") : lean >= 0.35 ? "TILTED" : "SPLIT";
    const tone = lean >= 0.7 ? (pos > neg ? "cool" : "hot") : lean >= 0.35 ? "warn" : "mute";
    return el(`div.align-row${r.rail ? ".is-rail" : ""}`, null, [
      el("span.align-k", { text: r.label }),
      el("span.align-mix", { text: `${pos}↑ ${neg}↓` }),
      tag(word, tone),
    ]);
  });

  return panel({
    idx: "G1", title: "ALIGNMENT AT STRIKE", jp: "整合",
    tools: [tag("PER-COLUMN SCALE", "mute")],
    body: el("div.align-wrap", null, [host, el("div.align-side", null, verdicts)]),
    flush: false,
    note: "cool = positive, hot = negative · a row leaning one colour is aligned; an alternating row is a battleground",
  });
}

/* ── G2 LADDER ───────────────────────────────────────────────────────────── */

function ladderPanel(ok, spot, marks, err) {
  const meta = GREEK_BY_KEY[sel];
  const g = greek(sel, ok[sel], expIdx);

  const greekPick = segmented(
    GREEKS.map((x) => ({ label: x.name, value: x.key, title: x.sign })),
    sel,
    (v) => { sel = v; expIdx = null; refresh(); },
    { cls: "seg-greek" },
  );

  if (!g.ok) {
    return panel({
      idx: "G2", title: `${meta.name} LADDER`, jp: meta.jp, tools: [greekPick],
      body: nodata(err?.[sel] ? `${sel}: ${err[sel]}` : "NO ROWS FOR THIS GREEK"),
    });
  }

  const expPick = segmented(
    [{ label: "CHAIN", value: null, title: "every expiry summed" },
     ...g.expiries.map((e, i) => ({ label: e.short, value: i, title: `${e.label}${isNum(e.dte) ? ` · ${e.dte}d` : ""}` }))],
    expIdx,
    (v) => { expIdx = v; refresh(); },
  );

  const host = el("div.chart-host");
  queueMicrotask(() => spine(host, {
    rows: g.rows, spot, marks, maxRows: 36, unit: meta.unit,
    fmtVal: (n) => compact(n, 1),
  }));

  const t = g.totals;
  const head = el("div.gh", null, [
    stat("NET", compactSigned(t.net, 2), { tone: sgn(t.net) === "p" ? "cool" : "hot", sub: meta.unit || null }),
    stat("CALLS", compactSigned(t.call, 2), { tone: sgn(t.call) === "p" ? "cool" : "hot" }),
    stat("PUTS", compactSigned(t.put, 2), { tone: sgn(t.put) === "p" ? "cool" : "hot" }),
    stat("STRIKES", String(g.rows.length), { sub: expIdx === null ? "whole chain" : g.expiries[expIdx]?.label }),
  ]);

  const clusters = Array.isArray(g.clusters) && g.clusters.length
    ? el("div", null, [
        rule("CLUSTERS"),
        el("div.clusters", null, g.clusters.slice(0, 6).map((c) => el("span.cluster", null, [
          el("b", { text: strikeLabel(c.strike) }),
          el("i", { text: compactSigned(c.total_tex ?? c.total, 1) }),
        ]))),
      ])
    : null;

  return panel({
    idx: "G2", title: `${meta.name} LADDER`, jp: meta.jp,
    tools: [greekPick, expPick],
    body: [head, host, clusters],
    note: meta.sign,
  });
}

/* ── G3 TENOR ────────────────────────────────────────────────────────────── */

function tenorPanel(ok, spot) {
  const meta = GREEK_BY_KEY[sel];
  const t = termGrid(sel, ok[sel]);
  if (!t.ok) return null;

  const host = el("div.chart-host");
  queueMicrotask(() => termMatrix(host, { rows: t.rows, expiries: t.expiries, spot, maxRows: 28 }));

  return panel({
    idx: "G3", title: `${meta.name} BY TENOR`, jp: "期限",
    tools: [tag(`${t.expiries.length} EXPIRIES`, "mute")],
    body: host, flush: true,
    note: "0DTE is the leftmost column · exposure that only exists in column one expires tonight; exposure that persists across columns is structure",
  });
}
