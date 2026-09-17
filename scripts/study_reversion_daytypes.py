"""
REVERSION CONSISTENCIES — day types, ladder churn, level tenure, clustering, reaction size and
bracket sensitivity, on the ThetaData-derived 1-min 0DTE QQQ chains × NQ 1-min bars.

Pre-registered 2026-09-17, before any output was seen. Prompted by a live day (2026-09-17) where
every level carried an "OK" IV screen, the ladder re-drew every few minutes, 716 gave a 20-MNQ
reaction and then ran, and the day was bullish chop. Questions:
  Q1  Can the day TYPE be read by 10:30 (first-hour drive / range / IV change / gap / gamma
      sign / ladder churn), and do approaches AFTER 10:30 hold at different rates by type?
  Q2  Does LADDER CHURN matter — how often the top-|gex| strike in the ±1% band changes, and
      does a strike's TENURE as the top strike (minutes in the last 60) predict its hold?
  Q3  Does CLUSTERING matter — heavy strikes within ±0.5E of the level?
  Q4  REACTION SIZE — of filled approaches, how many react ≥10/20/30/40/60/80 MNQ before the
      40 stop, and given a 20-MNQ reaction, how often does the 80 follow (reflex-bounce share)?
  Q5  BRACKET SENSITIVITY — the same approaches graded on (stop,tp) ∈ {20/40, 40/40, 40/80,
      40/120, 60/120, 80/80, 80/160} MNQ, by IV state and side.
Protocol: 2022-23 IN-SAMPLE only. 2024 is the holdout and is touched ONCE, at the end, only
for a hypothesis that clears the bar in-sample (a ≥5-pt win-rate gap with n ≥ 300 per cell).
Approach definition, IV state, fills and grading are those of study_approach_2224.py /
study_0dte_alignment.py (trade-through fill, adverse-first, t-1 decision, RTH only).

    python scripts/study_reversion_daytypes.py            # 2022-23 → data/study/reversion_2223*.parquet
    python scripts/study_reversion_daytypes.py --years 2024  # holdout (once)
    python scripts/study_reversion_daytypes.py --report [--years 2024]
    python scripts/study_reversion_daytypes.py --smoke     # three days
"""
from __future__ import annotations
import glob, os, sys
from multiprocessing import Pool
import numpy as np, pandas as pd
try: sys.stdout.reconfigure(encoding="utf-8")
except Exception: pass
sys.path.insert(0, os.path.dirname(__file__))
import study_0dte_alignment as S

IV_WIN, IV_THR, PEAK_WIN, NEAR_PCT, CONTACT = 30, 0.01, 60, 0.01, 0.5
MNQ = S.MNQ_PER_QQQ
BRACKETS = [(20, 40), (40, 40), (40, 80), (40, 120), (60, 120), (80, 80), (80, 160)]
REACT_LEVELS = [10, 20, 30, 40, 60, 80]
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "study")


def prior_close_nq(date):
    """The prior RTH session's 15:59 NQ close (the NQ frame is RTH-only, 2022-24)."""
    S.nq_for(date)
    d = S._NQ; prev = d[d["day"] < date]
    return float(prev["close"].iloc[-1]) if len(prev) else np.nan


def run_day(args):
    path, date = args
    try: return _run_day(path, date)
    except Exception as e: return {"error": f"{date}: {type(e).__name__}: {e}"}


