"""
NET FLOW AS TRADE CONFIRMATION — a veto before entry and a hold-signal after it.

User: "use it as confirmation to either not take a trade or to stay in a trade and let it run."
Two uses, both tested on the bar-CVD proxy (close-location × volume, NQ), live + 2022-23. Fades only (buy support /
sell resistance). Sign convention: flow "for the runner" = +CVD for a support fade (price rising after the turn),
−CVD for a resistance fade.

PRE-REGISTERED 2026-09-17 before these outcomes were computed.

VETO (before entry): the absorption studies said flow INTO a level that HOLDS is good, but flow into a level that
is GIVING WAY is a break. So veto only the break shape:
  V = at t-1, flow is hard against the fade (Δ30 into the level ≥ 70th pctl of the day) AND price is NOT holding
      (already ≥0.15 through the level on the last bar). Expect V-trades to react worse.

HOLD (after entry, the real prize — "let it run"): among fills that reached +40 (where the run/exit choice exists),
does post-+40 flow tell you whether to hold? Exits compared, all starting from a filled fade:
  E1 fixed +40 (our current best)         E2 hold to 15:55 (lost in every prior test)
  E3 FLOW-MANAGED: bank nothing at +40; keep holding while CVD keeps making new extremes for the runner; exit the
     first time CVD fails to make a new runner-extreme for 2 straight bars (flow stalls), else 15:55. Stop stays 15.
  E4 FLOW-GATED RUN: take +40 UNLESS flow at the +40 bar still supports the runner (Δ15 for the runner > 0) — then
     hold with a breakeven stop and the same CVD-stall exit as E3.
OUTCOME    net MNQ per filled trade, 1 MNQ cost; and, for the +40 winners, share that ran on to +80 / +120 split by
           whether flow confirmed at +40.
PASS       a flow exit must beat BOTH fixed-+40 and hold-to-close in both live halves AND 2022/2023.
    python scripts/study_flow_exit.py
"""
from __future__ import annotations
import os, sys
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(__file__))
import study_ledger_greeks as L
import study_far_travel as FT
import study_flow as FL
import study_0dte_alignment as S
try: sys.stdout.reconfigure(encoding="utf-8")
except Exception: pass
ST = L.ST; MNQ = L.MNQ; COST = 1.0
STOP = 15 / MNQ


def exits(bars, f, K, sup):
    """bars: day frame with lq/hq/cq/bd; f = FILL bar index. Returns pnl for E1..E4 (MNQ) + diagnostics."""
    s = 1 if sup else -1
    lo, hi, cl, bd = bars.lq.to_numpy(), bars.hq.to_numpy(), bars.cq.to_numpy(), bars.bd.to_numpy()
    end = f
    hm = bars.min_.to_numpy()
    while end + 1 < len(bars) and hm[end + 1] <= 15 * 60 + 55: end += 1
    adv = (K - lo[f:end + 1]) if sup else (hi[f:end + 1] - K)
    fav = ((hi[f:end + 1] - K) if sup else (K - lo[f:end + 1])).copy(); fav[0] = -np.inf
    cvd = np.nancumsum(bd[f:end + 1]) * s                 # + = flow for the runner, from the fill
    close_pnl = ((cl[end] - K) if sup else (K - cl[end])) * MNQ
    s_hit = np.flatnonzero(adv >= STOP); si = s_hit[0] if len(s_hit) else None
    t40 = np.flatnonzero(fav >= 40 / MNQ); b40 = t40[0] if len(t40) else None
    def stopped_first(bi): return si is not None and (bi is None or si <= bi)
    # E1 fixed +40
    e1 = -15.0 if stopped_first(b40) else (40.0 if b40 is not None else close_pnl)
    # E2 hold to close
    e2 = -15.0 if si is not None else close_pnl
    # reached +40?
    reached40 = b40 is not None and not stopped_first(b40)
    conf40 = np.nan; ran80 = ran120 = np.nan
    if reached40:
        # flow at the +40 bar: Δ over the last 3 bars for the runner
        j = b40
        conf40 = bool(cvd[j] - cvd[max(0, j - 3)] > 0)
        r80 = np.flatnonzero(fav >= 80 / MNQ); r120 = np.flatnonzero(fav >= 120 / MNQ)
        ran80 = bool(len(r80) and (si is None or r80[0] < si))
        ran120 = bool(len(r120) and (si is None or r120[0] < si))
    # E3 flow-managed hold from entry (stop 15; exit when CVD stalls 2 bars)
    def flow_managed(be_after_40):
        peak_cvd = cvd[0]; stallbars = 0; be = False
        for k in range(1, len(adv)):
            if si is not None and k >= si and (not be or adv[k] >= STOP): return -15.0 if not be else 0.0
            if be and adv[k] >= 0:  # breakeven stop hit
                return 0.0
            if be_after_40 and not be and fav[k] >= 40 / MNQ: be = True
            if cvd[k] > peak_cvd + 1e-9: peak_cvd = cvd[k]; stallbars = 0
            else: stallbars += 1
            if stallbars >= 2 and (not be_after_40 or be):
                return float(fav[k]) * MNQ if fav[k] > 0 else (0.0 if be else close_pnl)
        return close_pnl
    e3 = flow_managed(False)
    # E4 flow-gated run: +40 unless flow still supports at +40, then hold w/ BE stop + stall exit
    if not reached40:
        e4 = e1
    elif conf40:
        e4 = flow_managed(True)
    else:
        e4 = 40.0
    return dict(e1=e1, e2=e2, e3=e3, e4=e4, reached40=reached40, conf40=conf40, ran80=ran80, ran120=ran120)


