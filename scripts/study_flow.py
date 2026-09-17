"""
NET FLOW — the order-flow ideas advanced traders use, tested on a bar-based cumulative-delta (CVD) proxy.

We have no tick-level buy/sell in history (Altaris's traded delta is gone; YYY's /dealer_anomalies bar_deltas are
live-only and were never stored). But every OHLCV CVD tool reconstructs net delta from bars the same way, and we
have NQ volume for both the live window and 2022-24. So this uses the standard close-location proxy, consistently.

  BAR DELTA  clv = ((close-low) - (high-close)) / (high-low);  bar_delta = clv * volume   (+ = net buying)
             (the Accumulation/Distribution / CVD-from-OHLCV convention; range −vol..+vol)
  CVD        cumulative sum of bar_delta through the session.

PRE-REGISTERED 2026-09-17 before these outcomes were computed. Signed so + always means "supports the trade":
for a support (buy) that is net BUYING, for a resistance (sell) that is net SELLING.
  H_absorb   over the prior 30 min, flow ran hard AGAINST the trade (price was being pushed through the level) yet
             price held within 0.3 E of it → absorption. flag: |Δ30 against| ≥ 70th pctl of the day AND price still
             within 0.3 E of the level at t-1.
  H_div      price made a new session extreme in the last 30 min but CVD did NOT make a new extreme (divergence
             supporting the fade).
  H_turn     net delta over the last 15 min has already flipped to SUPPORT the trade (early reversal of flow).
  H_withflow net delta over the last 60 min SUPPORTS the trade (flow already going the fade's way).
  H_exhaust  the move into the level came on strong delta (top-tercile |Δ60 into|) that dried up in the last 15
             min (|Δ15| ≤ 30th pctl) — momentum exhaustion.
OUTCOME    filled trade, ≥120 MNQ before the 15 stop (BE 11.1%); reaction +40 (BE 27.3%); +80 (BE 15.8%).
PASS       with − without ≥ +3 pts on ≥120 in both live halves AND 2022/2023, ≥100 trades with the flag per half.
    python scripts/study_flow.py
"""
from __future__ import annotations
import os, sys
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(__file__))
import study_ledger_greeks as L
import study_far_travel as FT
try: sys.stdout.reconfigure(encoding="utf-8")
except Exception: pass
ST = L.ST; MNQ = L.MNQ; COST = 1.0
NQ_BARS = L.S.NQ_BARS if hasattr(L, "S") else r"C:\Users\asare\Downloads\thepeak\hdata\NQ_1m_ET.parquet"


def bar_delta(o, h, l, c, v):
    rng = h - l
    clv = np.where(rng > 0, ((c - l) - (h - c)) / np.where(rng > 0, rng, 1), 0.0)
    return clv * v


def flow_features(bars, i, K, sup, E):
    """bars: DataFrame with lq/hq/cq and bar_delta, index-aligned; i = touch bar; returns the pre-registered flags."""
    s = 1 if sup else -1
    cl, lo, hi, bd = bars.cq.to_numpy(), bars.lq.to_numpy(), bars.hq.to_numpy(), bars.bd.to_numpy()
    n15, n30, n60 = 3, 6, 12                                    # 5-min bars
    if i < n60 + 1 or not (E > 0): return {}
    cvd = np.nancumsum(bd)
    d15 = cvd[i - 1] - cvd[i - 1 - n15]
    d30 = cvd[i - 1] - cvd[i - 1 - n30]
    d60 = cvd[i - 1] - cvd[i - 1 - n60]
    # signed so + supports the fade: a support fades a down-move, so SUPPORTING flow = net buying (+cvd)
    d15s, d30s, d60s = d15 * s, d30 * s, d60 * s
    # daily |Δ30| distribution for the "hard against" threshold
    day = bars.iloc[max(0, i - 78):i]
    dd30 = day.bd.rolling(n30).sum().dropna().abs()
    thr70 = dd30.quantile(0.7) if len(dd30) > 5 else np.inf
    thr30 = dd30.quantile(0.3) if len(dd30) > 5 else 0
    dist_now = abs(cl[i - 1] - K) * MNQ
    # session CVD/price extremes over the last 30 min (for divergence)
    seg = slice(max(0, i - n30), i)
    price_ext = (lo[seg].min() if sup else hi[seg].max())
    cvd_seg = cvd[seg]
    new_price_ext = (price_ext <= lo[max(0, i - 78):i].min() + 0.15) if sup else (price_ext >= hi[max(0, i - 78):i].max() - 0.15)
    cvd_new_ext = (cvd_seg.min() <= cvd[max(0, i - 78):i].min() + 1e-9) if sup else (cvd_seg.max() >= cvd[max(0, i - 78):i].max() - 1e-9)
    d60_into = -d60s                                            # flow pushing INTO the level (against the fade)
    return {
        "H_absorb": bool((-d30s) >= thr70 and dist_now <= 0.3 * E),
        "H_div": bool(new_price_ext and not cvd_new_ext),
        "H_turn": bool(d15s > 0 and d30s < 0),
        "H_withflow": bool(d60s > 0),
        "H_exhaust": bool(d60_into >= (day.bd.rolling(n60).sum().dropna().abs().quantile(0.66) if len(day) > 12 else np.inf) and abs(d15) <= thr30),
        "d60s": d60s, "d30s": d30s,
    }


