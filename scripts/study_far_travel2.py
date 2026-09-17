"""
FAR-TRAVEL, ROUND 2 — the fresh-extreme family and a wide sweep of other ideas.

Prompted 2026-09-17 by the user's correction: their best examples (700 on 09-16 at 15:25, 712 on 09-16 at 11:45)
were FIRST touches of untouched strikes making a new session extreme — the opposite of the "already traded today"
trait the dossier readers found (which is 85% of precise touches AND 85% of failures, so it never carried information).

PRE-REGISTERED before these outcomes were computed. Same protocol as round 1:
OUTCOME  filled trade (limit at the strike, trade-through fill within 30 min), runs ≥120 MNQ before going 15 past
         (BE 11.1%); secondary ≥80 (BE 15.8%); net MNQ/trade with a +120 and +80 target, 1 MNQ cost.
PASS     with − without ≥ +3 pts on ≥120 in EVERY half of every dataset the filter can be tested on, ≥100 trades
         with the filter per half. LIVE halves: explore 07-20→08-18, confirm 08-19→09-17. HISTORY: 2022 vs 2023.
FILTERS  (thresholds fixed here; E = spot·ATM IV·√(min to close/525600) in MNQ)
  F1  virgin        no earlier touch of this strike today (either side)
  F2  fresh extreme F1 AND the level is a new session extreme
  F3  capitulation  F2 AND price moved ≥0.5 E into the level over the prior 60 min          [the user's 700]
  F4  retest        ≥1 earlier touch today (the head-to-head against F1)
  F5  stretch-open  |level − session open| ≥ 1.0 E and the trade points back toward the open
  F6  stretch-vwap  |level − session VWAP| ≥ 0.75 E and the trade points back toward VWAP   [live only]
  F7  vol climax    mean NQ volume of the last 3 bars ≥ 2× the session-so-far median bar volume
  F8  round 10      strike is a multiple of 10
  F9  round 25      strike is a multiple of 25
  F10 late charm    after 14:30, support, dealer charm at the strike forces buying (charm sign with the side)
  F11 gap zone      |open − prior close| ≥ 0.3 E-at-open and the level lies between them, untouched today
  F12 high IV       ATM IV in the top third of its dataset half
  F13 first hour    touch before 10:30
  F14 last 2 hours  touch after 14:00
Multiplicity: 14 filters × 2-4 halves. With ~14 independent tests, one or two "passes" are expected by chance;
anything that passes here is a candidate for a forward test, not a finding.
    python scripts/study_far_travel2.py
"""
from __future__ import annotations
import os, sys
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(__file__))
import study_ledger_greeks as L
import study_precise_leadup as P
import study_far_travel as FT
try: sys.stdout.reconfigure(encoding="utf-8")
except Exception: pass
ST = L.ST; MNQ = L.MNQ; COST = 1.0