def _run_day(path, date):
    nq = S.nq_for(date)
    if nq is None: return {"error": f"{date}: no bars"}
    g = pd.read_csv(path, usecols=["minute", "strike", "side", "oi", "F", "T", "iv", "gex"]).dropna(subset=["iv", "F", "T"])
    g = g[g["T"] > 0]; g["strike"] = S.fix_strike_offset(g["strike"].to_numpy(float))
    if g.empty: return {"error": f"{date}: empty"}
    fwd = g.groupby("minute")["F"].first(); Tm = g.groupby("minute")["T"].first(); minutes = list(fwd.index)
    atm = g.assign(dk=(g["strike"] - g["F"]).abs()).sort_values("dk").groupby("minute")["iv"].first().reindex(minutes)
    oi_c = g[g.side == "C"].groupby("strike")["oi"].first(); oi_p = g[g.side == "P"].groupby("strike")["oi"].first()
    piv = g.pivot_table(index="minute", columns="strike", values="gex", aggfunc="sum").reindex(minutes).fillna(0.0)
    strikes = piv.columns.to_numpy(float); G = piv.to_numpy()

    # per-minute top-|gex| strike and top-3 set inside ±1% of F
    top1, top3 = [], []
    for i, m in enumerate(minutes):
        F = fwd[m]; band = np.abs(strikes - F) <= F * NEAR_PCT
        if band.sum() == 0: top1.append(np.nan); top3.append(set()); continue
        a = np.where(band, np.abs(G[i]), -1.0); order = np.argsort(-a)
        top1.append(float(strikes[order[0]])); top3.append(set(float(strikes[j]) for j in order[:3] if a[j] > 0))
    top1 = np.array(top1)

    # NQ → QQQ bars, ratio from bars BEFORE each minute
    nq = nq.set_index("hm"); common = [m for m in minutes if m in nq.index]
    rr = pd.Series({m: nq.at[m, "close"] / fwd[m] for m in common})
    ratio = rr.rolling(S.RATIO_WINDOW, min_periods=3).median().shift(1); ratio = ratio.fillna(rr.expanding().median().shift(1)).bfill()
    bars = pd.DataFrame({"hm": common, "lo": [nq.at[m, "low"] / ratio[m] for m in common], "hi": [nq.at[m, "high"] / ratio[m] for m in common],
                         "cl": [nq.at[m, "close"] / ratio[m] for m in common], "op": [nq.at[m, "open"] / ratio[m] for m in common]}).set_index("hm")
    hms = list(bars.index); lo, hi, cl = bars.lo.to_numpy(), bars.hi.to_numpy(), bars.cl.to_numpy()
    idx = {m: i for i, m in enumerate(minutes)}
    mins_to_close = {hm: 16 * 60 - (int(hm[:2]) * 60 + int(hm[3:])) for hm in minutes}

    # ── day features known by 10:30 ──────────────────────────────────────────────
    m0 = minutes[0]; S0 = float(fwd[m0]); sig0 = float(atm[m0]); T0 = float(Tm[m0])
    E0 = S0 * sig0 * np.sqrt(T0)
    if not (E0 > 0): return {"error": f"{date}: bad E0"}
    def F_at(hm, default=np.nan):
        return float(fwd[hm]) if hm in fwd.index else default
    F1030 = F_at("10:30"); a1030 = float(atm.get("10:30", np.nan))
    h1 = [i for i, h in enumerate(hms) if h <= "10:30"]
    drive1h = (F1030 - S0) / E0 if np.isfinite(F1030) else np.nan
    range1h = (hi[h1].max() - lo[h1].min()) / E0 if h1 else np.nan
    iv_1h = a1030 - sig0 if np.isfinite(a1030) else np.nan
    prior_close = prior_close_nq(date)
    gap_E = ((nq.at[hms[0], "open"] - prior_close) / ratio[hms[0]]) / E0 if np.isfinite(prior_close) else np.nan
    i1030 = idx.get("10:30", min(59, len(minutes) - 1))
    churn1h = int(np.sum(top1[1:i1030 + 1] != top1[:i1030])) if i1030 > 1 else 0
    churn_day = int(np.sum(top1[1:] != top1[:-1]))
    # median run length of the top strike over the day
    runs, r = [], 1
    for i in range(1, len(top1)):
        if top1[i] == top1[i - 1]: r += 1
        else: runs.append(r); r = 1
    runs.append(r)
    # cluster + gamma sign at 10:00
    m10 = "10:00" if "10:00" in idx else minutes[min(29, len(minutes) - 1)]
    F10 = float(fwd[m10]); i10 = idx[m10]
    band10 = [k for k in strikes if abs(k - F10) <= F10 * NEAR_PCT]
    medp = float(oi_p.reindex(band10).median()) if band10 else np.nan; medc = float(oi_c.reindex(band10).median()) if band10 else np.nan
    def heavy_strike(k):
        return (k in top3[i10]) or (medp and float(oi_p.get(k, 0)) >= 2 * medp) or (medc and float(oi_c.get(k, 0)) >= 2 * medc)
    E10 = F10 * float(atm[m10]) * np.sqrt(float(Tm[m10]))
    heavy10 = sorted(k for k in band10 if heavy_strike(k))
    cluster10 = int(sum(1 for k in heavy10 if abs(k - F10) <= 0.5 * E10))
    spacing10 = float(np.median(np.diff(heavy10)) / E10) if len(heavy10) >= 2 and E10 > 0 else np.nan
    band2 = np.abs(strikes - F10) <= F10 * 0.02
    neg_regime = bool(G[i10][band2].sum() < 0)
    # ex-post day outcome
    close_F = float(fwd.iloc[-1]); chg_E = (close_F - S0) / E0; range_E = (hi.max() - lo.min()) / E0
    day = dict(date=date, S0=S0, E0=E0, sig0=sig0, open_atm=sig0, close_atm=float(atm.iloc[-1]), drive1h=drive1h, range1h=range1h, iv_1h=iv_1h,
               gap_E=gap_E, churn1h=churn1h, churn_day=churn_day, top_run_med=float(np.median(runs)), cluster10=cluster10, spacing10=spacing10,
               n_heavy10=len(heavy10), neg_regime=neg_regime, chg_E=chg_E, range_E=range_E, n_min=len(minutes))

    # ── approaches after 10:30 ───────────────────────────────────────────────────
    def iv_state(hm):
        i = idx.get(hm)
        if i is None or i < 2: return None
        now, prev = atm.iloc[i], atm.iloc[max(0, i - IV_WIN)]
        peak = atm.iloc[max(0, i - PEAK_WIN):i + 1].max()
        if not (np.isfinite(now) and np.isfinite(prev)): return None
        d = now - prev
        return dict(atm_iv=now, d_iv=d, cls="rising" if d > IV_THR else "falling" if d < -IV_THR else "flat", rolled=(peak - now) > IV_THR)
    rows = []; seen = set()
    for i in range(1, len(hms)):
        hm = hms[i]
        if hm <= "10:30": continue
        Sp = float(fwd.get(hm, np.nan))
        if not np.isfinite(Sp): continue
        prev_c = cl[i - 1]; j = idx[hm]; jm1 = max(0, j - 1)
        Et = Sp * float(atm.iloc[jm1]) * np.sqrt(float(Tm.iloc[jm1]))
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
                # tenure / churn over the prior 60 minutes (t-60 .. t-1)
                w0 = max(0, jm1 - 59); wt1 = top1[w0:jm1 + 1]
                tenure1 = int(np.sum(wt1 == K)); tenure3 = int(sum(1 for q in range(w0, jm1 + 1) if K in top3[q]))
                churn60 = int(np.sum(wt1[1:] != wt1[:-1])) if len(wt1) > 1 else 0
                is_top1 = bool(top1[jm1] == K); is_top3 = bool(K in top3[jm1])
                # cluster around K at t-1 (heavy = top3 now or defending OI ≥ 2× band median)
                bandK = [k for k in strikes if abs(k - Sp) <= Sp * NEAR_PCT and k != K]
                def hv(k):
                    return (k in top3[jm1]) or (medp and float(oi_p.get(k, 0)) >= 2 * medp) or (medc and float(oi_c.get(k, 0)) >= 2 * medc)
                heavyN = [k for k in bandK if hv(k)]
                n_heavy_half = int(sum(1 for k in heavyN if abs(k - K) <= 0.5 * Et)) if Et > 0 else 0
                near_heavy_E = float(min(abs(k - K) for k in heavyN) / Et) if heavyN and Et > 0 else np.nan
                doi = float(oi_p.get(K, 0)) if sup else float(oi_c.get(K, 0)); dmed = medp if sup else medc
                # reaction before the 40 stop (tp = huge) → mfe in MNQ
                st_r, _, fi, _, mfe = S.grade(la, ha, ca, sup, K, 40 / MNQ, 1e9)
                filled = fi >= 0
                rec = dict(date=date, hm=hm, K=K, side=side, spot=Sp, E=Et, dist_E=abs(K - Sp) / Et if Et > 0 else np.nan, mins_to_close=mtc,
                           tenure1=tenure1, tenure3=tenure3, churn60=churn60, is_top1=is_top1, is_top3=is_top3,
                           n_heavy_half=n_heavy_half, near_heavy_E=near_heavy_E, heavy=bool(dmed and doi >= 2 * dmed), oi_x=doi / dmed if dmed else np.nan,
                           filled=filled, react_mnq=mfe * MNQ if filled else np.nan, react_status=st_r, **st)
                for stp, tp in BRACKETS:
                    s_, p_, _, res, _ = S.grade(la, ha, ca, sup, K, stp / MNQ, tp / MNQ)
                    rec[f"s{stp}_{tp}"] = s_; rec[f"p{stp}_{tp}"] = p_ * MNQ; rec[f"r{stp}_{tp}"] = res
                rows.append(rec)
    return {"rows": rows, "day": day}


