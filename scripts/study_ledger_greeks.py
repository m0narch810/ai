"""
LIVE-FEED PRECISION STUDY — which strike touches react PRECISELY, judged on the desk's own YYY book.

User (2026-09-17): the good levels are touched precisely and overshot by ≤10-15 MNQ, in RTH and
Globex alike (712 long 05:49 on 09-17 ~1.5 pts; 700 long 15:27 on 09-16 ~3 pts; 712 HOD 11:47 on
09-16 ~4.5 pts). "The big guys talk about gamma, vanna, charm and implied volatility; sometimes
theta." Question: what in the book at the strike separates the precise touches from the rest?

PRE-REGISTERED 2026-09-17, before any outcome was computed:
  TOUCH    price arrives from ≥0.50 QQQ away (prior bar close) and the bar reaches within 0.15 of a
           whole strike K (support: from above; resistance: from below). A level is ARMED once a bar closes ≥0.50
           away since its last touch; slow grinds count (amended before features were read: the user's
           09-17 712 and 09-16 700 were re-touches reached by a grind). RTH and Globex. Session day = calendar date, or the next weekday
           for bars from 18:00.
  OUTCOME  race from the touch bar: adverse = how far price goes PAST K (MNQ); favourable = how far
           it runs from K the right way, counted only from the bar AFTER the touch bar (conservative:
           the touch bar's other extreme may have printed before the touch).
           precise = favourable ≥40 before adverse ≥15.  strong = favourable ≥80 before adverse ≥15.
           Horizon 6 h. Grader: NQ=F converted to QQQ by the median NQ/QQQ ratio of the prior 24
           overlapping bars (QQQ incl. pre/post); bars whose carried ratio disagrees with the next
           available one by >0.10% are dropped (roll / thin-print guard; a data-quality filter only).
  NULL     the identical construction at half-strikes (K+0.5), where no options exist. If strikes
           carry no information, whole and half strikes react precisely at the same rate.
  FEATURES the last capture strictly before the touch (captures are RTH-only, so Globex touches use
           the prior close's book — the chain is static overnight). All band-relative within ±1.5%
           of the capture spot, never compared across greeks: |g| percentile rank; local peak
           (|g(K)| ≥ both neighbours); sign; for charm and vanna×IV-direction, whether the forced
           dealer flow is WITH the side (buying at a support, selling at a resistance); 0DTE share of
           the tenor ladder; strike IV − ATM IV; local skew slope; ATM IV change over the prior
           30-45 min; walls (K = call/put wall, 0DTE walls, band max |gex|); on the desk board.
  SPLIT    explore 2026-07-20 → 08-18, confirm 08-19 → 09-17. A feature counts only if the gap has
           the same sign in both halves AND the confirm-half 95% intervals do not overlap.
    python scripts/study_ledger_greeks.py [--res 5m|1m]
"""
from __future__ import annotations
import json, glob, os, sys
import numpy as np, pandas as pd
try: sys.stdout.reconfigure(encoding="utf-8")
except Exception: pass
ROOT = os.path.join(os.path.dirname(__file__), ".."); ST = os.path.join(ROOT, "data", "study")
MNQ = 40.7; TOL, CONTACT, NEAR = 0.15, 0.50, 0.015
ADV, RUN, RUN2 = 15 / MNQ, 40 / MNQ, 80 / MNQ
SPLIT = "2026-08-19"
GREEKS = ["gex", "charm", "vanna", "tex", "vex", "dex", "gex0", "charm0", "vanna0", "tex0", "oi_tot", "vol_tot"]


def wilson(k, n, z=1.96):
    if n == 0: return (np.nan, np.nan)
    p = k / n; d = 1 + z * z / n; c = p + z * z / (2 * n); s = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return ((c - s) / d, (c + s) / d)


