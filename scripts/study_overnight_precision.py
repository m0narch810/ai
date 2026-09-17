"""
OVERNIGHT PRECISION — is the small-overshoot touch (user: "the good ones don't overshoot more than
10 MNQ": 712 at 05:49 on 2026-09-17, 700 at 15:27 on 2026-09-16) a property of the SESSION?

For every Globex session 2022-23 (16:00 close → 09:30 next open), every first contact of a whole
QQQ strike within ±1.5% of the close, plus the prior day's RTH high / low / close, graded on the NQ
1-min bars converted by the day's 15:59 ratio (the same trade-through fill, adverse-first grader):
overshoot ladder, adverse ≤10 before a 40 / 80 run, run15→80, run40→80, P&L at the 09:30 open.
Split by sub-session: Globex evening 18:00-00:00, Asia 00:00-04:00, Europe 04:00-08:00, pre-market
08:00-09:30. RTH comparison numbers come from contacts_222324 (fresh fills).

Only whole strikes and price levels: the 0DTE share data cannot supply tomorrow's chain, so no
positioning levels exist overnight in this data. Pre-registered 2026-09-17.
    python scripts/study_overnight_precision.py [--smoke]
"""
from __future__ import annotations
import glob, os, sys
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(__file__))
import study_0dte_alignment as S
try: sys.stdout.reconfigure(encoding="utf-8")
except Exception: pass
MNQ = S.MNQ_PER_QQQ; CONTACT = 0.5; NEAR = 0.015
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "study")
SESS = [("evening", 18 * 60, 24 * 60), ("asia", 0, 4 * 60), ("europe", 4 * 60, 8 * 60), ("premarket", 8 * 60, 9 * 60 + 30)]


def load_nq():
    d = pd.read_parquet(S.NQ_BARS, columns=["date", "open", "high", "low", "close"])
    d = d[(d["date"] >= "2021-12-31") & (d["date"] < "2024-01-03")].copy()
    d["day"] = d["date"].dt.strftime("%Y-%m-%d"); d["min"] = d["date"].dt.hour * 60 + d["date"].dt.minute
    return d


def grade(lo, hi, cl, sup, K):
    fill = lo < K if sup else hi > K
    if not fill.any(): return None
    fi = int(np.argmax(fill)); lo, hi, cl = lo[fi:], hi[fi:], cl[fi:]
    adverse = (K - lo) if sup else (hi - K); fav = (hi - K) if sup else (K - lo)
    out = dict(fill_min=fi, mae=float(adverse.max()) * MNQ, mfe=float(fav.max()) * MNQ)
    for s_ in (10, 15, 40):
        hit = adverse >= s_ / MNQ; si = int(np.argmax(hit)) if hit.any() else None
        favb = fav[:si + 1] if si is not None else fav
        for r_ in (40, 80):
            ok = favb >= r_ / MNQ
            out[f"run{s_}_{r_}"] = bool(ok.any() and (si is None or int(np.argmax(ok)) < si))
        out[f"surv{s_}"] = si is None
        out[f"pnl{s_}"] = (-s_) if si is not None else float((cl[-1] - K) if sup else (K - cl[-1])) * MNQ
    return out


