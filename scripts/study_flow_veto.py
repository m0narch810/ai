"""
NET FLOW ENTRY VETO — don't fade a level while momentum is driving through it.

User: "did you test about not entering while it is showing momentum?" — the entry-side use of flow.
Bar-CVD proxy (close-location × volume, NQ), fades, live 2026 + 2022-23. A vetoed trade is one NOT taken; the test
is whether the TAKEN (non-vetoed) trades react / travel / net better than the vetoed ones, in every period.

PRE-REGISTERED 2026-09-17. Sign: flow "against the fade" = the momentum trying to push THROUGH the level
(net selling into a support you'd buy, net buying into a resistance you'd sell). Δ over the prior 30/15 min.
  V1 naive-against   flow Δ30 against the fade in the day's top tercile of |Δ30|  (expected to hurt: kills absorption)
  V2 break-through   V1 AND price is NOT holding — at t-1 already ≥0.15 QQQ through the level (momentum break)
  V3 accelerating    flow against AND accelerating: Δ15-against > 0.6 × Δ30-against (2nd half faster than the 1st)
  V4 last-bar thrust the touch's prior bar was a large-range bar (≥1.2× the day's median range) closing hard
                     through the level on strong one-sided delta (|clv|≥0.6 in the break direction)
  V5 with-flow late  the naive momentum read: flow Δ60 against the fade at all (skip fading into any opposing flow)
OUTCOME  reaction +40 (BE 27.3%), ≥120 (BE 11.1%), and net MNQ/trade on the +40 exit (1 MNQ cost). A veto PASSES if
  the KEPT trades beat the VETOED trades by ≥+3 pts reaction in every period AND kept-net ≥ all-net in every period.
    python scripts/study_flow_veto.py
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
ST = L.ST; MNQ = L.MNQ; COST = 1.0; STOP = 15 / MNQ


def veto_and_grade(g, di, K, sup):
    s = 1 if sup else -1
    lo, hi, cl, op, bd = g.lq.to_numpy(), g.hq.to_numpy(), g.cq.to_numpy(), (g.oq.to_numpy() if "oq" in g else g.o.to_numpy()), g.bd.to_numpy()
    if di < 13: return None
    through = (lo[di:di + 7] < K) if sup else (hi[di:di + 7] > K)
    if not through.any(): return None
    f = di + int(np.argmax(through))
    # outcome from the fill
    end = f; hm = g.min_.to_numpy()
    while end + 1 < len(g) and hm[end + 1] <= 15 * 60 + 55: end += 1
    adv = (K - lo[f:end + 1]) if sup else (hi[f:end + 1] - K)
    fav = ((hi[f:end + 1] - K) if sup else (K - lo[f:end + 1])).copy(); fav[0] = -np.inf
    close_pnl = ((cl[end] - K) if sup else (K - cl[end])) * MNQ
    s_hit = np.flatnonzero(adv >= STOP); si = s_hit[0] if len(s_hit) else None
    t40 = np.flatnonzero(fav >= 40 / MNQ); b40 = t40[0] if len(t40) else None
    t120 = np.flatnonzero(fav >= 120 / MNQ); b120 = t120[0] if len(t120) else None
    react = b40 is not None and (si is None or b40 < si)
    run120 = b120 is not None and (si is None or b120 < si)
    pnl40 = -15.0 if (si is not None and (b40 is None or si <= b40)) else (40.0 if b40 is not None else close_pnl)
    # flow at t-1 (against the fade = -CVD change for the runner)
    cvd = np.nancumsum(bd)
    d30_against = -(cvd[di - 1] - cvd[di - 1 - 6]) * s
    d15_against = -(cvd[di - 1] - cvd[di - 1 - 3]) * s
    d60_against = -(cvd[di - 1] - cvd[di - 1 - 12]) * s
    day = g.iloc[max(0, di - 78):di]
    absd30 = day.bd.rolling(6).sum().dropna().abs()
    thr = absd30.quantile(0.66) if len(absd30) > 6 else np.inf
    through_now = (lo[di - 1] < K - 0.15) if sup else (hi[di - 1] > K + 0.15)
    rng = hi[di - 1] - lo[di - 1]; medrng = (day.hq - day.lq).median()
    clv_prev = (((cl[di - 1] - lo[di - 1]) - (hi[di - 1] - cl[di - 1])) / rng) if rng > 0 else 0
    thrust = bool(rng >= 1.2 * medrng and (clv_prev * -s) >= 0.6)     # closed hard in the break direction
    return dict(react=react, run120=run120, pnl40=pnl40,
                V1=bool(d30_against >= thr),
                V2=bool(d30_against >= thr and through_now),
                V3=bool(d30_against > 0 and d15_against > 0.6 * d30_against and d30_against >= thr),
                V4=thrust,
                V5=bool(d60_against > 0))


def collect(by, ts):
    rows = []
    for r in ts:
        g = by.get(r["day"])
        if g is None or r["di"] is None or "lq" not in g: continue
        res = veto_and_grade(g, r["di"], r["K"], r["side"] == "support")
        if res: rows.append(dict(half_=r["half"], **res))
    return pd.DataFrame(rows)


def live():
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
        m = np.flatnonzero(tv[d] == r.t.value)
        ts.append(dict(day=d, di=int(m[0]) if len(m) else None, side=r.side, K=r.K, half=r.half_))
    return collect(by, ts)


def hist():
    c = FT.history()
    d = pd.read_parquet(FL.NQ_BARS, columns=["date", "open", "high", "low", "close", "volume"])
    d = d[(d["date"] >= "2021-12-31") & (d["date"] < "2024-01-03")].copy()
    d["day"] = d["date"].dt.strftime("%Y-%m-%d"); d["min_"] = d["date"].dt.hour * 60 + d["date"].dt.minute
    d = d[(d.min_ >= 570) & (d.min_ < 960)]; d["bd"] = FL.bar_delta(d.open, d.high, d.low, d.close, d.volume.to_numpy(float))
    by = {}
    for day, g in d.groupby("day"):
        g5 = g.assign(t5=(g.min_ // 5) * 5).groupby("t5").agg(oq=("open", "first"), h=("high", "max"), l=("low", "min"), cqr=("close", "last"), bd=("bd", "sum")).reset_index()
        g5["min_"] = g5.t5; by[day] = g5
    ts = []
    for r in c.itertuples():
        g = by.get(r.date); nqd = S.nq_for(r.date)
        if g is None or nqd is None or r.hm not in set(nqd.hm): continue
        ratio = float(np.median(nqd.set_index("hm").close.reindex([r.hm]).dropna()) / r.spot)
        if not np.isfinite(ratio) or ratio <= 0: continue
        g["lq"] = g.l / ratio; g["hq"] = g.h / ratio; g["cq"] = g.cqr / ratio
        thm = (int(r.hm[:2]) * 60 + int(r.hm[3:])) // 5 * 5
        di = int((g.t5 == thm).values.argmax()) if (g.t5 == thm).any() else None
        ts.append(dict(day=r.date, di=di, side=r.side, K=r.K, half=r.date[:4]))
    return collect(by, ts)


def main():
    out = []; pr = lambda x: (out.append(x), print(x))
    D = live(); H = hist()
    pr("# NET FLOW ENTRY VETO — skip fades while momentum drives through the level (bar-CVD proxy)")
    pr(f"LIVE fills {len(D)} · HIST fills {len(H)}")
    vetoes = {"V1": "flow hard against (top tercile) — naive", "V2": "hard against AND price not holding (break)",
              "V3": "flow against AND accelerating", "V4": "last bar = large-range thrust through", "V5": "any opposing 60m flow (naive momentum)"}
    def show(DF, halves, name):
        pr(f"\n## {name}")
        for v, lab in vetoes.items():
            pr(f"  {v} {lab}")
            for h in halves:
                g = DF[DF.half_ == h]; kept = g[g[v] == False]; vetoed = g[g[v] == True]
                if len(vetoed) < 20 or len(kept) < 50: pr(f"     {h}: (too few — kept {len(kept)}, vetoed {len(vetoed)})"); continue
                gap = 100 * (kept.react.mean() - vetoed.react.mean())
                pr(f"     {h}: KEPT react {100*kept.react.mean():5.1f}% ≥120 {100*kept.run120.mean():4.1f}% net {kept.pnl40.mean()-COST:+5.1f} (n={len(kept):4d}) | VETOED react {100*vetoed.react.mean():5.1f}% ≥120 {100*vetoed.run120.mean():4.1f}% net {vetoed.pnl40.mean()-COST:+5.1f} (n={len(vetoed):3d}) | kept−vetoed react {gap:+5.1f} | kept vs ALL net {kept.pnl40.mean()-g.pnl40.mean():+4.1f}")
    show(D, ("explore", "confirm"), "LIVE 2026")
    show(H, ("2022", "2023"), "HIST 2022-23")
    # verdict
    pr("\n## verdict (pass = kept beats vetoed by ≥+3 react in every period, ≥20 vetoed & ≥50 kept per period)")
    for v in vetoes:
        oks = []
        for DF, halves in ((D, ("explore", "confirm")), (H, ("2022", "2023"))):
            for h in halves:
                g = DF[DF.half_ == h]; kept = g[g[v] == False]; vetoed = g[g[v] == True]
                oks.append(len(vetoed) >= 20 and len(kept) >= 50 and (kept.react.mean() - vetoed.react.mean()) >= 0.03 and kept.pnl40.mean() >= g.pnl40.mean())
        pr(f"  {v}: {'PASS' if all(oks) else 'fail'}")
    open(os.path.join(ST, "flow_veto_report.md"), "w", encoding="utf-8").write("\n".join(out))


if __name__ == "__main__":
    main()
