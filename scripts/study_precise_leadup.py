"""
PRECISE-TOUCH LEAD-UP — what the two hours before a precise reaction have in common, from the strike's
point of view and from everything else, on the live feed (2026-07-20 → 09-17).

User (2026-09-17): "look at only the precise reactions and see what they all have in common … in the
time leading up to them, from the strike perspective and the whole everything perspective."

Labels (live_touches_5m.parquet, study_ledger_greeks.py definitions, whole strikes only):
  precise = +40 MNQ from the level before 15 past it; good = +80 first with ≤10 MNQ overshoot at the touch
  failed  = went 15 past before +40; unresolved touches are dropped.
A trait that every precise touch shares is only informative if failed touches share it less, so every
commonality is checked against FAILED touches from the SAME session day and side (matched pairs, which also
removes day-level regime), explore 07-20→08-18 vs confirm 08-19→09-17.

Nothing after the touch bar's open is used for any feature. Captures are RTH-only, so Globex touches carry
the prior close's book (static overnight); their book-change features are flagged, not dropped.

    python scripts/study_precise_leadup.py build        # features + matched pairs + profiles + classifier
    python scripts/study_precise_leadup.py dossiers     # text dossiers for the AI read + the blind set
"""
from __future__ import annotations
import json, os, sys
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(__file__))
import study_ledger_greeks as L
try: sys.stdout.reconfigure(encoding="utf-8")
except Exception: pass
ST = L.ST; MNQ = L.MNQ; SPLIT = L.SPLIT
DOS = os.path.join(ST, "dossiers")
BOOK_G = ["gex", "charm", "vanna", "tex", "vex", "dex", "oi_tot", "vol_tot"]


def load_touches():
    c = pd.read_parquet(os.path.join(ST, "live_touches_5m.parquet"))
    c = c[~c.half].copy()
    c["t"] = pd.to_datetime(c.t, utc=True).dt.tz_convert("America/New_York").astype("datetime64[ns, America/New_York]")
    c["failed"] = (~c.precise) & (c.mae_first40 >= 15)
    c = c[c.precise | c.failed].copy()
    c["good"] = c.strong & (c.overshoot <= 10)
    c["half_"] = np.where(c.sday < SPLIT, "explore", "confirm")
    return c.sort_values("t").reset_index(drop=True)


def load_book():
    b = pd.read_json(os.path.join(ST, "capture_strikes.jsonl"), lines=True)
    b["cap_t"] = pd.to_datetime(b.capturedAt).dt.tz_localize("America/New_York").astype("datetime64[ns, America/New_York]")
    b["oi_tot"] = b[["oi_c", "oi_p"]].sum(axis=1, min_count=1); b["vol_tot"] = b[["vol_c", "vol_p"]].sum(axis=1, min_count=1)
    ctx = pd.read_json(os.path.join(ST, "capture_context.jsonl"), lines=True)
    ctx["cap_t"] = pd.to_datetime(ctx.capturedAt).dt.tz_localize("America/New_York").astype("datetime64[ns, America/New_York]")
    ctx = ctx.sort_values("cap_t").reset_index(drop=True)
    return {k: g.set_index("K").sort_index() for k, g in b.groupby("key")}, ctx


def price_context(nq):
    """Per calendar date: RTH open/high/low/close; per session day: overnight high/low (bars before 09:30)."""
    nq = nq.copy(); nq["date"] = nq.t.dt.strftime("%Y-%m-%d")
    rth = nq[nq.sess == "RTH"].groupby("date").agg(r_open=("oq", "first"), r_high=("hq", "max"), r_low=("lq", "min"), r_close=("cq", "last"))
    rth["p_high"], rth["p_low"], rth["p_close"] = rth.r_high.shift(1), rth.r_low.shift(1), rth.r_close.shift(1)
    return nq, rth


