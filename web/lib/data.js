// Normalisers: YYY payloads → the two or three shapes the views actually draw.
//
// YYY is very nearly uniform across greeks — eight of the nine per-strike routes return the
// same {expiries, rows:[{strike, call_cells, put_cells, total}]} envelope — but /gex and /theta
// each deviate, and the heatmap grids are a third shape again. Rather than teach every panel
// those three dialects, everything is funnelled through `greek()` here and the views only ever
// see {rows:[{strike, put, call, net}], expiries, totals}.

import { isNum, sum, etNow } from "./util.js";

/* ── greek catalogue ─────────────────────────────────────────────────────── */

/**
 * The nine per-strike greeks, in the order the terminal presents them: first-order dealer
 * exposure first, then the drift terms that actually move a hedge through the day, then the
 * second-order vol terms, then rho (carried for completeness, near-noise on a 0-8DTE chain).
 *
 * `sign` is the plain-English reading of a POSITIVE aggregate — printed under each spine so the
 * chart is interpretable without holding the convention in your head.
 */
export const GREEKS = [
  { key: "gex",   name: "GAMMA",  jp: "ガンマ", unit: "$M",
    sign: "positive = dealers long gamma, hedging suppresses moves" },
  { key: "dex",   name: "DELTA",  jp: "デルタ", unit: "",
    sign: "positive = dealers long delta, they sell rallies" },
  { key: "charm", name: "CHARM",  jp: "チャーム", unit: "",
    sign: "positive = decay pushes dealers to BUY into the close" },
  { key: "vanna", name: "VANNA",  jp: "ヴァンナ", unit: "",
    sign: "positive = falling IV pushes dealers to BUY" },
  { key: "vega",  name: "VEGA",   jp: "ベガ", unit: "",
    sign: "positive = dealers long vol, they sell IV spikes" },
  { key: "theta", name: "THETA",  jp: "セータ", unit: "$",
    sign: "negative = the book bleeds premium, pin pressure at the cluster" },
  { key: "veta",  name: "VETA",   jp: "ヴェータ", unit: "",
    sign: "positive = vega grows as time passes (long-dated vol builds)" },
  { key: "vomma", name: "VOMMA",  jp: "ヴォンマ", unit: "",
    sign: "positive = vega accelerates with IV, vol-of-vol convexity" },
  { key: "rho",   name: "RHO",    jp: "ロー", unit: "",
    sign: "positive = rate rises help the book (negligible under 8DTE)" },
];

export const GREEK_BY_KEY = Object.fromEntries(GREEKS.map((g) => [g.key, g]));

/* ── expiries ────────────────────────────────────────────────────────────── */

const MS_DAY = 86_400_000;

/** Today's ET calendar date as a UTC-midnight epoch — a day counter that ignores wall-clock. */
function etDayUtc(now = etNow()) {
  const year = new Date().getUTCFullYear();
  // etNow only carries month/day; pick the year that puts the date within ±6 months of now
  const d = Date.UTC(year, +now.month - 1, +now.day);
  const t = Date.now();
  if (d - t > 183 * MS_DAY) return Date.UTC(year - 1, +now.month - 1, +now.day);
  if (t - d > 183 * MS_DAY) return Date.UTC(year + 1, +now.month - 1, +now.day);
  return d;
}

/**
 * Calendar days from today (ET) to an expiry given as "YYYY-MM-DD" or "MM-DD" (any suffix).
 * YYY's own `dte` is floored from the wall clock, so after the 16:00 close BOTH today's expired
 * chain and tomorrow's read 0 — which is how the ladders grew two "0DTE" tabs. Calendar days
 * are what the tabs mean by DTE.
 */
export function calendarDte(exp) {
  const m = String(exp ?? "").match(/^\s*(?:(\d{4})-)?(\d{2})-(\d{2})/);
  if (!m) return null;
  const today = etDayUtc();
  const yr = m[1] ? +m[1] : new Date(today).getUTCFullYear();
  let d = Date.UTC(yr, +m[2] - 1, +m[3]);
  if (!m[1]) {   // MM-DD: pick the year that lands nearest today (December → January wrap)
    if (d - today > 183 * MS_DAY) d = Date.UTC(yr - 1, +m[2] - 1, +m[3]);
    else if (today - d > 183 * MS_DAY) d = Date.UTC(yr + 1, +m[2] - 1, +m[3]);
  }
  return Math.round((d - today) / MS_DAY);
}