def load_bars(res):
    nq = pd.read_parquet(os.path.join(ST, f"yahoo_NQF_{res}.parquet")); qq = pd.read_parquet(os.path.join(ST, f"yahoo_QQQ_{res}.parquet"))
    nq = nq.sort_values("t").reset_index(drop=True); qq = qq.sort_values("t")
    ov = nq[["t", "c"]].merge(qq[["t", "c"]], on="t", suffixes=("_nq", "_qq")); ov = ov[(ov.c_qq > 0)]
    ov["r"] = ov.c_nq / ov.c_qq
    win = 24 if res == "5m" else 60
    ov["r_prev"] = ov.r.rolling(win, min_periods=6).median().shift(1)
    ov["r_next"] = ov.r[::-1].rolling(win, min_periods=6).median()[::-1]
    nq = pd.merge_asof(nq, ov[["t", "r_prev"]].dropna(), on="t", direction="backward")
    nq = pd.merge_asof(nq, ov[["t", "r_next"]].dropna(), on="t", direction="forward")
    nq["ok"] = (nq.r_prev / nq.r_next - 1).abs() <= 0.001
    for k in ("o", "h", "l", "c"): nq[k + "q"] = nq[k] / nq.r_prev
    nq["hm"] = nq.t.dt.hour * 60 + nq.t.dt.minute
    nq["sess"] = np.where((nq.hm >= 570) & (nq.hm < 960), "RTH", "ETH")
    d = nq.t.dt.tz_localize(None).dt.normalize()
    nxt = d + pd.offsets.BDay(1)
    nq["sday"] = np.where(nq.hm >= 18 * 60, nxt.dt.strftime("%Y-%m-%d"), d.dt.strftime("%Y-%m-%d"))
    return nq.dropna(subset=["r_prev"]).reset_index(drop=True)


def contacts(nq, bar_min):
    """Per (level, side) state machine: ARMED once a bar closes ≥0.50 away on the approach side since
    the last touch (or a tape gap); a TOUCH is an armed level whose bar reaches within 0.15; it then
    disarms until price is ≥0.50 away again. Slow grinds into a strike count (the user's 09-17 712)."""
    lo, hi, cl = nq.lq.to_numpy(), nq.hq.to_numpy(), nq.cq.to_numpy(); ok = nq.ok.to_numpy()
    T = nq.t.to_numpy(); sday = nq.sday.to_numpy(); sess = nq.sess.to_numpy()
    horizon = int(6 * 60 / bar_min)
    Ks = np.arange(np.floor(np.nanmin(lo)) - 1, np.ceil(np.nanmax(hi)) + 2, 0.5)
    armed_s = np.zeros(len(Ks), bool); armed_r = np.zeros(len(Ks), bool)
    gap = np.r_[True, np.diff(T) / np.timedelta64(1, "m") > 3 * bar_min]
    rows = []
    for i in range(len(nq)):
        if gap[i]: armed_s[:] = False; armed_r[:] = False
        if i > 0 and ok[i]:
            F = cl[i - 1]; near = np.abs(Ks - F) <= F * NEAR
            ts = armed_s & near & (lo[i] <= Ks + TOL); tr = armed_r & near & (hi[i] >= Ks - TOL)
            for side, hits in (("support", np.flatnonzero(ts)), ("resistance", np.flatnonzero(tr))):
                sup = side == "support"
                for idx in hits:
                    K = float(Ks[idx]); j_end = min(len(nq), i + horizon + 1)
                    adv = np.maximum(0, (K - lo[i:j_end]) if sup else (hi[i:j_end] - K))
                    fav = ((hi[i:j_end] - K) if sup else (K - lo[i:j_end])).copy(); fav[0] = -np.inf
                    a_hit = np.flatnonzero(adv >= ADV); ai = a_hit[0] if len(a_hit) else None
                    def before(th):
                        f = np.flatnonzero(fav >= th); fi = f[0] if len(f) else None
                        return fi is not None and (ai is None or fi < ai), fi
                    p40, f40 = before(RUN); p80, _ = before(RUN2)
                    stop_at = ai if ai is not None else len(adv) - 1
                    rows.append(dict(sday=sday[i], t=pd.Timestamp(T[i]), sess=sess[i], K=K, half=(K % 1) == 0.5, side=side,
                                     overshoot=float(adv[0]) * MNQ, mae_first40=float(adv[: (f40 if f40 is not None else len(adv))].max()) * MNQ,
                                     precise=p40, strong=p80, mfe_before_stop=float(np.max(fav[1:stop_at + 1])) * MNQ if stop_at >= 1 else 0.0,
                                     traded_through=bool((lo[i] < K) if sup else (hi[i] > K))))
            armed_s[ts] = False; armed_r[tr] = False
        # arm on this bar's close
        armed_s |= cl[i] >= Ks + CONTACT; armed_r |= cl[i] <= Ks - CONTACT
    return pd.DataFrame(rows)


