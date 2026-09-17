"""
2025 (Databento OPRA, quotes only) — two forward blocks in one pass over the DBN files:

 B. BREAKS at any whole strike (no OI in 2025): first CLOSE >= STOP beyond K after price was on
    the other side; IV class at the break; continuation on the 40/80 bracket from the break close;
    run size in E; first retest and the reversal trade AT K from the new side.
 C. ASIA / OVERNIGHT: at the last RTH minute (<= 15:59 ET) build the NEXT expiry's smile from
    the OTM mids (Black r = 0.04 as in the wall spec, T = hours to that expiry's 16:00 / 8760),
    freeze the four 19-delta walls (the spec's prior-evening bracket) and grade them against NQ
    Globex bars 18:00 D -> 04:00 D+1 ET converted with the 15:59 NQ/F ratio. Placebo = the same
    bracket displaced 0.25E further out. Also: whole-strike contacts overnight (geometry check).
"""
from __future__ import annotations
import glob, os, sys
from multiprocessing import Pool
import numpy as np, pandas as pd
from scipy.stats import norm
sys.path.insert(0, os.path.dirname(__file__))
import study_0dte_alignment as S
import study_2025_forward as F
import study_ivwalls_2224 as W
import study_breakouts_2224 as B

IV_WIN, IV_THR, CONTACT, PLACEBO_E = 30, 0.01, 0.5, 0.25
STOP, TP = S.STOP_PTS, S.TP_PTS

_NQ = None
def nq_all():
    global _NQ
    if _NQ is None:
        d = pd.read_parquet(S.NQ_BARS, columns=["date", "open", "high", "low", "close"])
        d = d[(d["date"] >= "2025-01-01") & (d["date"] < "2026-01-03")].copy()
        d["day"] = d["date"].dt.strftime("%Y-%m-%d"); d["hm"] = d["date"].dt.strftime("%H:%M")
        _NQ = d
    return _NQ


def overnight_bars(date):
    """18:00 on `date` -> 04:00 next calendar day (ET), Globex."""
    d = nq_all(); t0 = pd.Timestamp(date + " 18:00:00"); t1 = t0 + pd.Timedelta(hours=10)
    x = d[(d["date"] >= t0) & (d["date"] <= t1)]
    return x if len(x) >= 200 else None


def load_all_quotes(path):
    import databento as db
    df = db.DBNStore.from_file(path).to_df()
    sym = df["symbol"].astype(str)
    df = df[sym.str.startswith("QQQ")].copy()
    s = df["symbol"].astype(str)
    df["exp"] = s.str.slice(6, 12); df["cp"] = s.str.slice(12, 13); df["strike"] = s.str.slice(13).astype(float) / 1000
    df["hm"] = df.index.tz_convert("America/New_York").strftime("%H:%M")
    df = df[(df["bid_px_00"] > 0) & (df["ask_px_00"] > df["bid_px_00"])]
    df["mid"] = (df["bid_px_00"] + df["ask_px_00"]) / 2
    return df[["hm", "exp", "cp", "strike", "mid"]]


def run_day(args):
    path, date = args
    try: return _run_day(path, date)
    except Exception as e: return {"error": f"{date}: {type(e).__name__}: {e}"}


