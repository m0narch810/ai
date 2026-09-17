"""
0DTE ALIGNMENT STUDY — does greek alignment at a strike predict a held reversal?

Data (all local, none of it touched by the live pipeline):
  * Downloads/shareddata/qqq_share/<yyyy>/greeks/greeks_<date>.csv.gz — ThetaData-derived 0DTE QQQ
    chain, one row per minute x strike x side: bid/ask/mid, OI, forward F (= spot S), T (minutes
    to 16:00 / 525600 — the desk's own 0DTE convention), IV, delta, gamma, vega, gex.
    Verified 2026-09-16: delta/gamma/gex reproduce forward-Black with r=0 exactly.
  * Downloads/thepeak/hdata/NQ_1m_ET.parquet — NQ front-month 1-min OHLC in ET. Converted to
    QQQ terms bar by bar with a rolling median NQ/F ratio so the outcome is graded on REAL wicks
    (the forward is mid-derived and has none) in the instrument the trader actually holds.

Method — MATCHES THE DESK'S OWN COMPUTATION (the point of the exercise):
  * Alignment classes are a line-for-line port of `evaluateStrike` in src/score.ts (passes 1-3
    + the ordinal prob table). Pass 4 (live evidence) is empty: the share has no volume, no
    day-over-day OI, no premium. Tenor durability is trivially true (0DTE only) and every strike
    is a "0DTE Pin" by construction, so those two never discriminate here.
  * Charm and vanna are computed from the file's own IV/F/T with the same model, then turned into
    DEALER HEDGING FLOW with the sign convention the scorer's truth tables read:
      positive charm  = decay pushes dealers to BUY into the close
      positive vanna  = FALLING IV pushes dealers to BUY
    under the standard dealer-long-calls / short-puts assumption that the share's gex uses.
  * Outcomes are a port of `gradeTradeCall` in src/detect.ts: fill requires trading THROUGH the
    strike, adverse side checked first inside every bar, strictly sequential from the fill,
    the order dies at the close (flat_close). Two bracket specs are graded on every call:
      A  the trader's real bracket: 40 / 80 MNQ pts = 0.983 / 1.966 QQQ pts, fill tol 0.15 pts
      B  the same bracket scaled by spot/700 — the era-normalised control the design rules
         require (a fixed point bracket is 2.5x larger relative to price in 2022 than in 2026)
  * Controls: every real call gets two DISPLACED PLACEBO TWINS carrying the same labels, at the
    strike moved 0.25E toward spot and 0.25E away (E = S * sigma_atm * sqrt(T_remaining)). If the
    edge is about the strike, the twins regress to the population base rate.
  * Decision ticks every 15 minutes 09:45-15:30 (the desk cadence). The PRIMARY sample is each
    (day, strike, side)'s FIRST tick in the band; all ticks are kept for a secondary view.

No parameter here was chosen by looking at outcomes. Analysis + holdout split live in
study_0dte_alignment_report.py (in-sample 2022-2023, holdout 2024 touched once).

Usage:  python scripts/study_0dte_alignment.py [--days N] [--workers K] [--out data/study]
"""
from __future__ import annotations

import argparse
import glob
import os
import sys
from multiprocessing import Pool

import numpy as np
import pandas as pd
from scipy.stats import norm

SHARE = r"C:\Users\asare\Downloads\shareddata\qqq_share"
NQ_BARS = r"C:\Users\asare\Downloads\thepeak\hdata\NQ_1m_ET.parquet"

# ── desk constants (src/config.ts) ──────────────────────────────────────────────
MNQ_PER_QQQ = 40.7
STOP_PTS = 40 / MNQ_PER_QQQ        # 0.983 QQQ pts  (hardStopPts)
TP_PTS = 80 / MNQ_PER_QQQ          # 1.966 QQQ pts  (callTpPts)
FILL_TOL = 0.15                    # fillTolPts
NEAR_BAND_PCT = 0.010              # nearSpotBandPct
REF_SPOT = 700.0                   # spec B scales the bracket by S / REF_SPOT

