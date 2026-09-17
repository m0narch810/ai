"""
OPEN EXPLORATION over the state tape (study_state_tape.py) — every feature, its 5/15/30/60-min
changes and its distance to spot, swept against the "tight stop, let it run" outcomes, plus
event-aligned time profiles around the atlas turns / run-throughs.

Not a hypothesis test: this prints EVERYTHING, ranked by effect, with n and a 2022-vs-2023
sign-consistency flag so a reader can separate a regularity from a lucky bin. Multiple
comparisons are the price of looking wide — anything found here is a lead, not a result.

    python scripts/study_state_explore.py [--tag 222324] [--years 2022,2023]
"""
from __future__ import annotations
import os, sys
import numpy as np, pandas as pd
try: sys.stdout.reconfigure(encoding="utf-8")
except Exception: pass
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "study")
MNQ = 40.7
STOPS = [10, 15, 20, 30, 40]; RUNS = [20, 40, 80, 120, 200]
ID_COLS = {"date", "hm", "tick", "ltype", "K", "side", "filled", "fill_min", "spot"}


def load(tag, years):
    c = pd.read_parquet(os.path.join(OUT, f"contacts_{tag}.parquet"))
    for col in [x[:-2] for x in c.columns if x.endswith("_x")]:
        c[col] = c[f"{col}_x"]; c = c.drop(columns=[f"{col}_x", f"{col}_y"])
    c["year"] = c.date.str.slice(0, 4).astype(int)
    if years: c = c[c.year.isin(years)]
    c = c[c.filled & (c.mins_to_close >= 15)].copy()
    c["E_mnq"] = c.E * MNQ; c["stop15_E"] = 15 / c.E_mnq
    c["y80"] = c.run15_80.astype(float); c["y40"] = c.run15_40.astype(float)
    c["named"] = c.ltype != "strike"
    return c


def rate(g, col="y80"):
    return 100 * g[col].mean() if len(g) else np.nan


def section(t): print(f"\n## {t}")


def stop_ladder(c, title):
    section(title)
    print(f"{'stop':>5} {'surv%':>6} " + " ".join(f"{'run→'+str(r)+'%':>9}" for r in RUNS) + f" {'E[mfe]':>7} {'pnl@close':>9} {'be-rule pnl':>11} {'n':>6}")
    for s in STOPS:
        surv = 100 * c[f"surv{s}"].mean()
        runs = " ".join(f"{100 * c[f'run{s}_{r}'].mean():9.1f}" for r in RUNS)
        be = c[f"be_pnl{s}"].mean() if f"be_pnl{s}" in c else np.nan
        print(f"{s:>5} {surv:6.1f} {runs} {c[f'mfe{s}'].mean():7.1f} {c[f'pnl{s}'].mean():9.1f} {be:11.1f} {len(c):6d}")


def by(c, keys, col="y80", title="", min_n=100, extra=("y40", "surv15", "mfe15", "be_pnl15")):
    section(title or " × ".join(keys))
    print(f"{'group':>40} {'n':>6} {'run15→80%':>10} {'run15→40%':>10} {'surv15%':>8} {'E[mfe15]':>9} {'be-pnl15':>9}")
    for k, g in c.groupby(keys, observed=True, dropna=False):
        if len(g) < min_n: continue
        kk = " · ".join(str(x) for x in k) if isinstance(k, tuple) else str(k)
        print(f"{kk:>40} {len(g):6d} {rate(g):10.1f} {rate(g, 'y40'):10.1f} {100 * g.surv15.mean():8.1f} {g.mfe15.mean():9.1f} {g.be_pnl15.mean():9.1f}")


def sweep(c, col="y80", title="", min_n=150, top=45, bins=5):
    """Every numeric feature → quantile bins → outcome rate per bin; ranked by spread."""
    section(title)
    feats = [f for f in c.columns if f not in ID_COLS and c[f].dtype.kind in "fi" and not f.startswith(("surv", "mfe", "run", "pnl", "tstop", "be_pnl", "y", "mae"))]
    out = []
    for f in feats:
        v = c[f]
        if v.notna().sum() < 4 * min_n or v.nunique() < 4: continue
        try: b = pd.qcut(v, bins, duplicates="drop")
        except Exception: continue
        g = c.groupby(b, observed=True)[col].agg(["mean", "size"])
        g = g[g["size"] >= min_n]
        if len(g) < 3: continue
        r = 100 * g["mean"]; spread = r.max() - r.min()
        # 2022 vs 2023 sign consistency of (top bin − bottom bin)
        def tb(sub):
            gg = sub.groupby(b.loc[sub.index], observed=True)[col].mean()
            return (gg.iloc[-1] - gg.iloc[0]) if len(gg) >= 2 else np.nan
        signs = [np.sign(tb(c[c.year == y])) for y in sorted(c.year.unique())]
        cons = "yes" if len(set(s for s in signs if np.isfinite(s))) == 1 else "no"
        rho = pd.Series(r.values).corr(pd.Series(range(len(r))), method="spearman")
        out.append((spread, f, cons, rho, " ".join(f"{x:5.1f}" for x in r.values), " ".join(f"{int(n):5d}" for n in g["size"].values), [str(iv) for iv in g.index]))
    out.sort(key=lambda x: -x[0])
    print(f"{'feature':>22} {'spread':>6} {'yr-cons':>7} {'mono':>5}  rate by quantile bin (low→high) · n per bin")
    for spread, f, cons, rho, rates, ns, edges in out[:top]:
        print(f"{f:>22} {spread:6.1f} {cons:>7} {rho:5.2f}  {rates}  ·  {ns}")
    return out


