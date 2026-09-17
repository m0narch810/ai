"""
RECIPE AS REAL TRADES — the RTH reader-1 recipe (already-traded level + gamma flip within 1.2 pts in the prior 2 h
+ busiest option-volume strike at the level or 1-2 strikes on the approach side), with and without the IV screen,
graded as limit orders at the strike with the user's fixed 15-MNQ stop.

Pre-registered 2026-09-17 before grading:
  FILL     limit at K; fills only if a bar trades THROUGH K (support: low < K; resistance: high > K) within 30 min
           of the touch bar (touch bar included). Touches that turn in front of the strike are no trade.
  STOP     15 MNQ beyond K, counted from the fill bar itself (the fill bar's full far extreme counts as adverse).
  TARGETS  favourable excursion counted only from the bar AFTER the fill bar (conservative).
           A = +40 target · B = +80 target · C = let it run: stop to breakeven once +40 prints, exit 15:55.
           A bar that reaches both the stop and a target is a loss. Unfilled/unresolved at 15:55: exit at that close.
  COSTS    1.0 MNQ pt per round trip (commission + fees + stop slippage), shown gross and net.
  GROUPS   all RTH whole-strike touches; recipe; recipe minus supports on falling IV (ATM IV ≤ −0.5 vol pt over
           ~60 min); no recipe. Explore 07-20→08-18, confirm 08-19→09-17. Resolved touches only (the ~3% that
           neither ran +40 nor went 15 past within 6 h are outside the feature table).
    python scripts/study_recipe_fills.py [--res 5m|1m]
"""
from __future__ import annotations
import os, sys
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(__file__))
import study_ledger_greeks as L
try: sys.stdout.reconfigure(encoding="utf-8")
except Exception: pass
ST = L.ST; MNQ = L.MNQ; COST = 1.0
STOP, T1, T2 = 15 / MNQ, 40 / MNQ, 80 / MNQ


def grade(nq, i, K, sup, bar_min):
    lo, hi, cl, hm, T = nq.lq.to_numpy(), nq.hq.to_numpy(), nq.cq.to_numpy(), nq.hm.to_numpy(), nq.date_.to_numpy()
    j_fill_end = min(len(nq), i + int(30 / bar_min) + 1)
    through = (lo[i:j_fill_end] < K) if sup else (hi[i:j_fill_end] > K)
    if not through.any(): return None
    f = i + int(np.argmax(through))
    day = T[f]
    end = f
    while end + 1 < len(nq) and T[end + 1] == day and hm[end + 1] <= 15 * 60 + 55: end += 1
    adv = (K - lo[f:end + 1]) if sup else (hi[f:end + 1] - K)
    fav = ((hi[f:end + 1] - K) if sup else (K - lo[f:end + 1])).copy(); fav[0] = -np.inf
    close_pnl = ((cl[end] - K) if sup else (K - cl[end])) * MNQ
    s_hit = np.flatnonzero(adv >= STOP); si = s_hit[0] if len(s_hit) else None
    out = {"fill_min": (f - i) * bar_min, "mae": float(np.max(adv)) * MNQ}
    for name, tgt in (("A", T1), ("B", T2)):
        t_hit = np.flatnonzero(fav >= tgt); ti = t_hit[0] if len(t_hit) else None
        if si is not None and (ti is None or si <= ti): out[name] = -15.0
        elif ti is not None: out[name] = tgt * MNQ
        else: out[name] = close_pnl
    # C: let it run — breakeven after +40, exit 15:55
    t40 = np.flatnonzero(fav >= T1); b = t40[0] if len(t40) else None
    if si is not None and (b is None or si <= b): out["C"] = -15.0
    elif b is not None:
        after = adv[b + 1:]; back = np.flatnonzero(after >= 0)
        out["C"] = 0.0 if len(back) else close_pnl
    else: out["C"] = close_pnl
    return out


def main():
    res = sys.argv[sys.argv.index("--res") + 1] if "--res" in sys.argv else "5m"
    bar_min = {"5m": 5, "1m": 1}[res]
    F = pd.read_parquet(os.path.join(ST, "reader_pattern_features.parquet"))
    F["t"] = pd.to_datetime(F.t, utc=True).dt.tz_convert("America/New_York").astype("datetime64[ns, America/New_York]")
    F = F[F.sess == "RTH"].copy()
    F["recipe"] = F.tested & (F.flip12 == True) & (F.busiest == True)
    F["avoid"] = (F.side == "support") & (F.d_iv_60 <= -0.5)
    nq = L.load_bars(res); nq["date_"] = nq.t.dt.strftime("%Y-%m-%d")
    if res == "1m":
        F = F[F.sday >= L.SPLIT].copy()
        F["t"] = F.t.dt.floor("5min")          # touches were detected on 5-min bars; grade from the bar's first minute
    idx = pd.Series(np.arange(len(nq)), index=nq.t.map(lambda x: x.value))
    rows = []
    for r in F.itertuples():
        i = idx.get(r.t.value)
        if i is None: continue
        g = grade(nq, int(i), r.K, r.side == "support", bar_min)
        rows.append(dict(sday=r.sday, half_=r.half_, side=r.side, recipe=r.recipe, avoid=r.avoid, filled=g is not None, **(g or {})))
    D = pd.DataFrame(rows)
    D.to_parquet(os.path.join(ST, f"recipe_fills_{res}.parquet"), index=False)
    print(f"# RECIPE AS TRADES — RTH, limit at the strike, trade-through fill within 30 min, 15-MNQ stop, {res} bars, cost {COST} MNQ/round trip")
    print("A = +40 target (BE 27.3%) · B = +80 target (BE 15.8%) · C = let it run (breakeven after +40, out 15:55) · MNQ pts per trade")
    groups = [("all RTH touches", pd.Series(True, index=D.index)), ("recipe", D.recipe), ("recipe minus supports on falling IV", D.recipe & ~D.avoid),
              ("no recipe", ~D.recipe), ("no recipe minus supports on falling IV", ~D.recipe & ~D.avoid), ("supports on falling IV (any)", D.avoid)]
    halves = ("explore", "confirm") if res == "5m" else ("confirm",)
    for h in halves:
        print(f"\n## {h.upper()}")
        print(f"{'group':>40} {'touches':>7} {'filled':>7} {'trades/day':>10} | {'A win%':>6} {'A net':>6} | {'B win%':>6} {'B net':>6} | {'C net':>6} {'C tot':>7}")
        days = D[D.half_ == h].sday.nunique()
        for lab, m in groups:
            g = D[m & (D.half_ == h)]; f = g[g.filled]
            if len(f) == 0: continue
            print(f"{lab:>40} {len(g):7d} {100 * len(f) / len(g):6.0f}% {len(f) / days:10.1f} | {100 * (f.A >= 40).mean():5.1f}% {f.A.mean() - COST:+6.1f} | {100 * (f.B >= 80).mean():5.1f}% {f.B.mean() - COST:+6.1f} | {f.C.mean() - COST:+6.1f} {f.C.sum() - COST * len(f):+7.0f}")
        g = D[(D.half_ == h) & D.filled]
        print(f"{'':>40} gross (no cost) for reference: all A {g.A.mean():+.1f} · recipe A {g[g.recipe].A.mean():+.1f} · recipe−avoid A {g[g.recipe & ~g.avoid].A.mean():+.1f}")


if __name__ == "__main__":
    main()
