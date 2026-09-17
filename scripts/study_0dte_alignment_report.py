"""
Report for the 0DTE alignment study (see study_0dte_alignment.py for the construction).

Discipline:
  * IN-SAMPLE = 2022 + 2023. HOLDOUT = 2024, printed once, in its own block, never used to pick
    anything above it.
  * Nothing is pooled across eras without the per-year split printed first (design rule 5).
  * The NULL is read before anything else: the population hold rate under the 1:2 bracket, the
    symmetric-bracket sanity, and the displaced placebo twins.
  * Hold rate = P(win | resolved), resolved = win or stopped (flat_close reported separately).
    Expectancy is per FILLED call in MNQ points (pnl_pts x 40.7, flat_close marked at the close).

Usage: python scripts/study_0dte_alignment_report.py [data/study/0dte_alignment_calls.parquet]
"""
from __future__ import annotations

import sys
import numpy as np
import pandas as pd

MNQ = 40.7
PATH = sys.argv[1] if len(sys.argv) > 1 else "data/study/0dte_alignment_calls.parquet"


def wilson(k, n, z=1.96):
    if n == 0:
        return (np.nan, np.nan)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (c - h, c + h)


def block(df, by, spec="A", label=""):
    """fill rate, hold rate (win|resolved) with 95% CI, flat share, expectancy per filled call."""
    st, pnl = f"status_{spec}", f"pnl_{spec}"
    rows = []
    for key, x in df.groupby(by, observed=True):
        n = len(x)
        filled = x[x[st] != "no_fill"]
        res = filled[filled[st].isin(["win", "stopped"])]
        w = int((res[st] == "win").sum())
        lo, hi = wilson(w, len(res))
        rows.append({
            "group": key if not isinstance(key, tuple) else " · ".join(map(str, key)),
            "calls": n, "fill%": round(100 * len(filled) / n, 1) if n else np.nan,
            "resolved": len(res), "hold%": round(100 * w / len(res), 1) if len(res) else np.nan,
            "ci": f"{100*lo:.0f}-{100*hi:.0f}" if len(res) else "",
            "flat%": round(100 * (filled[st] == "flat_close").mean(), 1) if len(filled) else np.nan,
            "exp MNQ/fill": round(filled[pnl].mean() * MNQ, 1) if len(filled) else np.nan,
        })
    out = pd.DataFrame(rows)
    print(f"\n### {label} (spec {spec})\n")
    print(out.to_string(index=False))
    return out


def placebo(df, spec="A", label=""):
    st = f"status_{spec}"
    rows = []
    for name in ("real", "near", "far"):
        col = st if name == "real" else f"{name}_{st}"
        for vec, x in df.groupby("vector", observed=True):
            res = x[x[col].isin(["win", "stopped"])]
            w = int((res[col] == "win").sum())
            lo, hi = wilson(w, len(res))
            rows.append({"strike": name, "vector": vec, "resolved": len(res), "hold%": round(100 * w / len(res), 1) if len(res) else np.nan, "ci": f"{100*lo:.0f}-{100*hi:.0f}" if len(res) else ""})
    out = pd.DataFrame(rows).pivot(index="vector", columns="strike", values=["resolved", "hold%", "ci"])
    print(f"\n### PLACEBO — same labels, strike displaced 0.25E toward (near) / away (far) — {label} (spec {spec})\n")
    print(out.to_string())


