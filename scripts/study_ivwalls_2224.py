"""
IV WALLS on 2022-24 0DTE chains: how much they move, how often price reaches them, and what
happens when it does. Same conventions as the desk's src/ivWalls.ts / web/lib/ivwalls.js:
inner walls = the |delta| = 0.1925 strikes of the 0DTE smile (monotone-|delta| crossing,
linear interpolation), outer = inner +/- spot * (1.56/750 upper, 1.79/750 lower), Black r=0.04,
T = minutes to 16:00 / 525600.

Three bracket variants per day:
  live    — recomputed every minute (the browser panel); the order is re-placed at the t-1 value
  open    — frozen at the first usable minute (09:31), the desk's "first US chain" rule
  t10     — frozen at 10:00
Plus a displaced placebo for the frozen brackets: the same four levels moved 0.25E further out.

Events: first contact per (day, variant, wall) from the inside (within 0.5 pt), decision at t-1;
outcome = limit at the wall value, 40/80 MNQ bracket, trade-through fill, adverse-first (grade()),
and the 'held' outcome (reject 80 before overshoot 40 from contact). IV state at t-1 recorded.
"""
from __future__ import annotations
import glob, os, sys
from multiprocessing import Pool
import numpy as np, pandas as pd
from scipy.stats import norm
sys.path.insert(0, os.path.dirname(__file__))
import study_0dte_alignment as S

DELTA_STAR, W_U, W_L, R = 0.1925, 1.56 / 750, 1.79 / 750, 0.04
CONTACT, IV_WIN, IV_THR = 0.5, 30, 0.01
PLACEBO_E = 0.25


def delta_cross(wing):
    mono = []
    for k, d in wing:
        if not np.isfinite(d): continue
        if not mono or d < mono[-1][1]: mono.append((k, d))
    for (ka, da), (kb, db) in zip(mono, mono[1:]):
        if da >= DELTA_STAR >= db:
            f = (da - DELTA_STAR) / ((da - db) or 1); return ka + f * (kb - ka)
    return None


def walls(strikes, sigmas, spot, T):
    if len(strikes) < 8 or not (spot > 0 and T > 0): return None
    sqT = np.sqrt(T)
    d1 = (np.log(spot / strikes) + (R + sigmas ** 2 / 2) * T) / (sigmas * sqT)
    up = [(k, norm.cdf(x)) for k, x in zip(strikes, d1) if k >= spot]
    dn = [(k, norm.cdf(-x)) for k, x in zip(strikes[::-1], d1[::-1]) if k <= spot]
    ui, li = delta_cross(up), delta_cross(dn)
    if ui is None or li is None: return None
    return dict(u_inner=ui, u_outer=ui + spot * W_U, l_inner=li, l_outer=li - spot * W_L)


def run_day(args):
    path, date = args
    try: return _run_day(path, date)
    except Exception as e: return {"error": f"{date}: {type(e).__name__}: {e}"}