def build():
    nq = L.load_bars("5m"); nq, rth = price_context(nq)
    c = load_touches(); book, ctx = load_book()
    T = nq.t.to_numpy(); lo, hi, cl, op, vol = nq.lq.to_numpy(), nq.hq.to_numpy(), nq.cq.to_numpy(), nq.oq.to_numpy(), nq.v.to_numpy(dtype=float)
    idx = pd.Series(np.arange(len(nq)), index=nq.t)
    cap_t = ctx.cap_t.map(lambda x: x.value).to_numpy()
    rows = []
    for r in c.itertuples():
        i = int(idx.get(r.t, -1))
        if i < 25: continue
        sup = r.side == "support"; s = 1 if sup else -1; K = r.K
        pre = slice(max(0, i - 24), i)                                   # 2 h before, touch bar excluded
        d = {}
        # ── price perspective (MNQ, signed so + = moving INTO the level) ───────────────────────────
        for m, bars in (("15", 3), ("30", 6), ("60", 12), ("120", 24)):
            j = max(0, i - bars); d[f"into_{m}"] = (cl[j] - cl[i - 1]) * s * MNQ
        path = cl[max(0, i - 12):i]; d["efficiency_60"] = abs(path[-1] - path[0]) / max(1e-9, np.abs(np.diff(path)).sum())
        d["range_30"] = (hi[i - 6:i].max() - lo[i - 6:i].min()) * MNQ
        d["range_60"] = (hi[i - 12:i].max() - lo[i - 12:i].min()) * MNQ
        d["last_bar_range"] = (hi[i - 1] - lo[i - 1]) * MNQ
        d["last_bar_into"] = (op[i - 1] - cl[i - 1]) * s * MNQ
        d["bars_since_05_away"] = next((k for k in range(1, 25) if (cl[i - k] - K) * s >= 0.5), 25)
        v30 = vol[i - 6:i]; vday = vol[max(0, i - 78):i]
        d["vol_30_rel"] = (np.nanmean(v30) / np.nanmean(vday)) if np.nanmean(vday) > 0 else np.nan
        # same-day history of this level
        same = c[(c.sday == r.sday) & (c.K == K) & (c.t < r.t)]
        d["prior_touches_same_side"] = int((same.side == r.side).sum())
        d["prior_touches_other_side"] = int((same.side != r.side).sum())
        d["prior_same_side_precise"] = int(same[same.side == r.side].precise.sum())
        # session extremes so far (session day) and reference prices
        sd = nq[(nq.sday == r.sday) & (nq.t < r.t)]
        if len(sd):
            d["k_beyond_session_extreme"] = bool((K <= sd.lq.min() + 0.15) if sup else (K >= sd.hq.max() - 0.15))
            d["dist_session_extreme"] = ((K - sd.lq.min()) if sup else (sd.hq.max() - K)) * MNQ
        date = r.t.strftime("%Y-%m-%d"); rr = rth.loc[date] if date in rth.index else None
        if rr is not None:
            for nm in ("p_high", "p_low", "p_close", "r_open"):
                d[f"k_minus_{nm}"] = (K - rr[nm]) * MNQ if np.isfinite(rr[nm]) else np.nan
            ons = nq[(nq.sday == r.sday) & (nq.sess == "ETH") & (nq.t < r.t)]
            if len(ons): d["k_minus_on_high"] = (K - ons.hq.max()) * MNQ; d["k_minus_on_low"] = (K - ons.lq.min()) * MNQ
        d["mins_into_session"] = (r.t.hour * 60 + r.t.minute - 570) if r.sess == "RTH" else np.nan
        d["hour"] = r.t.hour
        # ── book perspective ─────────────────────────────────────────────────────────────────────
        j0 = np.searchsorted(cap_t, r.t.value, side="left") - 1
        if j0 >= 0 and (r.t - ctx.cap_t.iloc[j0]).total_seconds() < 72 * 3600:
            c0 = ctx.iloc[j0]; d["cap_age_min"] = (r.t - c0.cap_t).total_seconds() / 60
            prev = ctx[(ctx.cap_t <= c0.cap_t - pd.Timedelta(minutes=50)) & (ctx.cap_t >= c0.cap_t - pd.Timedelta(minutes=80)) & (ctx.cap_t.dt.date == c0.cap_t.date())]
            c1 = prev.iloc[-1] if len(prev) else None
            d["atm_iv"] = c0.atm_iv; d["em"] = c0.em; d["regime_neg"] = c0.regime == "negative"
            d["iv_vs_start"] = (c0.iv_cur - c0.iv_start) if pd.notna(c0.iv_cur) and pd.notna(c0.iv_start) else np.nan
            d["d_iv_60"] = (c0.atm_iv - c1.atm_iv) if c1 is not None else np.nan
            d["d_net_gex_60_sign"] = np.sign(c0.net_gex - c1.net_gex) if c1 is not None and pd.notna(c0.net_gex) else np.nan
            d["net_gex_pos"] = c0.net_gex > 0 if pd.notna(c0.net_gex) else np.nan
            d["net_dex_with"] = np.sign(c0.net_dex) * s if pd.notna(c0.net_dex) else np.nan
            d["hiro_with"] = {"BULLISH": 1, "BEARISH": -1}.get(str(c0.hiro_dir).upper(), 0) * s
            d["hiro30_with"] = np.sign(c0.hiro_30m) * s if pd.notna(c0.hiro_30m) else np.nan
            d["entropy_ratio"] = c0.entropy / c0.entropy_thr if pd.notna(c0.entropy) and c0.entropy_thr else np.nan
            d["hurst"] = c0.hurst; d["garch_z"] = c0.garch_z; d["pc_rr"] = c0.pc_rr
            cons = str(c0.rv2_consensus).upper(); d["rv2_with"] = (1 if "BULL" in cons else -1 if "BEAR" in cons else 0) * s
            d["anom_net_with"] = ((c0.anom_up or 0) - (c0.anom_down or 0)) * s
            lvl = [x for x in (c0.la_levels or []) if x.get("strike") == K]
            d["la_listed"] = bool(lvl); d["la_grade"] = lvl[0].get("grade") if lvl else None; d["la_archetype"] = lvl[0].get("archetype") if lvl else None
            for nm in ("cw", "pw", "cw0", "pw0", "major", "max_pain", "flip"):
                d[f"k_is_{nm}"] = bool(pd.notna(c0[nm]) and abs(K - c0[nm]) < 0.01)
            d["k_minus_flip_em"] = (K - c0.flip) / c0.em if pd.notna(c0.flip) and c0.em else np.nan
            # strike perspective: band-relative level at t0 and change over ~60 min, K and its neighbours
            g0 = book.get(c0.key); g1 = book.get(c1.key) if c1 is not None else None
            if g0 is not None and K in g0.index:
                spot = g0.spot.iloc[0]; band = g0[(g0.index >= spot * 0.985) & (g0.index <= spot * 1.015)]
                for gk in BOOK_G:
                    mx = band[gk].abs().max()
                    if not mx or not np.isfinite(mx): continue
                    v0 = g0.at[K, gk]; d[f"{gk}_share"] = v0 / mx                     # signed share of the band max
                    d[f"{gk}_rank"] = band[gk].abs().rank(pct=True).get(K, np.nan)
                    nb = [g0[gk].abs().get(K + o, np.nan) for o in (-2, -1, 1, 2)]
                    d[f"{gk}_vs_neighbours"] = abs(v0) / max(1e-9, np.nanmax(nb)) if np.isfinite(np.nanmax(nb)) else np.nan
                    behind = [g0[gk].abs().get(K + o * (-s), np.nan) for o in (1, 2, 3)]      # strikes past the level
                    front = [g0[gk].abs().get(K + o * s, np.nan) for o in (1, 2, 3)]          # strikes price passes on the way in
                    d[f"{gk}_behind_vs_front"] = np.nansum(behind) / max(1e-9, np.nansum(front))
                    if g1 is not None and K in g1.index:
                        mx1 = g1[(g1.index >= spot * 0.985) & (g1.index <= spot * 1.015)][gk].abs().max()
                        if mx1: d[f"{gk}_share_d60"] = v0 / mx - g1.at[K, gk] / mx1
                d["charm_with"] = np.sign(g0.at[K, "charm"]) * s
                d["vanna_iv_with"] = np.sign(g0.at[K, "vanna"]) * -np.sign(d.get("d_iv_60", np.nan)) * s
                d["iv_prem"] = g0.at[K, "iv_k"] - g0.at[K, "atm_iv"]
                if g1 is not None and K in g1.index: d["iv_k_d60"] = g0.at[K, "iv_k"] - g1.at[K, "iv_k"]
                d["vol_c_share"] = g0.at[K, "vol_c"] / max(1, (g0.at[K, "vol_c"] or 0) + (g0.at[K, "vol_p"] or 0))
                d["oi_c_share"] = g0.at[K, "oi_c"] / max(1, (g0.at[K, "oi_c"] or 0) + (g0.at[K, "oi_p"] or 0))
                d["gex0_share_of_total"] = abs(g0.at[K, "gex0"]) / max(1e-9, abs(g0.at[K, "gex"])) if pd.notna(g0.at[K, "gex0"]) else np.nan
        rows.append(dict(sday=r.sday, t=r.t, sess=r.sess, K=K, side=r.side, precise=r.precise, good=r.good, failed=r.failed, half_=r.half_, overshoot=r.overshoot, **d))
    X = pd.DataFrame(rows)
    X.to_parquet(os.path.join(ST, "precise_leadup_features.parquet"), index=False)
    print(f"features: {len(X)} touches ({int(X.precise.sum())} precise, {int(X.good.sum())} good, {int(X.failed.sum())} failed) · {X.shape[1]} columns")
    analyse(X)


