"""
STATE TAPE — the whole 0DTE book, the IV walls, the flips and the price path, sampled every
5 minutes of every session 2022-24, plus every level CONTACT graded for the "tight stop, let it
run" objective (stops 10/15/20/30/40 MNQ; how far the trade ran before the stop or the close).

This is the DATA LAYER for an open exploration (2026-09-17, user: "include everything, as wide as
possible, look for things rather than confirm things … my goal is to limit levels with 15-point
stops and just let them run"). No hypothesis is encoded here; `study_state_explore.py` sweeps
every feature and its time-changes against the outcomes, and the daily tapes are also rendered
as text for a qualitative read.

Outputs (data/study/):
  state_tape_<years>.parquet    one row per (date, 5-min tick): spot, E, IV, IV walls (live + open-
                                frozen), 0DTE flip / walls / OI walls / sums / concentration, HOD/LOD,
                                distances (in E), and Δ5/Δ15/Δ30/Δ60 of every level & sum (added in
                                the parent, within-day only)
  contacts_<years>.parquet      one row per first contact of a level (whole strikes ±1%, plus the
                                named levels at t-1): state at the last tick before contact, and the
                                MAE/MFE outcome ladder for each stop.

    python scripts/study_state_tape.py --smoke
    python scripts/study_state_tape.py --years 2022,2023,2024
"""
from __future__ import annotations
import glob, os, sys
from multiprocessing import Pool
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(__file__))
import study_0dte_alignment as S
try: sys.stdout.reconfigure(encoding="utf-8")
except Exception: pass

MNQ = S.MNQ_PER_QQQ
NEAR_PCT, CONTACT, BAND_PCT = 0.01, 0.5, 0.015
STOPS = [10, 15, 20, 30, 40]              # MNQ
RUNS = [20, 40, 80, 120, 200]             # MNQ
DELTA_STAR, W_U_PCT, W_L_PCT = 0.1925, 1.56 / 750, 1.79 / 750
TICKS = [f"{h:02d}:{m:02d}" for h in range(9, 16) for m in range(0, 60, 5) if (h, m) >= (9, 35) and (h, m) <= (15, 55)]
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "study")
LEVEL_FIELDS = ["flip", "major", "cwall", "pwall", "coi_wall", "poi_wall", "ivu_in", "ivu_out", "ivl_in", "ivl_out"]
SUM_FIELDS = ["net_gex", "abs_gex", "charm_sum", "vanna_sum", "dex_sum", "vex_sum", "conc1", "conc3", "atm_iv", "E", "iv_skew"]


def iv_walls(F, ks, dC, dP):
    """Inner walls = interpolated |Δ|=0.1925 strikes on each wing; outer = spec widths beyond."""
    up = [(k, d) for k, d in zip(ks, dC) if k > F and np.isfinite(d)]
    dn = [(k, d) for k, d in zip(ks, dP) if k < F and np.isfinite(d)]
    def cross(pairs, target, ascending):
        pairs = sorted(pairs, key=lambda p: p[0], reverse=not ascending)
        for (k1, d1), (k2, d2) in zip(pairs, pairs[1:]):
            if (d1 - target) * (d2 - target) <= 0 and d1 != d2:
                return k1 + (target - d1) * (k2 - k1) / (d2 - d1)
        return np.nan
    u = cross(up, DELTA_STAR, True); l = cross([(k, abs(d)) for k, d in dn], DELTA_STAR, False)
    return u, u + F * W_U_PCT if np.isfinite(u) else np.nan, l, l - F * W_L_PCT if np.isfinite(l) else np.nan


def run_day(args):
    path, date = args
    try: return _run_day(path, date)
    except Exception as e: return {"error": f"{date}: {type(e).__name__}: {e}"}