def main():
    smoke = "--smoke" in sys.argv
    nq = load_nq(); days = sorted(nq.day.unique())
    files = {f"{os.path.basename(f)[7:11]}-{os.path.basename(f)[11:13]}-{os.path.basename(f)[13:15]}": f for y in (2022, 2023) for f in glob.glob(os.path.join(S.SHARE, str(y), "greeks", "greeks_*.csv.gz"))}
    dates = sorted(files); dates = dates[:5] if smoke else dates
    rows = []
    for k, date in enumerate(dates):
        if k + 1 >= len(dates) and not smoke: break
        g = pd.read_csv(files[date], usecols=["minute", "F"]).dropna(); fwd = g.groupby("minute")["F"].first()
        rth = nq[(nq.day == date) & (nq["min"] >= 570) & (nq["min"] < 960)]
        if len(rth) < 300 or fwd.empty: continue
        rth = rth.set_index(rth["date"].dt.strftime("%H:%M"))
        common = [m for m in fwd.index if m in rth.index][-30:]
        if len(common) < 10: continue
        ratio = float(np.median([rth.at[m, "close"] / fwd[m] for m in common]))
        close = float(rth.close.iloc[-1]) / ratio; hod = float(rth.high.max()) / ratio; lod = float(rth.low.min()) / ratio
        # the overnight: bars from 16:00 on `date` to 09:30 on the next trading day in the frame
        i = days.index(date) if date in days else None
        if i is None or i + 1 >= len(days): continue
        nxt = days[i + 1]
        ev = nq[(nq.day == date) & (nq["min"] >= 16 * 60)]; nt = nq[(nq.day == nxt) & (nq["min"] < 570)]
        on = pd.concat([ev, nt]); on = on[(on["min"] >= 18 * 60) | (on.day == nxt)]
        if len(on) < 200: continue
        lo = on.low.to_numpy() / ratio; hi = on.high.to_numpy() / ratio; cl = on.close.to_numpy() / ratio; mins = on["min"].to_numpy(); dayarr = on.day.to_numpy()
        levels = [("strike", float(K)) for K in range(int(np.floor(close * (1 - NEAR))), int(np.ceil(close * (1 + NEAR))) + 1)]
        levels += [("prior_close", close), ("prior_hod", hod), ("prior_lod", lod)]
        seen = set()
        for j in range(1, len(on)):
            prev_c = cl[j - 1]
            for typ, K in levels:
                for side in ("support", "resistance"):
                    key = (typ, round(K, 2), side)
                    if key in seen: continue
                    sup = side == "support"
                    contact = (prev_c > K + CONTACT and lo[j] <= K + CONTACT) if sup else (prev_c < K - CONTACT and hi[j] >= K - CONTACT)
                    if not contact: continue
                    seen.add(key)
                    m = int(mins[j]); sess = next((n for n, a, b in SESS if a <= m < b), None)
                    if sess is None: continue
                    o = grade(lo[j:], hi[j:], cl[j:], sup, K)
                    rec = dict(date=date, night_of=nxt, sess=sess, hm=f"{m // 60:02d}:{m % 60:02d}", ltype=typ, K=K, side=side, filled=o is not None, dist_close=abs(K - close))
                    if o: rec.update(o)
                    rows.append(rec)
        if (k + 1) % 50 == 0: print(f"  {k + 1}/{len(dates)} · {len(rows)} contacts", flush=True)
    df = pd.DataFrame(rows); df.to_parquet(os.path.join(OUT, f"overnight_{'smoke' if smoke else '2223'}.parquet"), index=False)
    print("wrote", len(df)); report(df)


def report(df):
    print("\n# OVERNIGHT PRECISION — Globex sessions 2022-23, whole strikes ±1.5% of the close + prior HOD/LOD/close")
    print("overshoot = max adverse after the fill (MNQ) · precise = adverse ≤10 before the run · BE: 10/40 20%, 15/80 15.8%, 40/80 33.3%")
    def line(g):
        f = g[g.filled]
        if len(f) < 30: return f"n={len(g)} (too few fills)"
        return (f"contacts {len(g):5d} · filled {100*len(f)/len(g):3.0f}% · overshoot med {f.mae.median():4.0f} MNQ · ≤10 {100*(f.mae<=10).mean():3.0f}% · ≤15 {100*(f.mae<=15).mean():3.0f}% · "
                f"p40 {100*f.run10_40.mean():4.1f}% · p80 {100*f.run10_80.mean():4.1f}% · run15→80 {100*f.run15_80.mean():4.1f}% · run40→80 {100*f.run40_80.mean():4.1f}% · pnl15@open {f.pnl15.mean():+5.1f} · pnl40 {f.pnl40.mean():+5.1f}")
    print("\n## by session"); [print(f"  {s:>9}: {line(df[df.sess == s])}") for s, _, _ in SESS]
    print("\n## by level type"); [print(f"  {t:>12}: {line(df[df.ltype == t])}") for t in ["strike", "prior_close", "prior_hod", "prior_lod"]]
    print("\n## strikes by session × side")
    for s, _, _ in SESS:
        for side in ["support", "resistance"]: print(f"  {s:>9} {side:>10}: {line(df[(df.sess == s) & (df.ltype == 'strike') & (df.side == side)])}")
    print("\n## by year"); [print(f"  {y}: {line(df[df.date.str.startswith(y)])}") for y in ["2022", "2023"]]
    # RTH comparison from the contacts table (fresh fills, whole strikes)
    try:
        c = pd.read_parquet(os.path.join(OUT, "contacts_222324.parquet"))
        for col in [x[:-2] for x in c.columns if x.endswith("_x")]: c[col] = c[f"{col}_x"]; c = c.drop(columns=[f"{col}_x", f"{col}_y"])
        c = c[c.filled & (c.date < "2024") & (c.fill_min <= 5) & (c.ltype == "strike") & (c.mins_to_close >= 15)]
        print(f"\n## RTH comparison (contacts_222324, whole strikes, fresh fills): n={len(c)} · overshoot med {c.mae_close.median():.0f} · ≤10 {100*(c.mae_close<=10).mean():.0f}% · ≤15 {100*(c.mae_close<=15).mean():.0f}% · p40 {100*c.run10_40.astype(bool).mean():.1f}% · p80 {100*c.run10_80.astype(bool).mean():.1f}% · run15→80 {100*c.run15_80.astype(bool).mean():.1f}% · run40→80 {100*c.run40_80.astype(bool).mean():.1f}%")
    except Exception as e: print("RTH comparison failed:", e)


if __name__ == "__main__":
    if "--report" in sys.argv: report(pd.read_parquet(os.path.join(OUT, "overnight_2223.parquet")))
    else: main()
