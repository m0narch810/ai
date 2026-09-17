"""
WHOLE-CHAIN WALLS (2022): does positioning across ALL expiries do what 0DTE positioning did not?

Data: the TD Ameritrade full-chain snapshots (Downloads/QQQ 2022-01-01 To 2022-12-31.zip):
one JSON per (day, 09:36) and (day, 15:51) with every expiry, per contract OI, IV, delta, gamma.
Joined by date with the 2022 ThetaData 0DTE minute files (ATM-IV tape + forward) and NQ bars.

Per day D, from the 09:36 chain (and, as a second variant, the 15:51 chain of the PRIOR day):
  per strike: net dealer gamma across the whole book (calls +, puts −, gamma·OI·100·S²·0.01),
  the 0DTE slice of the same, call/put OI totals across the book.
  Whole-chain walls: top-3 |net gex| within ±2% of spot, call wall (largest positive net gex
  above spot within 3%), put wall (most negative below), OI walls (largest call OI above / put
  OI below). 0DTE-heavy: top-3 |0DTE net gex| within ±1%.
Approaches: first contact per (strike within ±1% of the 10:00 print, side) within 0.5 pt, IV
class from the ThetaData tape at t−1, limit at the strike, 40/80 MNQ, trade-through, adverse-first.
Classes compared: whole-chain heavy / 0DTE heavy only / both / light; named walls separately.
"""
from __future__ import annotations
import glob, io, json, os, re, sys, zipfile
from multiprocessing import Pool
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(__file__))
import study_0dte_alignment as S

ZIP = r"C:\Users\asare\Downloads\QQQ 2022-01-01 To 2022-12-31.zip"
IV_WIN, IV_THR, NEAR_PCT, CONTACT = 30, 0.01, 0.01, 0.5
STOP, TP = S.STOP_PTS, S.TP_PTS


def chain_levels(raw):
    """Per-strike book from one TD snapshot → DataFrame(strike, gex_all, gex_0, oi_c, oi_p, gex_w1)."""
    S0 = raw.get("underlyingPrice")
    acc = {}
    for side, key in (("C", "callExpDateMap"), ("P", "putExpDateMap")):
        for exp, strikes in (raw.get(key) or {}).items():
            dte = int(exp.split(":")[1]) if ":" in exp else 99
            for k, lst in strikes.items():
                for c in lst:
                    K = float(k); oi = float(c.get("openInterest") or 0); gam = float(c.get("gamma") or 0)
                    if not np.isfinite(gam) or oi <= 0: continue
                    g = gam * oi * 100 * S0 * S0 * 0.01 * (1 if side == "C" else -1)
                    a = acc.setdefault(K, dict(strike=K, gex_all=0.0, gex_0=0.0, gex_w1=0.0, oi_c=0.0, oi_p=0.0))
                    a["gex_all"] += g
                    if dte == 0: a["gex_0"] += g
                    if dte <= 7: a["gex_w1"] += g
                    if side == "C": a["oi_c"] += oi
                    else: a["oi_p"] += oi
    df = pd.DataFrame(list(acc.values())).sort_values("strike") if acc else pd.DataFrame()
    return S0, df


def load_zip_index():
    z = zipfile.ZipFile(ZIP)
    idx = {}
    for n in z.namelist():
        m = re.search(r"qqq-(\d{4}-\d{2}-\d{2})-T(\d{4})\.txt$", n)
        if m: idx.setdefault(m.group(1), {})["am" if m.group(2) < "1200" else "pm"] = n
    return idx


_IDX = None
def snapshot(date, which):
    global _IDX
    if _IDX is None: _IDX = load_zip_index()
    n = _IDX.get(date, {}).get(which)
    if not n: return None
    with zipfile.ZipFile(ZIP) as z:
        try: return json.loads(z.read(n))
        except Exception: return None


def prev_trading(date, idx):
    d = pd.Timestamp(date)
    for i in range(1, 6):
        p = (d - pd.Timedelta(days=i)).strftime("%Y-%m-%d")
        if p in idx and "pm" in idx[p]: return p
    return None


def walls_from(df, spot):
    if df is None or df.empty or not spot: return None
    b2 = df[(df.strike - spot).abs() <= spot * 0.02]; b3 = df[(df.strike - spot).abs() <= spot * 0.03]
    top3_all = set(b2.reindex(b2.gex_all.abs().sort_values(ascending=False).index).head(3).strike)
    b1 = df[(df.strike - spot).abs() <= spot * NEAR_PCT]
    top3_0 = set(b1.reindex(b1.gex_0.abs().sort_values(ascending=False).index).head(3).strike) if b1.gex_0.abs().sum() > 0 else set()
    up, dn = b3[b3.strike > spot], b3[b3.strike < spot]
    call_wall = float(up.loc[up.gex_all.idxmax()].strike) if len(up) and up.gex_all.max() > 0 else np.nan
    put_wall = float(dn.loc[dn.gex_all.idxmin()].strike) if len(dn) and dn.gex_all.min() < 0 else np.nan
    call_oi = float(up.loc[up.oi_c.idxmax()].strike) if len(up) else np.nan
    put_oi = float(dn.loc[dn.oi_p.idxmax()].strike) if len(dn) else np.nan
    medc, medp = b1.oi_c.median(), b1.oi_p.median()
    return dict(top3_all=top3_all, top3_0=top3_0, call_wall=call_wall, put_wall=put_wall, call_oi=call_oi, put_oi=put_oi, medc=medc, medp=medp,
                oi_c=dict(zip(df.strike, df.oi_c)), oi_p=dict(zip(df.strike, df.oi_p)), gex_all=dict(zip(df.strike, df.gex_all)))