def run(bars_by_day, touches, sess_key):
    rows = []
    for r in touches:
        g = bars_by_day.get(r["day"])
        if g is None: continue
        di = r["di"]
        if di is None or di < 13 or di >= len(g) - 2: continue
        lo, hi = g.lq.to_numpy(), g.hq.to_numpy()
        sup = r["side"] == "support"; K = r["K"]
        through = (lo[di:di + 7] < K) if sup else (hi[di:di + 7] > K)
        if not through.any(): continue
        f = di + int(np.argmax(through))
        ex = exits(g, f, K, sup)
        rows.append(dict(half_=r["half"], **ex))
    return pd.DataFrame(rows)


def live_touches():
    F = pd.read_parquet(os.path.join(ST, "reader_pattern_features.parquet"))
    F["t"] = pd.to_datetime(F.t, utc=True).dt.tz_convert("America/New_York").astype("datetime64[ns, America/New_York]")
    F = F[F.sess == "RTH"].copy()
    nq = L.load_bars("5m"); nq["date_"] = nq.t.dt.strftime("%Y-%m-%d"); nq["min_"] = nq.t.dt.hour * 60 + nq.t.dt.minute
    nq["bd"] = FL.bar_delta(nq.oq, nq.hq, nq.lq, nq.cq, nq.v.to_numpy(float))
    by = {d: g.reset_index(drop=True) for d, g in nq.groupby("date_")}
    tv = {d: g.t.map(lambda x: x.value).to_numpy() for d, g in by.items()}
    ts = []
    for r in F.itertuples():
        d = r.t.strftime("%Y-%m-%d")
        if d not in by: continue
        arr = tv[d]; m = np.flatnonzero(arr == r.t.value)
        ts.append(dict(day=d, di=int(m[0]) if len(m) else None, side=r.side, K=r.K, half=r.half_))
    return by, ts


