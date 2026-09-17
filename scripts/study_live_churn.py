"""
LIVE-FEED WALL CHURN — how often the walls the terminal shows actually change, and whether a
wall that has persisted holds better than one that just appeared.

Sources (all produced by the running system, not a backtest):
  * data/study/captures_walls.jsonl — every cloud capture (capture.mjs, ~15-min grid + fast
    ticks) 2026-06-22 → 2026-09-17: spot, call/put wall, vol trigger, max pain, 0DTE walls, the
    top-6 |gex| strikes, ATM IV and the 1-day expected move. Altaris until 2026-07-16, YYY after.
  * data/scored/<date>.calibration.jsonl — the desk detector's own grades (Yahoo 1-min) for
    every candidate strike: reversed / broke / untouched, with touchedAt. Bracket semantics
    changed 2026-08-15 (0.5/3.0 → 0.98/1.97 QQQ pts), so eras are split, never pooled.
  * data/scored/<date>.boards.jsonl — the desk's published levels per tick (persistence).

Pre-registered 2026-09-17. Descriptive first (Q1), then one hypothesis (Q2): a wall that held
its title for ≥4 ticks (~1 h) before the touch holds more often than one with ≤1 tick.
    python scripts/study_live_churn.py
"""
from __future__ import annotations
import glob, json, os, sys
from collections import Counter, defaultdict
import numpy as np, pandas as pd
try: sys.stdout.reconfigure(encoding="utf-8")
except Exception: pass

ROOT = os.path.join(os.path.dirname(__file__), "..")
CAP = os.path.join(ROOT, "data", "study", "captures_walls.jsonl")
SCORED = os.path.join(ROOT, "data", "scored")
ERA_SPLIT = "2026-08-15"
WALL_FIELDS = ["call_wall", "put_wall", "vol_trigger", "max_pain", "call_wall_0dte", "put_wall_0dte"]


def load_captures():
    rows = [json.loads(l) for l in open(CAP, encoding="utf-8")]
    df = pd.DataFrame(rows)
    df["date"] = df.key.str.slice(0, 10)
    df["hm"] = df.capturedAt.str.slice(11, 16)
    df = df[(df.hm >= "09:30") & (df.hm <= "16:00")].sort_values(["date", "capturedAt"]).reset_index(drop=True)
    df["top_gex"] = df.gex_top.map(lambda t: float(t[0][0]) if isinstance(t, list) and t else np.nan)
    df["provider"] = np.where(df.date < "2026-07-17", "altaris", "yyy")
    return df


