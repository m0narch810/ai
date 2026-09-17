"""
FORWARD TEST (2025 holdout) of the IV-into-level description from the 2022-24 atlas study.

Pre-registered before touching the data (paper §7): at every FIRST approach of price to a whole
strike from the appropriate side, classify the CHANGE IN ATM 0DTE IMPLIED VOLATILITY over the
prior 30 minutes (rising > +1 vol pt / falling < −1 / flat), decided one minute BEFORE contact,
and tabulate what happened next. Prediction: approaches on rising IV hold far more often than
approaches on falling IV (of the order 3:1 in the atlas contrast). Second test: whether ATM IV
had already retreated > 1 pt from its trailing 60-min peak at decision ("rolled over").

Data (2025, never used before): Databento OPRA cbbo-1m (`QQQ.OPT`, all contracts, 1-min NBBO),
from which the 0DTE chain is filtered; the forward comes from put-call parity on near-ATM pairs;
IV is solved from the OTM mid with Black-76 (r = 0, T = minutes to 16:00 / 525600 — the same
conventions as the 2022-24 share). Outcomes on NQ 1-min bars converted to QQQ terms exactly as
before, graded with the desk's own bracket (40/80 MNQ, trade-through fill, adverse-first).

Nothing here is tuned. Thresholds are the atlas thresholds. Run once, report as is.
"""
from __future__ import annotations

import glob
import os
import sys
from multiprocessing import Pool

import numpy as np
import pandas as pd
from scipy.stats import norm

sys.path.insert(0, os.path.dirname(__file__))
import study_0dte_alignment as S  # grade(), constants

DBN_DIR = r"C:\Users\asare\Downloads\TrueAlgo\historicaldata\optionsdatamore"
NQ_BARS = S.NQ_BARS
IV_WIN, IV_THR, PEAK_WIN = 30, 0.01, 60
NEAR_PCT = 0.01
CONTACT = 0.5          # "came within 0.5 pts" = the approach minute


def black_iv(F, K, T, price, is_call):
    """Vectorised bisection for Black-76 IV (r=0). NaN where the price is at/below intrinsic."""
    F, K, T, price = map(np.asarray, (F, K, T, price))
    intrinsic = np.where(is_call, np.maximum(F - K, 0), np.maximum(K - F, 0))
    ok = (price > intrinsic + 1e-4) & (T > 0)
    lo = np.full(F.shape, 0.01); hi = np.full(F.shape, 6.0)
    sqT = np.sqrt(np.maximum(T, 1e-12))
    for _ in range(40):
        mid = 0.5 * (lo + hi)
        d1 = (np.log(F / K) + 0.5 * mid * mid * T) / (mid * sqT); d2 = d1 - mid * sqT
        model = np.where(is_call, F * norm.cdf(d1) - K * norm.cdf(d2), K * norm.cdf(-d2) - F * norm.cdf(-d1))
        up = model < price
        lo = np.where(up, mid, lo); hi = np.where(up, hi, mid)
    iv = 0.5 * (lo + hi)
    return np.where(ok, iv, np.nan)


_NQ = None
def nq_for(date):
    global _NQ
    if _NQ is None:
        d = pd.read_parquet(NQ_BARS, columns=["date", "open", "high", "low", "close"])
        d = d[(d["date"] >= "2025-01-01") & (d["date"] < "2026-01-02")]
        d["day"] = d["date"].dt.strftime("%Y-%m-%d"); d["hm"] = d["date"].dt.strftime("%H:%M")
        _NQ = d[(d["hm"] >= "09:30") & (d["hm"] <= "15:59")]
    x = _NQ[_NQ["day"] == date]
    return x if len(x) >= 300 else None