/** True once an expiry can no longer trade: a past date, or today after the 16:00 ET close. */
export function isExpired(dte, now = etNow()) {
  if (!isNum(dte)) return false;
  return dte < 0 || (dte === 0 && now.minutes >= 960);
}

/** Short tab label for an expiry: 0DTE / 1DTE / … / EXP'D. */
export function dteTag(dte, expired = isExpired(dte)) {
  if (!isNum(dte)) return null;
  return expired ? "EXP'D" : `${dte}DTE`;
}

/**
 * "09-16 (0d)" / "09-16 - 0DTE" / {exp:"2026-09-16", dte:0} all collapse to a short "09-16" plus
 * a CALENDAR dte, an `expired` flag and a ready `tag`. The feed's own dte is kept as `feedDte`.
 */
function expiryList(raw) {
  const now = etNow();
  return (raw || []).map((e, i) => {
    const str = typeof e === "string";
    const label = str ? e : (e?.label ?? e?.exp ?? e?.date ?? "");
    const m = String(label).match(/^\s*([\d-]{4,10})/);
    const feedDte = !str && isNum(e?.dte) ? e.dte : null;
    const cal = calendarDte((!str && e?.exp) || label);
    const dte = isNum(cal) ? cal : feedDte;
    const expired = isExpired(dte, now);
    return { label, short: m ? m[1] : label, dte, feedDte, expired, tag: dteTag(dte, expired), i };
  });
}

/** Index of the first expiry that can still trade (today's before the close, else the next). */
export function frontExpiryIndex(expiries) {
  const i = (expiries || []).findIndex((e) => !e.expired);
  return i < 0 ? 0 : i;
}

/* ── greek normaliser ────────────────────────────────────────────────────── */

/**
 * @param {string} key   one of GREEKS[].key
 * @param {object} raw   the YYY payload for that route
 * @param {number|null} expIdx  expiry column to isolate, or null for the whole chain
 * @returns {{rows:Array, expiries:Array, totals:object, spot:number, ok:boolean}}
 */
export function greek(key, raw, expIdx = null) {
  const empty = { rows: [], expiries: [], totals: {}, spot: NaN, ok: false };
  if (!raw || raw.error && !raw.rows && !raw.strike_data) return empty;

  // /gex is its own shape: a flat strike_data ladder for the aggregate, and a THREE-column
  // by_expiry grid (not eight) when a tenor is isolated.
  if (key === "gex") return normalizeGex(raw, expIdx);

  const expiries = expiryList(raw.expiries);
  const src = Array.isArray(raw.rows) ? raw.rows : [];
  if (!src.length) return empty;

  const pick = (cells) => {
    if (!Array.isArray(cells)) return 0;
    return expIdx === null ? sum(cells) : (isNum(cells[expIdx]) ? cells[expIdx] : 0);
  };

  const rows = src
    .filter((r) => isNum(r?.strike))
    .map((r) => {
      const put = pick(r.put_cells);
      const call = pick(r.call_cells);
      // `total` is the whole-chain net; when a tenor is isolated it no longer applies.
      const net = expIdx === null && isNum(r.total) ? r.total : put + call;
      return { strike: r.strike, put, call, net };
    })
    .filter((r) => r.put !== 0 || r.call !== 0);

  // /theta names its aggregates tex rather than total.
  const total = isNum(raw.total) ? raw.total : raw.total_tex;
  const callTotal = isNum(raw.call_total) ? raw.call_total : raw.call_tex;
  const putTotal = isNum(raw.put_total) ? raw.put_total : raw.put_tex;

  return {
    ok: rows.length > 0,
    rows,
    expiries,
    spot: raw.spot,
    totals: expIdx === null
      ? { net: total, call: callTotal, put: putTotal }
      : { net: sum(rows.map((r) => r.net)), call: sum(rows.map((r) => r.call)), put: sum(rows.map((r) => r.put)) },
    clusters: raw.clusters || null,
  };
}