def _run_day(path, date):
    nq = S.nq_for(date)
    if nq is None: return {"error": f"{date}: no bars"}
    g = pd.read_csv(path, usecols=["minute", "strike", "side", "F", "T", "iv"]).dropna(subset=["iv", "F", "T"])
    g = g[(g["T"] > 0) & (g.side == "C")]; g["strike"] = S.fix_strike_offset(g["strike"].to_numpy(float))
    fwd = g.groupby("minute")["F"].first(); Tm = g.groupby("minute")["T"].first(); minutes = list(fwd.index)
    atm = g.assign(dk=(g["strike"] - g["F"]).abs()).sort_values("dk").groupby("minute")["iv"].first().reindex(minutes)
    smiles = {m: x.sort_values("strike") for m, x in g.groupby("minute")}
    W = {}
    for m in minutes:
        s = smiles[m]; w = walls(s.strike.to_numpy(float), s.iv.to_numpy(float), float(fwd[m]), float(Tm[m]))
        if w: W[m] = w
    if len(W) < 200: return {"error": f"{date}: walls thin ({len(W)})"}
    Wdf = pd.DataFrame(W).T.reindex(minutes).ffill()
    E0 = float(fwd.iloc[0] * atm.iloc[0] * np.sqrt(Tm.iloc[0]))
    nq = nq.set_index("hm"); common = [m for m in minutes if m in nq.index]
    rr = pd.Series({m: nq.at[m, "close"] / fwd[m] for m in common})
    ratio = rr.rolling(S.RATIO_WINDOW, min_periods=3).median().shift(1); ratio = ratio.fillna(rr.expanding().median().shift(1)).bfill()
    bars = pd.DataFrame({"hm": common, "lo": [nq.at[m, "low"] / ratio[m] for m in common], "hi": [nq.at[m, "high"] / ratio[m] for m in common], "cl": [nq.at[m, "close"] / ratio[m] for m in common]}).set_index("hm")
    hms = list(bars.index); lo, hi, cl = bars.lo.to_numpy(), bars.hi.to_numpy(), bars.cl.to_numpy()
    idx = {m: i for i, m in enumerate(minutes)}
    mtc = {hm: 16 * 60 - (int(hm[:2]) * 60 + int(hm[3:])) for hm in minutes}
    # drift of the live bracket through the day
    drift = dict(date=date, E0=E0, spot0=float(fwd.iloc[0]), **{f"{k}_open": float(Wdf[k].iloc[0]) for k in Wdf.columns},
                 **{f"{k}_range": float(Wdf[k].max() - Wdf[k].min()) for k in Wdf.columns},
                 **{f"{k}_15min_med_move": float(Wdf[k].diff(15).abs().median()) for k in Wdf.columns},
                 width_inner_open=float(Wdf.u_inner.iloc[0] - Wdf.l_inner.iloc[0]), width_inner_close=float(Wdf.u_inner.iloc[-1] - Wdf.l_inner.iloc[-1]))
    first_m = minutes[0]; m10 = "10:00" if "10:00" in Wdf.index else minutes[min(29, len(minutes) - 1)]
    variants = {"live": None, "open": Wdf.loc[first_m].to_dict(), "t10": Wdf.loc[m10].to_dict()}
    rows = []
    for var, fixed in variants.items():
        for wall in ("u_inner", "u_outer", "l_inner", "l_outer"):
            upper = wall.startswith("u")
            for pl in ((0.0,) if var == "live" else (0.0, PLACEBO_E)):
                seen = False
                for i in range(1, len(hms)):
                    hm = hms[i]
                    if var == "live":
                        prev_hm = hms[i - 1]
                        lvl = float(Wdf.at[prev_hm, wall]) if prev_hm in Wdf.index else np.nan
                    else:
                        lvl = fixed[wall] + (pl * E0 if upper else -pl * E0)
                    if not np.isfinite(lvl): continue
                    if var != "live" and hm <= (m10 if var == "t10" else first_m): continue
                    prev_c = cl[i - 1]
                    contact = (prev_c < lvl - CONTACT and hi[i] >= lvl - CONTACT) if upper else (prev_c > lvl + CONTACT and lo[i] <= lvl + CONTACT)
                    if not contact: continue
                    seen = True
                    j = idx.get(hms[i - 1]); st = None
                    if j is not None and j >= 2:
                        now, prev = atm.iloc[j], atm.iloc[max(0, j - IV_WIN)]
                        if np.isfinite(now) and np.isfinite(prev):
                            d = now - prev; st = "rising" if d > IV_THR else "falling" if d < -IV_THR else "flat"
                    if mtc.get(hm, 0) < 20: break
                    la, ha, ca = lo[i:], hi[i:], cl[i:]
                    status, pnl, fi, res, mfe = S.grade(la, ha, ca, not upper, lvl, S.STOP_PTS, S.TP_PTS)
                    over = (ha - lvl) if upper else (lvl - la); rej = (lvl - la) if upper else (ha - lvl)
                    si = int(np.argmax(over >= S.STOP_PTS)) if (over >= S.STOP_PTS).any() else None
                    ri = int(np.argmax(rej >= S.TP_PTS)) if (rej >= S.TP_PTS).any() else None
                    held = "broke" if (si is not None and (ri is None or si <= ri)) else "held" if ri is not None else "unresolved"
                    rows.append(dict(date=date, variant=var, wall=wall, placebo=pl > 0, hm=hm, mins_to_close=mtc.get(hm, 0), level=lvl, spot=float(fwd.get(hm, np.nan)),
                                     dist_E0=abs(lvl - float(fwd.iloc[0])) / E0 if E0 else np.nan, iv_cls=st, status=status, pnl=pnl, held=held, over_max=float(over.max()), reached=True))
                    break
                if not seen:
                    rows.append(dict(date=date, variant=var, wall=wall, placebo=pl > 0, hm=None, mins_to_close=np.nan, level=np.nan, spot=np.nan, dist_E0=np.nan, iv_cls=None, status="never_reached", pnl=0.0, held="n/a", over_max=np.nan, reached=False))
    return {"rows": rows, "drift": drift}


def main():
    out_dir = os.path.join(os.path.dirname(__file__), "..", "data", "study")
    files = sorted(glob.glob(os.path.join(S.SHARE, "*", "greeks", "greeks_*.csv.gz")))
    jobs = [(f, f"{os.path.basename(f)[7:11]}-{os.path.basename(f)[11:13]}-{os.path.basename(f)[13:15]}") for f in files]
    if "--days" in sys.argv:
        n = int(sys.argv[sys.argv.index("--days") + 1]); jobs = jobs[:: max(1, len(jobs) // n)][:n]
    frames, drifts, errs = [], [], []
    with Pool(max(1, os.cpu_count() - 2)) as pool:
        for i, r in enumerate(pool.imap_unordered(run_day, jobs, chunksize=2), 1):
            if "error" in r: errs.append(r["error"])
            else: frames.append(pd.DataFrame(r["rows"])); drifts.append(r["drift"])
            if i % 50 == 0 or i == len(jobs): print(f"  {i}/{len(jobs)} · {len(errs)} errors", flush=True)
    pd.concat(frames, ignore_index=True).to_parquet(os.path.join(out_dir, "ivwalls_2224_events.parquet"), index=False)
    pd.DataFrame(drifts).to_parquet(os.path.join(out_dir, "ivwalls_2224_drift.parquet"), index=False)
    with open(os.path.join(out_dir, "ivwalls_2224_errors.txt"), "w", encoding="utf-8") as fh: fh.write("\n".join(errs))
    print("done;", len(errs), "errors")


if __name__ == "__main__":
    main()