def matched_pairs(X, min_gap_h=0.0, max_gap_h=3.0):
    """Each precise touch paired with the nearest-in-time FAILED touch on the same session day and side, no reuse.
    min_gap_h ≥ 2.5 keeps either touch's 2-hour lead-up from containing the other's outcome (see the null check)."""
    P = X[X.precise].sort_values("t"); F = X[X.failed].copy(); used = set(); pairs = []
    for r in P.itertuples():
        cand = F[(F.sday == r.sday) & (F.side == r.side) & (~F.index.isin(used))]
        dt = (cand.t - r.t).abs(); cand = cand[(dt >= pd.Timedelta(hours=min_gap_h)) & (dt <= pd.Timedelta(hours=max_gap_h))]
        if cand.empty: continue
        j = (cand.t - r.t).abs().idxmin()
        used.add(j); pairs.append((r.Index, j))
    return pairs


def analyse(X):
    out = []
    pr = lambda s: out.append(s) or print(s)
    pairs = matched_pairs(X)
    pr(f"\n# PRECISE-TOUCH LEAD-UP — {len(X)} resolved whole-strike touches, {len(pairs)} same-day same-side matched pairs (precise vs failed)")
    feats = [c for c in X.columns if c not in ("sday", "t", "sess", "K", "side", "precise", "good", "failed", "half_", "overshoot", "la_grade", "la_archetype")]
    Pi = [a for a, b in pairs]; Fi = [b for a, b in pairs]
    P, F = X.loc[Pi].reset_index(drop=True), X.loc[Fi].reset_index(drop=True)
    rows = []
    for f in feats:
        p, q = pd.to_numeric(P[f].astype(object).where(P[f].notna()), errors="coerce").astype(float), pd.to_numeric(F[f].astype(object).where(F[f].notna()), errors="coerce").astype(float)
        ok = p.notna() & q.notna()
        if ok.sum() < 60: continue
        halves = {}
        for h in ("explore", "confirm"):
            m = ok & (P.half_ == h)
            if m.sum() < 25: halves[h] = (np.nan, 0, np.nan); continue
            diff = (p[m] - q[m]); nz = diff[diff != 0]
            wins = (nz > 0).mean() if len(nz) else np.nan          # share of pairs where precise > failed
            halves[h] = (float(diff.median()), int(m.sum()), wins)
        e, co = halves["explore"], halves["confirm"]
        same = np.isfinite(e[2]) and np.isfinite(co[2]) and (e[2] - 0.5) * (co[2] - 0.5) > 0
        # sign test on the confirm half
        n = int(((p - q)[ok & (P.half_ == "confirm")] != 0).sum()); k = int(((p - q)[ok & (P.half_ == "confirm")] > 0).sum())
        from math import comb
        pval = min(1.0, 2 * sum(comb(n, x) for x in range(0, min(k, n - k) + 1)) / 2 ** n) if n else np.nan
        rows.append((f, p[ok].median(), q[ok].median(), e, co, same, pval))
    rows.sort(key=lambda x: (not x[5], x[6] if np.isfinite(x[6]) else 1))
    pr("\n## MATCHED PAIRS — every feature; 'precise>failed' = share of pairs where the precise touch had the higher value (0.50 = no difference)")
    pr(f"{'feature':>28} {'med precise':>11} {'med failed':>10} | {'explore: share, n':>18} | {'confirm: share, n':>18} | same sign | confirm sign-test p")
    for f, mp, mf, e, co, same, pval in rows:
        pr(f"{f:>28} {mp:11.3f} {mf:10.3f} | {e[2]:6.2f} n={e[1]:4d}      | {co[2]:6.2f} n={co[1]:4d}      | {'yes' if same else ' no'}       | {pval:.3f}")
    # categorical: level-assessment grade and archetype
    for cat in ("la_grade", "la_archetype"):
        pr(f"\n## {cat} (precise rate among all resolved touches, by half)")
        for v, g in X.groupby(X[cat].fillna("not listed")):
            e = g[g.half_ == "explore"]; co = g[g.half_ == "confirm"]
            if len(g) < 30: continue
            pr(f"  {str(v):>22}: explore {100 * e.precise.mean():5.1f}% n={len(e):4d} | confirm {100 * co.precise.mean():5.1f}% n={len(co):4d}")
    classifier(X, feats, pr)
    open(os.path.join(ST, "precise_leadup_report.md"), "w", encoding="utf-8").write("\n".join(out))


