"""
REVERSAL ATLAS — the raw material for a qualitative read, not a backtest.

For every day: find the session's real turns (a zigzag on the QQQ-equivalent NQ 1-min wicks with
the 80-MNQ swing as the reversal threshold, so every turn listed is one that would have paid the
bracket) and the run-throughs (the day's three heaviest 0DTE gamma strikes that price crossed
and kept going). For each event, dump the 0DTE ladder AS IT STOOD THE MINUTE BEFORE — OI per
side, dealer gamma / vega / charm-flow / vanna-flow, per-side IV and its 30-minute drift, the
quotes — plus the session context (time, E remaining, ATM IV trend, where the OI walls are).

Output: data/study/atlas_events.parquet (every event, with the ladder features at the event
strike and its neighbours) and data/study/atlas_sample.md (a readable sample to study by eye).
"""
from __future__ import annotations

import glob
import os
import sys
from multiprocessing import Pool

import numpy as np
import pandas as pd
from io import StringIO

sys.path.insert(0, os.path.dirname(__file__))
import study_0dte_alignment as S  # noqa: E402  (shared loaders + greeks)

SWING = 80 / S.MNQ_PER_QQQ          # 1.966 QQQ pts — a turn must be followed by at least this
PRE_SWING = SWING                    # ...and preceded by at least this (a real leg, not noise)
LADDER_HALF = 5                      # strikes each side of the event strike in the dump
DRIFT_MIN = 30


def zigzag(hi, lo, cl, thr):
    """Turn points: (idx, price, kind) with kind 'top' or 'bottom'. Strictly causal detection is
    not needed here — this is an atlas of what happened, read after the fact."""
    n = len(hi)
    turns = []
    mode = None; ext_i = 0; ext_p = cl[0]
    for i in range(n):
        if mode is None:
            if hi[i] - ext_p >= thr: mode = "up"; ext_i, ext_p = i, hi[i]
            elif ext_p - lo[i] >= thr: mode = "down"; ext_i, ext_p = i, lo[i]
            else:
                if hi[i] > ext_p and lo[i] < ext_p: pass
            continue
        if mode == "up":
            if hi[i] > ext_p: ext_i, ext_p = i, hi[i]
            elif ext_p - lo[i] >= thr:
                turns.append((ext_i, ext_p, "top")); mode = "down"; ext_i, ext_p = i, lo[i]
        else:
            if lo[i] < ext_p: ext_i, ext_p = i, lo[i]
            elif hi[i] - ext_p >= thr:
                turns.append((ext_i, ext_p, "bottom")); mode = "up"; ext_i, ext_p = i, hi[i]
    return turns


def run_day(args):
    path, date = args
    try:
        return _run_day(path, date)
    except Exception as e:
        return {"error": f"{date}: {type(e).__name__}: {e}"}


