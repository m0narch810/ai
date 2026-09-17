"""
ENTRY VARIANTS the readers proposed, graded on the same bars (2022-23):
  A. AT the level (the desk's order): limit at K, fill = trade-through, stop S beyond ENTRY.
  B. IN FRONT: limit at K + 0.25 (support) / K − 0.25 (resistance); stop S beyond K (i.e. S + 0.25
     from entry). Turns that print "in front of the strike" fill; the extra 0.25 costs on the stop.
  C. REJECTION: price touches within 0.15 of K but does NOT trade through, and the first completed
     5-min bar after the touch closes ≥ 0.50 on the near side → enter at that bar's close, stop
     15 MNQ beyond K. Market entry on evidence, not a resting order.
All three: order placed at first contact, fill must occur within 30 min of contact (else cancelled),
≥15 min to close, RTH only, adverse-first, NQ-converted bars. Outcomes: run to 80 before the stop,
P&L at the close with the stop, max favourable run. Levels: whole strikes ±1% and the named levels
(put/call gamma wall, major, OI walls, frozen IV walls) from the state tape.
    python scripts/study_entry_variants.py [--smoke]
"""
from __future__ import annotations
import glob, os, sys
from multiprocessing import Pool
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(__file__))
import study_0dte_alignment as S
try: sys.stdout.reconfigure(encoding="utf-8")
except Exception: pass
MNQ = S.MNQ_PER_QQQ; NEAR_PCT, CONTACT, TOL, FRONT, WINDOW = 0.01, 0.5, 0.15, 0.25, 30
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "study")
STOPS = [15, 40]


def outcome(lo, hi, cl, sup, entry, stop_level, tp_pts=80 / MNQ):
    """From the fill bar on: adverse-first; returns (stopped, ran80, mfe_mnq, pnl_close_mnq, t_stop)."""
    adverse = (entry - lo) if sup else (hi - entry); fav = (hi - entry) if sup else (entry - lo)
    s_dist = (entry - stop_level) if sup else (stop_level - entry)
    hit = adverse >= s_dist; si = int(np.argmax(hit)) if hit.any() else None
    r80 = fav >= tp_pts; ri = int(np.argmax(r80)) if r80.any() else None
    stopped = si is not None; ran80 = ri is not None and (si is None or ri < si)
    mfe = float(fav[:si + 1].max()) if si is not None else float(fav.max())
    pnl = -s_dist if stopped else float((cl[-1] - entry) if sup else (entry - cl[-1]))
    return stopped, ran80, mfe * MNQ, pnl * MNQ, si if si is not None else -1


def run_day(args):
    path, date = args
    try: return _run_day(path, date)
    except Exception as e: return {"error": f"{date}: {type(e).__name__}: {e}"}


TAPE = None
def _tape():
    """Lazy per-process load: Pool workers on Windows do not inherit the parent's global."""
    global TAPE
    if TAPE is None:
        TAPE = pd.read_parquet(os.path.join(OUT, "state_tape_222324.parquet"), columns=["date", "tick", "F", "E", "d_iv30", "flip", "major", "cwall", "pwall", "coi_wall", "poi_wall", "ivu_in_frz", "ivu_out_frz", "ivl_in_frz", "ivl_out_frz"])
    return TAPE