function normalizeGex(raw, expIdx) {
  const byExp = raw.by_expiry || {};
  const expiries = expiryList(byExp.expiries);

  let rows;
  if (expIdx !== null && Array.isArray(byExp.rows) && expIdx < expiries.length) {
    rows = byExp.rows
      .filter((r) => isNum(r?.strike))
      .map((r) => {
        const call = isNum(r.call_cells?.[expIdx]) ? r.call_cells[expIdx] : 0;
        const put = isNum(r.put_cells?.[expIdx]) ? r.put_cells[expIdx] : 0;
        return { strike: r.strike, put, call, net: put + call };
      });
  } else {
    rows = (raw.strike_data || [])
      .filter((r) => isNum(r?.strike))
      .map((r) => ({
        strike: r.strike,
        put: isNum(r.put_gex) ? r.put_gex : 0,
        call: isNum(r.call_gex) ? r.call_gex : 0,
        net: (isNum(r.call_gex) ? r.call_gex : 0) + (isNum(r.put_gex) ? r.put_gex : 0),
        callOi: r.call_oi,
        putOi: r.put_oi,
      }));
  }
  rows = rows.filter((r) => r.put !== 0 || r.call !== 0);

  return {
    ok: rows.length > 0,
    rows,
    expiries,
    spot: raw.spot,
    totals: {
      net: isNum(raw.net_gex_bn) ? raw.net_gex_bn * 1e3 : sum(rows.map((r) => r.net)), // → $M, the ladder's unit
      call: sum(rows.map((r) => r.call)),
      put: sum(rows.map((r) => r.put)),
    },
    levels: {
      call_wall: raw.call_wall, call_wall_2: raw.call_wall_2,
      put_wall: raw.put_wall, put_wall_2: raw.put_wall_2,
      vol_trigger: raw.vol_trigger, max_pain: raw.max_pain,
      gamma_env: raw.gamma_env, net_gex_bn: raw.net_gex_bn,
      positive_gamma: raw.positive_gamma, above_vol_trigger: raw.above_vol_trigger,
    },
  };
}

/* ── tenor grid ──────────────────────────────────────────────────────────── */

/**
 * Strike × expiry net grid for one greek, built from the SAME dedicated route the spine uses.
 *
 * /heatmap also ships six aggregate grids, but its column names are a documented trap in this
 * repo (`vex` is vega, `cex` is charm, and `vegaex` is unidentified — nothing in src/ maps it).
 * The per-greek routes carry `call_cells`/`put_cells` over the identical eight expiries, so the
 * tenor view is derived from those instead and the ambiguity never enters the front end.
 */
export function termGrid(key, raw) {
  if (key === "gex") {
    const be = raw?.by_expiry;
    const expiries = expiryList(be?.expiries);
    const rows = (be?.rows || [])
      .filter((r) => isNum(r?.strike))
      .map((r) => ({
        strike: r.strike,
        cells: expiries.map((_, i) => (r.call_cells?.[i] ?? 0) + (r.put_cells?.[i] ?? 0)),
      }))
      .filter((r) => r.cells.some((v) => v !== 0));
    return { rows, expiries, spot: raw?.spot, ok: rows.length > 0 && expiries.length > 0 };
  }

  const expiries = expiryList(raw?.expiries);
  const rows = (raw?.rows || [])
    .filter((r) => isNum(r?.strike))
    .map((r) => ({
      strike: r.strike,
      cells: expiries.map((_, i) => (r.call_cells?.[i] ?? 0) + (r.put_cells?.[i] ?? 0)),
    }))
    .filter((r) => r.cells.some((v) => v !== 0));
  return { rows, expiries, spot: raw?.spot, ok: rows.length > 0 && expiries.length > 0 };
}

/* ── IV ──────────────────────────────────────────────────────────────────── */

/** iv_surface.grid → the curves `smile()` draws, nearest expiry first. */
export function smileCurves(ivSurface) {
  const grid = ivSurface?.grid;
  if (!grid || !Array.isArray(grid.moneyness) || !Array.isArray(grid.z)) return null;
  const curves = grid.z.map((iv, i) => ({
    iv,
    dte: isNum(grid.dte?.[i]) ? grid.dte[i] : null,
    rank: i,
    label: isNum(grid.dte?.[i]) ? `${grid.dte[i]}d` : `#${i}`,
  })).filter((c) => (c.iv || []).some(isNum));
  return { moneyness: grid.moneyness, curves, atm: ivSurface.atm_iv, spot: ivSurface.spot };
}

/* ── board ───────────────────────────────────────────────────────────────── */

/** Strikes the desk board flagged — drawn as marks on every spine so context carries across. */
export function boardMarks(board) {
  const s = new Set();
  for (const l of board?.levels || []) if (isNum(l?.strike)) s.add(l.strike);
  return s;
}

/** Wall/trigger strikes from /gex, for the same purpose. */
export function levelMarks(gexLevels) {
  const s = new Set();
  for (const k of ["call_wall", "call_wall_2", "put_wall", "put_wall_2", "vol_trigger", "max_pain"]) {
    const v = gexLevels?.[k];
    if (isNum(v)) s.add(v);
  }
  return s;
}