def _run_day(path, date):
    nq = S.nq_for(date)
    if nq is None: return {"error": f"{date}: no bars"}
    g = pd.read_csv(path, usecols=["minute", "strike", "side", "oi", "F", "T", "iv", "delta", "gex"]).dropna(subset=["iv", "F", "T"])
    g = g[g["T"] > 0]; g["strike"] = S.fix_strike_offset(g["strike"].to_numpy(float))
    if g.empty: return {"error": f"{date}: empty"}
    fwd = g.groupby("minute")["F"].first(); Tm = g.groupby("minute")["T"].first(); minutes = list(fwd.index)
    atm = g.assign(dk=(g["strike"] - g["F"]).abs()).sort_values("dk").groupby("minute")["iv"].first().reindex(minutes)
    # dealer ladders (share convention, as study_0dte_alignment)
    dc, vega, charm, vanna = S.black_greeks(g["F"].to_numpy(), g["strike"].to_numpy(), g["T"].to_numpy(), g["iv"].to_numpy())
    is_c = (g["side"] == "C").to_numpy(); sgn = np.where(is_c, 1.0, -1.0); oi = g["oi"].to_numpy(float)
    delta_bs = np.where(is_c, dc, dc - 1.0)
    g = g.assign(gex_s=g["gex"].to_numpy(), vex_s=sgn * oi * 100 * vega, dex_s=sgn * oi * 100 * delta_bs,
                 charm_flow=-sgn * oi * 100 * charm, vanna_flow=sgn * oi * 100 * vanna,
                 oi_c=np.where(is_c, oi, 0.0), oi_p=np.where(is_c, 0.0, oi),
                 dC=np.where(is_c, g["delta"].to_numpy(float), np.nan), dP=np.where(is_c, np.nan, g["delta"].to_numpy(float)),
                 ivC=np.where(is_c, g["iv"].to_numpy(float), np.nan), ivP=np.where(is_c, np.nan, g["iv"].to_numpy(float)))
    lad = g.groupby(["minute", "strike"]).agg(gex_s=("gex_s", "sum"), vex_s=("vex_s", "sum"), dex_s=("dex_s", "sum"), charm_flow=("charm_flow", "sum"),
                                              vanna_flow=("vanna_flow", "sum"), oi_c=("oi_c", "sum"), oi_p=("oi_p", "sum"), dC=("dC", "first"), dP=("dP", "first"),
                                              ivC=("ivC", "first"), ivP=("ivP", "first"))
    # bars
    nq = nq.set_index("hm"); common = [m for m in minutes if m in nq.index]
    rr = pd.Series({m: nq.at[m, "close"] / fwd[m] for m in common})
    ratio = rr.rolling(S.RATIO_WINDOW, min_periods=3).median().shift(1); ratio = ratio.fillna(rr.expanding().median().shift(1)).bfill()
    bars = pd.DataFrame({"hm": common, "lo": [nq.at[m, "low"] / ratio[m] for m in common], "hi": [nq.at[m, "high"] / ratio[m] for m in common],
                         "cl": [nq.at[m, "close"] / ratio[m] for m in common], "op": [nq.at[m, "open"] / ratio[m] for m in common]}).set_index("hm")
    hms = list(bars.index); lo, hi, cl = bars.lo.to_numpy(), bars.hi.to_numpy(), bars.cl.to_numpy()
    bidx = {m: i for i, m in enumerate(hms)}; midx = {m: i for i, m in enumerate(minutes)}
    day_open = float(bars.op.iloc[0])

    # ── state at each 5-min tick ────────────────────────────────────────────────
    lad_minutes = set(lad.index.get_level_values(0))
    ticks = []; frozen = None
    for tick in TICKS:
        if tick not in lad_minutes or tick not in bidx: continue
        L = lad.loc[tick]; F = float(fwd[tick]); T = float(Tm[tick]); siv = float(atm[tick]); E = F * siv * np.sqrt(T)
        i = midx[tick]; bi = bidx[tick]
        band = L[(L.index >= F * (1 - BAND_PCT)) & (L.index <= F * (1 + BAND_PCT)) & ((L["oi_c"] + L["oi_p"]) > 0)]
        if len(band) < 4 or not (E > 0): continue
        gex = band["gex_s"]; a = gex.abs(); tot = float(a.sum())
        above, below = gex[gex.index > F], gex[gex.index < F]
        cum = gex.sort_index().cumsum(); flip = np.nan; prev_c = 0.0
        for k, v in cum.items():
            if prev_c != 0 and np.sign(v) != np.sign(prev_c): flip = float(k); break
            prev_c = v
        top = a.sort_values(ascending=False)
        ks = L.index.to_numpy(float)
        u_in, u_out, l_in, l_out = iv_walls(F, ks, L["dC"].to_numpy(float), L["dP"].to_numpy(float))
        # 25Δ-ish skew proxy: put IV at spot−2% minus call IV at spot+2% (nearest strikes)
        def iv_at(kt, col):
            s = L[col].dropna()
            if s.empty: return np.nan
            return float(s.iloc[int(np.argmin(np.abs(s.index.to_numpy(float) - kt)))])
        skew = iv_at(F * 0.98, "ivP") - iv_at(F * 1.02, "ivC")
        st = dict(date=date, tick=tick, F=F, T=T, E=E, atm_iv=siv, mins_to_close=16 * 60 - (int(tick[:2]) * 60 + int(tick[3:])),
                  hod=float(hi[:bi + 1].max()), lod=float(lo[:bi + 1].min()), day_open=day_open,
                  flip=flip, major=float(a.idxmax()), cwall=float(above.idxmax()) if len(above) and above.max() > 0 else np.nan,
                  pwall=float(below.idxmin()) if len(below) and below.min() < 0 else np.nan,
                  coi_wall=float(band["oi_c"].idxmax()), poi_wall=float(band["oi_p"].idxmax()),
                  ivu_in=u_in, ivu_out=u_out, ivl_in=l_in, ivl_out=l_out,
                  net_gex=float(gex.sum()), abs_gex=tot, charm_sum=float(band["charm_flow"].sum()), vanna_sum=float(band["vanna_flow"].sum()),
                  dex_sum=float(band["dex_s"].sum()), vex_sum=float(band["vex_s"].sum()),
                  conc1=float(top.iloc[0] / tot) if tot > 0 else np.nan, conc3=float(top.iloc[:3].sum() / tot) if tot > 0 else np.nan,
                  iv_skew=skew, top1=float(top.index[0]), top2=float(top.index[1]) if len(top) > 1 else np.nan, top3=float(top.index[2]) if len(top) > 2 else np.nan,
                  d_iv30=siv - float(atm.iloc[max(0, i - 30)]), d_iv15=siv - float(atm.iloc[max(0, i - 15)]),
                  iv_off_peak60=float(atm.iloc[max(0, i - 60):i + 1].max()) - siv)
        if frozen is None and np.isfinite(u_in) and np.isfinite(l_in): frozen = dict(ivu_in_frz=u_in, ivu_out_frz=u_out, ivl_in_frz=l_in, ivl_out_frz=l_out)
        st.update(frozen or dict(ivu_in_frz=np.nan, ivu_out_frz=np.nan, ivl_in_frz=np.nan, ivl_out_frz=np.nan))
        ticks.append(st)
    if len(ticks) < 10: return {"error": f"{date}: too few ticks"}
    tape = pd.DataFrame(ticks)
    tick_at = {t: j for j, t in enumerate(tape.tick)}

    # ── contacts ───────────────────────────────────────────────────────────────
    named = ["flip", "major", "cwall", "pwall", "coi_wall", "poi_wall", "ivu_in", "ivu_out", "ivl_in", "ivl_out", "ivu_in_frz", "ivu_out_frz", "ivl_in_frz", "ivl_out_frz"]
    rows = []; seen = set()
    for i in range(1, len(hms)):
        hm = hms[i]
        if hm < "09:41": continue
        prev_c = cl[i - 1]
        # state = last tick strictly before this minute
        prior = [t for t in tape.tick if t < hm]
        if not prior: continue
        st = tape.iloc[tick_at[prior[-1]]]
        F = float(st.F); E = float(st.E)
        cands = [("strike", float(K)) for K in range(int(np.floor(F * (1 - NEAR_PCT))), int(np.ceil(F * (1 + NEAR_PCT))) + 1)]
        cands += [(nm, float(st[nm])) for nm in named if np.isfinite(st[nm]) and abs(float(st[nm]) - F) <= F * BAND_PCT]
        for typ, K in cands:
            for side in ("support", "resistance"):
                key = (typ, round(K, 2), side)
                if key in seen: continue
                sup = side == "support"
                contact = (prev_c > K + CONTACT and lo[i] <= K + CONTACT) if sup else (prev_c < K - CONTACT and hi[i] >= K - CONTACT)
                if not contact: continue
                seen.add(key)
                mtc = 16 * 60 - (int(hm[:2]) * 60 + int(hm[3:]))
                if mtc < 15: continue
                la, ha, ca = lo[i:], hi[i:], cl[i:]
                fill = la < K if sup else ha > K
                rec = dict(date=date, hm=hm, tick=st.tick, ltype=typ, K=K, side=side, spot=F, E=E, dist_E=abs(K - F) / E, mins_to_close=mtc, filled=bool(fill.any()))
                if fill.any():
                    fi = int(np.argmax(fill)); la2, ha2, ca2 = la[fi:], ha[fi:], cl[i + fi:]
                    adverse = (K - la2) if sup else (ha2 - K); fav = (ha2 - K) if sup else (K - la2)
                    rec["fill_min"] = fi
                    rec["mae_close"] = float(adverse.max()) * MNQ
                    rec["mfe_close"] = float(fav.max()) * MNQ
                    rec["pnl_close"] = float((ca2[-1] - K) if sup else (K - ca2[-1])) * MNQ
                    for s_ in STOPS:
                        hit = adverse >= s_ / MNQ; si = int(np.argmax(hit)) if hit.any() else None
                        surv = si is None
                        mfe = float(fav[:si + 1].max()) * MNQ if si is not None else float(fav.max()) * MNQ
                        rec[f"surv{s_}"] = surv; rec[f"mfe{s_}"] = mfe; rec[f"tstop{s_}"] = si if si is not None else -1
                        rec[f"pnl{s_}"] = (-s_) if not surv else rec["pnl_close"]
                        for r_ in RUNS: rec[f"run{s_}_{r_}"] = bool(mfe >= r_) if surv else bool(float(fav[:si + 1].max()) * MNQ >= r_ and int(np.argmax(fav >= r_ / MNQ)) < si)
                        # trailing exit: once the run reaches R, trail a stop of S behind the best → pnl
                    # simple "let it run" realisation: stop S; after +40 move the stop to breakeven; exit at the close
                    for s_ in (10, 15, 20):
                        hit = adverse >= s_ / MNQ; si = int(np.argmax(hit)) if hit.any() else None
                        be = fav >= 40 / MNQ; bi_ = int(np.argmax(be)) if be.any() else None
                        if si is not None and (bi_ is None or si < bi_): pnl = -s_
                        elif bi_ is not None:
                            after = adverse[bi_:]; back = after >= 0  # touched entry again = breakeven
                            k2 = int(np.argmax(back)) if back.any() else None
                            pnl = 0.0 if k2 is not None else rec["pnl_close"]
                        else: pnl = rec["pnl_close"]
                        rec[f"be_pnl{s_}"] = pnl
                rows.append(rec)
    return {"tape": tape, "contacts": pd.DataFrame(rows)}