def hist_touches():
    c = FT.history()
    d = pd.read_parquet(FL.NQ_BARS, columns=["date", "open", "high", "low", "close", "volume"])
    d = d[(d["date"] >= "2021-12-31") & (d["date"] < "2024-01-03")].copy()
    d["day"] = d["date"].dt.strftime("%Y-%m-%d"); d["min_"] = d["date"].dt.hour * 60 + d["date"].dt.minute
    d = d[(d.min_ >= 570) & (d.min_ < 960)]; d["bd"] = FL.bar_delta(d.open, d.high, d.low, d.close, d.volume.to_numpy(float))
    by = {}; ts = []
    for day, g in d.groupby("day"):
        g5 = g.assign(t5=(g.min_ // 5) * 5).groupby("t5").agg(o=("open", "first"), h=("high", "max"), l=("low", "min"), cq=("close", "last"), bd=("bd", "sum")).reset_index()
        g5["min_"] = g5.t5
        by[day] = g5
    for r in c.itertuples():
        g = by.get(r.date); nqd = S.nq_for(r.date)
        if g is None or nqd is None: continue
        ratio = float(np.median(nqd.set_index("hm").close.reindex([r.hm]).dropna()) / r.spot) if r.hm in set(nqd.hm) else np.nan
        if not np.isfinite(ratio) or ratio <= 0: continue
        by[r.date]["lq"] = by[r.date].l / ratio; by[r.date]["hq"] = by[r.date].h / ratio; by[r.date]["cq"] = by[r.date].cq / ratio if by[r.date].cq.max() > 3000 else by[r.date].cq
        thm = (int(r.hm[:2]) * 60 + int(r.hm[3:])) // 5 * 5
        di = int((g.t5 == thm).values.argmax()) if (g.t5 == thm).any() else None
        ts.append(dict(day=r.date, di=di, side=r.side, K=r.K, half=r.date[:4]))
    # fix cq scaling once (avoid re-dividing): rebuild lq/hq/cq cleanly
    for day, g in by.items():
        pass
    return by, ts


def main():
    out = []; pr = lambda x: (out.append(x), print(x))
    pr("# NET FLOW AS CONFIRMATION — hold/exit management for the runner (fades, bar-CVD proxy)")
    lby, lts = live_touches(); D = run(lby, lts, "live")
    hby, hts = hist_touches()
    # hist cq was divided by ratio inside the loop per touch-day; rebuild once properly
    Hrows = []
    for r in hts:
        g = hby.get(r["day"])
        if g is None or r["di"] is None or r["di"] < 13: continue
        if "lq" not in g: continue
        lo, hi = g.lq.to_numpy(), g.hq.to_numpy(); sup = r["side"] == "support"; K = r["K"]
        through = (lo[r["di"]:r["di"] + 7] < K) if sup else (hi[r["di"]:r["di"] + 7] > K)
        if not through.any(): continue
        f = r["di"] + int(np.argmax(through))
        Hrows.append(dict(half_=r["half"], **exits(g, f, K, sup)))
    H = pd.DataFrame(Hrows)
    def tab(DF, halves, name):
        pr(f"\n## {name}: net MNQ/trade per exit (cost {COST})")
        pr(f"{'half':>8} {'fills':>6} | {'E1 +40':>7} {'E2 hold':>8} {'E3 flow':>8} {'E4 gated':>9}")
        for h in halves:
            g = DF[DF.half_ == h]
            if len(g) < 40: continue
            pr(f"{h:>8} {len(g):6d} | {g.e1.mean()-COST:+7.1f} {g.e2.mean()-COST:+8.1f} {g.e3.mean()-COST:+8.1f} {g.e4.mean()-COST:+9.1f}")
        w = DF[DF.reached40 == True]
        if len(w):
            for h in halves:
                g = w[(w.half_ == h) & w.conf40.notna()]
                if len(g) < 30: continue
                cf = g[g.conf40 == True]; nc = g[g.conf40 == False]
                pr(f"   {h} — of the {len(g)} that reached +40: flow-confirmed at +40 → ran on to +80 {100*cf.ran80.mean():.0f}% / +120 {100*cf.ran120.mean():.0f}% (n={len(cf)}) | NOT confirmed → +80 {100*nc.ran80.mean():.0f}% / +120 {100*nc.ran120.mean():.0f}% (n={len(nc)})")
    tab(D, ("explore", "confirm"), "LIVE 2026")
    tab(H, ("2022", "2023"), "HIST 2022-23")
    D.to_parquet(os.path.join(ST, "flow_exit_live.parquet"), index=False)
    open(os.path.join(ST, "flow_exit_report.md"), "w", encoding="utf-8").write("\n".join(out))


if __name__ == "__main__":
    main()