def files_for(years):
    out = []
    for y in years:
        out += sorted(glob.glob(os.path.join(S.SHARE, str(y), "greeks", "greeks_*.csv.gz")))
    return out


def tag_for(years):
    return "2223" if years == [2022, 2023] else "".join(str(y) for y in years)


def run(years, smoke=False):
    files = files_for(years)
    if smoke: files = files[:3]
    jobs = [(f, f"{os.path.basename(f)[7:11]}-{os.path.basename(f)[11:13]}-{os.path.basename(f)[13:15]}") for f in files]
    frames, days, errs = [], [], []
    if smoke:
        for j in jobs:
            r = run_day(j)
            if "error" in r: errs.append(r["error"])
            else: frames.append(pd.DataFrame(r["rows"])); days.append(r["day"])
    else:
        with Pool(max(1, os.cpu_count() - 2)) as pool:
            for i, r in enumerate(pool.imap_unordered(run_day, jobs, chunksize=2), 1):
                if "error" in r: errs.append(r["error"])
                else: frames.append(pd.DataFrame(r["rows"])); days.append(r["day"])
                if i % 50 == 0 or i == len(jobs): print(f"  {i}/{len(jobs)} · {sum(len(x) for x in frames)} approaches", flush=True)
    tag = "smoke" if smoke else tag_for(years)
    df = pd.concat(frames, ignore_index=True); dd = pd.DataFrame(days).sort_values("date").reset_index(drop=True)
    # prior-session close IV → open IV gap (trading-day order)
    dd["prev_close_atm"] = dd["close_atm"].shift(1); dd["iv_gap"] = dd["open_atm"] - dd["prev_close_atm"]
    df.to_parquet(os.path.join(OUT, f"reversion_{tag}.parquet"), index=False); dd.to_parquet(os.path.join(OUT, f"reversion_days_{tag}.parquet"), index=False)
    print("wrote", len(df), "approaches,", len(dd), "days;", len(errs), "errors", errs[:3])