def _run_day(path, date):
    q = load_all_quotes(path)
    ymd = date[2:4] + date[5:7] + date[8:10]
    out = {"breaks": [], "asia": [], "asia_strikes": []}
    # ── B. 0DTE minute series (same construction as study_2025_forward) ──
    q0 = q[(q.exp == ymd) & (q.hm >= "09:31") & (q.hm <= "15:59")]
    nq = F.nq_for(date)
    if nq is not None and len(q0):
        piv = q0.pivot_table(index=["hm", "strike"], columns="cp", values="mid").reset_index()
        fwd = {}
        for hm, g in piv.groupby("hm"):
            both = g.dropna(subset=["C", "P"]); both = both[(both.C > 0.03) | (both.P > 0.03)]
            if len(both) < 4: continue
            f0 = both.strike + both.C - both.P; med = f0.median(); near = f0[(both.strike - med).abs() <= 4]
            if len(near) >= 3: fwd[hm] = float(near.median())
        fwd = pd.Series(fwd).sort_index()
        if len(fwd) >= 200:
            minutes = list(fwd.index); mtc = {hm: 16 * 60 - (int(hm[:2]) * 60 + int(hm[3:])) for hm in minutes}
            piv = piv[piv.hm.isin(minutes)].copy(); piv["F"] = piv.hm.map(fwd); piv["T"] = piv.hm.map(mtc) / 525600.0
            piv["is_call"] = piv.strike >= piv.F; piv["otm_mid"] = np.where(piv.is_call, piv.C, piv.P); piv = piv.dropna(subset=["otm_mid"])
            piv["iv"] = F.black_iv(piv.F.to_numpy(), piv.strike.to_numpy(), piv["T"].to_numpy(), piv.otm_mid.to_numpy(), piv.is_call.to_numpy())
            piv = piv.dropna(subset=["iv"]); piv["dk"] = (piv.strike - piv.F).abs()
            atm = piv[piv.dk <= 1.0].groupby("hm").apply(lambda g: float(np.average(g.iv, weights=1 / (g.dk + 0.05)))).reindex(minutes).interpolate(limit=3)
            nqi = nq.set_index("hm"); common = [m for m in minutes if m in nqi.index]
            rr = pd.Series({m: nqi.at[m, "close"] / fwd[m] for m in common})
            ratio = rr.rolling(S.RATIO_WINDOW, min_periods=3).median().shift(1); ratio = ratio.fillna(rr.expanding().median().shift(1)).bfill()
            bars = pd.DataFrame({"hm": common, "lo": [nqi.at[m, "low"] / ratio[m] for m in common], "hi": [nqi.at[m, "high"] / ratio[m] for m in common], "cl": [nqi.at[m, "close"] / ratio[m] for m in common]}).set_index("hm")
            hms = list(bars.index); lo, hi, cl = bars.lo.to_numpy(), bars.hi.to_numpy(), bars.cl.to_numpy()
            idx = {m: i for i, m in enumerate(minutes)}
            def iv_cls(hm):
                i = idx.get(hm)
                if i is None or i < 2: return None
                now, prev = atm.iloc[i], atm.iloc[max(0, i - IV_WIN)]
                if not (np.isfinite(now) and np.isfinite(prev)): return None
                d = now - prev; return "rising" if d > IV_THR else "falling" if d < -IV_THR else "flat"
            S10 = float(fwd.get("10:00", fwd.iloc[min(29, len(fwd) - 1)]))
            E_at = lambda hm: float(fwd[hm] * atm[hm] * np.sqrt(mtc[hm] / 525600.0)) if hm in fwd.index and np.isfinite(atm.get(hm, np.nan)) else np.nan
            seen = set(); i0 = hms.index("10:00") if "10:00" in hms else 30
            lo_k, hi_k = int(np.floor(bars.lo.min())) - 1, int(np.ceil(bars.hi.max())) + 1
            for i in range(i0, len(hms)):
                hm = hms[i]
                if mtc.get(hm, 0) < 20: break
                prev_c = cl[i - 1]
                for K in range(lo_k, hi_k + 1):
                    K = float(K)
                    for down in (True, False):
                        if (K, down) in seen: continue
                        brk = (prev_c > K - STOP and cl[i] <= K - STOP and (cl[:i] >= K).any()) if down else (prev_c < K + STOP and cl[i] >= K + STOP and (cl[:i] <= K).any())
                        if not brk: continue
                        seen.add((K, down))
                        if abs(K - S10) > S10 * 0.02: continue
                        E = E_at(hm); entry = float(cl[i]); la, ha, ca = lo[i + 1:], hi[i + 1:], cl[i + 1:]
                        if len(la) < 2: continue
                        st, pnl, _ = B.market_grade(la, ha, ca, not down, entry, STOP, TP)
                        beyond = (K - la) if down else (ha - K); back = (ha >= K) if down else (la <= K)
                        bi = int(np.argmax(back)) if back.any() else len(la)
                        run_E = float(beyond[:bi].max() / E) if (bi > 0 and np.isfinite(E) and E > 0) else (0.0 if bi == 0 else np.nan)
                        ret = None
                        for j in range(i + 1, len(hms)):
                            pc = cl[j - 1]
                            if (down and pc < K - CONTACT and hi[j] >= K - CONTACT) or ((not down) and pc > K + CONTACT and lo[j] <= K + CONTACT): ret = j; break
                        if ret is not None and mtc.get(hms[ret], 0) >= 20:
                            l2, h2, c2 = lo[ret:], hi[ret:], cl[ret:]
                            st_r, pnl_r, *_ = S.grade(l2, h2, c2, False if down else True, K, STOP, TP)
                            rt = dict(retest=True, retest_min=int(ret - i), retest_iv=iv_cls(hms[ret - 1]), retest_status=st_r, retest_pnl=pnl_r)
                        else: rt = dict(retest=False, retest_min=np.nan, retest_iv=None, retest_status="none", retest_pnl=np.nan)
                        out["breaks"].append(dict(date=date, hm=hm, K=K, dir="down" if down else "up", iv_cls=iv_cls(hm), E=E, mins_to_close=mtc.get(hm, 0), cont_fixed=st, cont_fixed_pnl=pnl, run_E=run_E, **rt))
    # ── C. ASIA: prior-evening bracket from the NEXT expiry at the last RTH minute ──
    ob = overnight_bars(date)
    exps = sorted(e for e in q.exp.unique() if e > ymd)
    if ob is not None and exps:
        nexp = exps[0]
        last = q[(q.exp == ymd) & (q.hm <= "15:59")]
        # F at the close from the 0DTE parity (fallback: next expiry's parity)
        def parity_F(sub):
            both = sub.pivot_table(index="strike", columns="cp", values="mid").dropna()
            both = both[(both.C > 0.03) | (both.P > 0.03)]
            if len(both) < 4: return np.nan
            ks = both.index.to_numpy(float); f0 = ks + both.C.to_numpy() - both.P.to_numpy(); med = float(np.median(f0)); near = f0[np.abs(ks - med) <= 4]
            return float(np.median(near)) if len(near) >= 3 else np.nan
        hm_last = last.hm.max() if len(last) else None
        Fc = parity_F(last[last.hm == hm_last]) if hm_last else np.nan
        qn = q[(q.exp == nexp) & (q.hm == (hm_last or "15:59"))]
        if not np.isfinite(Fc): Fc = parity_F(qn)
        if np.isfinite(Fc) and len(qn):
            # calendar days to the next expiry → T anchored to its 16:00 (24h for the next trading day, 72h over a weekend)
            d0 = pd.Timestamp("20" + ymd[:2] + "-" + ymd[2:4] + "-" + ymd[4:]); d1 = pd.Timestamp("20" + nexp[:2] + "-" + nexp[2:4] + "-" + nexp[4:])
            T = ((d1 - d0).days * 24) / 8760.0
            pv = qn.pivot_table(index="strike", columns="cp", values="mid")
            if "C" in pv and "P" in pv:
                pv = pv.reset_index(); pv["is_call"] = pv.strike >= Fc; pv["otm"] = np.where(pv.is_call, pv.C, pv.P); pv = pv.dropna(subset=["otm"])
                pv["iv"] = F.black_iv(np.full(len(pv), Fc), pv.strike.to_numpy(), np.full(len(pv), T), pv.otm.to_numpy(), pv.is_call.to_numpy())
                pv = pv.dropna(subset=["iv"]).sort_values("strike")
                w = W.walls(pv.strike.to_numpy(float), pv.iv.to_numpy(float), Fc, T)
                if w:
                    atm_iv = float(pv.iloc[(pv.strike - Fc).abs().argsort()[:2]].iv.mean()); E = Fc * atm_iv * np.sqrt(T)
                    nq_close = float(nq_all().loc[(nq_all().day == date) & (nq_all().hm <= "15:59"), "close"].iloc[-1]); ratio = nq_close / Fc
                    lo_ = ob.low.to_numpy() / ratio; hi_ = ob.high.to_numpy() / ratio; cl_ = ob.close.to_numpy() / ratio
                    for wall in ("u_inner", "u_outer", "l_inner", "l_outer"):
                        upper = wall.startswith("u")
                        for pl in (0.0, PLACEBO_E):
                            lvl = w[wall] + (pl * E if upper else -pl * E)
                            hit = None
                            for i in range(1, len(lo_)):
                                pc = cl_[i - 1]
                                if (upper and pc < lvl - CONTACT and hi_[i] >= lvl - CONTACT) or ((not upper) and pc > lvl + CONTACT and lo_[i] <= lvl + CONTACT): hit = i; break
                            if hit is None:
                                out["asia"].append(dict(date=date, wall=wall, placebo=pl > 0, level=lvl, F=Fc, E=E, T_h=T * 8760, reached=False, status="never", pnl=0.0, held="n/a", over_max=np.nan, min_to_hit=np.nan)); continue
                            la, ha, ca = lo_[hit:], hi_[hit:], cl_[hit:]
                            st, pnl, fi, res, mfe = S.grade(la, ha, ca, not upper, lvl, STOP, TP)
                            over = (ha - lvl) if upper else (lvl - la); rej = (lvl - la) if upper else (ha - lvl)
                            si = int(np.argmax(over >= STOP)) if (over >= STOP).any() else None; ri = int(np.argmax(rej >= TP)) if (rej >= TP).any() else None
                            held = "broke" if (si is not None and (ri is None or si <= ri)) else "held" if ri is not None else "unresolved"
                            out["asia"].append(dict(date=date, wall=wall, placebo=pl > 0, level=lvl, F=Fc, E=E, T_h=T * 8760, reached=True, status=st, pnl=pnl, held=held, over_max=float(over.max()), min_to_hit=hit))
                    # whole-strike contacts overnight (first per strike/side), geometry check
                    seen = set()
                    for i in range(1, len(lo_)):
                        pc = cl_[i - 1]
                        for K in range(int(np.floor(Fc * 0.985)), int(np.ceil(Fc * 1.015)) + 1):
                            for sup in (True, False):
                                if (K, sup) in seen: continue
                                c = (pc > K + CONTACT and lo_[i] <= K + CONTACT) if sup else (pc < K - CONTACT and hi_[i] >= K - CONTACT)
                                if not c: continue
                                seen.add((K, sup)); la, ha, ca = lo_[i:], hi_[i:], cl_[i:]
                                st, pnl, *_ = S.grade(la, ha, ca, sup, float(K), STOP, TP)
                                out["asia_strikes"].append(dict(date=date, K=float(K), side="support" if sup else "resistance", status=st, pnl=pnl))
    return out


