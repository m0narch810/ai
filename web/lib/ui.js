// Layout chrome. Every panel in the terminal is built from these five or six pieces, which is
// what makes six very different tabs read as one instrument.

import { el, append } from "./util.js";

/**
 * The frame. `idx` is the stamped hardware tag on the left of the label bar, `jp` the kanji on
 * the right. `tools` are controls that live in the label bar (expiry pickers, toggles).
 */
export function panel({ idx, title, jp, tools, body, note, cls = "", flush = false }) {
  const label = el("div.p-label", null, [
    el("span.p-label-l", null, [
      idx ? el("i.p-ix", { text: idx }) : null,
      el("span.p-title", { text: title }),
    ]),
    el("span.p-label-r", null, [
      tools ? el("span.p-tools", null, tools) : null,
      jp ? el("span.p-jp", { text: jp }) : null,
    ]),
  ]);
  const inner = el(`div.p-body${flush ? ".flush" : ""}`);
  if (body) append(inner, body);
  return el(`section.pnl${cls ? "." + cls.split(" ").join(".") : ""}`, null, [
    label,
    inner,
    note ? el("div.p-note", { text: note }) : null,
  ]);
}

/** Small uppercase chip. `tone` = "" | pos | neg | warn | cool | mute. */
export function tag(text, tone = "") {
  return el("span", { class: `tag ${tone}`, text });
}

/** Horizontal rule made of box-drawing characters — the ASCII divider. */
export function rule(label) {
  return el("div.rule", null, [
    el("i.rule-line"),
    label ? el("span.rule-lbl", { text: label }) : null,
    label ? el("i.rule-line") : null,
  ]);
}

/**
 * Segmented control. Returns the element; `onPick(value)` fires on change and the active
 * item is tracked internally so callers never re-render the control to move the highlight.
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