# ── report ───────────────────────────────────────────────────────────────────────
def wilson(k, n, z=1.96):
    if n == 0: return (np.nan, np.nan)
    p = k / n; d = 1 + z * z / n; c = p + z * z / (2 * n); s = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return ((c - s) / d, (c + s) / d)


def table(df, by, col="s40_80", pcol="p40_80", title="", min_n=1):
    print(f"\n### {title}" if title else "")
    print(f"{'group':>34} {'n':>6} {'fill%':>6} {'win|res%':>9} {'ci':>8} {'MNQ/fill':>9}")
    for key, grp in df.groupby(by, dropna=False, observed=True):
        n = len(grp); filled = grp[grp[col] != "no_fill"]
        res = filled[filled[col].isin(["win", "stopped"])]
        w = int((res[col] == "win").sum()); wr = 100 * w / len(res) if len(res) else np.nan
        lo_, hi_ = wilson(w, len(res)); mnq = filled[pcol].mean() if len(filled) else np.nan
        if n < min_n: continue
        k = " · ".join(str(x) for x in key) if isinstance(key, tuple) else str(key)
        print(f"{k:>34} {n:6d} {100 * len(filled) / n if n else 0:6.1f} {wr:9.1f} {100 * lo_:4.0f}-{100 * hi_:<3.0f} {mnq:9.1f}")