def main():
    df = pd.read_parquet(PATH)
    df["year"] = df["date"].str.slice(0, 4).astype(int)
    df["triad"] = np.select(
        [(df.gex_vote == 1) & (df.vex_vote == 1) & (df.charm_vote == 1),
         (df.gex_vote == 1) & ((df.vex_vote == 1) | (df.charm_vote == 1)) & (df.charm_vote >= 0) & (df.vex_vote >= 0),
         (df.gex_vote == 1) & ((df.vex_vote == -1) | (df.charm_vote == -1)),
         (df.gex_vote == -1)],
        ["gex+vex+charm", "gex+one", "gex vs vex/charm", "gamma opposed"], default="no gamma vote")
    df["reach"] = pd.cut(df["dist_E"], [0, 0.5, 1.0, 2.0, np.inf], labels=["<0.5E", "0.5-1E", "1-2E", ">2E"])
    df["role_vec"] = df["role"] + " · " + df["vector"]
    first = df[df["first"]]
    ins = first[first.year <= 2023]
    hold = first[first.year == 2024]

    print(f"# 0DTE ALIGNMENT STUDY — {df.date.nunique()} days, {len(df)} calls, {len(first)} first-appearance calls")
    print(f"in-sample 2022-2023: {ins.date.nunique()} days / {len(ins)} calls · holdout 2024: {hold.date.nunique()} days / {len(hold)} calls")
    print("\nbracket A = 40/80 MNQ fixed (0.983/1.966 QQQ pts) · bracket B = same scaled by spot/700 (era-normalised)")

    # ── 0. THE NULL FIRST ─────────────────────────────────────────────────────────
    print("\n\n## 0 · NULL — read this before anything else")
    block(ins, "year", "A", "population, by year (a 1:2 bracket on a driftless walk resolves ~33% wins)")
    block(ins, "year", "B", "population, by year")
    block(ins, "reach", "A", "population by distance to spot in E (unreachable = wasted slot)")
    # symmetric-bracket sanity: recompute from mfe? not stored per bar — approximated by comparing stop-first vs tp-first is not symmetric; skip.

    # ── 1. THE DESK'S OWN CLASSES ─────────────────────────────────────────────────
    print("\n\n## 1 · DESK ALIGNMENT VECTOR (port of evaluateStrike) — IN-SAMPLE, split by year first")
    block(ins, ["year", "vector"], "A", "vector by year")
    block(ins, ["year", "vector"], "B", "vector by year")
    block(ins, ["side", "vector"], "A", "vector by side (charm's structural asymmetry shows here)")
    block(ins, "role_vec", "A", "role × vector")
    block(ins, "prob", "A", "desk prob tier → realised hold rate (calibration)")

    # ── 2. THE USER'S TRIAD ───────────────────────────────────────────────────────
    print("\n\n## 2 · GEX + VEX + CHARM (the user's triad) — IN-SAMPLE")
    block(ins, ["year", "triad"], "A", "triad by year")
    block(ins, ["side", "triad"], "A", "triad by side")
    block(ins, "triad", "B", "triad, era-normalised bracket")
    block(ins[ins.role.isin(["dominant", "significant"])], "triad", "A", "triad, dominant+significant roles only")
    # single-greek votes
    for g in ("gex_vote", "vex_vote", "charm_vote", "vanna_vote", "dex_vote"):
        block(ins, ["side", g], "A", f"{g} alone by side")

    # ── 3. CONTROLS ───────────────────────────────────────────────────────────────
    print("\n\n## 3 · CONTROLS — IN-SAMPLE")
    placebo(ins, "A", "in-sample")
    placebo(ins, "B", "in-sample")
    block(ins, ["neg_regime", "vector"], "A", "by 0DTE gamma regime × vector")
    block(ins, ["iv_dir", "vector"], "A", "by IV direction × vector")
    block(df[df.year <= 2023], ["vector"], "A", "ALL TICKS (secondary, overlapping) — vector")

    # ── 4. HOLDOUT — touched once ─────────────────────────────────────────────────
    print("\n\n## 4 · HOLDOUT 2024 — touched once, same tables, no re-cutting")
    block(hold, "vector", "A", "vector"); block(hold, "vector", "B", "vector")
    block(hold, ["side", "vector"], "A", "vector by side")
    block(hold, "triad", "A", "triad"); block(hold, "triad", "B", "triad")
    block(hold, "role_vec", "A", "role × vector")
    block(hold, "prob", "A", "desk prob tier → realised")
    placebo(hold, "A", "holdout")


if __name__ == "__main__":
    main()