TICKS = [f"{h:02d}:{m:02d}" for h in range(9, 16) for m in (0, 15, 30, 45) if (h, m) >= (9, 45) and (h, m) <= (15, 30)]
IV_DIR_LOOKBACK_MIN = 30
IV_DIR_THRESH = 0.015              # 1.5 vol pts over 30 min → RISING / FALLING, else STABLE
RATIO_WINDOW = 30
PLACEBO_E = 0.25


# ── black (forward, r = 0), the model the share's greeks come from ────────────────
def black_greeks(F, K, T, sig):
    sqT = np.sqrt(T)
    d1 = (np.log(F / K) + 0.5 * sig * sig * T) / (sig * sqT)
    d2 = d1 - sig * sqT
    pdf = norm.pdf(d1)
    delta_c = norm.cdf(d1)
    vega = F * pdf * sqT                      # per 1.00 vol
    # dDelta/dt as CALENDAR time passes (= -dDelta/dT); same for calls and puts
    charm = pdf * d2 / (2.0 * T)              # per year
    vanna = -pdf * d2 / sig                   # dDelta/dSigma, per 1.00 vol; same for calls and puts
    return delta_c, vega, charm, vanna


def fix_strike_offset(strikes: np.ndarray) -> np.ndarray:
    """Some days carry every strike shifted by a constant (e.g. 395.78 for 396) — undo it."""
    frac = strikes - np.round(strikes)
    med = np.median(frac)
    if 0.05 < abs(med) < 0.45 and np.std(frac) < 0.02:
        return np.round(strikes - med, 2)
    return strikes


def is_round(k: float) -> bool:
    return abs(k - round(k)) < 1e-6 and round(k) % 5 == 0


# ── grader: port of gradeTradeCall (src/detect.ts) ────────────────────────────────
def grade(lo, hi, cl, side_long: bool, K: float, stop: float, tp: float):
    """Returns (status, pnl_pts, fill_idx, minutes_to_resolve, mfe)."""
    fill = lo < K if side_long else hi > K
    if not fill.any():
        return "no_fill", 0.0, -1, -1, 0.0
    fi = int(np.argmax(fill))
    lo, hi, cl = lo[fi:], hi[fi:], cl[fi:]
    adverse = (K - lo) if side_long else (hi - K)
    fav = (hi - K) if side_long else (K - lo)
    s_hit = adverse >= stop
    t_hit = fav >= tp
    si = int(np.argmax(s_hit)) if s_hit.any() else None
    ti = int(np.argmax(t_hit)) if t_hit.any() else None
    if si is not None and (ti is None or si <= ti):       # adverse first inside the bar
        mfe = float(fav[:si + 1].max()) if si >= 0 else 0.0
        return "stopped", -stop, fi, si, mfe
    if ti is not None:
        return "win", tp, fi, ti, float(fav[:ti + 1].max())
    pnl = float(cl[-1] - K) if side_long else float(K - cl[-1])
    return "flat_close", pnl, fi, len(lo) - 1, float(fav.max())


# ── one day ──────────────────────────────────────────────────────────────────────
def run_day(args):
    path, date = args
    try:
        return _run_day(path, date)
    except Exception as e:  # keep the pool alive; report the day
        return {"error": f"{date}: {type(e).__name__}: {e}"}


_NQ = None
def nq_for(date: str) -> pd.DataFrame | None:
    global _NQ
    if _NQ is None:
        d = pd.read_parquet(NQ_BARS, columns=["date", "open", "high", "low", "close"])
        d = d[(d["date"] >= "2021-12-31") & (d["date"] < "2025-01-02")]
        d["day"] = d["date"].dt.strftime("%Y-%m-%d")
        d["hm"] = d["date"].dt.strftime("%H:%M")
        _NQ = d[(d["hm"] >= "09:30") & (d["hm"] <= "15:59")]
    x = _NQ[_NQ["day"] == date]
    return x if len(x) >= 300 else None