def report(years, tag=None):
    tag = tag or tag_for(years)
    df = pd.read_parquet(os.path.join(OUT, f"reversion_{tag}.parquet")); dd = pd.read_parquet(os.path.join(OUT, f"reversion_days_{tag}.parquet"))
    df = df.merge(dd[["date", "drive1h", "range1h", "iv_1h", "iv_gap", "gap_E", "churn1h", "cluster10", "spacing10", "neg_regime", "chg_E", "range_E", "top_run_med"]], on="date", how="left")
    print(f"# REVERSION CONSISTENCIES — {tag}: {len(dd)} days, {len(df)} first approaches after 10:30 (whole strikes within ±1%)")
    print("bracket 40/80 MNQ unless stated · trade-through fill · adverse-first · decision at t-1 · win|res = wins / (wins+stops)")
    df["drive_b"] = pd.cut(df.drive1h.abs(), [-0.01, 0.25, 0.5, 0.8, 99], labels=["<0.25E", "0.25-0.5", "0.5-0.8", ">0.8E"])
    df["with_drive"] = np.where(df.drive1h > 0, df.side == "support", df.side == "resistance")
    df["range_b"] = pd.cut(df.range1h, [0, 0.5, 0.8, 1.2, 99], labels=["<0.5E", "0.5-0.8", "0.8-1.2", ">1.2E"])
    df["ivgap_b"] = pd.cut(df.iv_gap, [-9, -0.02, -0.005, 0.005, 0.02, 9], labels=["<-2vp", "-2..-.5", "flat", "+.5..2", ">+2vp"])
    df["iv1h_b"] = pd.cut(df.iv_1h, [-9, -0.01, 0.01, 9], labels=["fell>1", "flat", "rose>1"])
    df["gap_b"] = pd.cut(df.gap_E.abs(), [-0.01, 0.25, 0.75, 99], labels=["<0.25E", "0.25-0.75", ">0.75E"])
    df["churn1h_b"] = pd.cut(df.churn1h, [-1, 3, 8, 15, 999], labels=["0-3", "4-8", "9-15", "16+"])
    df["churn60_b"] = pd.cut(df.churn60, [-1, 2, 6, 12, 999], labels=["0-2", "3-6", "7-12", "13+"])
    df["tenure1_b"] = pd.cut(df.tenure1, [-1, 0, 9, 29, 60], labels=["0", "1-9", "10-29", "30-60"])
    df["tenure3_b"] = pd.cut(df.tenure3, [-1, 0, 19, 44, 60], labels=["0", "1-19", "20-44", "45-60"])
    df["heavyhalf_b"] = pd.cut(df.n_heavy_half, [-1, 0, 1, 99], labels=["0", "1", "2+"])
    df["nearheavy_b"] = pd.cut(df.near_heavy_E, [-0.01, 0.25, 0.5, 1.0, 99], labels=["<0.25E", "0.25-0.5", "0.5-1", ">1E"])
    df["cluster10_b"] = pd.cut(df.cluster10, [-1, 1, 3, 99], labels=["0-1", "2-3", "4+"])
    df["dist_b"] = pd.cut(df.dist_E, [-0.01, 0.1, 0.3, 0.6, 99], labels=["<0.1E", "0.1-0.3", "0.3-0.6", ">0.6E"])
    df["tod"] = pd.cut(df.mins_to_close, [0, 90, 240, 999], labels=["<90 left", "90-240", ">240"])
    df["chop"] = (df.range_E <= 1.0) & (df.chg_E.abs() <= 0.5)

    print("\n## Q0 population")
    table(df, ["cls"], title="by IV state (replication of the approach test, after 10:30 only)")
    table(df, ["side", "cls"], title="side × IV state")

    print("\n## Q1 DAY TYPE (features fixed at 10:30; approaches after 10:30)")
    table(df, ["drive_b"], title="first-hour |drive| in E0")
    table(df, ["drive_b", "with_drive"], title="|drive| × approach WITH the drive (support on an up-drive day) vs AGAINST", min_n=100)
    table(df, ["range_b"], title="first-hour range in E0 (compression → expansion)")
    table(df, ["range_b", "side"], title="first-hour range × side", min_n=100)
    table(df, ["ivgap_b"], title="IV at the open vs the prior close (vol pts)")
    table(df, ["iv1h_b"], title="ATM IV change over the first hour")
    table(df, ["iv1h_b", "side"], title="first-hour IV change × side", min_n=100)
    table(df, ["gap_b"], title="overnight gap |open − prior close| in E0")
    table(df, ["neg_regime"], title="0DTE net gamma sign at 10:00 (True = negative)")
    table(df, ["churn1h_b"], title="ladder churn in the first hour (top-|gex| strike changes)")
    table(df, ["cluster10_b"], title="heavy strikes within ±0.5E of spot at 10:00")
    table(df, ["chop"], title="EX-POST day was chop (range ≤ 1E and |close−open| ≤ 0.5E) — not tradeable, for reference")
    # can chop be predicted by 10:30?
    print("\n### P(ex-post chop day) by 10:30 features (days)")
    dd["chop"] = (dd.range_E <= 1.0) & (dd.chg_E.abs() <= 0.5)
    for c, bins, labels in [("drive1h", [-0.01, 0.25, 0.5, 0.8, 99], ["<0.25E", "0.25-0.5", "0.5-0.8", ">0.8E"]), ("range1h", [0, 0.5, 0.8, 1.2, 99], ["<0.5E", "0.5-0.8", "0.8-1.2", ">1.2E"]),
                            ("iv_1h", [-9, -0.01, 0.01, 9], ["fell>1", "flat", "rose>1"]), ("churn1h", [-1, 3, 8, 15, 999], ["0-3", "4-8", "9-15", "16+"]), ("cluster10", [-1, 1, 3, 99], ["0-1", "2-3", "4+"])]:
        v = dd[c].abs() if c == "drive1h" else dd[c]
        b = pd.cut(v, bins, labels=labels)
        print(f"  {c:>10}: " + " · ".join(f"{lab} {100 * dd.chop[b == lab].mean():.0f}% (n={int((b == lab).sum())})" for lab in labels) + f" · base {100 * dd.chop.mean():.0f}%")

    print("\n## Q2 LADDER CHURN + TENURE (the top-|gex| strike inside ±1%, prior 60 min)")
    print(f"  top strike changes per day: median {dd.churn_day.median():.0f} (IQR {dd.churn_day.quantile(.25):.0f}-{dd.churn_day.quantile(.75):.0f}) over ~390 min · median run length {dd.top_run_med.median():.0f} min · first-hour changes median {dd.churn1h.median():.0f}")
    table(df, ["is_top1"], title="level IS the top-|gex| strike at t-1")
    table(df, ["is_top3"], title="level is in the top-3 at t-1")
    table(df, ["tenure1_b"], title="tenure as top-1 in the last 60 min")
    table(df, ["tenure3_b"], title="tenure in top-3 in the last 60 min")
    table(df, ["churn60_b"], title="ladder churn in the last 60 min (all approaches)")
    table(df, ["churn60_b", "cls"], title="churn × IV state", min_n=100)
    table(df, ["tenure3_b", "cls"], title="tenure3 × IV state", min_n=100)

    print("\n## Q3 CLUSTERING at the level (t-1)")
    table(df, ["heavyhalf_b"], title="other heavy strikes within ±0.5E of the level")
    table(df, ["nearheavy_b"], title="distance to the nearest other heavy strike")
    table(df, ["heavyhalf_b", "side"], title="cluster × side", min_n=100)
    table(df, ["dist_b"], title="distance from spot at t-1 (E)")

    print("\n## Q4 REACTION SIZE (filled approaches; reaction = max favourable excursion before the 40-MNQ stop)")
    f = df[df.filled]
    print(f"  filled {len(f)} of {len(df)} ({100 * len(f) / len(df):.0f}%)")
    for grp_name, grp in [("all", f)] + [(c, f[f.cls == c]) for c in ["rising", "flat", "falling"]] + [(s, f[f.side == s]) for s in ["support", "resistance"]]:
        print(f"  {grp_name:>10} (n={len(grp)}): " + " · ".join(f"≥{lv}: {100 * (grp.react_mnq >= lv).mean():.0f}%" for lv in REACT_LEVELS))
    r20 = f[f.react_mnq >= 20]
    print(f"  given a ≥20-MNQ reaction (n={len(r20)}): reached 40 {100 * (r20.react_mnq >= 40).mean():.0f}% · reached 80 (win on 40/80) {100 * (r20.s40_80 == 'win').mean():.0f}% · stopped after it {100 * (r20.s40_80 == 'stopped').mean():.0f}%")
    r40 = f[f.react_mnq >= 40]
    print(f"  given a ≥40-MNQ reaction (n={len(r40)}): reached 80 {100 * (r40.s40_80 == 'win').mean():.0f}% · stopped after it {100 * (r40.s40_80 == 'stopped').mean():.0f}%")

    print("\n## Q5 BRACKET SENSITIVITY (same approaches, stop/target in MNQ; BE = stop/(stop+tp))")
    print(f"{'bracket':>10} {'BE%':>5} | " + " | ".join(f"{c:>22}" for c in ["all", "rising", "flat", "falling", "support", "resistance"]))
    for stp, tp in BRACKETS:
        col, pcol = f"s{stp}_{tp}", f"p{stp}_{tp}"
        cells = []
        for grp in [df, df[df.cls == "rising"], df[df.cls == "flat"], df[df.cls == "falling"], df[df.side == "support"], df[df.side == "resistance"]]:
            fl = grp[grp[col] != "no_fill"]; res = fl[fl[col].isin(["win", "stopped"])]
            wr = 100 * (res[col] == "win").mean() if len(res) else np.nan; mnq = fl[pcol].mean() if len(fl) else np.nan
            cells.append(f"{wr:5.1f}% {mnq:+6.1f} n={len(fl):<5d}")
        print(f"{stp:>4}/{tp:<5} {100 * stp / (stp + tp):5.1f} | " + " | ".join(f"{c:>22}" for c in cells))
    print("\n  median minutes to resolution on 40/80 (resolved only): " + " · ".join(f"{c}: {df[(df.cls == c) & df.s40_80.isin(['win', 'stopped'])].r40_80.median():.0f}" for c in ["rising", "flat", "falling"]))


if __name__ == "__main__":
    years = [2022, 2023]
    if "--years" in sys.argv: years = [int(y) for y in sys.argv[sys.argv.index("--years") + 1].split(",")]
    if "--report" in sys.argv: report(years, tag="smoke" if "--smoke" in sys.argv else None)
    else: run(years, smoke="--smoke" in sys.argv)