def _run_day(path, date):
    nq = S.nq_for(date)
    if nq is None:
        return {"error": f"{date}: no bars"}
    g = pd.read_csv(path, usecols=["minute", "strike", "side", "oi", "F", "T", "iv", "bid", "ask", "mid", "vega", "gex"])
    g = g.dropna(subset=["iv", "F", "T"]); g = g[g["T"] > 0]
    g["strike"] = S.fix_strike_offset(g["strike"].to_numpy(float))
    fwd = g.groupby("minute")["F"].first(); Tm = g.groupby("minute")["T"].first()
    atm_iv = g.assign(dk=(g["strike"] - g["F"]).abs()).sort_values("dk").groupby("minute")["iv"].first()
    minutes = list(fwd.index)
    nq = nq.set_index("hm"); common = [m for m in minutes if m in nq.index]
    rr = pd.Series({m: nq.at[m, "close"] / fwd[m] for m in common})
    ratio = rr.rolling(S.RATIO_WINDOW, min_periods=3).median().shift(1); ratio = ratio.fillna(rr.expanding().median().shift(1)).bfill()
    bars = pd.DataFrame({"hm": common, "lo": [nq.at[m, "low"] / ratio[m] for m in common], "hi": [nq.at[m, "high"] / ratio[m] for m in common], "cl": [nq.at[m, "close"] / ratio[m] for m in common]}).set_index("hm")

    dc, vega, charm, vanna = S.black_greeks(g["F"].to_numpy(), g["strike"].to_numpy(), g["T"].to_numpy(), g["iv"].to_numpy())
    is_c = (g["side"] == "C").to_numpy(); sgn = np.where(is_c, 1.0, -1.0); oi = g["oi"].to_numpy(float)
    g["gexM"] = g["gex"] / 1e6
    g["vexM"] = sgn * oi * 100 * vega / 1e6
    g["charmM"] = -sgn * oi * 100 * charm / 1e6 / 365 * 60   # dealer BUY flow per HOUR of decay, $M-ish delta
    g["vannaM"] = sgn * oi * 100 * vanna / 1e6                 # dealer BUY flow per −1.00 vol
    g["oi_c"] = np.where(is_c, oi, 0.0); g["oi_p"] = np.where(is_c, 0.0, oi)
    g["ivC"] = np.where(is_c, g["iv"], np.nan); g["ivP"] = np.where(is_c, np.nan, g["iv"])
    g["midC"] = np.where(is_c, g["mid"], np.nan); g["midP"] = np.where(is_c, np.nan, g["mid"])
    g["sprC"] = np.where(is_c, g["ask"] - g["bid"], np.nan); g["sprP"] = np.where(is_c, np.nan, g["ask"] - g["bid"])
    lad = g.groupby(["minute", "strike"]).agg(oi_c=("oi_c", "sum"), oi_p=("oi_p", "sum"), gexM=("gexM", "sum"), vexM=("vexM", "sum"), charmM=("charmM", "sum"), vannaM=("vannaM", "sum"),
                                              ivC=("ivC", "max"), ivP=("ivP", "max"), midC=("midC", "max"), midP=("midP", "max"), sprC=("sprC", "max"), sprP=("sprP", "max"))

    hi, lo, cl = bars["hi"].to_numpy(), bars["lo"].to_numpy(), bars["cl"].to_numpy()
    hms = list(bars.index)
    turns = zigzag(hi, lo, cl, SWING)
    # day OI walls (static within the day)
    day_lad = lad.loc[minutes[0]] if minutes[0] in lad.index.get_level_values(0) else None
    put_oi_wall = float(day_lad["oi_p"].idxmax()) if day_lad is not None else np.nan
    call_oi_wall = float(day_lad["oi_c"].idxmax()) if day_lad is not None else np.nan

    events = []
    def ladder_at(hm, center):
        if hm not in lad.index.get_level_values(0): return None
        L = lad.loc[hm]
        prev = minutes[max(0, minutes.index(hm) - DRIFT_MIN)]
        P = lad.loc[prev] if prev in lad.index.get_level_values(0) else L
        ks = [k for k in L.index if abs(k - center) <= LADDER_HALF + 0.5]
        out = L.loc[ks].copy()
        out["dIvC"] = out["ivC"] - P["ivC"].reindex(ks).to_numpy()
        out["dIvP"] = out["ivP"] - P["ivP"].reindex(ks).to_numpy()
        out["dMidC"] = out["midC"] - P["midC"].reindex(ks).to_numpy()
        out["dMidP"] = out["midP"] - P["midP"].reindex(ks).to_numpy()
        return out

    OFFS = [60, 45, 30, 15, 10, 5, 1]
    def tape_at(hm, k):
        """The event strike's own tape over the preceding hour: how IV, quotes, gamma and vanna were moving."""
        i = minutes.index(hm); rows = []
        for off in OFFS:
            m = minutes[max(0, i - off)]
            if m not in lad.index.get_level_values(0) or k not in lad.loc[m].index: continue
            r = lad.loc[m].loc[k]
            rows.append(dict(t=f"-{off}m", spot=round(float(fwd[m]), 2), iv=round(100 * float(r["ivC"]), 1), midC=round(float(r["midC"]), 2), midP=round(float(r["midP"]), 2),
                             gexM=round(float(r["gexM"]), 2), vannaM=round(float(r["vannaM"]), 2), atm=round(100 * float(atm_iv[m]), 1)))
        return pd.DataFrame(rows).to_json(orient="records")

    def context(hm):
        i = minutes.index(hm); prev = minutes[max(0, i - DRIFT_MIN)]
        Sp = float(fwd[hm]); T = float(Tm[hm]); iv = float(atm_iv[hm])
        return dict(S=Sp, T=T, E=Sp * iv * np.sqrt(T), atm_iv=iv, d_atm_iv=iv - float(atm_iv[prev]), mins_to_close=round(T * 525600))

    # ── turns ──
    for j, (ti, price, kind) in enumerate(turns):
        hm = hms[ti]
        if hm not in fwd.index or ti == 0: continue
        pre_hm = hms[ti - 1]
        if pre_hm not in fwd.index: continue
        # pre-leg and post-leg sizes
        pre = abs(price - (turns[j - 1][1] if j else cl[0]))
        post = abs((turns[j + 1][1] if j + 1 < len(turns) else cl[-1]) - price)
        if pre < PRE_SWING: continue
        k0 = round(price)
        ctx = context(pre_hm)
        L = ladder_at(pre_hm, k0)
        if L is None or k0 not in L.index: continue
        r = L.loc[k0]
        ev = dict(date=date, kind="turn", turn=kind, hm=hm, price=round(price, 2), k0=float(k0), dist_k=round(price - k0, 2), pre_leg=round(pre, 2), post_leg=round(post, 2),
                  put_oi_wall=put_oi_wall, call_oi_wall=call_oi_wall, **ctx)
        for c in ("oi_c", "oi_p", "gexM", "vexM", "charmM", "vannaM", "ivC", "ivP", "dIvC", "dIvP", "dMidC", "dMidP", "sprC", "sprP"):
            ev[c] = float(r[c])
        # neighbourhood: is k0 the local max of |gex| / put OI / call OI within ±3
        nb = L[(L.index >= k0 - 3) & (L.index <= k0 + 3)]
        ev["gex_rank_pm3"] = int((nb["gexM"].abs() > abs(r["gexM"])).sum()) + 1
        ev["putoi_rank_pm3"] = int((nb["oi_p"] > r["oi_p"]).sum()) + 1
        ev["calloi_rank_pm3"] = int((nb["oi_c"] > r["oi_c"]).sum()) + 1
        ev["ladder"] = L.round(3).to_json(orient="index")
        ev["tape"] = tape_at(pre_hm, float(k0))
        events.append(ev)

    # ── run-throughs: the day's 3 heaviest |gex| strikes at 10:00, crossed by ≥ SWING with no turn within 0.5 ──
    if "10:00" in lad.index.get_level_values(0):
        L10 = lad.loc["10:00"]
        S10 = float(fwd["10:00"])
        heavy = L10[(L10.index >= S10 * 0.99) & (L10.index <= S10 * 1.01)]["gexM"].abs().nlargest(3).index
        turn_prices = [p for _, p, _ in turns]
        for k in heavy:
            k = float(k)
            for i in range(hms.index("10:00") + 1, len(hms)):
                prev_c = cl[i - 1]
                crossed_up = prev_c < k and hi[i] >= k
                crossed_dn = prev_c > k and lo[i] <= k
                if not (crossed_up or crossed_dn): continue
                # continued ≥ SWING beyond within the rest of the session, and no turn within 0.5 of k after the cross
                beyond = (hi[i:].max() - k) if crossed_up else (k - lo[i:].min())
                near_turn = any(abs(p - k) <= 0.5 for p in turn_prices)
                if beyond >= SWING and not near_turn:
                    hm = hms[i]; pre_hm = hms[i - 1]
                    if pre_hm not in fwd.index: break
                    ctx = context(pre_hm); L = ladder_at(pre_hm, k)
                    if L is None or k not in L.index: break
                    r = L.loc[k]
                    ev = dict(date=date, kind="run_through", turn="up" if crossed_up else "down", hm=hm, price=round(k, 2), k0=k, dist_k=0.0, pre_leg=np.nan, post_leg=round(beyond, 2),
                              put_oi_wall=put_oi_wall, call_oi_wall=call_oi_wall, **ctx)
                    for c in ("oi_c", "oi_p", "gexM", "vexM", "charmM", "vannaM", "ivC", "ivP", "dIvC", "dIvP", "dMidC", "dMidP", "sprC", "sprP"):
                        ev[c] = float(r[c])
                    nb = L[(L.index >= k - 3) & (L.index <= k + 3)]
                    ev["gex_rank_pm3"] = int((nb["gexM"].abs() > abs(r["gexM"])).sum()) + 1
                    ev["putoi_rank_pm3"] = int((nb["oi_p"] > r["oi_p"]).sum()) + 1
                    ev["calloi_rank_pm3"] = int((nb["oi_c"] > r["oi_c"]).sum()) + 1
                    ev["ladder"] = L.round(3).to_json(orient="index")
                    ev["tape"] = tape_at(pre_hm, k)
                    events.append(ev)
                break
    return {"events": events}