def q1_churn(df):
    print(f"# LIVE WALL CHURN — {df.date.nunique()} days, {len(df)} RTH captures ({df.groupby('date').size().median():.0f}/day median), {df.date.min()} → {df.date.max()}")
    print("\n## Q1 how often each published level changes between consecutive captures (per day, then median across days)")
    print(f"{'field':>16} {'provider':>9} {'days':>5} {'distinct/day':>13} {'chg%/tick':>10} {'med tenure (ticks)':>19} {'|x−spot|/EM med':>16} {'==spot strike%':>15}")
    for prov, g in df.groupby("provider"):
        for fld in WALL_FIELDS + ["top_gex"]:
            per = []
            for d, day in g.groupby("date"):
                v = day[fld].to_numpy(float); s = day.spot.to_numpy(float); em = day.expected_move.to_numpy(float)
                ok = np.isfinite(v)
                if ok.sum() < 5: continue
                v, s, em = v[ok], s[ok], em[ok]
                chg = np.mean(v[1:] != v[:-1]) if len(v) > 1 else np.nan
                runs, r = [], 1
                for i in range(1, len(v)):
                    if v[i] == v[i - 1]: r += 1
                    else: runs.append(r); r = 1
                runs.append(r)
                dist = np.nanmedian(np.abs(v - s) / np.where(em > 0, em, np.nan))
                at_spot = np.mean(np.abs(v - np.round(s)) < 0.75)
                per.append((len(set(v)), chg, np.median(runs), dist, at_spot))
            if not per: continue
            a = np.array(per, float)
            print(f"{fld:>16} {prov:>9} {len(per):5d} {np.median(a[:, 0]):13.1f} {100 * np.median(a[:, 1]):10.0f} {np.median(a[:, 2]):19.1f} {np.median(a[:, 3]):16.2f} {100 * np.mean(a[:, 4]):15.0f}")
    # intraday: does churn cluster at the open?
    print("\n### share of call/put wall changes by hour (yyy era)")
    y = df[df.provider == "yyy"].copy()
    y["hour"] = y.hm.str.slice(0, 2)
    for fld in ["call_wall", "put_wall", "vol_trigger"]:
        cnt = Counter()
        for d, day in y.groupby("date"):
            v = day[fld].to_numpy(float); h = day.hour.to_numpy()
            for i in range(1, len(v)):
                if np.isfinite(v[i]) and np.isfinite(v[i - 1]) and v[i] != v[i - 1]: cnt[h[i]] += 1
        tot = sum(cnt.values()) or 1
        print(f"  {fld:>12}: " + " · ".join(f"{h}h {100 * cnt[h] / tot:.0f}%" for h in sorted(cnt)))
    # how often are the walls ON TOP of spot (the ATM-riding pattern seen 2026-09-17)
    print("\n### the ATM-riding pattern (yyy era): fraction of captures where …")
    print(f"  call_wall == vol_trigger: {100 * np.mean(y.call_wall == y.vol_trigger):.0f}% · call_wall within 0.25 EM of spot: {100 * np.mean((y.call_wall - y.spot).abs() <= 0.25 * y.expected_move):.0f}% · put_wall within 0.25 EM: {100 * np.mean((y.put_wall - y.spot).abs() <= 0.25 * y.expected_move):.0f}% · call_wall_0dte == put_wall_0dte: {100 * np.mean(y.call_wall_0dte == y.put_wall_0dte):.0f}%")
    print(f"  call_wall ABOVE spot: {100 * np.mean(y.call_wall > y.spot):.0f}% · put_wall BELOW spot: {100 * np.mean(y.put_wall < y.spot):.0f}%")


def load_calibration():
    out = []
    for f in sorted(glob.glob(os.path.join(SCORED, "*.calibration.jsonl"))):
        date = os.path.basename(f)[:10]
        lines = [json.loads(l) for l in open(f, encoding="utf-8")]
        if not lines: continue
        for d in lines[-1].get("detected", []):
            if not d.get("touched"): continue
            out.append(dict(date=date, strike=float(d["strike"]), side=d["side"], outcome=d.get("outcome"), touchedAt=d.get("touchedAt"), clean=d.get("clean"), overshoot=d.get("overshoot")))
    df = pd.DataFrame(out)
    df["era"] = np.where(df.date < ERA_SPLIT, "pre-0815 (0.5/3.0)", "post-0815 (40/80)")
    return df


def load_boards():
    out = []
    for f in sorted(glob.glob(os.path.join(SCORED, "*.boards.jsonl"))):
        date = os.path.basename(f)[:10]
        for l in open(f, encoding="utf-8"):
            b = json.loads(l)
            at = b.get("as_of") or ""
            sc = b.get("scored_at")
            for lv in b.get("levels", []):
                out.append(dict(date=date, scored_at=sc, strike=float(lv["strike"]), side=lv.get("side"), prob=lv.get("reversal_prob")))
    return pd.DataFrame(out)


def rate_table(df, by, title):
    print(f"\n### {title}")
    print(f"{'group':>36} {'touched':>8} {'reversed':>9} {'broke':>6} {'hold%':>6}")
    for key, g in df.groupby(by, dropna=False, observed=True):
        rv = int((g.outcome == "reversed").sum()); br = int((g.outcome == "broke").sum())
        k = " · ".join(str(x) for x in key) if isinstance(key, tuple) else str(key)
        print(f"{k:>36} {len(g):8d} {rv:9d} {br:6d} {100 * rv / (rv + br) if rv + br else np.nan:6.0f}")


