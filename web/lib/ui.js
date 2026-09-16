// Layout chrome. Every panel in the terminal is built from these pieces, which is what makes
// six very different tabs read as one instrument.

import { el, append } from "./util.js";

/**
 * The frame. `idx` is the small lit index at the left of the label, followed by the title,
 * a dashed rule that takes the slack, then `tools`. `cls: "half"` lets the panel take one
 * column of the two-column grid on wide screens. (`jp` is accepted and ignored — kept so the
 * views did not all need touching when the kanji went.)
 */
export function panel({ idx, title, tools, body, note, cls = "", flush = false }) {
  const label = el("div.p-label", null, [
    el("span.p-label-l", null, [
      idx ? el("i.p-ix", { text: idx }) : null,
      el("span.p-title", { text: title, "data-decode": "" }),
    ]),
    el("i.p-line"),
    tools ? el("span.p-tools", null, tools) : null,
  ]);
  const inner = el(`div.p-body${flush ? ".flush" : ""}`);
  if (body) append(inner, body);
  return el(`section.pnl${cls ? "." + cls.split(" ").join(".") : ""}`, null, [
    label,
    inner,
    note ? el("div.p-note", { text: note }) : null,
  ]);
}

/** Bracketed chip: [ TEXT ]. `tone` = "" | pos | neg | warn | cool | hot | mute. */
export function tag(text, tone = "") {
  return el("span", { class: `tag ${tone}`, text });
}

/** Dashed divider with an optional label. */
export function rule(label) {
  return el("div.rule", null, [
    el("i.rule-line"),
    label ? el("span.rule-lbl", { text: label }) : null,
    label ? el("i.rule-line") : null,
  ]);
}

/**
 * Segmented control. `onPick(value)` fires on change; the active item is tracked internally
 * so callers never re-render the control to move the highlight.
 */
export function segmented(items, active, onPick, { cls = "" } = {}) {
  const root = el(`div.seg.${cls || "seg-default"}`);
  const btns = items.map((it) => {
    const b = el("button.seg-btn", {
      type: "button",
      text: it.label,
      title: it.title || "",
      onClick: () => {
        if (b.classList.contains("on")) return;
        root.querySelectorAll(".seg-btn.on").forEach((x) => x.classList.remove("on"));
        b.classList.add("on");
        onPick(it.value);
      },
    });
    if (it.value === active) b.classList.add("on");
    return b;
  });
  append(root, btns);
  return root;
}

/** Grid of `stat()` cells. */
export function statGrid(cells, cls = "") {
  return el(`div.statgrid${cls ? "." + cls : ""}`, null, cells.filter(Boolean));
}

/** Empty / error state inside a panel body. */
export function nodata(msg = "NO DATA") {
  return el("div.chart-empty", { text: msg });
}

/**
 * Loading state: strips of ░ with a light band sweeping across. Shown while a panel's
 * endpoint is in flight — an error is only ever shown for an actual failure.
 * `kind`: "rows" (a ladder), "chart" (one tall block), "stats" (a row of cells).
 */
export function skeleton(kind = "rows", n = 6) {
  if (kind === "chart") return el("div.sk-wrap", null, [el("i.sk.tall"), el("i.sk.w2")]);
  if (kind === "stats") return el("div.statgrid", null, Array.from({ length: n }, () =>
    el("div.stat", null, [el("i.sk.w2"), el("i.sk.w1", { style: "height:16px;line-height:16px;font-size:16px" })])));
  return el("div.sk-wrap", null, Array.from({ length: n }, (_, i) =>
    el("div.sk-row", null, [el("i.sk"), el("i.sk", { class: `sk w${1 + ((i * 7) % 3)}` }), el("i.sk")])));
}

/* ── toast ───────────────────────────────────────────────────────────────── */

let toastEl = null, toastTimer = 0;
/** One-line confirmation at the bottom of the screen. *stars* mark emphasis. */
export function toast(text, ms = 2200) {
  if (!toastEl) { toastEl = el("div.toast", { role: "status" }); document.body.append(toastEl); }
  toastEl.textContent = "";
  for (const p of String(text).split(/(\*[^*]+\*)/g)) {
    if (p.startsWith("*") && p.endsWith("*")) toastEl.append(el("b", { text: p.slice(1, -1) }));
    else if (p) toastEl.append(p);
  }
  toastEl.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("on"), ms);
}

/* ── decode ──────────────────────────────────────────────────────────────── */

const GLYPHS = "░▒▓█<>/\\|=-_+*#";
const reduced = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/**
 * Resolve an element's text out of block noise, left to right. The one text animation in the
 * terminal; run on panel titles the first time a tab reveals, and on the wordmark at boot.
 * Reads the CURRENT text and restores it exactly; never runs twice on the same node at once.
 */
export function decode(node, dur = 420) {
  if (!node || node._decoding || reduced()) return;
  const orig = node.textContent;
  if (!orig || orig.trim().length < 2) return;
  node._decoding = true;
  const t0 = performance.now();
  const n = orig.length;
  const step = (now) => {
    const p = Math.min(1, (now - t0) / dur);
    const keep = Math.floor(p * n);
    let out = orig.slice(0, keep);
    for (let i = keep; i < n; i++) out += orig[i] === " " ? " " : GLYPHS[(Math.random() * GLYPHS.length) | 0];
    node.textContent = out;
    if (p < 1) requestAnimationFrame(step);
    else { node.textContent = orig; node._decoding = false; }
  };
  requestAnimationFrame(step);
}

/** Decode every `[data-decode]` under `root`, staggered so a column of panels ripples. */
export function decodeAll(root, stagger = 45) {
  if (!root || reduced()) return;
  root.querySelectorAll("[data-decode]").forEach((n, i) => setTimeout(() => decode(n), i * stagger));
}