def classifier(X, feats, pr):
    from sklearn.ensemble import HistGradientBoostingClassifier
    from sklearn.metrics import roc_auc_score
    num = [f for f in feats if pd.api.types.is_numeric_dtype(X[f]) or X[f].dtype == bool]
    Z = X[num].apply(lambda col: pd.to_numeric(col.astype(object).where(col.notna()), errors="coerce")).astype(float)
    y = X.precise.astype(int).to_numpy(); ex = (X.half_ == "explore").to_numpy(); co = ~ex
    price = [f for f in num if f.startswith(("into_", "efficiency", "range_", "last_bar", "bars_since", "vol_30", "prior_", "k_beyond", "dist_session", "k_minus_p", "k_minus_r", "k_minus_on", "mins_into", "hour"))]
    bookf = [f for f in num if f not in price]
    pr("\n## CLASSIFIER — gradient boosting trained on one half, scored once on the other (AUC 0.50 = no information)")
    for name, cols in (("everything", num), ("price / session only", price), ("book only (strike + whole)", bookf)):
        res = []
        for tr, te, lab in ((ex, co, "explore→confirm"), (co, ex, "confirm→explore")):
            m = HistGradientBoostingClassifier(max_depth=3, learning_rate=0.05, max_iter=200, min_samples_leaf=40, l2_regularization=1.0, random_state=7)
            m.fit(Z.loc[tr, cols], y[tr]); auc = roc_auc_score(y[te], m.predict_proba(Z.loc[te, cols])[:, 1])
            rng = np.random.default_rng(11); null = []
            for _ in range(30):
                yy = rng.permutation(y[tr]); mm = HistGradientBoostingClassifier(max_depth=3, learning_rate=0.05, max_iter=200, min_samples_leaf=40, l2_regularization=1.0, random_state=7)
                mm.fit(Z.loc[tr, cols], yy); null.append(roc_auc_score(y[te], mm.predict_proba(Z.loc[te, cols])[:, 1]))
            res.append(f"{lab} AUC {auc:.3f} (shuffled-label null {np.mean(null):.3f} ± {np.std(null):.3f}, max {np.max(null):.3f})")
        pr(f"  {name:>28} ({len(cols)} features): " + " · ".join(res))