def load_book():
    b = pd.read_json(os.path.join(ST, "capture_strikes.jsonl"), lines=True)
    b["cap_t"] = pd.to_datetime(b.capturedAt).dt.tz_localize("America/New_York")
    b["oi_tot"] = b[["oi_c", "oi_p"]].sum(axis=1, min_count=1); b["vol_tot"] = b[["vol_c", "vol_p"]].sum(axis=1, min_count=1)
    feats = []
    for key, g in b.groupby("key", sort=False):
        g = g.sort_values("K").set_index("K"); spot = g.spot.iloc[0]
        band = g[(g.index >= spot * (1 - NEAR)) & (g.index <= spot * (1 + NEAR))]
        if len(band) < 8: continue
        f = pd.DataFrame(index=band.index)
        for gk in GREEKS:
            a = band[gk].abs()
            f[f"{gk}_rank"] = a.rank(pct=True)
            nb = g[gk].abs(); f[f"{gk}_peak"] = [bool(np.isfinite(nb.get(k, np.nan)) and nb.get(k, 0) > 0 and nb.get(k, 0) >= nb.get(k - 1, 0) and nb.get(k, 0) >= nb.get(k + 1, 0)) for k in band.index]
            f[f"{gk}_sign"] = np.sign(band[gk])
        for gk in ("gex", "charm", "vanna", "tex"):
            den = band[[f"{gk}_d0", f"{gk}_w1", f"{gk}_w2"]].abs().sum(axis=1)
            f[f"{gk}_d0share"] = band[f"{gk}_d0"].abs() / den.replace(0, np.nan)
        f["iv_prem"] = band.iv_k - band.atm_iv
        ivk = g.iv_k; f["skew_slope"] = [(ivk.get(k + 1, np.nan) - ivk.get(k - 1, np.nan)) / 2 for k in band.index]
        f["is_cw"] = band.index == band.cw.iloc[0]; f["is_pw"] = band.index == band.pw.iloc[0]
        f["is_cw0"] = band.index == band.cw0.iloc[0]; f["is_pw0"] = band.index == band.pw0.iloc[0]
        f["is_gexmax"] = band.index == band.gex.abs().idxmax()
        f["dist_em"] = (band.index - spot) / band.em.iloc[0]
        for c in ("key", "cap_t", "spot", "atm_iv", "em", "regime", "net_vanna", "pc"): f[c] = band[c].iloc[0]
        feats.append(f.reset_index())
    F = pd.concat(feats, ignore_index=True)
    # ATM IV change over the prior 30-45 min (same day)
    caps = F.drop_duplicates("key")[["key", "cap_t", "atm_iv"]].sort_values("cap_t")
    caps["day"] = caps.cap_t.dt.date
    prev = []
    for r in caps.itertuples():
        m = caps[(caps.day == r.day) & (caps.cap_t <= r.cap_t - pd.Timedelta(minutes=25)) & (caps.cap_t >= r.cap_t - pd.Timedelta(minutes=50))]
        prev.append(r.atm_iv - m.atm_iv.iloc[-1] if len(m) else np.nan)
    caps["d_iv"] = prev
    return F.merge(caps[["key", "d_iv"]], on="key", how="left")


def attach(c, F):
    caps = F.drop_duplicates("key")[["key", "cap_t"]].sort_values("cap_t")
    c = c.copy(); c["t"] = pd.to_datetime(c.t, utc=True).dt.tz_convert("America/New_York").astype("datetime64[ns, America/New_York]")
    caps = caps.copy(); caps["cap_t"] = pd.to_datetime(caps.cap_t, utc=True).dt.tz_convert("America/New_York").astype("datetime64[ns, America/New_York]")
    c = c.sort_values("t")
    c = pd.merge_asof(c, caps, left_on="t", right_on="cap_t", direction="backward", allow_exact_matches=False)
    c["cap_age_h"] = (c.t - c.cap_t).dt.total_seconds() / 3600
    c.loc[c.cap_age_h > 72, "key"] = np.nan                       # weekends allowed (Fri 16:00 → Sun night)
    c = c.merge(F.drop(columns=["cap_t"]), on=["key", "K"], how="left")
    # side-aligned forced flows
    s = np.where(c.side == "support", 1, -1)
    c["charm_with"] = np.sign(c.charm_sign * s)          # +1: charm makes dealers buy at a support / sell at a resistance
    c["charm0_with"] = np.sign(c.charm0_sign * s)
    ivdir = -np.sign(c.d_iv)                              # +1 when IV is falling
    c["vanna_with"] = np.sign(c.vanna_sign * ivdir * s)   # vanna+ with falling IV → dealers buy
    c["vanna0_with"] = np.sign(c.vanna0_sign * ivdir * s)
    return c


def board_levels():
    out = []
    for f in sorted(glob.glob(os.path.join(ROOT, "data", "scored", "*.boards.jsonl"))):
        for l in open(f, encoding="utf-8"):
            b = json.loads(l); sc = b.get("scored_at")
            if not sc: continue
            for lv in b.get("levels", []): out.append(dict(bt=pd.Timestamp(sc, unit="ms", tz="UTC").tz_convert("America/New_York"), K=float(lv["strike"]), bside=lv.get("side")))
    return pd.DataFrame(out)