def load_0dte(path, date):
    import databento as db
    df = db.DBNStore.from_file(path).to_df()
    sym = df["symbol"].astype(str)
    ymd = date[2:4] + date[5:7] + date[8:10]
    m = sym.str.startswith("QQQ") & (sym.str.slice(6, 12) == ymd)
    df = df[m].copy()
    if df.empty: return None
    s = df["symbol"].astype(str)
    df["cp"] = s.str.slice(12, 13); df["strike"] = s.str.slice(13).astype(float) / 1000
    df["hm"] = df.index.tz_convert("America/New_York").strftime("%H:%M")
    df = df[(df["hm"] >= "09:31") & (df["hm"] <= "15:59")]
    df["mid"] = (df["bid_px_00"] + df["ask_px_00"]) / 2
    df = df[(df["bid_px_00"] > 0) & (df["ask_px_00"] > df["bid_px_00"])]
    return df[["hm", "cp", "strike", "mid"]]


def run_day(args):
    path, date = args
    try:
        return _run_day(path, date)
    except Exception as e:
        return {"error": f"{date}: {type(e).__name__}: {e}"}


def _run_day(path, date):
    nq = nq_for(date)
    if nq is None: return {"error": f"{date}: no NQ bars"}
    q = load_0dte(path, date)
    if q is None or q.empty: return {"error": f"{date}: no 0DTE quotes"}
    piv = q.pivot_table(index=["hm", "strike"], columns="cp", values="mid").reset_index()
    if "C" not in piv or "P" not in piv: return {"error": f"{date}: one-sided"}
    # forward per minute from parity on strikes with both sides quoted near the money
    fwd = {}
    for hm, g in piv.groupby("hm"):
        both = g.dropna(subset=["C", "P"]); both = both[(both.C > 0.03) | (both.P > 0.03)]
        if len(both) < 4: continue
        f0 = both.strike + both.C - both.P
        med = f0.median(); near = f0[(both.strike - med).abs() <= 4]
        if len(near) >= 3: fwd[hm] = float(near.median())
    fwd = pd.Series(fwd).sort_index()
    if len(fwd) < 200: return {"error": f"{date}: thin forward ({len(fwd)})"}
    minutes = list(fwd.index)
    mins_to_close = pd.Series({hm: 16 * 60 - (int(hm[:2]) * 60 + int(hm[3:])) for hm in minutes})
    # ATM IV per minute: OTM mid at the two strikes straddling F, solved, averaged
    piv = piv[piv.hm.isin(minutes)].copy()
    piv["F"] = piv.hm.map(fwd); piv["T"] = piv.hm.map(mins_to_close) / 525600.0
    piv["is_call"] = piv.strike >= piv.F
    piv["otm_mid"] = np.where(piv.is_call, piv.C, piv.P)
    piv = piv.dropna(subset=["otm_mid"])
    piv["iv"] = black_iv(piv.F.to_numpy(), piv.strike.to_numpy(), piv["T"].to_numpy(), piv.otm_mid.to_numpy(), piv.is_call.to_numpy())
    piv = piv.dropna(subset=["iv"]); piv["dk"] = (piv.strike - piv.F).abs()
    atm = piv[piv.dk <= 1.0].groupby("hm").apply(lambda g: float(np.average(g.iv, weights=1 / (g.dk + 0.05)))).reindex(minutes)
    atm = atm.interpolate(limit=3)
    # bars → QQQ terms
    nq = nq.set_index("hm"); common = [m for m in minutes if m in nq.index]
    rr = pd.Series({m: nq.at[m, "close"] / fwd[m] for m in common})
    ratio = rr.rolling(S.RATIO_WINDOW, min_periods=3).median().shift(1); ratio = ratio.fillna(rr.expanding().median().shift(1)).bfill()
    bars = pd.DataFrame({"hm": common, "lo": [nq.at[m, "low"] / ratio[m] for m in common], "hi": [nq.at[m, "high"] / ratio[m] for m in common], "cl": [nq.at[m, "close"] / ratio[m] for m in common]}).set_index("hm")
    hms = list(bars.index); lo, hi, cl = bars.lo.to_numpy(), bars.hi.to_numpy(), bars.cl.to_numpy()
    idx = {m: i for i, m in enumerate(minutes)}

    def iv_state(hm):
        i = idx.get(hm)
        if i is None or i < 2: return None
        now = atm.iloc[i]; prev = atm.iloc[max(0, i - IV_WIN)]
        peak = atm.iloc[max(0, i - PEAK_WIN):i + 1].max(); trough = atm.iloc[max(0, i - PEAK_WIN):i + 1].min()
        if not (np.isfinite(now) and np.isfinite(prev)): return None
        d = now - prev
        return dict(atm_iv=now, d_iv=d, cls="rising" if d > IV_THR else "falling" if d < -IV_THR else "flat",
                    off_peak=peak - now, off_trough=now - trough, rolled=(peak - now) > IV_THR, popped=(now - trough) > IV_THR)

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
                seen.add((K, side))
                st = iv_state(hms[i - 1])            # decided one minute BEFORE contact
                if st is None: continue
                mtc = int(mins_to_close.get(hm, 0))
                if mtc < 20: continue
                la, ha, ca = lo[i:], hi[i:], cl[i:]
                status, pnl, fi, res, mfe = S.grade(la, ha, ca, sup, K, S.STOP_PTS, S.TP_PTS)
                # "held": reject ≥ TP before overshoot ≥ STOP, from contact, regardless of fill
                over = (K - la) if sup else (ha - K); rej = (ha - K) if sup else (K - la)
                si = int(np.argmax(over >= S.STOP_PTS)) if (over >= S.STOP_PTS).any() else None
                ri = int(np.argmax(rej >= S.TP_PTS)) if (rej >= S.TP_PTS).any() else None
                held = "broke" if (si is not None and (ri is None or si <= ri)) else "held" if ri is not None else "unresolved"
                rows.append(dict(date=date, hm=hm, K=K, side=side, spot=Sp, mins_to_close=mtc, status=status, pnl=pnl, held=held, over_max=float(over.max()) if len(over) else np.nan, **st))
    series = pd.DataFrame({"date": date, "hm": hms, "F": [fwd.get(m, np.nan) for m in hms], "atm_iv": [atm.get(m, np.nan) for m in hms], "lo": lo, "hi": hi, "cl": cl})
    return {"rows": rows, "series": series}