# ── dossiers ─────────────────────────────────────────────────────────────────────────────────────
def dossier(X, r, nq, book, ctx, show_label=False):
    sup = r.side == "support"; s = 1 if sup else -1; K = r.K
    i = int(np.flatnonzero(nq.t.map(lambda x: x.value).to_numpy() == r.t.value)[0])
    lines = [f"LEVEL {K:.0f} as {r.side.upper()} · touched {r.t:%a %Y-%m-%d %H:%M} ET ({r.sess})" + (f" · OUTCOME: {'PRECISE' if r.precise else 'FAILED'}" if show_label else "")]
    rw = X.loc[r.Index]
    def g(k, fmt="{:.0f}"):
        v = rw.get(k, np.nan)
        return "—" if v is None or (isinstance(v, float) and not np.isfinite(v)) else fmt.format(v)
    lines.append(f"session: level vs prior-day high {g('k_minus_p_high')} / low {g('k_minus_p_low')} / close {g('k_minus_p_close')} · vs today's open {g('k_minus_r_open')} · vs overnight high {g('k_minus_on_high')} / low {g('k_minus_on_low')}  (MNQ pts)")
    lines.append(f"level is beyond the session extreme so far: {g('k_beyond_session_extreme', '{}')} · earlier touches today: same side {g('prior_touches_same_side')} (precise {g('prior_same_side_precise')}), other side {g('prior_touches_other_side')}")
    lines.append("\nPRICE, last 2 h before the touch (5-min bars; distance from the level in MNQ pts, + = on the approach side):")
    for k in range(max(0, i - 24), i):
        lines.append(f"  {nq.t.iloc[k]:%H:%M}  close {(nq.cq.iloc[k] - K) * s * MNQ:+6.0f}  low {(nq.lq.iloc[k] - K) * s * MNQ if sup else (nq.hq.iloc[k] - K) * s * MNQ:+6.0f}  range {(nq.hq.iloc[k] - nq.lq.iloc[k]) * MNQ:4.0f}  vol {nq.v.iloc[k]:>7.0f}")
    cap_t = ctx.cap_t.map(lambda x: x.value).to_numpy(); j0 = np.searchsorted(cap_t, r.t.value, side="left") - 1
    caps = ctx[(ctx.cap_t <= ctx.cap_t.iloc[j0]) & (ctx.cap_t >= ctx.cap_t.iloc[j0] - pd.Timedelta(minutes=120)) & (ctx.cap_t.dt.date == ctx.cap_t.iloc[j0].date())] if j0 >= 0 else ctx.iloc[0:0]
    caps = caps.iloc[::max(1, len(caps) // 8)] if len(caps) > 8 else caps
    lines.append(f"\nWHOLE BOOK at each capture (last one {g('cap_age_min')} min before the touch; Globex touches see the prior close's book):")
    for c0 in caps.itertuples():
        lines.append(f"  {c0.cap_t:%m-%d %H:%M} spot {(c0.spot - K) * s * MNQ:+5.0f} · ATM IV {c0.atm_iv:.2f} (vs open {c0.iv_cur - c0.iv_start if c0.iv_cur and c0.iv_start else float('nan'):+.2f}) · EM {c0.em:.1f} · {c0.regime} gamma · flip {c0.flip:.1f} · cw {c0.cw} pw {c0.pw} major {c0.major} · HIRO {c0.hiro_dir} 30m {c0.hiro_30m} · Hurst {c0.hurst} · entropy {c0.entropy_status} · regime vote {c0.rv2_consensus} · RR {c0.pc_rr}")
    if j0 >= 0:
        c0 = ctx.iloc[j0]; lvls = [f"{x['strike']:.0f} {x.get('zone')}/{x.get('grade')}/{x.get('archetype')}" for x in (c0.la_levels or []) if x.get("strike") is not None]
        lines.append(f"  desk level assessment: {c0.la_zone or '—'} · dominant {c0.la_dominant} · levels: {', '.join(lvls) if lvls else 'none'}")
    lines.append("\nSTRIKE NEIGHBOURHOOD at the last capture and ~60 min earlier (signed, % of the ±1.5% band's largest |value| for that greek; IV in vol pts):")
    for lab, key in (("now", ctx.key.iloc[j0] if j0 >= 0 else None), ("-60m", caps.key.iloc[0] if len(caps) > 1 else None)):
        g0 = book.get(key) if key else None
        if g0 is None: continue
        spot = g0.spot.iloc[0]; band = g0[(g0.index >= spot * 0.985) & (g0.index <= spot * 1.015)]
        lines.append(f"  [{lab}] strike  " + "  ".join(f"{x:>6}" for x in ("gamma", "charm", "vanna", "theta", "vega", "delta", "OI", "volume", "IV")))
        for o in (-3, -2, -1, 0, 1, 2, 3):
            kk = K + o * s                 # listed from the far side (past the level) to the approach side
            if kk not in g0.index: continue
            vals = []
            for gk in BOOK_G:
                mx = band[gk].abs().max(); v = g0.at[kk, gk]
                vals.append(f"{(100 * v / mx):+6.0f}" if mx and pd.notna(v) else "     —")
            iv = g0.at[kk, "iv_k"]
            tag = " ◀ LEVEL" if o == 0 else (" (past)" if o < 0 else "")
            lines.append(f"         {kk:6.0f}  " + "  ".join(vals) + f"  {iv:6.1f}{tag}" if pd.notna(iv) else f"         {kk:6.0f}  " + "  ".join(vals) + f"       —{tag}")
    return "\n".join(lines)


def dossiers():
    X = pd.read_parquet(os.path.join(ST, "precise_leadup_features.parquet"))
    X["t"] = pd.to_datetime(X.t, utc=True).dt.tz_convert("America/New_York").astype("datetime64[ns, America/New_York]")
    nq = L.load_bars("5m"); book, ctx = load_book()
    os.makedirs(os.path.join(DOS, "precise"), exist_ok=True); os.makedirs(os.path.join(DOS, "blind"), exist_ok=True)
    rng = np.random.default_rng(17)
    # READ SET: good touches (80 first, ≤10 overshoot) from the EXPLORE half, one per session day+side cluster
    good = X[X.good & (X.half_ == "explore")].copy(); good["cl"] = good.sday + good.side + (good.t.dt.hour // 2).astype(str)
    good = good.groupby("cl").head(1)
    rth, eth = good[good.sess == "RTH"], good[good.sess == "ETH"]
    pick = pd.concat([rth.sample(min(28, len(rth)), random_state=3), eth.sample(min(20, len(eth)), random_state=3)]).sort_values("t")
    for n, r in enumerate(pick.itertuples()):
        open(os.path.join(DOS, "precise", f"P{n:02d}.txt"), "w", encoding="utf-8").write(dossier(X, r, nq, book, ctx))
    # BLIND SET: CONFIRM half, 20 good + 20 failed matched (same day and side), shuffled, unlabeled
    C = X[X.half_ == "confirm"]; pairs = matched_pairs(C, min_gap_h=2.5, max_gap_h=24)
    pairs = [(a, b) for a, b in pairs if C.loc[a, "good"]]
    sel = [pairs[k] for k in rng.choice(len(pairs), size=min(20, len(pairs)), replace=False)]
    items = [(a, "PRECISE") for a, b in sel] + [(b, "FAILED") for a, b in sel]
    order = rng.permutation(len(items)); key = []
    for n, o in enumerate(order):
        ix, lab = items[o]; r = next(C.loc[[ix]].itertuples())
        open(os.path.join(DOS, "blind", f"B{n:02d}.txt"), "w", encoding="utf-8").write(dossier(C, r, nq, book, ctx))
        key.append(dict(id=f"B{n:02d}", label=lab, t=str(r.t), K=r.K, side=r.side))
    pd.DataFrame(key).to_csv(os.path.join(ST, "blind_key.csv"), index=False)       # kept outside the dossier folder
    print(f"dossiers: {len(pick)} precise (explore half, RTH {len(pick[pick.sess == 'RTH'])}, ETH {len(pick[pick.sess == 'ETH'])}) · {len(items)} blind (confirm half, 50/50)")


def analyse_saved():
    X = pd.read_parquet(os.path.join(ST, "precise_leadup_features.parquet"))
    X["t"] = pd.to_datetime(X.t, utc=True).dt.tz_convert("America/New_York").astype("datetime64[ns, America/New_York]")
    analyse(X)


if __name__ == "__main__":
    {"build": build, "analyse": analyse_saved, "dossiers": dossiers}[sys.argv[1]]()