def q2_tenure(df, cal, boards):
    print("\n## Q2 does a wall's TENURE before the touch predict the detector's grade?")
    print("   tenure = consecutive captures (≈15 min each) the strike held the side-matched title right before touchedAt; 'at touch' = it was the wall on the last capture before the touch")
    caps = {d: g for d, g in df.groupby("date")}
    recs = []
    for r in cal.itertuples():
        g = caps.get(r.date)
        if g is None or not r.touchedAt: continue
        before = g[g.capturedAt < r.touchedAt]
        if before.empty: continue
        fld = "put_wall" if r.side == "support" else "call_wall"
        lst = "put_walls" if r.side == "support" else "call_walls"
        v = before[fld].to_numpy(float)
        at_touch = bool(v[-1] == r.strike)
        ten = 0
        for x in v[::-1]:
            if x == r.strike: ten += 1
            else: break
        in_list = before[lst].map(lambda L: isinstance(L, list) and r.strike in [float(x) for x in L]).to_numpy()
        ten_list = 0
        for x in in_list[::-1]:
            if x: ten_list += 1
            else: break
        ever = bool((v == r.strike).any())
        recs.append(dict(date=r.date, era=r.era, strike=r.strike, side=r.side, outcome=r.outcome, at_touch=at_touch, tenure=ten, tenure_list=ten_list, ever_wall=ever, in_top3=bool(in_list[-1])))
    t = pd.DataFrame(recs)
    t = t[t.outcome.isin(["reversed", "broke"])]
    t["tenure_b"] = pd.cut(t.tenure, [-1, 0, 1, 3, 999], labels=["0 (not the wall)", "1 tick", "2-3 ticks", "4+ ticks (≥1h)"])
    t["tenure3_b"] = pd.cut(t.tenure_list, [-1, 0, 1, 3, 999], labels=["0", "1 tick", "2-3 ticks", "4+ ticks"])
    print(f"   {len(t)} touched+resolved detector strikes with a capture history")
    rate_table(t, ["era"], "base rate by era (detector grades)")
    rate_table(t, ["era", "at_touch"], "was the side-matched wall at the touch")
    rate_table(t, ["era", "tenure_b"], "tenure as THE wall")
    rate_table(t, ["era", "tenure3_b"], "tenure in the top-3 side list")
    rate_table(t, ["era", "ever_wall"], "was the wall at ANY capture before the touch")
    # desk board persistence
    print("\n## Q3 desk-board level persistence (ticks a strike sat on the published board before its touch)")
    bd = {d: g for d, g in boards.groupby("date")}
    recs = []
    for r in cal.itertuples():
        g = bd.get(r.date)
        if g is None or not r.touchedAt: continue
        ts = pd.Timestamp(r.touchedAt)
        gg = g[(g.side == r.side) & (g.strike == r.strike)]
        n_before = int((pd.to_datetime(gg.scored_at, unit="ms", utc=True).dt.tz_convert("America/New_York").dt.tz_localize(None) < ts).sum())
        on_board = n_before > 0
        recs.append(dict(era=r.era, outcome=r.outcome, ticks_on_board=n_before, on_board=on_board))
    b = pd.DataFrame(recs); b = b[b.outcome.isin(["reversed", "broke"])]
    b["ticks_b"] = pd.cut(b.ticks_on_board, [-1, 0, 1, 3, 999], labels=["never on board", "1 tick", "2-3 ticks", "4+ ticks"])
    rate_table(b, ["era", "ticks_b"], "detector grade by how long the strike had been a published desk level")


if __name__ == "__main__":
    df = load_captures()
    q1_churn(df)
    cal = load_calibration(); boards = load_boards()
    print(f"\ncalibration: {len(cal)} touched strikes over {cal.date.nunique()} days; outcomes {dict(Counter(cal.outcome))}")
    q2_tenure(df, cal, boards)