def main():
    out_dir = os.path.join(os.path.dirname(__file__), "..", "data", "study"); os.makedirs(out_dir, exist_ok=True)
    files = sorted(glob.glob(os.path.join(DBN_DIR, "opra-pillar-*.cbbo-1m.dbn.zst")))
    jobs = [(f, f"{os.path.basename(f)[12:16]}-{os.path.basename(f)[16:18]}-{os.path.basename(f)[18:20]}") for f in files]
    if "--days" in sys.argv:
        n = int(sys.argv[sys.argv.index("--days") + 1]); jobs = jobs[:: max(1, len(jobs) // n)][:n]
    workers = int(sys.argv[sys.argv.index("--workers") + 1]) if "--workers" in sys.argv else 6
    frames, errs, ser = [], [], []
    with Pool(workers) as pool:
        for i, r in enumerate(pool.imap_unordered(run_day, jobs, chunksize=1), 1):
            if "error" in r: errs.append(r["error"])
            else: frames.append(pd.DataFrame(r["rows"])); ser.append(r["series"])
            if i % 10 == 0 or i == len(jobs): print(f"  {i}/{len(jobs)} · {sum(len(x) for x in frames)} approaches · {len(errs)} errors", flush=True)
    df = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()
    df.to_parquet(os.path.join(out_dir, "forward_2025_approaches.parquet"), index=False)
    if ser: pd.concat(ser, ignore_index=True).to_parquet(os.path.join(out_dir, "forward_2025_series.parquet"), index=False)
    with open(os.path.join(out_dir, "forward_2025_errors.txt"), "w", encoding="utf-8") as fh: fh.write("\n".join(errs))
    print(f"wrote {len(df)} approaches from {len(frames)} days; {len(errs)} errors")


if __name__ == "__main__":
    main()