def fmt_event(e: pd.Series) -> str:
    L = pd.read_json(StringIO(e["ladder"]), orient="index").sort_index(ascending=False)
    head = (f"### {e['date']} {e['hm']}  {e['kind'].upper()} {e['turn']}  @ {e['price']}  (strike {e['k0']:.0f}, off by {e['dist_k']:+.2f})\n"
            f"spot {e['S']:.2f} · E-to-close {e['E']:.2f} · {e['mins_to_close']} min left · ATM IV {100*e['atm_iv']:.1f}% ({100*e['d_atm_iv']:+.1f} vs 30m ago) · "
            f"pre-leg {e['pre_leg']} · post-leg {e['post_leg']} · day OI walls: put {e['put_oi_wall']:.0f} / call {e['call_oi_wall']:.0f}\n")
    L["iv"] = 100 * L["ivC"]; L["dIv"] = 100 * L["dIvC"]; L["dIv_vs_atm"] = 100 * L["dIvC"] - 100 * e["d_atm_iv"]
    cols = ["oi_c", "oi_p", "gexM", "vexM", "charmM", "vannaM", "iv", "dIv", "dIv_vs_atm", "midC", "dMidC", "midP", "dMidP"]
    tbl = L[cols].copy()
    tbl.index = [f"{'>' if k == e['k0'] else ' '}{k:.0f}" for k in tbl.index]
    tape = pd.read_json(StringIO(e["tape"]), orient="records") if isinstance(e.get("tape"), str) else None
    tape_txt = ("event-strike tape (minutes before):\n" + tape.set_index("t").to_string() + "\n") if tape is not None and len(tape) else ""
    return head + tbl.round(2).to_string() + "\n" + tape_txt


