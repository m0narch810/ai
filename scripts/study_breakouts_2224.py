"""
BREAKOUTS / CONTINUATION / RETEST + DAY BIAS on the 2022-24 0DTE chains (with OI).

Pre-registered. A BREAK of strike K is the first 1-min CLOSE beyond K by >= STOP_PTS (0.983 =
40 MNQ, the desk's hard-stop distance — the same number that says "the level broke" in
src/detect.ts). Heavy strikes = top-3 |gex| at 10:00 within +-1% OR defending OI >= 2x the band
median; light strikes are the placebo class. Everything is decided on the break bar's close and
graded strictly forward, adverse-first, order dies at the close.

Outcomes per break:
  cont_fixed   — enter at the break close in the break direction, 40/80 MNQ bracket
  cont_next    — same entry, stop = back through the broken strike, target = the next heavy strike
  reach_next   — price reaches the next heavy strike before trading back to K (no bracket)
  run_E        — max excursion beyond K in the break direction, in expected moves at the break
  retest_*     — first return to within 0.5 of K from the far side: minutes to it, IV state then,
                 and the outcome of a reversal trade AT K from the new side (40/80, trade-through)
Day bias: first turn in the 10:00 hour vs close direction; first-hour IV change vs close; gamma
regime vs range consumed.
"""
from __future__ import annotations
import glob, os, sys
from multiprocessing import Pool
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(__file__))
import study_0dte_alignment as S
import study_0dte_atlas as A

IV_WIN, IV_THR, NEAR_PCT, CONTACT = 30, 0.01, 0.01, 0.5
STOP, TP = S.STOP_PTS, S.TP_PTS


def market_grade(lo, hi, cl, long, entry, stop_d, tp_d):
    """Filled at `entry` on the first bar (market/stop entry), adverse-first, flat at the close."""
    if not len(lo): return "none", 0.0, -1
    adverse = (entry - lo) if long else (hi - entry); fav = (hi - entry) if long else (entry - lo)
    s_hit = adverse >= stop_d; t_hit = fav >= tp_d
    si = int(np.argmax(s_hit)) if s_hit.any() else None; ti = int(np.argmax(t_hit)) if t_hit.any() else None
    if si is not None and (ti is None or si <= ti): return "stopped", -stop_d, si
    if ti is not None: return "win", tp_d, ti
    return "flat", float(cl[-1] - entry) if long else float(entry - cl[-1]), len(lo) - 1


def run_day(args):
    path, date = args
    try: return _run_day(path, date)
    except Exception as e: return {"error": f"{date}: {type(e).__name__}: {e}"}