def _run_day(path, date):
    tape = _tape(); tape = tape[tape.date == date].sort_values("tick")
    if tape.empty: return {"error": f"{date}: no tape"}
    nq = S.nq_for(date)
    if nq is None: return {"error": f"{date}: no bars"}
    g = pd.read_csv(path, usecols=["minute", "F"]).dropna(); fwd = g.groupby("minute")["F"].first(); minutes = list(fwd.index)
    nq = nq.set_index("hm"); common = [m for m in minutes if m in nq.index]
    rr = pd.Series({m: nq.at[m, "close"] / fwd[m] for m in common})
    ratio = rr.rolling(S.RATIO_WINDOW, min_periods=3).median().shift(1); ratio = ratio.fillna(rr.expanding().median().shift(1)).bfill()
    lo = np.array([nq.at[m, "low"] / ratio[m] for m in common]); hi = np.array([nq.at[m, "high"] / ratio[m] for m in common]); cl = np.array([nq.at[m, "close"] / ratio[m] for m in common])
    hms = common
    named = ["flip", "major", "cwall", "pwall", "coi_wall", "poi_wall", "ivu_in_frz", "ivu_out_frz", "ivl_in_frz", "ivl_out_frz"]
    ticks = list(tape.tick); rows = []; seen = set()
    for i in range(1, len(hms)):
        hm = hms[i]
        if hm < "09:41": continue
        mtc = 16 * 60 - (int(hm[:2]) * 60 + int(hm[3:]))
        if mtc < 15: continue
        prior = [t for t in ticks if t < hm]
        if not prior: continue
        st = tape[tape.tick == prior[-1]].iloc[0]; F = float(st.F); E = float(st.E)
        prev_c = cl[i - 1]
        cands = [("strike", float(K)) for K in range(int(np.floor(F * (1 - NEAR_PCT))), int(np.ceil(F * (1 + NEAR_PCT))) + 1)]
        cands += [(nm, float(st[nm])) for nm in named if np.isfinite(st[nm]) and abs(float(st[nm]) - F) <= F * 0.015]
        for typ, K in cands:
            for side in ("support", "resistance"):
                key = (typ, round(K, 2), side)
                if key in seen: continue
                sup = side == "support"
                contact = (prev_c > K + CONTACT and lo[i] <= K + CONTACT) if sup else (prev_c < K - CONTACT and hi[i] >= K - CONTACT)
                if not contact: continue
                seen.add(key)
                j_end = min(len(hms), i + WINDOW + 1)
                d_iv = float(st.d_iv30) if np.isfinite(st.d_iv30) else np.nan
                base = dict(date=date, hm=hm, ltype=typ, K=K, side=side, E=E, mins_to_close=mtc, d_iv30=d_iv, dist_E=abs(K - F) / E if E > 0 else np.nan)
                # A: at the level; B: in front
                for var, entry in (("at", K), ("front", K + FRONT if sup else K - FRONT)):
                    fill = (lo[i:j_end] < entry) if sup else (hi[i:j_end] > entry)
                    rec = dict(base, variant=var, filled=bool(fill.any()))
                    if fill.any():
                        fi = i + int(np.argmax(fill)); rec["fill_min"] = fi - i
                        for s_ in STOPS:
                            stop_lvl = (K - s_ / MNQ) if sup else (K + s_ / MNQ)      # stop measured beyond K for both variants
                            if var == "at": stop_lvl = (entry - s_ / MNQ) if sup else (entry + s_ / MNQ)
                            stopped, ran80, mfe, pnl, ts = outcome(lo[fi:], hi[fi:], cl[fi:], sup, entry, stop_lvl)
                            rec[f"stopped{s_}"] = stopped; rec[f"run80_{s_}"] = ran80; rec[f"mfe{s_}"] = mfe; rec[f"pnl{s_}"] = pnl; rec[f"tstop{s_}"] = ts
                    rows.append(rec)
                # C: rejection without trade-through
                touched = (lo[i] <= K + TOL) if sup else (hi[i] >= K - TOL)
                through = (lo[i:j_end] < K) if sup else (hi[i:j_end] > K)
                if touched and not through[:5].any():
                    # first completed 5-min bar after the touch: bars i+1..i+5 → close at i+5
                    k5 = i + 5
                    if k5 < len(hms):
                        c5 = cl[k5]; rej = (c5 >= K + 0.5) if sup else (c5 <= K - 0.5)
                        rec = dict(base, variant="reject", filled=bool(rej))
                        if rej:
                            entry = c5; stop_lvl = (K - 15 / MNQ) if sup else (K + 15 / MNQ)
                            stopped, ran80, mfe, pnl, ts = outcome(lo[k5 + 1:], hi[k5 + 1:], cl[k5 + 1:], sup, entry, stop_lvl)
                            rec.update(fill_min=5, stopped15=stopped, run80_15=ran80, mfe15=mfe, pnl15=pnl, tstop15=ts, risk15=(entry - stop_lvl if sup else stop_lvl - entry) * MNQ)
                        rows.append(rec)
    return {"rows": rows}


