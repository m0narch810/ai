// One tooltip for the whole terminal.
//
// Any element — SVG or HTML — carrying `data-tip` shows its text in a small bracketed tag that
// follows the pointer. Newlines in the attribute become lines. One delegated listener on the
// document, one floating node, no per-chart wiring: a renderer only has to put `data-tip` on
// whatever it wants to be hoverable (a bar, a cell, an invisible hit column over a line).
// Touch: a tap shows the tag for a moment where the finger landed.

import { el } from "./util.js";

let node = null;
let current = null;
let currentText = "";

function ensure() {
  if (node) return node;
  node = el("div.tip", { role: "tooltip", "aria-hidden": "true" });
  document.body.append(node);
  return node;
}

function place(x, y) {
  const n = ensure();
  const pad = 14;
  const vw = window.innerWidth, vh = window.innerHeight;
  const r = n.getBoundingClientRect();
  let left = x + pad, top = y + pad;
  if (left + r.width > vw - 8) left = x - pad - r.width;
  if (top + r.height > vh - 8) top = y - pad - r.height;
  n.style.transform = `translate(${Math.max(4, left).toFixed(0)}px, ${Math.max(4, top).toFixed(0)}px)`;
}

function show(target, x, y) {
  const text = target.getAttribute("data-tip");
  if (!text) return hide();
  const n = ensure();
  if (current !== target || currentText !== text) {
    currentText = text;
    n.replaceChildren();
    text.split("\n").forEach((line, i) => {
      if (i) n.append(el("br"));
      // "key: value" lines get the key dimmed
      const m = line.match(/^([^:]{1,24}):\s(.*)$/);
      if (m) { n.append(el("i", { text: m[1] + " " }), m[2]); } else n.append(line);
    });
    current = target;
  }
  n.classList.add("on");
  place(x, y);
}

function hide() {
  if (!node) return;
  node.classList.remove("on");
  current = null;
}

export function initTips() {
  let raf = 0, lastEv = null;
  document.addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch") return;
    lastEv = e;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const t = lastEv.target?.closest?.("[data-tip]");
      if (t) show(t, lastEv.clientX, lastEv.clientY); else hide();
    });
  }, { passive: true });
  document.addEventListener("pointerleave", hide);
  document.addEventListener("scroll", hide, { passive: true, capture: true });
  // touch: tap to peek
  let tt = 0;
  document.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch") return;
    const t = e.target?.closest?.("[data-tip]");
    if (!t) return hide();
    show(t, e.clientX, e.clientY);
    clearTimeout(tt);
    tt = setTimeout(hide, 1800);
  }, { passive: true });
}