def main():
    out_dir = os.path.join(os.path.dirname(__file__), "..", "data", "study")
    files = sorted(glob.glob(os.path.join(S.SHARE, "*", "greeks", "greeks_*.csv.gz")))
    jobs = [(f, f"{os.path.basename(f)[7:11]}-{os.path.basename(f)[11:13]}-{os.path.basename(f)[13:15]}") for f in files]
    if "--days" in sys.argv:
        n = int(sys.argv[sys.argv.index("--days") + 1]); jobs = jobs[:: max(1, len(jobs) // n)][:n]
    evs, errs = [], []
    with Pool(max(1, os.cpu_count() - 2)) as pool:
        for i, r in enumerate(pool.imap_unordered(run_day, jobs, chunksize=2), 1):
            if "error" in r: errs.append(r["error"])
            else: evs.extend(r["events"])
            if i % 50 == 0 or i == len(jobs): print(f"  {i}/{len(jobs)} · {len(evs)} events · {len(errs)} errors", flush=True)
    df = pd.DataFrame(evs)
    df.to_parquet(os.path.join(out_dir, "atlas_events.parquet"), index=False)
    print(df.groupby(["kind", "turn"]).size())
    # readable sample: stratified across years, 60 turns + 40 run-throughs
    rng = np.random.default_rng(7)
    parts = []
    for yr in ("2022", "2023", "2024"):
        d = df[df.date.str.startswith(yr)]
        t = d[d.kind == "turn"]; rt = d[d.kind == "run_through"]
        parts.append(t.iloc[rng.choice(len(t), min(20, len(t)), replace=False)] if len(t) else t)
        parts.append(rt.iloc[rng.choice(len(rt), min(14, len(rt)), replace=False)] if len(rt) else rt)
    sample = pd.concat(parts).sort_values(["date", "hm"])
    with open(os.path.join(out_dir, "atlas_sample.md"), "w", encoding="utf-8") as fh:
        fh.write("# REVERSAL ATLAS — 0DTE ladder the minute before each event\n\n"
                 "gexM/vexM: dealer gamma/vega $M (calls +, puts −) · charmM: dealer BUY flow per hour of decay · vannaM: dealer BUY flow per −1 vol · "
                 "iv in %, dIv = change vs 30 min earlier · mid = option mid, dMid = 30-min change · > marks the event strike\n\n")
        for _, e in sample.iterrows(): fh.write(fmt_event(e) + "\n")
    print("wrote atlas_events.parquet + atlas_sample.md", len(sample), "sampled events;", len(errs), "errors")


if __name__ == "__main__":
    main()