def live():
    F = pd.read_parquet(os.path.join(ST, "reader_pattern_features.parquet"))
    F["t"] = pd.to_datetime(F.t, utc=True).dt.tz_convert("America/New_York").astype("datetime64[ns, America/New_York]")
    F = F[F.sess == "RTH"].copy()
    nq = L.load_bars("5m"); nq["date_"] = nq.t.dt.strftime("%Y-%m-%d")
    nq["bd"] = bar_delta(nq.oq, nq.hq, nq.lq, nq.cq, nq.v.to_numpy(float))
    idx = pd.Series(np.arange(len(nq)), index=nq.t.map(lambda x: x.value))
    # E from the reader features / expected_move via room; reuse the stored E where present
    rows = []
    for r in F.itertuples():
        i = idx.get(r.t.value)
        if i is None: continue
        i = int(i); sup = r.side == "support"
        g = FT.grade_live(nq, i, r.K, sup)
        if g is None: continue
        day = nq[nq.date_ == nq.date_.iloc[i]].reset_index(drop=True)
        di = int((day.t.map(lambda x: x.value) == r.t.value).values.argmax())
        E = r.E if hasattr(r, "E") and isinstance(r.E, float) and np.isfinite(r.E) else np.nan
        if not np.isfinite(E):
            E = abs(r.into_60) if False else 150 / MNQ    # fallback only; most rows carry E via reader features below
        ff = flow_features(day, di, r.K, sup, E if np.isfinite(E) else 150 / MNQ)
        if not ff: continue
        rows.append(dict(sday=r.sday, half_=r.half_, side=r.side, **g, **ff))
    return pd.DataFrame(rows)