def main():
    out_dir = os.path.join(os.path.dirname(__file__), "..", "data", "study")
    files = sorted(glob.glob(os.path.join(F.DBN_DIR, "opra-pillar-*.cbbo-1m.dbn.zst")))
    jobs = [(f, f"{os.path.basename(f)[12:16]}-{os.path.basename(f)[16:18]}-{os.path.basename(f)[18:20]}") for f in files]
    if "--days" in sys.argv:
        n = int(sys.argv[sys.argv.index("--days") + 1]); jobs = jobs[:: max(1, len(jobs) // n)][:n]
    workers = int(sys.argv[sys.argv.index("--workers") + 1]) if "--workers" in sys.argv else 6
    acc = {"breaks": [], "asia": [], "asia_strikes": []}; errs = []
    with Pool(workers) as pool:
        for i, r in enumerate(pool.imap_unordered(run_day, jobs, chunksize=1), 1):
            if "error" in r: errs.append(r["error"])
            else:
                for k in acc: acc[k].extend(r[k])
            if i % 10 == 0 or i == len(jobs): print(f"  {i}/{len(jobs)} · breaks {len(acc['breaks'])} · asia {len(acc['asia'])} · {len(errs)} errors", flush=True)
    for k, v in acc.items(): pd.DataFrame(v).to_parquet(os.path.join(out_dir, f"y2025_{k}.parquet"), index=False)
    with open(os.path.join(out_dir, "y2025_errors.txt"), "w", encoding="utf-8") as fh: fh.write("\n".join(errs))
    print("done;", len(errs), "errors")


if __name__ == "__main__":
    main()