def files_for(years):
    out = []
    for y in years: out += sorted(glob.glob(os.path.join(S.SHARE, str(y), "greeks", "greeks_*.csv.gz")))
    return out


def add_deltas(tape):
    tape = tape.sort_values(["date", "tick"]).reset_index(drop=True)
    g = tape.groupby("date")
    for f in LEVEL_FIELDS + SUM_FIELDS + ["F", "top1"]:
        for n, lag in [("d5", 1), ("d15", 3), ("d30", 6), ("d60", 12)]:
            tape[f"{f}_{n}"] = tape[f] - g[f].shift(lag)
    # distances in E
    for f in LEVEL_FIELDS: tape[f"{f}_distE"] = (tape[f] - tape.F) / tape.E
    tape["hod_distE"] = (tape.hod - tape.F) / tape.E; tape["lod_distE"] = (tape.F - tape.lod) / tape.E; tape["open_distE"] = (tape.F - tape.day_open) / tape.E
    tape["ivwall_widthE"] = (tape.ivu_in - tape.ivl_in) / tape.E
    return tape


def main():
    years = [2022, 2023, 2024]
    if "--years" in sys.argv: years = [int(y) for y in sys.argv[sys.argv.index("--years") + 1].split(",")]
    smoke = "--smoke" in sys.argv
    files = files_for(years); files = files[:3] if smoke else files
    jobs = [(f, f"{os.path.basename(f)[7:11]}-{os.path.basename(f)[11:13]}-{os.path.basename(f)[13:15]}") for f in files]
    tapes, cons, errs = [], [], []
    it = map(run_day, jobs) if smoke else Pool(max(1, os.cpu_count() - 2)).imap_unordered(run_day, jobs, chunksize=2)
    for i, r in enumerate(it, 1):
        if "error" in r: errs.append(r["error"])
        else: tapes.append(r["tape"]); cons.append(r["contacts"])
        if i % 50 == 0 or i == len(jobs): print(f"  {i}/{len(jobs)} · {sum(len(x) for x in cons)} contacts", flush=True)
    tape = add_deltas(pd.concat(tapes, ignore_index=True)); con = pd.concat(cons, ignore_index=True)
    con = con.merge(tape.drop(columns=["F", "E"]), on=["date", "tick"], how="left")
    tag = "smoke" if smoke else "".join(str(y)[2:] for y in years)
    tape.to_parquet(os.path.join(OUT, f"state_tape_{tag}.parquet"), index=False); con.to_parquet(os.path.join(OUT, f"contacts_{tag}.parquet"), index=False)
    print("wrote", len(tape), "tape rows,", len(con), "contacts;", len(errs), "errors", errs[:3])


if __name__ == "__main__":
    main()