def history():
    c = FT.history()
    d = pd.read_parquet(NQ_BARS, columns=["date", "open", "high", "low", "close", "volume"])
    d = d[(d["date"] >= "2021-12-31") & (d["date"] < "2024-01-03")].copy()
    d["day"] = d["date"].dt.strftime("%Y-%m-%d"); d["min"] = d["date"].dt.hour * 60 + d["date"].dt.minute
    d = d[(d["min"] >= 570) & (d["min"] < 960)]
    d["bd"] = bar_delta(d.open, d.high, d.low, d.close, d.volume.to_numpy(float))
    # resample NQ 1-min to 5-min to match the touch grid and reduce noise
    out_rows = []
    grp = {day: g.reset_index(drop=True) for day, g in d.groupby("day")}
    # ratio per day from S.nq_for (QQQ conversion) — reuse the alignment loader's ratio via close/F is overkill;
    # flow flags are ratio-invariant except the dist_now/E term, so convert only the level distance using a daily ratio.
    import study_0dte_alignment as S
    for r in c.itertuples():
        g = grp.get(r.date)
        if g is None: continue
        nqd = S.nq_for(r.date)
        if nqd is None: continue
        ratio = float(np.median((nqd.set_index("hm").close.reindex([r.hm]).dropna())) / r.spot) if r.hm in set(nqd.hm) else np.nan
        if not np.isfinite(ratio) or ratio <= 0: continue
        g5 = g.assign(t5=(g["min"] // 5) * 5).groupby("t5").agg(o=("open", "first"), h=("high", "max"), l=("low", "min"), cq=("close", "last"), bd=("bd", "sum")).reset_index()
        g5["lq"] = g5.l / ratio; g5["hq"] = g5.h / ratio; g5["cq"] = g5.cq / ratio
        thm = (int(r.hm[:2]) * 60 + int(r.hm[3:])) // 5 * 5
        di = int((g5.t5 == thm).values.argmax()) if (g5.t5 == thm).any() else None
        if di is None or di < 13: continue
        ff = flow_features(g5, di, r.K, r.side == "support", r.E * MNQ)
        if not ff: continue
        out_rows.append(dict(half_=r.date[:4], side=r.side, run120=bool(r.run15_120), run80=bool(r.run15_80), precise=bool(r.run15_40), **ff))
    return pd.DataFrame(out_rows)


def main():
    out = []; pr = lambda x: (out.append(x), print(x))
    D = live(); H = history()
    D["precise"] = D.run120
    pr("# NET FLOW (bar-CVD proxy) — absorption / divergence / exhaustion into a level · outcome ≥120 MNQ before the 15 stop (BE 11.1%)")
    pr(f"LIVE RTH fills: {len(D)} · base ≥120 explore {100*D[D.half_=='explore'].run120.mean():.1f}% confirm {100*D[D.half_=='confirm'].run120.mean():.1f}%")
    pr(f"HIST 2022-23 fills: {len(H)} · base ≥120 2022 {100*H[H.half_=='2022'].run120.mean():.1f}% 2023 {100*H[H.half_=='2023'].run120.mean():.1f}%")
    flags = {"H_absorb": "absorption: hard flow against, price held ≤0.3E", "H_div": "CVD divergence at a new extreme",
             "H_turn": "flow already turned to support the fade (15m)", "H_withflow": "net flow (60m) supports the fade",
             "H_exhaust": "momentum exhaustion: strong flow in, dried up"}
    passed = []
    for f, lab in flags.items():
        pr(f"\n## {f} {lab}")
        okL = FT.verdict(D, f, ("explore", "confirm"), pr)
        okH = FT.verdict(H, f, ("2022", "2023"), pr) if f in H.columns else False
        ok = okL and okH
        pr(f"   → {'PASS' if ok else 'fail'}")
        if ok: passed.append(f)
    pr("\n## monotone: outcome by net-flow-into-the-level sign (does flow direction into a level matter?)")
    for name, DF, halves in (("LIVE", D, ("explore", "confirm")), ("HIST", H, ("2022", "2023"))):
        for h in halves:
            g = DF[DF.half_ == h]
            if "d60s" not in g or len(g) < 100: continue
            with_ = g[g.d60s > 0]; against = g[g.d60s < 0]
            pr(f"  {name} {h}: flow supports fade → react {100*with_.precise.mean():4.1f}% ≥120 {100*with_.run120.mean():4.1f}% (n={len(with_)}) | flow into level → react {100*against.precise.mean():4.1f}% ≥120 {100*against.run120.mean():4.1f}% (n={len(against)})")
    pr(f"\n## PASSED: {passed if passed else 'nothing'}")
    pr("\n## trades (≥40 in a live half, net MNQ/trade, 1 MNQ cost)")
    pr(f"{'flag':>10} {'half':>8} {'trades':>7} {'≥120%':>6} {'net+120':>8} {'react%':>7} {'net+80':>8}")
    for f in list(flags) + ["ALL"]:
        for h in ("explore", "confirm"):
            g = D[D.half_ == h] if f == "ALL" else D[(D.half_ == h) & (D[f] == True)]
            if len(g) < 40: continue
            pr(f"{f:>10} {h:>8} {len(g):7d} {100*g.run120.mean():6.1f} {g.pnl120.mean()-COST:+8.1f} {100*g.precise.mean():7.1f} {g.pnl80.mean()-COST:+8.1f}")
    D.to_parquet(os.path.join(ST, "flow_live.parquet"), index=False)
    open(os.path.join(ST, "flow_report.md"), "w", encoding="utf-8").write("\n".join(out))


if __name__ == "__main__":
    main()