def live():
    F = pd.read_parquet(os.path.join(ST, "reader_pattern_features.parquet"))
    F["t"] = pd.to_datetime(F.t, utc=True).dt.tz_convert("America/New_York").astype("datetime64[ns, America/New_York]")
    F = F[F.sess == "RTH"].copy()
    nq = L.load_bars("5m"); nq["date_"] = nq.t.dt.strftime("%Y-%m-%d"); nq["min_"] = nq.t.dt.hour * 60 + nq.t.dt.minute
    # session VWAP and session-so-far volume median, RTH only
    rth = nq[(nq.min_ >= 570) & (nq.min_ < 960)].copy()
    tp = (rth.hq + rth.lq + rth.cq) / 3
    rth["pv"] = tp * rth.v
    rth["vwap"] = rth.groupby("date_").pv.cumsum() / rth.groupby("date_").v.cumsum()
    rth["volmed"] = rth.groupby("date_").v.transform(lambda s: s.expanding().median())
    nq = nq.merge(rth[["t", "vwap", "volmed"]], on="t", how="left")
    idx = pd.Series(np.arange(len(nq)), index=nq.t.map(lambda x: x.value))
    book, ctx = P.load_book(); cap_ns = ctx.cap_t.map(lambda x: x.value).to_numpy()
    op = nq[nq.min_ == 570].set_index("date_").oq
    pc = nq[(nq.min_ >= 955) & (nq.min_ < 960)].groupby("date_").cq.last()
    rows = []
    for r in F.itertuples():
        i = idx.get(r.t.value)
        if i is None: continue
        i = int(i); sup = r.side == "support"; s = 1 if sup else -1
        g = FT.grade_live(nq, i, r.K, sup)
        if g is None: continue
        mtc = 16 * 60 - (r.t.hour * 60 + r.t.minute); mn = r.t.hour * 60 + r.t.minute
        j0 = np.searchsorted(cap_ns, r.t.value, side="left") - 1
        if j0 < 0: continue
        c0 = ctx.iloc[j0]; date = nq.date_.iloc[i]
        spot = nq.cq.iloc[i - 1]
        E = spot * (c0.atm_iv / 100) * np.sqrt(max(mtc, 1) / 525600) * MNQ if pd.notna(c0.atm_iv) and c0.atm_iv > 0 else np.nan
        d = dict(sday=r.sday, half_=r.half_, side=r.side, K=r.K, t=r.t, E=E, atm_iv=c0.atm_iv, **g)
        prior = (r.prior_touches_same_side or 0) + (r.prior_touches_other_side or 0)
        d["F1"] = prior == 0
        d["F2"] = bool(d["F1"] and r.k_beyond_session_extreme == True)
        d["F3"] = bool(d["F2"] and np.isfinite(E) and r.into_60 >= 0.5 * E)
        d["F4"] = prior >= 1
        o = op.get(date, np.nan)
        d["F5"] = bool(np.isfinite(E) and np.isfinite(o) and abs(r.K - o) * MNQ >= 1.0 * E and np.sign(o - r.K) == s)
        vw = nq.vwap.iloc[i - 1]
        d["F6"] = bool(np.isfinite(E) and pd.notna(vw) and abs(r.K - vw) * MNQ >= 0.75 * E and np.sign(vw - r.K) == s)
        vm = nq.volmed.iloc[i - 1]
        d["F7"] = bool(pd.notna(vm) and vm > 0 and nq.v.iloc[max(0, i - 3):i].mean() >= 2 * vm)
        d["F8"] = r.K % 10 == 0; d["F9"] = r.K % 25 == 0
        gb = book.get(c0.key)
        charm_with = np.nan
        if gb is not None and r.K in gb.index and pd.notna(gb.at[r.K, "charm"]): charm_with = np.sign(gb.at[r.K, "charm"]) * s
        d["F10"] = bool(mn >= 870 and sup and charm_with > 0)
        pcl = pc.get(date, np.nan); E_open = spot * (c0.atm_iv / 100) * np.sqrt(390 / 525600) * MNQ if pd.notna(c0.atm_iv) else np.nan
        if np.isfinite(pcl) and np.isfinite(o) and np.isfinite(E_open):
            gap = abs(o - pcl) * MNQ
            d["F11"] = bool(gap >= 0.3 * E_open and min(o, pcl) <= r.K <= max(o, pcl) and prior == 0)
        else: d["F11"] = np.nan
        d["F13"] = mn < 630; d["F14"] = mn >= 840
        rows.append(d)
    D = pd.DataFrame(rows)
    for h in ("explore", "confirm"):
        m = D.half_ == h; q = D.loc[m, "atm_iv"].quantile(2 / 3)
        D.loc[m, "F12"] = D.loc[m, "atm_iv"] > q
    return D