def _run_day(path, date):
    nq = S.nq_for(date)
    if nq is None: return {"error": f"{date}: no bars"}
    g = pd.read_csv(path, usecols=["minute", "strike", "side", "oi", "F", "T", "iv", "gex"]).dropna(subset=["iv", "F", "T"])
    g = g[g["T"] > 0]; g["strike"] = S.fix_strike_offset(g["strike"].to_numpy(float))
    fwd = g.groupby("minute")["F"].first(); Tm = g.groupby("minute")["T"].first(); minutes = list(fwd.index)
    atm = g.assign(dk=(g["strike"] - g["F"]).abs()).sort_values("dk").groupby("minute")["iv"].first().reindex(minutes)
    oi_c = g[g.side == "C"].groupby("strike")["oi"].first(); oi_p = g[g.side == "P"].groupby("strike")["oi"].first()
    if "10:00" not in set(minutes): return {"error": f"{date}: no 10:00"}
    S10 = float(fwd["10:00"]); gex10 = g[g.minute == "10:00"].groupby("strike")["gex"].sum()
    band = gex10[(gex10.index >= S10 * (1 - NEAR_PCT)) & (gex10.index <= S10 * (1 + NEAR_PCT))]
    top3 = set(band.abs().nlargest(3).index.astype(float)); neg_regime = float(band.sum()) < 0
    bks = [k for k in oi_p.index if abs(k - S10) <= S10 * NEAR_PCT]
    medp, medc = float(oi_p.reindex(bks).median() or 0), float(oi_c.reindex(bks).median() or 0)
    def heavy(k, down):
        if k in top3: return True
        return (float(oi_p.get(k, 0)) >= 2 * medp) if down else (float(oi_c.get(k, 0)) >= 2 * medc)
    nq = nq.set_index("hm"); common = [m for m in minutes if m in nq.index]
    rr = pd.Series({m: nq.at[m, "close"] / fwd[m] for m in common})
    ratio = rr.rolling(S.RATIO_WINDOW, min_periods=3).median().shift(1); ratio = ratio.fillna(rr.expanding().median().shift(1)).bfill()
    bars = pd.DataFrame({"hm": common, "lo": [nq.at[m, "low"] / ratio[m] for m in common], "hi": [nq.at[m, "high"] / ratio[m] for m in common], "cl": [nq.at[m, "close"] / ratio[m] for m in common]}).set_index("hm")
    hms = list(bars.index); lo, hi, cl = bars.lo.to_numpy(), bars.hi.to_numpy(), bars.cl.to_numpy()
    idx = {m: i for i, m in enumerate(minutes)}
    mtc = {hm: 16 * 60 - (int(hm[:2]) * 60 + int(hm[3:])) for hm in minutes}
    def iv_cls(hm):
        i = idx.get(hm)
        if i is None or i < 2: return None
        now, prev = atm.iloc[i], atm.iloc[max(0, i - IV_WIN)]
        if not (np.isfinite(now) and np.isfinite(prev)): return None
        d = now - prev; return "rising" if d > IV_THR else "falling" if d < -IV_THR else "flat"
    E_at = lambda hm: float(fwd[hm] * atm[hm] * np.sqrt(Tm[hm])) if hm in fwd.index and np.isfinite(atm.get(hm, np.nan)) else np.nan

    rows = []; seen = set(); i0 = hms.index("10:00") if "10:00" in hms else 30
    lo_k, hi_k = int(np.floor(bars.lo.min())) - 1, int(np.ceil(bars.hi.max())) + 1
    for i in range(i0, len(hms)):
        hm = hms[i]
        if mtc.get(hm, 0) < 20: break
        prev_c = cl[i - 1]
        for K in range(lo_k, hi_k + 1):
            K = float(K)
            for down in (True, False):
                if (K, down) in seen: continue
                # first CLOSE >= STOP beyond K, after price has actually been on the other side of K today
                brk = (prev_c > K - STOP and cl[i] <= K - STOP and (cl[:i] >= K).any()) if down else (prev_c < K + STOP and cl[i] >= K + STOP and (cl[:i] <= K).any())
                if not brk: continue
                seen.add((K, down))
                if abs(K - S10) > S10 * 0.02: continue          # keep to the tradeable band around the 10:00 print
                hv = heavy(K, down); E = E_at(hm)
                # next heavy strike beyond, within 3E
                cand = [k for k in oi_p.index if (k < K - 0.5 and K - k <= 3 * E) if down] if down else [k for k in oi_c.index if (k > K + 0.5 and k - K <= 3 * E)]
                nxt = [k for k in cand if heavy(float(k), down)]
                next_k = float(max(nxt)) if (down and nxt) else float(min(nxt)) if nxt else np.nan
                entry = float(cl[i]); la, ha, ca = lo[i + 1:], hi[i + 1:], cl[i + 1:]
                if len(la) < 2: continue
                st_fixed, pnl_fixed, _ = market_grade(la, ha, ca, not down, entry, STOP, TP)
                if np.isfinite(next_k):
                    st_next, pnl_next, _ = market_grade(la, ha, ca, not down, entry, abs(entry - K) + 0.15, abs(next_k - entry))
                else: st_next, pnl_next = "n/a", np.nan
                beyond = (K - la) if down else (ha - K)                 # excursion beyond K
                back = (ha >= K) if down else (la <= K)                  # traded back to K
                bi = int(np.argmax(back)) if back.any() else len(la)
                run_E = float(beyond[:bi].max() / E) if (bi > 0 and np.isfinite(E) and E > 0) else (0.0 if bi == 0 else np.nan)
                reach_next = bool(np.isfinite(next_k) and ((la[:bi] <= next_k).any() if down else (ha[:bi] >= next_k).any()))
                # retest: first return to within CONTACT of K from the far side
                ret = None
                for j in range(i + 1, len(hms)):
                    pc = cl[j - 1]
                    if (down and pc < K - CONTACT and hi[j] >= K - CONTACT) or ((not down) and pc > K + CONTACT and lo[j] <= K + CONTACT):
                        ret = j; break
                if ret is not None and mtc.get(hms[ret], 0) >= 20:
                    l2, h2, c2 = lo[ret:], hi[ret:], cl[ret:]
                    # reversal AT K from the new side: down-break → K is resistance → short at K
                    st_r, pnl_r, fi_r, res_r, mfe_r = S.grade(l2, h2, c2, not down, K, STOP, TP)   # sup=True means long; after a down-break we SHORT → sup=False → not down... careful
                    # S.grade(side_long=...) : long when we buy at K (support). After a DOWN break K is resistance → short → side_long=False
                    st_r, pnl_r, fi_r, res_r, mfe_r = S.grade(l2, h2, c2, False if down else True, K, STOP, TP)
                    over = (h2 - K) if down else (K - l2); rej = (K - l2) if down else (h2 - K)
                    si = int(np.argmax(over >= STOP)) if (over >= STOP).any() else None; ri = int(np.argmax(rej >= TP)) if (rej >= TP).any() else None
                    held = "broke" if (si is not None and (ri is None or si <= ri)) else "held" if ri is not None else "unresolved"
                    retest = dict(retest=True, retest_min=int((ret - i)), retest_iv=iv_cls(hms[ret - 1]), retest_status=st_r, retest_pnl=pnl_r, retest_held=held)
                else:
                    retest = dict(retest=False, retest_min=np.nan, retest_iv=None, retest_status="none", retest_pnl=np.nan, retest_held="n/a")
                rows.append(dict(date=date, hm=hm, K=K, dir="down" if down else "up", heavy=hv, top3=(K in top3), spot=float(fwd.get(hm, np.nan)), E=E, mins_to_close=mtc.get(hm, 0),
                                 iv_cls=iv_cls(hm), neg_regime=neg_regime, entry_beyond=abs(entry - K), next_k=next_k, next_dist_E=(abs(next_k - K) / E if np.isfinite(next_k) and E else np.nan),
                                 cont_fixed=st_fixed, cont_fixed_pnl=pnl_fixed, cont_next=st_next, cont_next_pnl=pnl_next, reach_next=reach_next, run_E=run_E, **retest))
    # day bias
    turns = A.zigzag(hi, lo, cl, A.SWING)
    first10 = next(((hms[ti], kind) for ti, p, kind in turns if "09:45" <= hms[ti] <= "10:59"), None)
    o, c = float(fwd.iloc[0]), float(fwd.iloc[-1]); E0 = E_at(minutes[0])
    iv1h = float(atm.get("10:31", np.nan) - atm.iloc[0]) if "10:31" in atm.index else np.nan
    bias = dict(date=date, open=o, close=c, chg=c - o, chg_E=(c - o) / E0 if E0 else np.nan, range_E=(bars.hi.max() - bars.lo.min()) / E0 if E0 else np.nan,
                turn10=first10[1] if first10 else None, turn10_hm=first10[0] if first10 else None, iv1h=iv1h, neg_regime=neg_regime, up_open=(o > float(bars.cl.iloc[0])) if False else None)
    return {"rows": rows, "bias": bias}


