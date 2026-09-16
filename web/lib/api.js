// The whole network surface of the terminal, in one place.
//
// Two classes of source:
//   LIVE  — YYY, via /.netlify/functions/yyy. Works with the scoring PC off, which is the normal
//           case now, so every panel that can be driven from YYY is driven from YYY.
//   DESK  — the locally-scored board / narrative / regime. These go stale for days at a time;
//           anything rendered from them must be stamped with its age, never shown as current.

const FN = "/.netlify/functions";
const URLS = {
  yyy:       `${FN}/yyy`,
  spot:      `${FN}/spot`,
  board:     `${FN}/dashboard`,   // locally-scored board, pushed to Blobs
  cloudBoard:`${FN}/board`,       // deterministic cloud board (box-off fallback)
  narrative: `${FN}/narrative`,
  regime:    `${FN}/regime`,
  macro:     `${FN}/macro`,
};

/* ── auth ────────────────────────────────────────────────────────────────── */

export const getToken = () => localStorage.getItem("authToken");
export const getUser  = () => localStorage.getItem("authUser") || "";

export function clearAuth() {
  localStorage.removeItem("authToken");
  localStorage.removeItem("authUser");
  localStorage.removeItem("lastSeen");
}

export function signOut() {
  clearAuth();
  window.location.href = "/login.html";
}

const authHdrs = () => {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
};

/** A 401 means the token expired or was revoked — there is no recovery but re-login. */
function on401() {
  clearAuth();
  window.location.href = "/login.html";
}

/* ── fetch core ──────────────────────────────────────────────────────────── */

/**
 * Every request is no-store + cache-busted: this is a terminal, a cached quote is a wrong quote.
 * Returns null on 401 (after kicking to login) so callers can bail without special-casing.
 */