def profiles(tag, years):
    section("EVENT-ALIGNED PROFILES (atlas turns vs run-throughs; median feature at −60…+30 min, 5-min ticks)")
    tape = pd.read_parquet(os.path.join(OUT, f"state_tape_{tag}.parquet")); ev = pd.read_parquet(os.path.join(OUT, "atlas_events.parquet"))
    tape["year"] = tape.date.str.slice(0, 4).astype(int); ev = ev[ev.date.str.slice(0, 4).astype(int).isin(years)]
    key = {(d, t): i for i, (d, t) in enumerate(zip(tape.date, tape.tick))}
    feats = ["atm_iv", "d_iv30", "iv_off_peak60", "E", "flip_distE", "cwall_distE", "pwall_distE", "ivu_in_distE", "ivl_in_distE", "conc1", "conc3", "net_gex", "charm_sum", "vanna_sum", "iv_skew", "ivwall_widthE", "hod_distE", "lod_distE", "open_distE"]
    offs = list(range(-60, 35, 5))
    def tick_of(hm, off):
        m = int(hm[:2]) * 60 + int(hm[3:]) + off; m -= m % 5
        return f"{m // 60:02d}:{m % 60:02d}"
    for cls, sub in [("BOTTOM (turn)", ev[(ev.kind == "turn") & (ev.turn == "bottom")]), ("TOP (turn)", ev[(ev.kind == "turn") & (ev.turn == "top")]),
                     ("RUN-THROUGH down", ev[(ev.kind == "run_through") & (ev.turn == "down")]), ("RUN-THROUGH up", ev[(ev.kind == "run_through") & (ev.turn == "up")])]:
        rows = {f: {o: [] for o in offs} for f in feats}
        n = 0
        for e in sub.itertuples():
            i0 = key.get((e.date, tick_of(e.hm, 0)))
            if i0 is None: continue
            n += 1; base = tape.iloc[i0]
            for o in offs:
                i = key.get((e.date, tick_of(e.hm, o)))
                if i is None: continue
                r = tape.iloc[i]
                for f in feats:
                    v = r[f]
                    if f in ("atm_iv",): v = 100 * (v - base[f])
                    elif f in ("E",): v = v / base[f] if base[f] else np.nan
                    elif f in ("net_gex", "charm_sum", "vanna_sum"): v = v / (abs(base[f]) or np.nan)
                    rows[f][o].append(v)
        print(f"\n### {cls} — n={n}")
        print(f"{'feature':>16} " + " ".join(f"{o:>6d}" for o in offs))
        for f in feats:
            print(f"{f:>16} " + " ".join(f"{np.nanmedian(rows[f][o]) if rows[f][o] else np.nan:6.2f}" for o in offs))


def main():
    tag = sys.argv[sys.argv.index("--tag") + 1] if "--tag" in sys.argv else "222324"
    years = [int(y) for y in sys.argv[sys.argv.index("--years") + 1].split(",")] if "--years" in sys.argv else [2022, 2023]
    c = load(tag, years)
    print(f"# OPEN EXPLORATION — tape {tag}, years {years}: {c.date.nunique()} days, {len(c)} filled contacts (≥15 min to close)")
    print("outcome of interest: run15→80 = survived a 15-MNQ stop and ran ≥80 · be-pnl15 = 15 stop, breakeven after +40, exit at close (MNQ/fill)")
    stop_ladder(c, "STOP LADDER — all contacts")
    stop_ladder(c[c.ltype == "strike"], "STOP LADDER — plain whole strikes")
    stop_ladder(c[c.named], "STOP LADDER — named levels (flip / walls / OI walls / IV walls)")
    by(c, ["ltype"], title="by level type")
    by(c, ["ltype", "side"], title="level type × side", min_n=80)
    c["E_b"] = pd.qcut(c.E_mnq, 5); by(c, ["E_b"], title="by expected-move-to-close (MNQ) — is a 15-pt stop only viable in low vol?")
    c["stopE_b"] = pd.cut(c.stop15_E, [0, 0.05, 0.1, 0.15, 0.25, 9], labels=["<0.05E", "0.05-0.1", "0.1-0.15", "0.15-0.25", ">0.25E"]); by(c, ["stopE_b"], title="15-pt stop as a fraction of E")
    c["tod"] = pd.cut(c.mins_to_close, [0, 60, 120, 240, 999], labels=["<60", "60-120", "120-240", ">240"]); by(c, ["tod"], title="time to close")
    by(c, ["tod", "side"], title="time × side")
    c["dist_b"] = pd.cut(c.dist_E, [-0.01, 0.1, 0.25, 0.5, 1, 9], labels=["<0.1E", "0.1-0.25", "0.25-0.5", "0.5-1", ">1E"]); by(c, ["dist_b"], title="distance from spot at the last tick before contact")
    by(c, ["dist_b", "named"], title="distance × named", min_n=80)
    c["iv_cls"] = np.where(c.d_iv30 > 0.01, "rising", np.where(c.d_iv30 < -0.01, "falling", "flat")); by(c, ["iv_cls", "side"], title="IV state × side (replication)")
    sweep(c, "y80", "FEATURE SWEEP — run15→80, all filled contacts (top 45 by spread; yr-cons = same sign in every year)")
    sweep(c[c.side == "support"], "y80", "FEATURE SWEEP — supports only", top=25)
    sweep(c[c.side == "resistance"], "y80", "FEATURE SWEEP — resistances only", top=25)
    sweep(c, "surv15", "FEATURE SWEEP — survive the 15 stop at all", top=25)
    sweep(c, "be_pnl15", "FEATURE SWEEP — breakeven-rule pnl (MNQ/fill)", top=25)
    profiles(tag, years)


if __name__ == "__main__":
    main()