def _run_day(path: str, date: str):
    nq = nq_for(date)
    if nq is None:
        return {"error": f"{date}: no NQ RTH bars"}
    g = pd.read_csv(path, usecols=["minute", "strike", "side", "oi", "F", "T", "iv", "delta", "vega", "gex"])
    g = g.dropna(subset=["iv", "F", "T"])
    g["strike"] = fix_strike_offset(g["strike"].to_numpy(dtype=float))
    g = g[g["T"] > 0]
    if g.empty:
        return {"error": f"{date}: empty"}

    # per-minute forward + ATM iv (for E and the IV direction)
    fwd = g.groupby("minute")["F"].first()
    Tm = g.groupby("minute")["T"].first()
    atm_iv = g.assign(dk=(g["strike"] - g["F"]).abs()).sort_values("dk").groupby("minute")["iv"].first()
    minutes = list(fwd.index)

    # NQ → QQQ-equivalent bars via a rolling median ratio that uses only bars BEFORE each minute
    nq = nq.set_index("hm")
    common = [m for m in minutes if m in nq.index]
    ratio_raw = pd.Series({m: nq.at[m, "close"] / fwd[m] for m in common})
    ratio = ratio_raw.rolling(RATIO_WINDOW, min_periods=3).median().shift(1)
    ratio = ratio.fillna(ratio_raw.expanding().median().shift(1)).bfill()
    bars = pd.DataFrame({
        "hm": common,
        "lo": [nq.at[m, "low"] / ratio[m] for m in common],
        "hi": [nq.at[m, "high"] / ratio[m] for m in common],
        "cl": [nq.at[m, "close"] / ratio[m] for m in common],
    }).set_index("hm")

    # per-strike ladders per minute: net gex / vex / dex / charm flow / vanna flow
    dc, vega, charm, vanna = black_greeks(g["F"].to_numpy(), g["strike"].to_numpy(), g["T"].to_numpy(), g["iv"].to_numpy())
    is_c = (g["side"] == "C").to_numpy()
    sgn = np.where(is_c, 1.0, -1.0)
    oi = g["oi"].to_numpy(dtype=float)
    delta = np.where(is_c, dc, dc - 1.0)
    g["gex_s"] = g["gex"].to_numpy()                          # share convention: calls +, puts −
    g["vex_s"] = sgn * oi * 100.0 * vega                       # dealer vega, calls +, puts −
    g["dex_s"] = sgn * oi * 100.0 * delta                      # dealer delta (long calls, short puts)
    g["charm_flow"] = -sgn * oi * 100.0 * charm                # + = dealers must BUY as time passes
    g["vanna_flow"] = sgn * oi * 100.0 * vanna                 # + = FALLING IV makes dealers BUY
    g["oi_c"] = np.where(is_c, oi, 0.0)
    g["oi_p"] = np.where(is_c, 0.0, oi)
    lad = g.groupby(["minute", "strike"])[["gex_s", "vex_s", "dex_s", "charm_flow", "vanna_flow", "oi_c", "oi_p"]].sum()

    rows = []
    seen = set()
    for tick in TICKS:
        if tick not in lad.index.get_level_values(0) or tick not in bars.index:
            continue
        L = lad.loc[tick]
        S = float(fwd[tick]); T = float(Tm[tick]); siv = float(atm_iv[tick])
        E = S * siv * np.sqrt(T)
        # IV direction: ATM IV now vs 30 minutes ago
        i = minutes.index(tick)
        prev = minutes[max(0, i - IV_DIR_LOOKBACK_MIN)]
        d_iv = siv - float(atm_iv[prev])
        iv_dir = "RISING" if d_iv >= IV_DIR_THRESH else "FALLING" if d_iv <= -IV_DIR_THRESH else "STABLE"

        band = L[(L.index >= S * (1 - NEAR_BAND_PCT)) & (L.index <= S * (1 + NEAR_BAND_PCT)) & ((L["oi_c"] + L["oi_p"]) > 0)]
        if len(band) < 4:
            continue
        gex = band["gex_s"]; oi_t = band["oi_c"] + band["oi_p"]
        # bandStats: |exposure| medians / maxima across the band (the scale-free yardstick)
        st = dict(maxGex=max(1.0, gex.abs().max()), medGex=gex.abs().median(), maxOi=max(1.0, oi_t.max()), medOi=oi_t.median(),
                  medCharm=band["charm_flow"].abs().median(), medVanna=band["vanna_flow"].abs().median(),
                  medDex=band["dex_s"].abs().median(), medVex=band["vex_s"].abs().median())
        # named sets from the 0DTE ladder itself
        major = float(gex.abs().idxmax())
        above, below = gex[gex.index > S], gex[gex.index < S]
        call_wall = float(above.idxmax()) if len(above) and above.max() > 0 else None
        put_wall = float(below.idxmin()) if len(below) and below.min() < 0 else None
        call_walls = set(above[above > 0].nlargest(3).index.astype(float)) if len(above) else set()
        put_walls = set(below[below < 0].nsmallest(3).index.astype(float)) if len(below) else set()
        cum = gex.sort_index().cumsum()
        flip = None
        prev_c = 0.0
        for k, v in cum.items():
            if prev_c != 0 and np.sign(v) != np.sign(prev_c):
                flip = float(k); break
            prev_c = v
        neg_regime = float(gex.sum()) < 0
        bars_after = bars[bars.index > tick]
        if len(bars_after) < 2:
            continue
        lo, hi, cl = bars_after["lo"].to_numpy(), bars_after["hi"].to_numpy(), bars_after["cl"].to_numpy()

        for k, r in band.iterrows():
            k = float(k)
            if abs(k - S) < FILL_TOL:
                continue
            sup = k < S
            gexk, charmk, vannak, dexk, vexk = float(r["gex_s"]), float(r["charm_flow"]), float(r["vanna_flow"]), float(r["dex_s"]), float(r["vex_s"])
            oik = float(r["oi_c"] + r["oi_p"])
            gabs = abs(gexk)
            # pass 1: structural role
            named1 = k == major or k == call_wall or k == put_wall
            named2 = k in call_walls or k in put_walls
            named_flip = flip is not None and k == flip
            rnd = is_round(k)
            gex_rel = gabs / st["maxGex"]; oi_rel = oik / st["maxOi"]
            if gex_rel >= 0.75 or (named1 and (gex_rel >= 0.6 if rnd else (gex_rel >= 0.4 or oi_rel >= 0.5))):
                role = "dominant"
            elif gex_rel >= 0.35 or oi_rel >= 0.5 or (named1 and not rnd) or (named2 and gex_rel >= 0.15) or abs(charmk) >= 2 * max(1.0, st["medCharm"]):
                role = "significant"
            elif gabs >= st["medGex"] or oik >= st["medOi"] or named2 or named_flip:
                role = "minor"
            else:
                role = "empty"
            # pass 2: forced-flow alignment — the class of the votes, never their sum
            agree, oppose = [], []
            gex_vote = charm_vote = vanna_vote = dex_vote = vex_vote = 0
            if gabs >= st["medGex"] and gexk != 0:
                ok_ = (sup and gexk < 0) or ((not sup) and gexk > 0)
                (agree if ok_ else oppose).append("gamma"); gex_vote = 1 if ok_ else -1
            if charmk != 0 and abs(charmk) >= st["medCharm"]:
                ok_ = (sup and charmk > 0) or ((not sup) and charmk < 0)
                (agree if ok_ else oppose).append("charm"); charm_vote = 1 if ok_ else -1
                # the 0DTE charm slice votes again in the desk code (chain == 0DTE here → same vote)
                (agree if ok_ else oppose).append("charm0")
            if vannak != 0 and abs(vannak) >= st["medVanna"] and iv_dir != "STABLE":
                if iv_dir == "FALLING" and vannak > 0:
                    (agree if sup else oppose).append("vanna"); vanna_vote = 1 if sup else -1
                elif iv_dir == "RISING" and vannak < 0:
                    (oppose if sup else agree).append("vanna"); vanna_vote = -1 if sup else 1
            if sup and dexk != 0 and abs(dexk) >= st["medDex"]:
                (agree if dexk > 0 else oppose).append("dex"); dex_vote = 1 if dexk > 0 else -1
            # the user's third factor, not in the desk code: vega concentration on the right side
            if vexk != 0 and abs(vexk) >= st["medVex"]:
                vex_vote = 1 if ((sup and vexk < 0) or ((not sup) and vexk > 0)) else -1
            vector = "aligned" if (not oppose and len(agree) >= 2) else "opposed" if (len(oppose) >= 2 and len(agree) <= 1) else "mixed"
            # pass 5: ordinal prob table (durable = true, todayOnly = true, live = [] here)
            if vector == "opposed":
                prob = {"dominant": 25, "significant": 18}.get(role, 10)
            else:
                base = {"dominant": (62, 46), "significant": (52, 38), "minor": (33, 25), "empty": (18, 12)}[role]
                prob = base[0] if vector == "aligned" else base[1]
                if neg_regime:
                    if vector != "aligned": prob -= 6
                    prob = min(prob, 58)
            prob = max(5, min(68, prob))

            key = (k, sup)
            first = key not in seen
            seen.add(key)
            scale = S / REF_SPOT
            out = dict(date=date, tick=tick, strike=k, side="support" if sup else "resistance", S=S, E=E, dist_pts=abs(k - S), dist_E=abs(k - S) / E if E > 0 else np.nan,
                       role=role, vector=vector, prob=prob, n_agree=len(agree), n_oppose=len(oppose),
                       gex_vote=gex_vote, charm_vote=charm_vote, vanna_vote=vanna_vote, dex_vote=dex_vote, vex_vote=vex_vote,
                       gex=gexk, vex=vexk, charm_flow=charmk, vanna_flow=vannak, dex=dexk, oi=oik, gex_rel=gex_rel,
                       iv_dir=iv_dir, atm_iv=siv, neg_regime=neg_regime, is_major=(k == major), is_call_wall=(k == call_wall), is_put_wall=(k == put_wall), is_flip=named_flip, first=first)
            for spec, mult in (("A", 1.0), ("B", scale)):
                stA, pnl, fi, res, mfe = grade(lo, hi, cl, sup, k, STOP_PTS * mult, TP_PTS * mult)
                out[f"status_{spec}"] = stA; out[f"pnl_{spec}"] = pnl; out[f"mfe_{spec}"] = mfe
                out[f"fill_min_{spec}"] = fi; out[f"res_min_{spec}"] = res
                # placebo twins: same labels, strike displaced 0.25E toward / away from spot
                for name, kk in (("near", k + (PLACEBO_E * E if sup else -PLACEBO_E * E)), ("far", k - (PLACEBO_E * E if sup else -PLACEBO_E * E))):
                    if abs(kk - S) < FILL_TOL:
                        out[f"{name}_status_{spec}"] = "invalid"; out[f"{name}_pnl_{spec}"] = 0.0; continue
                    s2, p2, *_ = grade(lo, hi, cl, sup, kk, STOP_PTS * mult, TP_PTS * mult)
                    out[f"{name}_status_{spec}"] = s2; out[f"{name}_pnl_{spec}"] = p2
            rows.append(out)
    return {"rows": rows, "date": date}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=0, help="limit to the first N days (smoke test)")
    ap.add_argument("--workers", type=int, default=max(1, os.cpu_count() - 2))
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "data", "study"))
    a = ap.parse_args()
    files = sorted(glob.glob(os.path.join(SHARE, "*", "greeks", "greeks_*.csv.gz")))
    jobs = []
    for f in files:
        d = os.path.basename(f)[7:15]
        jobs.append((f, f"{d[:4]}-{d[4:6]}-{d[6:]}"))
    if a.days:
        jobs = jobs[:: max(1, len(jobs) // a.days)][: a.days]
    os.makedirs(a.out, exist_ok=True)
    print(f"{len(jobs)} days, {a.workers} workers", flush=True)
    frames, errors = [], []
    with Pool(a.workers) as pool:
        for i, res in enumerate(pool.imap_unordered(run_day, jobs, chunksize=2), 1):
            if "error" in res:
                errors.append(res["error"])
            else:
                frames.append(pd.DataFrame(res["rows"]))
            if i % 25 == 0 or i == len(jobs):
                print(f"  {i}/{len(jobs)} days · {sum(len(x) for x in frames)} calls · {len(errors)} errors", flush=True)
    df = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()
    out = os.path.join(a.out, "0dte_alignment_calls.parquet")
    df.to_parquet(out, index=False)
    with open(os.path.join(a.out, "0dte_alignment_errors.txt"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(errors))
    print(f"wrote {out}: {len(df)} calls from {len(frames)} days; {len(errors)} days skipped", flush=True)


if __name__ == "__main__":
    main()