def main():
    smoke = "--smoke" in sys.argv
    files = []
    for y in (2022, 2023): files += sorted(glob.glob(os.path.join(S.SHARE, str(y), "greeks", "greeks_*.csv.gz")))
    if smoke: files = files[:3]
    jobs = [(f, f"{os.path.basename(f)[7:11]}-{os.path.basename(f)[11:13]}-{os.path.basename(f)[13:15]}") for f in files]
    frames, errs = [], []
    it = map(run_day, jobs) if smoke else Pool(max(1, os.cpu_count() - 2)).imap_unordered(run_day, jobs, chunksize=2)
    for i, r in enumerate(it, 1):
        if "error" in r: errs.append(r["error"])
        else: frames.append(pd.DataFrame(r["rows"]))
        if i % 50 == 0 or i == len(jobs): print(f"  {i}/{len(jobs)}", flush=True)
    df = pd.concat(frames, ignore_index=True); df.to_parquet(os.path.join(OUT, f"entry_variants_{'smoke' if smoke else '2223'}.parquet"), index=False)
    print("wrote", len(df), "rows;", len(errs), "errors", errs[:3])
    report(df)


def report(df):
    print("\n# ENTRY VARIANTS — 2022-23, orders placed at first contact, fill within 30 min, ≥15 min to close")
    def line(g, s):
        f = g[g.filled]
        if f.empty: return "n=0"
        return f"filled {100*len(f)/len(g):4.0f}% of {len(g):5d} · run→80 before stop {100*f[f'run80_{s}'].mean():4.1f}% · stopped {100*f[f'stopped{s}'].mean():4.1f}% · E[mfe] {f[f'mfe{s}'].mean():5.1f} · pnl@close {f[f'pnl{s}'].mean():+5.1f} MNQ/fill"
    for grp, sub in [("ALL LEVELS", df), ("plain strikes", df[df.ltype == "strike"]), ("gamma/OI walls", df[df.ltype.isin(["pwall", "cwall", "major", "coi_wall", "poi_wall"])]), ("frozen IV walls", df[df.ltype.str.contains("frz")])]:
        print(f"\n## {grp}")
        for var in ["at", "front"]:
            for s in STOPS:
                print(f"  {var:>6} · stop {s} beyond {'entry' if var == 'at' else 'K'} (BE {100 * (s + (0 if var == 'at' else 10)) / (s + (0 if var == 'at' else 10) + 80):4.1f}%): {line(sub[sub.variant == var], s)}")
        rj = sub[sub.variant == "reject"]
        f = rj[rj.filled]
        if len(f): print(f"  reject · stop 15 beyond K (risk from entry avg {f.risk15.mean():.0f} MNQ, BE {100 * f.risk15.mean() / (f.risk15.mean() + 80):.0f}%): {line(rj, 15)}")
    print("\n## by side (front, stop 40 beyond K)")
    for side in ["support", "resistance"]:
        print(f"  {side}: {line(df[(df.variant == 'front') & (df.side == side)], 40)}")
    print("\n## reject by side")
    for side in ["support", "resistance"]:
        print(f"  {side}: {line(df[(df.variant == 'reject') & (df.side == side)], 15)}")
    print("\n## by year (front · 40 / at · 40 / reject · 15)")
    for y in ["2022", "2023"]:
        d = df[df.date.str.startswith(y)]
        print(f"  {y}: front {line(d[d.variant == 'front'], 40)} | at {line(d[d.variant == 'at'], 40)} | reject {line(d[d.variant == 'reject'], 15)}")


if __name__ == "__main__":
    if "--report" in sys.argv: report(pd.read_parquet(os.path.join(OUT, "entry_variants_2223.parquet")))
    else: main()