def main():
    out_dir = os.path.join(os.path.dirname(__file__), "..", "data", "study")
    files = sorted(glob.glob(os.path.join(S.SHARE, "*", "greeks", "greeks_*.csv.gz")))
    jobs = [(f, f"{os.path.basename(f)[7:11]}-{os.path.basename(f)[11:13]}-{os.path.basename(f)[13:15]}") for f in files]
    if "--days" in sys.argv:
        n = int(sys.argv[sys.argv.index("--days") + 1]); jobs = jobs[:: max(1, len(jobs) // n)][:n]
    frames, biases, errs = [], [], []
    with Pool(max(1, os.cpu_count() - 2)) as pool:
        for i, r in enumerate(pool.imap_unordered(run_day, jobs, chunksize=2), 1):
            if "error" in r: errs.append(r["error"])
            else: frames.append(pd.DataFrame(r["rows"])); biases.append(r["bias"])
            if i % 50 == 0 or i == len(jobs): print(f"  {i}/{len(jobs)} · {sum(len(x) for x in frames)} breaks · {len(errs)} errors", flush=True)
    pd.concat(frames, ignore_index=True).to_parquet(os.path.join(out_dir, "breaks_2224.parquet"), index=False)
    pd.DataFrame(biases).to_parquet(os.path.join(out_dir, "bias_2224.parquet"), index=False)
    print("done;", len(errs), "errors", errs[:3])


if __name__ == "__main__":
    main()
