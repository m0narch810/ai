// Layout chrome. Every panel in the terminal is built from these pieces, which is what makes
// six very different tabs read as one instrument.

import { el, append } from "./util.js";

/**
 * The frame. `idx` is the small accent index at the left of the label, `jp` the kanji that
 * sinks into the card as a watermark. `tools` are controls that live in the label bar.
 * `cls: "half"` lets the panel take one column of the two-column grid on wide screens.
 */
export function panel({ idx, title, jp, tools, body, note, cls = "", flush = false }) {
  const label = el("div.p-label", null, [
    el("span.p-label-l", null, [
      idx ? el("i.p-ix", { text: idx }) : null,
      el("span.p-title", { text: title }),
    ]),
    tools ? el("span.p-label-r", null, el("span.p-tools", null, tools)) : null,
  ]);
  const inner = el(`div.p-body${flush ? ".flush" : ""}`);
  if (body) append(inner, body);
  return el(`section.pnl${cls ? "." + cls.split(" ").join(".") : ""}`, null, [
    label,
    inner,
    note ? el("div.p-note", { text: note }) : null,
    jp ? el("span.p-jp", { text: jp, "aria-hidden": "true" }) : null,
  ]);
}

/** Small chip. `tone` = "" | pos | neg | warn | cool | hot | mute. */
export function tag(text, tone = "") {
  return el("span", { class: `tag ${tone}`, text });
}

/** Thin divider with an optional label. */
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
 * Loading state. A panel whose endpoint is still in flight shows this instead of an error —
 * "NO DATA" on first paint was the single worst thing about the previous build.
 * `kind`: "rows" (a ladder), "chart" (one tall block), "stats" (a row of cells).
 */
export function skeleton(kind = "rows", n = 6) {
  if (kind === "chart") return el("div.sk-wrap", null, [el("i.sk.tall"), el("i.sk.w2")]);
  if (kind === "stats") return el("div.statgrid", null, Array.from({ length: n }, () =>
    el("div.stat", null, [el("i.sk.w2"), el("i.sk.w1", { style: "height:18px" })])));
  return el("div.sk-wrap", null, Array.from({ length: n }, (_, i) =>
    el("div.sk-row", null, [el("i.sk"), el("i.sk", { class: `sk w${1 + ((i * 7) % 3)}` }), el("i.sk")])));
}

/* ── toast ───────────────────────────────────────────────────────────────── */

let toastEl = null, toastTimer = 0;
/** One-line confirmation at the bottom of the screen. `html` may contain <b> for emphasis. */
export function toast(text, ms = 2200) {
  if (!toastEl) { toastEl = el("div.toast", { role: "status" }); document.body.append(toastEl); }
  toastEl.textContent = "";
  const parts = String(text).split(/(\*[^*]+\*)/g);
  for (const p of parts) {
    if (p.startsWith("*") && p.endsWith("*")) toastEl.append(el("b", { text: p.slice(1, -1) }));
    else if (p) toastEl.append(p);
  }
  toastEl.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("on"), ms);
}

/* ── spotlight ───────────────────────────────────────────────────────────── */

/**
 * One delegated pointer listener drives the lit ring + fill on whichever panel the cursor is
 * over, via --mx/--my on that panel. Cheaper than a listener per card and survives re-renders.
 */
export function initSpotlight(root) {
  if (!root || !window.matchMedia?.("(hover: hover)").matches) return;
  let raf = 0, last = null;
  root.addEventListener("pointermove", (e) => {
    const card = e.target.closest?.(".pnl");
    if (!card) return;
    last = { card, x: e.clientX, y: e.clientY };
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const r = last.card.getBoundingClientRect();
      last.card.style.setProperty("--mx", `${(last.x - r.left).toFixed(0)}px`);
      last.card.style.setProperty("--my", `${(last.y - r.top).toFixed(0)}px`);
    });
  }, { passive: true });
}