async function getJson(url, { timeout = 25_000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const sep = url.includes("?") ? "&" : "?";
    const res = await fetch(`${url}${sep}t=${Date.now()}`, {
      cache: "no-store",
      headers: authHdrs(),
      signal: ctl.signal,
    });
    if (res.status === 401) { on401(); return null; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/* ── LIVE: YYY ───────────────────────────────────────────────────────────── */

/**
 * Pull a set of YYY endpoints in one round trip.
 *
 * The proxy fans out server-side, so asking for eight endpoints costs one request and roughly
 * the latency of the slowest one. It also never rejects the whole batch for a single bad
 * endpoint — failures come back in `err` and the rest of `ok` is still usable, which is what
 * keeps one flaky upstream route from blanking an entire tab.
 *
 * @param {string[]} eps  endpoint names from the proxy allowlist
 * @returns {Promise<{ok: Record<string,any>, err: Record<string,string>, at: string}>}
 */
export async function yyy(eps, { ticker = "QQQ", onPart } = {}) {
  const list = [...new Set(eps)].filter(Boolean);
  if (!list.length) return { ok: {}, err: {}, at: new Date().toISOString() };

  const chunks = planBatches(list);
  const parts = await Promise.all(chunks.map(async (chunk) => {
    let part;
    try {
      part = await getJson(`${URLS.yyy}?ticker=${encodeURIComponent(ticker)}&ep=${chunk.join(",")}`);
    } catch (e) {
      // Whole-batch failure (offline, cold-start timeout): report it per endpoint so the UI
      // shows a real error on those panels rather than a skeleton forever.
      part = { ok: {}, err: Object.fromEntries(chunk.map((c) => [c, String(e?.message ?? e)])), at: null };
    }
    if (part) onPart?.(part, chunk);
    return part;
  }));

  const ok = {}, err = {};
  for (const p of parts) {
    if (!p) continue;
    Object.assign(ok, p.ok || {});
    Object.assign(err, p.err || {});
  }
  return { ok, err, at: new Date().toISOString() };
}

/**
 * Endpoints that are slow or heavy upstream. Each gets its own request so it can never hold
 * the small, fast ones hostage — one batch of twelve used to return only when the slowest
 * (probability, ~15s cold) did, which is why the whole page used to flash in at once.
 */
const HEAVY = new Set(["iv_surface", "probability", "bias", "hurst", "flow", "chart", "history"]);
const BATCH = 4;

function planBatches(list) {
  const heavy = list.filter((e) => HEAVY.has(e));
  const light = list.filter((e) => !HEAVY.has(e));
  const out = [];
  for (let i = 0; i < light.length; i += BATCH) out.push(light.slice(i, i + BATCH));
  for (const h of heavy) out.push([h]);
  return out;
}

/* ── LOCAL SNAPSHOT ──────────────────────────────────────────────────────── */

const SNAP_KEY = "yyy.snapshot.v1";

/**
 * The last good frame, so a return visit paints instantly (stamped with its age) instead of
 * staring at skeletons until the proxy answers. ~400KB across all thirty endpoints; well
 * inside the storage budget, and quota errors are swallowed because the cache is optional.
 */
export function saveSnapshot(ok) {
  try { localStorage.setItem(SNAP_KEY, JSON.stringify({ at: Date.now(), ok })); }
  catch { /* quota / private mode — the live path still works */ }
}

export function loadSnapshot(maxAgeMs = 6 * 60 * 60_000) {
  try {
    const j = JSON.parse(localStorage.getItem(SNAP_KEY) || "null");
    if (!j || typeof j.at !== "number" || !j.ok || Date.now() - j.at > maxAgeMs) return null;
    return j;
  } catch { return null; }
}

/* ── LIVE: spot ──────────────────────────────────────────────────────────── */

/** Session-aware live print (QQQ in US hours, NQ=F converted in Asia). */
export async function spot() {
  try {
    const j = await getJson(URLS.spot, { timeout: 12_000 });
    return j && typeof j.spot === "number" ? j : null;
  } catch { return null; }
}

/* ── DESK: scored board ──────────────────────────────────────────────────── */

const boardTime = (b) => {
  const t = typeof b?.scored_at === "number" ? b.scored_at : Date.parse(b?.generated_at ?? "");
  return Number.isFinite(t) ? t : 0;
};

/**
 * The scored board, best-effort across three sources in freshness order:
 *   1. the authed Blobs board (what the PC publishes)
 *   2. the deterministic cloud board (recomputed server-side when the PC is off)
 *   3. the static dashboard.json (LAN only — `npm run web`)
 * Returns `{ board, source, at }`, or null when nothing at all is reachable.
 */
export async function board() {
  let best = null, source = null;

  try {
    const j = await getJson(URLS.board, { timeout: 15_000 });
    if (j && Array.isArray(j.levels)) { best = j; source = "desk"; }
  } catch { /* fall through */ }

  // Only reach for the cloud board when the desk board is missing or more than 30 min old —
  // a fresh local board is always the better read (it is the AI one).
  const stale = !best || Date.now() - boardTime(best) > 30 * 60_000;
  if (stale) {
    try {
      const j = await getJson(URLS.cloudBoard, { timeout: 25_000 });
      if (j && Array.isArray(j.levels) && boardTime(j) > boardTime(best)) { best = j; source = "cloud"; }
    } catch { /* fall through */ }
  }

  if (!best) {
    try {
      const res = await fetch(`dashboard.json?t=${Date.now()}`, { cache: "no-store" });
      if (res.ok) { best = await res.json(); source = "static"; }
    } catch { /* nothing reachable */ }
  }

  return best ? { board: best, source, at: boardTime(best) } : null;
}

export async function narrative() {
  try { return await getJson(URLS.narrative, { timeout: 15_000 }); }
  catch { return null; }
}

export async function regime() {
  try { return await getJson(URLS.regime, { timeout: 25_000 }); }
  catch { return null; }
}

/**
 * The desk macro pulse: FRED yields/liquidity, COT, VIX term, the cross-asset basket and a
 * bias score. Server-side and cached in Blobs, so unlike the scored board it stays current
 * with the box off — it is desk CODE running in the cloud, not desk OUTPUT.
 */
export async function macro() {
  try { return await getJson(URLS.macro, { timeout: 25_000 }); }
  catch { return null; }
}