def history():
    """The historical contacts carry the per-tick tape (spot/E/IV/walls/hod/lod/open) but no per-strike greeks,
    no prior-touch counts (they are first touches by construction) and no bar volume, so F1/F4/F6/F7/F10/F11
    cannot be built here — those stay live-only."""
    c = FT.history()
    s = np.where(c.side == "support", 1, -1); E = c.E * MNQ
    c["F2"] = np.where(c.side == "support", c.K <= c.lod + 0.15, c.K >= c.hod - 0.15)
    into60 = -c.F_d60 * s * MNQ                                   # + = spot moved INTO the level over 60 min
    c["F3"] = c.F2 & (into60 >= 0.5 * E).fillna(False)
    c["F5"] = (((c.K - c.day_open).abs() * MNQ >= 1.0 * E) & (np.sign(c.day_open - c.K) == s)).fillna(False)
    c["F8"] = c.K % 10 == 0; c["F9"] = c.K % 25 == 0
    c["F13"] = c.mins_to_close > 330; c["F14"] = c.mins_to_close <= 120
    for h in ("2022", "2023"):
        m = c.half_ == h; q = c.loc[m, "atm_iv"].quantile(2 / 3)
        c.loc[m, "F12"] = c.loc[m, "atm_iv"] > q
    return c


def main():
    out = []; pr = lambda x: (out.append(x), print(x))
    D = live(); H = history()
    pr("# FAR-TRAVEL ROUND 2 — the fresh-extreme family and a wide sweep · outcome: ≥120 MNQ before the 15 stop (BE 11.1%)")
    pr(f"LIVE RTH fills: {len(D)} · base ≥120 explore {100 * D[D.half_ == 'explore'].run120.mean():.1f}% confirm {100 * D[D.half_ == 'confirm'].run120.mean():.1f}%")
    pr(f"HIST 2022-23 fills: {len(H)} · base ≥120 2022 {100 * H[H.half_ == '2022'].run120.mean():.1f}% 2023 {100 * H[H.half_ == '2023'].run120.mean():.1f}%")
    labels = {"F1": "virgin strike (no earlier touch today)", "F2": "F1 + new session extreme", "F3": "F2 + ≥0.5E move into it in 60 min (the 700 case)",
              "F4": "retest (≥1 earlier touch) — head-to-head vs F1", "F5": "≥1.0E from the session open, trading back toward it",
              "F6": "≥0.75E from session VWAP, trading back toward it [live only]", "F7": "volume climax: last 3 bars ≥2× session median",
              "F8": "strike is a multiple of 10", "F9": "strike is a multiple of 25", "F10": "after 14:30, support, charm forces dealer buying",
              "F11": "inside an unfilled gap zone, untouched today", "F12": "ATM IV in the top third of the period", "F13": "touch before 10:30", "F14": "touch after 14:00"}
    passed = []
    for f, lab in labels.items():
        pr(f"\n## {f} {lab}")
        ok_live = FT.verdict(D, f, ("explore", "confirm"), pr) if f in D.columns else False
        ok = ok_live
        if f in H.columns:
            ok = FT.verdict(H, f, ("2022", "2023"), pr) and ok_live
        pr(f"   → {'PASS' if ok else 'fail'}")
        if ok: passed.append(f)
    pr(f"\n## PASSED: {passed if passed else 'nothing'}")
    pr("\n## trades for every filter with ≥40 live trades in a half (net MNQ/trade, 1 MNQ cost) — descriptive, not a pass")
    pr(f"{'filter':>6} {'half':>8} {'trades':>7} {'/day':>5} {'≥120%':>6} {'net +120':>9} {'≥80%':>6} {'net +80':>8}")
    for f in list(labels) + ["ALL"]:
        for h in ("explore", "confirm"):
            g = D[(D.half_ == h)] if f == "ALL" else D[(D.half_ == h) & (D[f] == True)]
            if len(g) < 40: continue
            days = D[D.half_ == h].sday.nunique()
            pr(f"{f:>6} {h:>8} {len(g):7d} {len(g) / days:5.1f} {100 * g.run120.mean():6.1f} {g.pnl120.mean() - COST:+9.1f} {100 * g.run80.mean():6.1f} {g.pnl80.mean() - COST:+8.1f}")
    D.to_parquet(os.path.join(ST, "far_travel2_live.parquet"), index=False)
    open(os.path.join(ST, "far_travel2_report.md"), "w", encoding="utf-8").write("\n".join(out))


if __name__ == "__main__":
    main()