def run_day(args):
    path, date = args
    try: return _run_day(path, date)
    except Exception as e: return {"error": f"{date}: {type(e).__name__}: {e}"}


def _run_day(path, date):
    nq = S.nq_for(date)
    if nq is None: return {"error": f"{date}: no bars"}
    am = snapshot(date, "am")
    if not am: return {"error": f"{date}: no TD am chain"}
    S_am, df_am = chain_levels(am); W_am = walls_from(df_am, S_am)
    idx = _IDX; pdte = prev_trading(date, idx)
    pm = snapshot(pdte, "pm") if pdte else None
    W_pm = None
    if pm:
        S_pm, df_pm = chain_levels(pm); W_pm = walls_from(df_pm, S_pm)
    if not W_am: return {"error": f"{date}: empty am chain"}
    g = pd.read_csv(path, usecols=["minute", "strike", "F", "T", "iv"]).dropna(); g = g[g["T"] > 0]
    g["strike"] = S.fix_strike_offset(g["strike"].to_numpy(float))
    fwd = g.groupby("minute")["F"].first(); minutes = list(fwd.index)
    atm = g.assign(dk=(g["strike"] - g["F"]).abs()).sort_values("dk").groupby("minute")["iv"].first().reindex(minutes)
    nq = nq.set_index("hm"); common = [m for m in minutes if m in nq.index]
    rr = pd.Series({m: nq.at[m, "close"] / fwd[m] for m in common})
    ratio = rr.rolling(S.RATIO_WINDOW, min_periods=3).median().shift(1); ratio = ratio.fillna(rr.expanding().median().shift(1)).bfill()
    bars = pd.DataFrame({"hm": common, "lo": [nq.at[m, "low"] / ratio[m] for m in common], "hi": [nq.at[m, "high"] / ratio[m] for m in common], "cl": [nq.at[m, "close"] / ratio[m] for m in common]}).set_index("hm")
    hms = list(bars.index); lo, hi, cl = bars.lo.to_numpy(), bars.hi.to_numpy(), bars.cl.to_numpy()
    idxm = {m: i for i, m in enumerate(minutes)}; mtc = {hm: 16 * 60 - (int(hm[:2]) * 60 + int(hm[3:])) for hm in minutes}
    def iv_cls(hm):
        i = idxm.get(hm)
        if i is None or i < 2: return None
        now, prev = atm.iloc[i], atm.iloc[max(0, i - IV_WIN)]
        if not (np.isfinite(now) and np.isfinite(prev)): return None
        d = now - prev; return "rising" if d > IV_THR else "falling" if d < -IV_THR else "flat"
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
                if mtc.get(hm, 0) < 20: continue
                la, ha, ca = lo[i:], hi[i:], cl[i:]
                status, pnl, fi, res, mfe = S.grade(la, ha, ca, sup, K, STOP, TP)
                def cls(W):
                    if not W: return {}
                    doi = W["oi_p"].get(K, 0) if sup else W["oi_c"].get(K, 0); dmed = W["medp"] if sup else W["medc"]
                    heavy_all = (K in W["top3_all"]) or (dmed and doi >= 2 * dmed)
                    heavy_0 = K in W["top3_0"]
                    named = (K == W["put_wall"] or K == W["put_oi"]) if sup else (K == W["call_wall"] or K == W["call_oi"])
                    def hv(k):
                        o = W["oi_p"].get(k, 0) if sup else W["oi_c"].get(k, 0)
                        return (k in W["top3_all"]) or (dmed and o >= 2 * dmed)
                    b1 = hv(K - 1) if sup else hv(K + 1); b2 = b1 or (hv(K - 2) if sup else hv(K + 2))
                    return dict(heavy_all=bool(heavy_all), heavy_0=bool(heavy_0), named=bool(named), oi_x=(doi / dmed if dmed else np.nan), gex_all=W["gex_all"].get(K, 0.0), wall_b1=bool(b1), wall_b2=bool(b2))
                a = {f"am_{k}": v for k, v in cls(W_am).items()}; p = {f"pm_{k}": v for k, v in cls(W_pm).items()} if W_pm else {}
                rows.append(dict(date=date, hm=hm, K=K, side=side, spot=Sp, mins_to_close=mtc.get(hm, 0), iv_cls=iv_cls(hms[i - 1]), status=status, pnl=pnl, **a, **p))
    return {"rows": rows}


def main():
    global _IDX
    _IDX = load_zip_index()
    out_dir = os.path.join(os.path.dirname(__file__), "..", "data", "study")
    files = sorted(glob.glob(os.path.join(S.SHARE, "2022", "greeks", "greeks_*.csv.gz")))
    jobs = [(f, f"{os.path.basename(f)[7:11]}-{os.path.basename(f)[11:13]}-{os.path.basename(f)[13:15]}") for f in files]
    frames, errs = [], []
    with Pool(max(1, os.cpu_count() - 2)) as pool:
        for i, r in enumerate(pool.imap_unordered(run_day, jobs, chunksize=2), 1):
            if "error" in r: errs.append(r["error"])
            else: frames.append(pd.DataFrame(r["rows"]))
            if i % 25 == 0 or i == len(jobs): print(f"  {i}/{len(jobs)} · {sum(len(x) for x in frames)} approaches · {len(errs)} errors", flush=True)
    df = pd.concat(frames, ignore_index=True); df.to_parquet(os.path.join(out_dir, "wholechain_2022.parquet"), index=False)
    print("done;", len(errs), "errors", errs[:4])


if __name__ == "__main__":
    main()
