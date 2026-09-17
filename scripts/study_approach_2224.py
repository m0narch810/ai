"""
The 2025 approach test re-run on 2022-24 WITH open interest, to see whether the IV state
discriminates more at HEAVY strikes (which the 2025 data cannot tell, having no OI).
Same approach definition, same decision timing (t-1), same classes and bracket as
study_2025_forward.py. Heavy = defending-side OI >= 2x the +-1% band median; heavy_gex = one of
the day's three largest |gex| strikes within +-1% at 10:00.
"""
from __future__ import annotations
import glob, os, sys
from multiprocessing import Pool
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(__file__))
import study_0dte_alignment as S

IV_WIN, IV_THR, PEAK_WIN, NEAR_PCT, CONTACT = 30, 0.01, 60, 0.01, 0.5


def run_day(args):
    path, date = args
    try: return _run_day(path, date)
    except Exception as e: return {"error": f"{date}: {type(e).__name__}: {e}"}


def _run_day(path, date):
    nq = S.nq_for(date)
    if nq is None: return {"error": f"{date}: no bars"}
    g = pd.read_csv(path, usecols=["minute", "strike", "side", "oi", "F", "T", "iv", "gex"]).dropna(subset=["iv", "F", "T"])
    g = g[g["T"] > 0]; g["strike"] = S.fix_strike_offset(g["strike"].to_numpy(float))
    fwd = g.groupby("minute")["F"].first(); minutes = list(fwd.index)
    atm = g.assign(dk=(g["strike"] - g["F"]).abs()).sort_values("dk").groupby("minute")["iv"].first().reindex(minutes)
    oi_c = g[g.side == "C"].groupby("strike")["oi"].first(); oi_p = g[g.side == "P"].groupby("strike")["oi"].first()
    gex10 = g[g.minute == "10:00"].groupby("strike")["gex"].sum() if "10:00" in set(g.minute) else None
    nq = nq.set_index("hm"); common = [m for m in minutes if m in nq.index]
    rr = pd.Series({m: nq.at[m, "close"] / fwd[m] for m in common})
    ratio = rr.rolling(S.RATIO_WINDOW, min_periods=3).median().shift(1); ratio = ratio.fillna(rr.expanding().median().shift(1)).bfill()
    bars = pd.DataFrame({"hm": common, "lo": [nq.at[m, "low"] / ratio[m] for m in common], "hi": [nq.at[m, "high"] / ratio[m] for m in common], "cl": [nq.at[m, "close"] / ratio[m] for m in common]}).set_index("hm")
    hms = list(bars.index); lo, hi, cl = bars.lo.to_numpy(), bars.hi.to_numpy(), bars.cl.to_numpy()
    idx = {m: i for i, m in enumerate(minutes)}
    mins_to_close = {hm: 16 * 60 - (int(hm[:2]) * 60 + int(hm[3:])) for hm in minutes}
    def iv_state(hm):
        i = idx.get(hm)
        if i is None or i < 2: return None
        now, prev = atm.iloc[i], atm.iloc[max(0, i - IV_WIN)]
        peak = atm.iloc[max(0, i - PEAK_WIN):i + 1].max()
        if not (np.isfinite(now) and np.isfinite(prev)): return None
        d = now - prev
        return dict(atm_iv=now, d_iv=d, cls="rising" if d > IV_THR else "falling" if d < -IV_THR else "flat", rolled=(peak - now) > IV_THR)
    S0 = float(fwd.iloc[0]); band = [k for k in oi_p.index if abs(k - S0) <= S0 * NEAR_PCT]
    medp = oi_p.reindex(band).median(); medc = oi_c.reindex(band).median()
    heavy_gex = set()
    if gex10 is not None:
        S10 = float(fwd.get("10:00", S0)); b10 = gex10[(gex10.index >= S10 * 0.99) & (gex10.index <= S10 * 1.01)]
        heavy_gex = set(b10.abs().nlargest(3).index.astype(float))
    rows = []; seen = set()
    for i in range(1, len(hms)):
        hm = hms[i]; Sp = float(fwd.get(hm, np.nan))
        if not np.isfinite(Sp): continue
        prev_c = cl[i - 1]
        for K in range(int(np.floor(Sp * (1 - NEAR_PCT))), int(np.ceil(Sp * (1 + NEAR_PCT))) + 1):
            K = float(K)
            for side in ("support", "resistance"):
                if (K, side) in seen: continue
                sup = side == "support"
                contact = (prev_c > K + CONTACT and lo[i] <= K + CONTACT) if sup else (prev_c < K - CONTACT and hi[i] >= K - CONTACT)
                if not contact: continue
                seen.add((K, side)); st = iv_state(hms[i - 1])
                if st is None: continue
                mtc = mins_to_close.get(hm, 0)
                if mtc < 20: continue
                la, ha, ca = lo[i:], hi[i:], cl[i:]
                status, pnl, fi, res, mfe = S.grade(la, ha, ca, sup, K, S.STOP_PTS, S.TP_PTS)
                over = (K - la) if sup else (ha - K); rej = (ha - K) if sup else (K - la)
                si = int(np.argmax(over >= S.STOP_PTS)) if (over >= S.STOP_PTS).any() else None
                ri = int(np.argmax(rej >= S.TP_PTS)) if (rej >= S.TP_PTS).any() else None
                held = "broke" if (si is not None and (ri is None or si <= ri)) else "held" if ri is not None else "unresolved"
                doi = float(oi_p.get(K, 0)) if sup else float(oi_c.get(K, 0)); dmed = medp if sup else medc
                def hv(k):
                    o = float(oi_p.get(k, 0)) if sup else float(oi_c.get(k, 0))
                    return (k in heavy_gex) or bool(dmed and o >= 2 * dmed)
                wall_b1 = hv(K - 1) if sup else hv(K + 1); wall_b2 = wall_b1 or (hv(K - 2) if sup else hv(K + 2))
                rows.append(dict(date=date, hm=hm, K=K, side=side, spot=Sp, mins_to_close=mtc, status=status, pnl=pnl, held=held,
                                 heavy=bool(dmed and doi >= 2 * dmed), oi_x=doi / dmed if dmed else np.nan, heavy_gex=(K in heavy_gex), wall_b1=wall_b1, wall_b2=wall_b2, **st))
    return {"rows": rows}


def main():
    out_dir = os.path.join(os.path.dirname(__file__), "..", "data", "study")
    files = sorted(glob.glob(os.path.join(S.SHARE, "*", "greeks", "greeks_*.csv.gz")))
    jobs = [(f, f"{os.path.basename(f)[7:11]}-{os.path.basename(f)[11:13]}-{os.path.basename(f)[13:15]}") for f in files]
    frames, errs = [], []
    with Pool(max(1, os.cpu_count() - 2)) as pool:
        for i, r in enumerate(pool.imap_unordered(run_day, jobs, chunksize=2), 1):
            if "error" in r: errs.append(r["error"])
            else: frames.append(pd.DataFrame(r["rows"]))
            if i % 50 == 0 or i == len(jobs): print(f"  {i}/{len(jobs)} · {sum(len(x) for x in frames)} approaches", flush=True)
    df = pd.concat(frames, ignore_index=True); df.to_parquet(os.path.join(out_dir, "approach_2224.parquet"), index=False)
    print("wrote", len(df), "approaches;", len(errs), "errors")


if __name__ == "__main__":
    main()
