"""
Report for the 2025 forward test. Two parts:
  A. the PRE-REGISTERED approach test (unconditional numbers the trader actually faces)
  B. the atlas descriptive statistic recomputed on 2025 (turns vs run-throughs, IV into the event)
Read once. Do not re-cut.
"""
import sys
import numpy as np
import pandas as pd

sys.path.insert(0, "scripts")
import study_0dte_atlas as A  # zigzag

MNQ = 40.7


def wilson(k, n, z=1.96):
    if n == 0: return (np.nan, np.nan)
    p = k / n; d = 1 + z * z / n; c = (p + z * z / (2 * n)) / d
    h = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (c - h, c + h)


def table(df, by, label):
    rows = []
    for key, x in df.groupby(by, observed=True):
        filled = x[x.status != "no_fill"]; res = filled[filled.status.isin(["win", "stopped"])]
        w = int((res.status == "win").sum()); lo, hi = wilson(w, len(res))
        hr = x[x.held != "unresolved"]; h = int((hr.held == "held").sum()); hlo, hhi = wilson(h, len(hr))
        rows.append({"group": key if not isinstance(key, tuple) else " · ".join(map(str, key)), "approaches": len(x), "fill%": round(100 * len(filled) / len(x), 0),
                     "win|resolved%": round(100 * w / len(res), 1) if len(res) else np.nan, "ci": f"{100*lo:.0f}-{100*hi:.0f}" if len(res) else "",
                     "level held%": round(100 * h / len(hr), 1) if len(hr) else np.nan, "ci_h": f"{100*hlo:.0f}-{100*hhi:.0f}" if len(hr) else "",
                     "exp MNQ/fill": round(filled.pnl.mean() * MNQ, 1) if len(filled) else np.nan})
    print(f"\n### {label}\n"); print(pd.DataFrame(rows).to_string(index=False))


def main():
    d = pd.read_parquet("data/study/forward_2025_approaches.parquet")
    d["month"] = d.date.str[:7]
    d["tod"] = pd.cut(d.mins_to_close, [0, 90, 240, 400], labels=["<90 min left", "90-240", ">240 (morning)"])
    d["state"] = np.select([(d.cls == "rising") & d.rolled, d.cls == "rising", d.cls == "falling"], ["rising, rolled over", "rising", "falling"], "flat")
    print(f"# 2025 FORWARD TEST — {d.date.nunique()} days, {len(d)} first approaches to a whole strike within ±1% of spot")
    print("bracket 40/80 MNQ, limit at the strike, trade-through fill, adverse-first · 'level held' = rejected ≥ 80 MNQ before overshooting 40, from contact, fill or not")
    print("\n## A. PRE-REGISTERED TEST — IV state decided one minute BEFORE contact")
    table(d, "cls", "all approaches by 30-min ATM IV class (prediction: rising ≫ falling)")
    table(d, ["side", "cls"], "by side × IV class")
    table(d, "state", "rising split by whether IV had already rolled >1 pt off its 60-min peak")
    table(d, ["side", "state"], "side × state")
    table(d, ["tod", "cls"], "time of day × IV class")
    table(d, ["month", "cls"], "month × IV class (stability)")
    print("\n## B. ATLAS STATISTIC RECOMPUTED ON 2025 (turns vs run-throughs need OI for run-throughs; here: turns vs ALL other strike contacts)")
    s = pd.read_parquet("data/study/forward_2025_series.parquet")
    out = []
    for date, g in s.groupby("date"):
        g = g.reset_index(drop=True)
        turns = A.zigzag(g.hi.to_numpy(), g.lo.to_numpy(), g.cl.to_numpy(), A.SWING)
        for j, (ti, price, kind) in enumerate(turns):
            pre = abs(price - (turns[j - 1][1] if j else g.cl.iloc[0]))
            if pre < A.PRE_SWING or ti < 31: continue
            iv_now = g.atm_iv.iloc[ti - 1]; iv_prev = g.atm_iv.iloc[ti - 31]
            peak = g.atm_iv.iloc[max(0, ti - 61):ti].max()
            if not (np.isfinite(iv_now) and np.isfinite(iv_prev)): continue
            out.append(dict(kind=kind, d_iv=100 * (iv_now - iv_prev), off_peak=100 * (peak - iv_now)))
    t = pd.DataFrame(out)
    for k in ("bottom", "top"):
        x = t[t.kind == k]
        print(f"  {k}s n={len(x)}: IV rising >1pt into {100*(x.d_iv>1).mean():.0f}% · falling >1pt into {100*(x.d_iv<-1).mean():.0f}% · median {x.d_iv.median():+.2f} · already >1pt off 60-min peak at t-1: {100*(x.off_peak>1).mean():.0f}%")
    print("  (2022-24 atlas: bottoms rising 53% / falling 23%; tops rising 27% / falling 51%; off-peak 45% / 43%)")


if __name__ == "__main__":
    main()
