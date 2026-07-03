// TOPO — market topography. A rotating 3D terrain of the dealer book, viewed from a ¾
// elevated camera (like a relief map on a table):
//   GEX   — dealer gamma by strike × expiry tenor: red peaks = call walls, blue basins = put walls.
//   CHARM — time-decay flow by strike × tenor: where charm-driven hedging pulls price.
//   RND   — market-implied probability of finishing at each strike (front expiry) as a ridge.
// Hand-rolled projection (no libraries). Heat-colored surface, floor grid with strike/tenor
// ticks, value legend, auto-labelled peaks, dashed spot column. Drag to rotate; hover reads
// the nearest node. Respects prefers-reduced-motion (static view, no auto-rotate).
window.Topo = (() => {
  const TENOR_LABELS = ["0DTE", "1W", "2W", "M+"];
  const ROWS = 16, MAX_COLS = 44;
  const CYCLE_MS = 16_000, PIN_MS = 45_000;

  let canvas = null, ctx = null, readout = null, chipsWrap = null, caption = null;
  let data = null;
  let surfaces = {};
  let modeIds = [];
  let modeIdx = 0, lastCycle = 0, pinnedUntil = 0;
  let yaw = 0.62, pitch = 0.52, dragUntil = 0;
  let pts = [];
  let raf = 0, fadeT = 1;
  let pal = { ink: "#111210", ink2: "#5c5b56", ink3: "#9b9a93", red: "#e60023", blue: "#1f5fd0", green: "#1c7a52", paper: "#f1f1ee" };
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const MODES = [
    { id: "gex",   label: "GEX",   kind: "term",  pick: (r) => r.gex,
      caption: "DEALER GAMMA · strike × expiry — red peak = call wall · blue basin = put wall · dashed line = spot" },
    { id: "charm", label: "CHARM", kind: "term",  pick: (r) => r.charm,
      caption: "TIME-DECAY FLOW · strike × expiry — where charm-driven hedging pulls price into each expiry" },
    { id: "rnd",   label: "RND",   kind: "ridge",
      caption: "MARKET-IMPLIED ODDS — probability of finishing at each strike (front expiry), higher = magnet" },
  ];

  function refreshPalette() {
    const s = getComputedStyle(document.documentElement);
    const g = (n, fb) => (s.getPropertyValue(n).trim() || fb);
    pal = { ink: g("--ink", pal.ink), ink2: g("--ink2", pal.ink2), ink3: g("--ink3", pal.ink3),
            red: g("--red", pal.red), blue: g("--blue", pal.blue), green: g("--green", pal.green), paper: g("--bg", pal.paper) };
  }
  const hex2rgb = (h) => { const n = parseInt(h.replace("#", ""), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
  const mix = (a, b, t) => { const A = hex2rgb(a), B = hex2rgb(b); return `rgb(${A.map((v, i) => Math.round(v + (B[i] - v) * t)).join(",")})`; };

  /** Cartographic halo: paper outline under the glyphs so labels stay legible on the wireframe. */
  function label(str, x, y, color) {
    ctx.strokeStyle = pal.paper; ctx.lineWidth = 3; ctx.lineJoin = "round";
    ctx.strokeText(str, x, y);
    ctx.fillStyle = color;
    ctx.fillText(str, x, y);
  }

  // ── surfaces ──────────────────────────────────────────────────────────────
  const cosMix = (a, b, t) => a + (b - a) * (1 - Math.cos(t * Math.PI)) / 2;

  function subsample(rows) {
    if (rows.length <= MAX_COLS) return rows;
    const step = rows.length / MAX_COLS;
    return Array.from({ length: MAX_COLS }, (_, i) => rows[Math.floor(i * step)]);
  }

  function termSurface(profile, pick) {
    const rows = subsample(profile);
    const cols = rows.map((r) => r.strike);
    const h = [], raw = [];
    for (let r = 0; r < ROWS; r++) {
      const t = (r / (ROWS - 1)) * 3;
      const i = Math.min(2, Math.floor(t)), f = t - i;
      h.push(rows.map((row) => cosMix(pick(row)[i] ?? 0, pick(row)[i + 1] ?? 0, f)));
      raw.push(rows.map((row) => pick(row)[Math.round(t)] ?? 0));
    }
    return finish(cols, h, raw, (r) => TENOR_LABELS[Math.round((r / (ROWS - 1)) * 3)]);
  }

  function ridgeSurface(coverage) {
    const rows = subsample([...coverage].sort((a, b) => a.strike - b.strike).filter((c) => typeof c.rnd === "number"));
    if (rows.length < 5) return null;
    const cols = rows.map((r) => r.strike);
    const mid = (ROWS - 1) / 2, sig = ROWS * 0.22;
    const h = [], raw = [];
    for (let r = 0; r < ROWS; r++) {
      const g = Math.exp(-(((r - mid) / sig) ** 2));
      h.push(rows.map((row) => row.rnd * g));
      raw.push(rows.map((row) => row.rnd));
    }
    return finish(cols, h, raw, () => "");
  }

  function finish(cols, h, raw, rowLabel) {
    let maxAbs = 0;
    for (const row of h) for (const v of row) maxAbs = Math.max(maxAbs, Math.abs(v));
    if (!(maxAbs > 0)) return null;
    return { cols, h: h.map((row) => row.map((v) => v / maxAbs)), raw, maxAbs, rowLabel };
  }

  function rebuild() {
    surfaces = {}; modeIds = [];
    if (!data) return;
    for (const m of MODES) {
      const s = m.kind === "term"
        ? (Array.isArray(data.term_profile) && data.term_profile.length >= 5 ? termSurface(data.term_profile, m.pick) : null)
        : (Array.isArray(data.coverage) ? ridgeSurface(data.coverage) : null);
      if (s) { surfaces[m.id] = s; modeIds.push(m.id); }
    }
    if (!modeIds.length) return;
    if (!modeIds[modeIdx]) modeIdx = 0;
    renderChips();
  }

  function currentMode() { return MODES.find((m) => m.id === modeIds[modeIdx]); }

  function renderChips() {
    if (chipsWrap) {
      chipsWrap.replaceChildren();
      modeIds.forEach((id, i) => {
        const m = MODES.find((x) => x.id === id);
        const b = document.createElement("button");
        b.className = `topo-chip${i === modeIdx ? " active" : ""}`;
        b.textContent = m.label;
        b.addEventListener("click", () => { modeIdx = i; fadeT = 0; pinnedUntil = Date.now() + PIN_MS; renderChips(); });
        chipsWrap.appendChild(b);
      });
    }
    if (caption && modeIds.length) caption.textContent = currentMode().caption;
  }

  // ── render loop ───────────────────────────────────────────────────────────
  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (!canvas || document.hidden || !canvas.offsetParent || !modeIds.length) return;
    if (!reduced && now > dragUntil) yaw += 0.0028;
    if (!reduced && now - lastCycle > CYCLE_MS && now > pinnedUntil && modeIds.length > 1) {
      lastCycle = now; modeIdx = (modeIdx + 1) % modeIds.length; fadeT = 0; renderChips();
    }
    fadeT = Math.min(1, fadeT + 0.06);
    draw();
  }

  /** Elevated ¾ camera: yaw turntable, then tilt DOWN by `pitch` so the far edge sits higher. */
  function makeProject(W, H, mode) {
    const cy = H * 0.5, cx = W / 2;
    const scale = Math.min(W * 0.34, H * 0.58), f = 3.8;
    const cosY = Math.cos(yaw), sinY = Math.sin(yaw), cosP = Math.cos(pitch), sinP = Math.sin(pitch);
    return (x, y, z) => {
      const xr = x * cosY - z * sinY, zr = x * sinY + z * cosY;
      const yr = y * cosP + zr * sinP;      // camera above: far (+z) projects UP
      const z2 = zr * cosP - y * sinP;      // depth after tilt (larger = farther)
      const s = f / (f + z2);
      return { px: cx + xr * s * scale, py: cy - yr * s * scale, z: z2 };
    };
  }

  function draw() {
    const dpr = devicePixelRatio || 1;
    const W = canvas.offsetWidth, H = canvas.offsetHeight;
    if (!W || !H) return;
    if (canvas.width !== W * dpr || canvas.height !== H * dpr) { canvas.width = W * dpr; canvas.height = H * dpr; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const mode = currentMode();
    const S = surfaces[mode.id];
    const nC = S.cols.length;
    const AMP = mode.kind === "ridge" ? 0.52 : 0.42;
    const floorY = mode.kind === "ridge" ? -0.02 : -AMP * 1.08;
    const proj = makeProject(W, H, mode);
    const X = (c) => (c / (nC - 1)) * 2 - 1;
    const Z = (r) => ((r / (ROWS - 1)) * 2 - 1) * 0.6;

    ctx.globalAlpha = 0.25 + 0.75 * fadeT;

    // ── floor grid + axis ticks ─────────────────────────────────────────────
    ctx.lineWidth = 0.6;
    ctx.strokeStyle = pal.ink3;
    ctx.globalAlpha = (0.25 + 0.75 * fadeT) * 0.35;
    for (let c = 0; c < nC; c += 6) {
      const a = proj(X(c), floorY, Z(0)), b = proj(X(c), floorY, Z(ROWS - 1));
      ctx.beginPath(); ctx.moveTo(a.px, a.py); ctx.lineTo(b.px, b.py); ctx.stroke();
    }
    for (let r = 0; r < ROWS; r += 5) {
      const a = proj(X(0), floorY, Z(r)), b = proj(X(nC - 1), floorY, Z(r));
      ctx.beginPath(); ctx.moveTo(a.px, a.py); ctx.lineTo(b.px, b.py); ctx.stroke();
    }
    ctx.globalAlpha = 0.25 + 0.75 * fadeT;

    // ── surface: project verts, paint heat quads back-to-front ─────────────
    pts = [];
    const P = [];
    for (let r = 0; r < ROWS; r++) {
      P.push([]);
      for (let c = 0; c < nC; c++) {
        const p = proj(X(c), S.h[r][c] * AMP, Z(r));
        P[r].push(p);
        pts.push({ px: p.px, py: p.py, r, c });
      }
    }
    const quads = [];
    for (let r = 0; r < ROWS - 1; r++) for (let c = 0; c < nC - 1; c++) {
      quads.push({ r, c, z: (P[r][c].z + P[r + 1][c + 1].z) / 2, v: (S.h[r][c] + S.h[r + 1][c + 1]) / 2 });
    }
    quads.sort((a, b) => b.z - a.z);
    for (const q of quads) {
      const a = P[q.r][q.c], b = P[q.r][q.c + 1], d = P[q.r + 1][q.c + 1], e = P[q.r + 1][q.c];
      ctx.beginPath();
      ctx.moveTo(a.px, a.py); ctx.lineTo(b.px, b.py); ctx.lineTo(d.px, d.py); ctx.lineTo(e.px, e.py); ctx.closePath();
      const t = Math.min(1, Math.abs(q.v));
      const pole = mode.kind === "ridge" ? pal.green : q.v >= 0 ? pal.red : pal.blue;
      // heat fill: solid enough to read as a heatmap, opaque enough to occlude lines behind
      ctx.fillStyle = mix(pal.paper, pole, 0.06 + 0.52 * t);
      ctx.fill();
      ctx.strokeStyle = mix(pal.ink2, pole, Math.min(1, t * 1.2));
      ctx.lineWidth = 0.7;
      ctx.stroke();
    }

    // ── axis labels ON TOP of the surface (drawn after it, or the terrain
    //    silhouette eats the digits at some yaw angles) ───────────────────────
    const kMin = S.cols[0], kMax = S.cols[nC - 1];
    const span = kMax - kMin;
    const step = span > 24 ? 10 : span > 12 ? 5 : 2;
    ctx.fillStyle = pal.ink3; ctx.font = "9px 'JetBrains Mono', monospace"; ctx.textAlign = "center";
    for (let k = Math.ceil(kMin / step) * step; k <= kMax; k += step) {
      const c = (k - kMin) / span * (nC - 1);
      const p = proj(X(c), floorY, Z(0));
      const p2 = proj(X(c), floorY - 0.03, Z(0));
      ctx.strokeStyle = pal.ink3; ctx.beginPath(); ctx.moveTo(p.px, p.py); ctx.lineTo(p2.px, p2.py); ctx.stroke();
      label(String(k), p2.px, p2.py + 10, pal.ink3);
    }
    if (mode.kind === "term") {
      ctx.textAlign = "left"; ctx.fillStyle = pal.ink2;
      for (const rr of [0, 5, 10, 15]) {
        const p = proj(X(nC - 1) + 0.06, floorY, Z(rr));
        label(S.rowLabel(rr), p.px, p.py, pal.ink2);
      }
    }

    // ── spot column ─────────────────────────────────────────────────────────
    let spotCol = -1;
    if (typeof data.spot === "number") {
      let best = Infinity;
      S.cols.forEach((k, i) => { const dd = Math.abs(k - data.spot); if (dd < best) { best = dd; spotCol = i; } });
      const top = P[ROWS - 1][spotCol], bot = proj(X(spotCol), floorY, Z(0));
      ctx.strokeStyle = pal.red; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(bot.px, bot.py); ctx.lineTo(top.px, top.py - 14); ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = "600 9px 'JetBrains Mono', monospace"; ctx.textAlign = "center";
      label(`SPOT ${data.spot.toFixed(0)}`, top.px, top.py - 18, pal.red);
    }

    // ── auto-labelled peaks: the 2 strongest columns, named on the summit ──
    const colPeak = S.cols.map((_, c) => {
      let v = 0;
      for (let r = 0; r < ROWS; r++) if (Math.abs(S.h[r][c]) > Math.abs(v)) v = S.h[r][c];
      return v;
    });
    // Keep labels clear of the SPOT tag (≥5 columns away) and of each other (≥8);
    // the ridge has one summit worth naming, the term surfaces get two.
    const ranked = colPeak.map((v, c) => ({ v, c }))
      .filter((x) => Math.abs(x.v) > 0.45 && Math.abs(x.c - spotCol) > 5)
      .sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
    const chosen = [];
    const maxLabels = mode.kind === "ridge" ? 1 : 2;
    for (const cand of ranked) {
      if (chosen.length >= maxLabels) break;
      if (chosen.every((x) => Math.abs(x.c - cand.c) >= 8)) chosen.push(cand);
    }
    ctx.font = "600 10px 'JetBrains Mono', monospace"; ctx.textAlign = "center";
    for (const pk of chosen) {
      let bestR = 0;
      for (let r = 0; r < ROWS; r++) if (Math.abs(S.h[r][pk.c]) > Math.abs(S.h[bestR][pk.c])) bestR = r;
      const p = P[bestR][pk.c];
      const pole = mode.kind === "ridge" ? pal.green : pk.v >= 0 ? pal.red : pal.blue;
      const tag = mode.kind === "ridge" ? `${S.cols[pk.c]}` : `${S.cols[pk.c]} ${pk.v >= 0 ? "CALL" : "PUT"}`;
      label(tag, p.px, p.py - 8, pole);
    }

    // ── legend: heat ramp + value scale, bottom-left (opaque backing so terrain
    //    labels can never collide with it) ─────────────────────────────────────
    const lw = 96, lh = 6, lx = 12, ly = H - 20;
    ctx.fillStyle = pal.paper; ctx.globalAlpha = 0.85;
    ctx.fillRect(lx - 8, ly - 18, lw + 60, 34);
    ctx.globalAlpha = 0.25 + 0.75 * fadeT;
    if (mode.kind === "term") {
      for (let i = 0; i < lw; i++) {
        const t = (i / (lw - 1)) * 2 - 1;
        ctx.fillStyle = mix(pal.paper, t >= 0 ? pal.red : pal.blue, 0.06 + 0.52 * Math.abs(t));
        ctx.fillRect(lx + i, ly, 1.2, lh);
      }
      ctx.strokeStyle = pal.ink3; ctx.lineWidth = 0.6; ctx.strokeRect(lx - 0.5, ly - 0.5, lw + 1, lh + 1);
      ctx.fillStyle = pal.ink3; ctx.font = "8.5px 'JetBrains Mono', monospace";
      ctx.textAlign = "left";  ctx.fillText(`PUT −${Math.round(S.maxAbs)}M`, lx, ly - 4);
      ctx.textAlign = "right"; ctx.fillText(`+${Math.round(S.maxAbs)}M CALL`, lx + lw, ly + lh + 11);
    } else {
      for (let i = 0; i < lw; i++) {
        ctx.fillStyle = mix(pal.paper, pal.green, 0.06 + 0.52 * (i / (lw - 1)));
        ctx.fillRect(lx + i, ly, 1.2, lh);
      }
      ctx.strokeStyle = pal.ink3; ctx.lineWidth = 0.6; ctx.strokeRect(lx - 0.5, ly - 0.5, lw + 1, lh + 1);
      ctx.fillStyle = pal.ink3; ctx.font = "8.5px 'JetBrains Mono', monospace";
      ctx.textAlign = "left"; ctx.fillText(`0 → ${S.maxAbs.toFixed(1)}% finish`, lx, ly - 4);
    }
    ctx.globalAlpha = 1;
  }

  // ── interaction ───────────────────────────────────────────────────────────
  function bindPointer() {
    let dragging = false, lx = 0, ly = 0;
    canvas.addEventListener("pointerdown", (e) => { dragging = true; lx = e.clientX; ly = e.clientY; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener("pointerup", () => { dragging = false; dragUntil = performance.now() + 6000; });
    canvas.addEventListener("pointermove", (e) => {
      if (dragging) {
        yaw += (e.clientX - lx) * 0.006;
        pitch = Math.max(0.15, Math.min(1.15, pitch + (e.clientY - ly) * 0.004));
        lx = e.clientX; ly = e.clientY;
        dragUntil = performance.now() + 6000;
        return;
      }
      if (!readout || !modeIds.length) return;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      let bp = null, bd = 22 * 22;
      for (const p of pts) { const dd = (p.px - mx) ** 2 + (p.py - my) ** 2; if (dd < bd) { bd = dd; bp = p; } }
      const mode = currentMode();
      const S = surfaces[mode.id];
      if (bp && S) {
        const v = S.raw[bp.r][bp.c];
        readout.textContent = mode.kind === "ridge"
          ? `$${S.cols[bp.c]} · ${v.toFixed(2)}% finish`
          : `$${S.cols[bp.c]} · ${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(0)}M ${S.rowLabel(bp.r)}`;
      } else {
        readout.textContent = "";
      }
    });
    canvas.addEventListener("pointerleave", () => { if (readout) readout.textContent = ""; });
  }

  // ── API ───────────────────────────────────────────────────────────────────
  return {
    init(canvasSel, chipsSel, readoutSel, captionSel) {
      canvas = document.querySelector(canvasSel);
      chipsWrap = document.querySelector(chipsSel);
      readout = document.querySelector(readoutSel);
      caption = document.querySelector(captionSel);
      if (!canvas) return;
      ctx = canvas.getContext("2d");
      refreshPalette();
      bindPointer();
      if (!raf) raf = requestAnimationFrame(frame);
    },
    setData(d) { data = d; rebuild(); },
    refreshPalette,
    hasData: () => modeIds.length > 0,
  };
})();