def rate(g, col):
    n = len(g); k = int(g[col].sum()); lo, hi = wilson(k, n)
    return 100 * k / n if n else np.nan, 100 * lo, 100 * hi, n


def row(label, g, col="precise"):
    r, lo, hi, n = rate(g, col)
    return f"{label:>42} {n:5d}  {r:5.1f}% [{lo:4.1f}-{hi:4.1f}]"


def compare(c, name, masks, col="precise"):
    """masks: list of (label, boolean Series). Prints explore / confirm side by side."""
    print(f"\n### {name}   ({col})")
    print(f"{'':>42} {'EXPLORE 07-20→08-18':>27} | {'CONFIRM 08-19→09-17':>27}")
    ex, co = c.sday < SPLIT, c.sday >= SPLIT
    res = []
    for label, m in masks:
        a = rate(c[m & ex], col); b = rate(c[m & co], col); res.append((label, a, b))
        print(f"{label:>42} {a[3]:5d} {a[0]:5.1f}% [{a[1]:4.1f}-{a[2]:4.1f}] | {b[3]:5d} {b[0]:5.1f}% [{b[1]:4.1f}-{b[2]:4.1f}]")
    return res


def main():
    res = sys.argv[sys.argv.index("--res") + 1] if "--res" in sys.argv else "5m"
    bar_min = {"5m": 5, "2m": 2, "1m": 1}[res]
    nq = load_bars(res)
    print(f"# LIVE-FEED PRECISION STUDY — NQ {res} converted, {nq.t.min():%Y-%m-%d} → {nq.t.max():%Y-%m-%d} · dropped for ratio disagreement: {100 * (~nq.ok).mean():.1f}% of bars")
    c = contacts(nq, bar_min)
    c.to_parquet(os.path.join(ST, f"live_touches_{res}.parquet"), index=False)
    print(f"touches: {len(c)} ({(~c.half).sum()} whole strikes, {c.half.sum()} half-strikes) over {c.sday.nunique()} session days")
    print("precise = runs 40 MNQ from the strike before going 15 past it · strong = runs 80 first · horizon 6 h")

    print("\n## 0. USER'S EXAMPLES (must appear as precise touches)")
    for day, K, side in [("2026-09-17", 712.0, "support"), ("2026-09-16", 700.0, "support"), ("2026-09-16", 712.0, "resistance")]:
        x = c[(c.sday == day) & (c.K == K) & (c.side == side)]
        print("  ", day, K, side, "→", "NOT FOUND" if x.empty else x[["t", "sess", "overshoot", "precise", "strong", "mfe_before_stop"]].round(1).to_dict("records"))

    print("\n## 1. NULL CHECK — do whole strikes react precisely more often than half-strikes (no options there)?")
    for s in ["RTH", "ETH"]:
        for col in ["precise", "strong"]:
            w = rate(c[(~c.half) & (c.sess == s)], col); h = rate(c[c.half & (c.sess == s)], col)
            print(f"  {s} {col:>7}: whole {w[0]:5.1f}% [{w[1]:4.1f}-{w[2]:4.1f}] n={w[3]:4d} · half {h[0]:5.1f}% [{h[1]:4.1f}-{h[2]:4.1f}] n={h[3]:4d}")
    w = c[~c.half]; h = c[c.half]
    print(f"  overshoot when it traded through (MNQ): whole median {w[w.traded_through].overshoot.median():.1f} · half {h[h.traded_through].overshoot.median():.1f}")
    print(f"  share of touches that turned within 0.15 WITHOUT trading through: whole {100 * (~w.traded_through).mean():.1f}% · half {100 * (~h.traded_through).mean():.1f}%")
    if res != "5m":
        return

    F = load_book()
    w = attach(c[~c.half].copy(), F)
    bl = board_levels()
    if len(bl):
        bl["bt"] = bl.bt.astype("datetime64[ns, America/New_York]")
        bl = bl.sort_values("bt"); w = w.sort_values("t")
        onb = []
        for r in w.itertuples():
            m = bl[(bl.bt < r.t) & (bl.bt >= r.t - pd.Timedelta(hours=18))]
            onb.append(bool(len(m) and (m[m.bt == m.bt.max()].K == r.K).any()))
        w["on_board"] = onb
    w = w[w.key.notna()].copy()
    w.to_parquet(os.path.join(ST, "live_touches_features.parquet"), index=False)
    print(f"\n## 2. BOOK FEATURES AT THE STRIKE — {len(w)} whole-strike touches with a capture (RTH {int((w.sess == 'RTH').sum())}, ETH {int((w.sess == 'ETH').sum())})")
    base = pd.Series(True, index=w.index)
    compare(w, "base", [("all", base), ("RTH", w.sess == "RTH"), ("ETH", w.sess == "ETH"), ("support", w.side == "support"), ("resistance", w.side == "resistance")])
    for gk in GREEKS:
        r = w[f"{gk}_rank"]
        compare(w, f"{gk}: |value| rank in the ±1.5% band, and local peak",
                [("bottom third", r <= 1 / 3), ("middle third", (r > 1 / 3) & (r <= 2 / 3)), ("top third", r > 2 / 3), ("top 10%", r > 0.9), ("local peak", w[f"{gk}_peak"] == True), ("not a peak", w[f"{gk}_peak"] == False)])
    for gk in ("gex", "gex0", "tex", "tex0", "dex", "vex"):
        compare(w, f"{gk} sign at the strike", [("positive", w[f"{gk}_sign"] > 0), ("negative", w[f"{gk}_sign"] < 0)])
    for gk in ("charm_with", "charm0_with", "vanna_with", "vanna0_with"):
        compare(w, f"{gk}: forced dealer flow WITH the side (+1) or AGAINST (−1)", [("with", w[gk] > 0), ("against", w[gk] < 0)])
    for gk in ("gex", "charm", "vanna", "tex"):
        s = w[f"{gk}_d0share"]; compare(w, f"{gk}: 0DTE share of the tenor ladder", [("<1/3", s < 1 / 3), ("1/3-2/3", (s >= 1 / 3) & (s < 2 / 3)), (">2/3", s >= 2 / 3)])
    compare(w, "ATM IV change over the prior 30-45 min (vol pts)", [("falling ≤ −0.5", w.d_iv <= -0.5), ("flat", w.d_iv.abs() < 0.5), ("rising ≥ +0.5", w.d_iv >= 0.5)])
    for side in ("support", "resistance"):
        m = w.side == side
        compare(w, f"{side}: ATM IV change", [("falling", m & (w.d_iv <= -0.5)), ("flat", m & (w.d_iv.abs() < 0.5)), ("rising", m & (w.d_iv >= 0.5))])
    q = w.iv_prem.quantile([1 / 3, 2 / 3]).to_numpy()
    compare(w, f"strike IV − ATM IV (terciles at {q[0]:.2f}, {q[1]:.2f})", [("low", w.iv_prem <= q[0]), ("mid", (w.iv_prem > q[0]) & (w.iv_prem <= q[1])), ("high", w.iv_prem > q[1])])
    q = w.skew_slope.quantile([1 / 3, 2 / 3]).to_numpy()
    compare(w, "local skew slope at the strike (terciles)", [("low", w.skew_slope <= q[0]), ("mid", (w.skew_slope > q[0]) & (w.skew_slope <= q[1])), ("high", w.skew_slope > q[1])])
    compare(w, "named walls", [("call wall", w.is_cw == True), ("put wall", w.is_pw == True), ("0DTE call wall", w.is_cw0 == True), ("0DTE put wall", w.is_pw0 == True), ("band max |gex|", w.is_gexmax == True), ("none of these", ~(w.is_cw | w.is_pw | w.is_cw0 | w.is_pw0 | w.is_gexmax).astype(bool))])
    compare(w, "regime at the capture", [("negative gamma", w.regime == "negative"), ("positive gamma", w.regime == "positive")])
    compare(w, "distance from the capture spot (expected moves)", [("<0.25 EM", w.dist_em.abs() < 0.25), ("0.25-0.5", (w.dist_em.abs() >= 0.25) & (w.dist_em.abs() < 0.5)), ("≥0.5 EM", w.dist_em.abs() >= 0.5)])
    if "on_board" in w: compare(w, "on the desk board at the time", [("on board", w.on_board), ("not on board", ~w.on_board)])
    # the "big guys" alignment: gamma peak AND charm with AND vanna×IV with
    trio = (w.gex_peak == True) & (w.charm_with > 0) & (w.vanna_with > 0)
    compare(w, "gamma local peak + charm with + vanna×IV with (all three)", [("all three", trio), ("not all three", ~trio)])
    for col in ("strong",):
        compare(w, "strong (80 first): top-third |gex| / |charm| / |vanna| / |tex|", [(f"{gk} top third", w[f"{gk}_rank"] > 2 / 3) for gk in ("gex", "charm", "vanna", "tex")] + [("all", base)], col=col)


if __name__ == "__main__":
    main()
