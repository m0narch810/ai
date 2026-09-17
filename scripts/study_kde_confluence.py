"""
KDE CONFLUENCE — the "typhoon" method (his site): collect ~30 weighted level candidates from many source
types, lay a Gaussian kernel over each on a price grid, sum into one density curve, and score each strike by
that curve. The bet is that a level where MANY INDEPENDENT sources agree reacts / travels better than one where
few do. Prior confluence tests here were per-source (each null); this is the first that scores AGREEMENT.

PRE-REGISTERED 2026-09-17 before these outcomes were computed. Same protocol as the far-travel studies.
SOURCES built per capture (9 of his 12; his CHURN_WALL/ABSORPTION/PERSISTENCE need a traded-flow feed we lack):
  gamma call/put walls, major, max_pain (weight 1.5)   OI gamma walls: top-3 |gex| and top-3 OI strikes (1.2)
  gamma flip (1.3)   charm sign-flip strike (1.0)   vanna sign-flip strike (1.0)
  expected-move edges spot±EM (1.0)   sigma bands spot ± 1·EM_close and 2·EM_close (0.8)
  prior-day high/low/close, overnight high/low, session open (1.0)   volume-profile peaks from NQ bars (1.1)
KERNEL   Gaussian, bandwidth = 0.30 × EM_to_close in QQQ pts (scales with vol; fixed, not tuned). Grid 0.1 pt.
SCORE    at a strike K: density(K) as a percentile within ±1.5% of spot (relative, cross-greek-safe), AND the
         count of DISTINCT source types with a candidate within the bandwidth of K (his "distinct sources").
OUTCOME  filled trade, ≥120 MNQ before the 15 stop (BE 11.1%); secondary reaction +40 (BE 27.3%) and +80 (15.8%).
FILTERS  K1 top-tercile KDE density   K2 ≥4 distinct sources   K3 ≥6 distinct sources   K4 near a KDE peak (±0.25 EM)
         K5 top-tercile density AND ≥4 sources   plus a monotone check: reaction rate by source-count bucket.
PASS     with − without ≥ +3 pts on ≥120 in both live halves, ≥100 trades with the filter per half; then the
         same on 2022-23 (built from the historical per-tick tape, fewer sources) before it means anything.
    python scripts/study_kde_confluence.py
"""
from __future__ import annotations
import os, sys
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(__file__))
import study_ledger_greeks as L
import study_precise_leadup as P
import study_far_travel as FT
try: sys.stdout.reconfigure(encoding="utf-8")
except Exception: pass
ST = L.ST; MNQ = L.MNQ; COST = 1.0; BW_FRAC = 0.30


def sign_flip_strikes(series):
    """strikes where a per-strike greek changes sign between K and K+1 (both sides count as the boundary)."""
    ks = sorted(series.index)
    out = []
    for a, b in zip(ks, ks[1:]):
        va, vb = series[a], series[b]
        if np.isfinite(va) and np.isfinite(vb) and va != 0 and vb != 0 and np.sign(va) != np.sign(vb):
            out.append((a + b) / 2)
    return out


def candidates(c0, gb, prof_peaks, refs, spot, em, em_close):
    """(price, weight, source_type) list for one capture."""
    out = []
    def add(p, w, src):
        if isinstance(p, (int, float)) and np.isfinite(p) and p > 0: out.append((float(p), w, src))
    for k in ("cw", "pw", "major", "max_pain"): add(c0.get(k), 1.5, "GWALL")
    add(c0.get("flip"), 1.3, "FLIP")
    for p in (c0.get("call_walls") or [])[:3]: add(p, 1.2, "OIWALL")
    for p in (c0.get("put_walls") or [])[:3]: add(p, 1.2, "OIWALL")
    if gb is not None and len(gb):
        band = gb[(gb.index >= spot * 0.985) & (gb.index <= spot * 1.015)]
        for p in band.gex.abs().nlargest(3).index: add(p, 1.2, "GEXHEAVY")
        for p in band.oi_tot.nlargest(3).index: add(p, 1.2, "OIHEAVY")
        for p in sign_flip_strikes(band.charm): add(p, 1.0, "CHARMFLIP")
        for p in sign_flip_strikes(band.vanna): add(p, 1.0, "VANNAFLIP")
    if np.isfinite(em): add(spot + em, 1.0, "EM"); add(spot - em, 1.0, "EM")
    if np.isfinite(em_close): add(spot + em_close, 0.8, "SIGMA"); add(spot - em_close, 0.8, "SIGMA"); add(spot + 2 * em_close, 0.8, "SIGMA"); add(spot - 2 * em_close, 0.8, "SIGMA")
    for p in refs: add(p, 1.0, "PRIOR")
    for p in prof_peaks: add(p, 1.1, "VPPEAK")
    return out


def density_and_count(cands, K, bw):
    """summed Gaussian density at K, and the number of DISTINCT source types within bw of K."""
    if not cands or not (bw > 0): return np.nan, 0
    dens = sum(w * np.exp(-0.5 * ((p - K) / bw) ** 2) for p, w, _ in cands)
    srcs = {src for p, w, src in cands if abs(p - K) <= bw}
    return dens, len(srcs)


def band_percentile(cands, K, spot, bw):
    lo, hi = spot * 0.985, spot * 1.015
    ks = np.arange(np.floor(lo), np.ceil(hi) + 1)
    d = np.array([density_and_count(cands, k, bw)[0] for k in ks])
    dK = density_and_count(cands, K, bw)[0]
    if not np.isfinite(dK) or len(d) < 8: return np.nan
    return float((d <= dK).mean())


def vp_peaks(bars, spot):
    """volume-profile peaks (local maxima of the whole-strike volume profile) within ±2.5% of spot."""
    import study_volnode as V
    acc = V.profile(bars)
    lo, hi = spot * 0.975, spot * 1.025
    vols = {k: V.at(acc, k) for k in range(int(np.floor(lo)), int(np.ceil(hi)) + 1)}
    if len(vols) < 6: return []
    ks = sorted(vols)
    return [k for k in ks if vols[k] > 0 and vols[k] >= vols.get(k - 1, 0) and vols[k] >= vols.get(k + 1, 0) and vols[k] >= 1.2 * np.median(list(vols.values()))]


def live():
    F = pd.read_parquet(os.path.join(ST, "reader_pattern_features.parquet"))
    F["t"] = pd.to_datetime(F.t, utc=True).dt.tz_convert("America/New_York").astype("datetime64[ns, America/New_York]")
    F = F[F.sess == "RTH"].copy()
    nq = L.load_bars("5m"); nq["date_"] = nq.t.dt.strftime("%Y-%m-%d"); nq["min_"] = nq.t.dt.hour * 60 + nq.t.dt.minute
    idx = pd.Series(np.arange(len(nq)), index=nq.t.map(lambda x: x.value))
    book, ctx = P.load_book(); cap_ns = ctx.cap_t.map(lambda x: x.value).to_numpy()
    days = sorted(nq[nq.min_ >= 570].date_.unique())
    rows = []; peak_cache = {}
    for r in F.itertuples():
        i = idx.get(r.t.value)
        if i is None: continue
        i = int(i); sup = r.side == "support"
        g = FT.grade_live(nq, i, r.K, sup)
        if g is None: continue
        j0 = np.searchsorted(cap_ns, r.t.value, side="left") - 1
        if j0 < 0: continue
        c0 = ctx.iloc[j0].to_dict(); gb = book.get(ctx.iloc[j0].key); date = nq.date_.iloc[i]
        spot = nq.cq.iloc[i - 1]; em = c0.get("em", np.nan); mtc = 16 * 60 - (r.t.hour * 60 + r.t.minute)
        atm = c0.get("atm_iv", np.nan)
        em_close = spot * (atm / 100) * np.sqrt(max(mtc, 1) / 525600) if np.isfinite(atm) and atm > 0 else np.nan
        bw = 0.30 * em_close if np.isfinite(em_close) and em_close > 0 else (0.30 * em / MNQ if np.isfinite(em) else np.nan)
        # reference prices: prior 2 RTH highs/lows/closes + overnight extremes + open
        di = days.index(date) if date in days else None
        refs = []
        if di is not None:
            for pd_ in days[max(0, di - 1):di]:
                rr = nq[(nq.date_ == pd_) & (nq.min_ >= 570) & (nq.min_ < 960)]
                if len(rr): refs += [rr.hq.max(), rr.lq.min(), rr.cq.iloc[-1]]
            on = nq[(nq.sday == r.sday) & (nq.sess == "ETH") & (nq.t < r.t)]
            if len(on): refs += [on.hq.max(), on.lq.min()]
            o = nq[(nq.date_ == date) & (nq.min_ == 570)]
            if len(o): refs.append(o.oq.iloc[0])
        key = ctx.iloc[j0].key
        if key not in peak_cache:
            td = nq[(nq.date_ == date) & (nq.min_ >= 570) & (nq.index < i)]
            peak_cache[key] = vp_peaks(td, spot) if len(td) >= 6 else []
        cands = candidates(c0, gb, peak_cache[key], refs, spot, em, em_close)
        if not cands or not (bw > 0): continue
        dens, cnt = density_and_count(cands, r.K, bw)
        pctl = band_percentile(cands, r.K, spot, bw)
        rows.append(dict(sday=r.sday, half_=r.half_, side=r.side, K=r.K, n_sources=cnt, dens_pctl=pctl, n_cands=len(cands), **g))
    return pd.DataFrame(rows)


def history():
    c = FT.history(); s = np.where(c.side == "support", 1, -1)
    # sources available in the historical tape: gamma walls, flip, major, OI walls, sigma (EM), prior H/L/C, open, IV walls
    rows = []
    for r in c.itertuples():
        spot = r.spot; em = r.E * MNQ; bw = 0.30 * r.E
        cn = [(r.cwall, 1.5, "GWALL"), (r.pwall, 1.5, "GWALL"), (r.major, 1.5, "GWALL"), (r.flip, 1.3, "FLIP"),
              (r.coi_wall, 1.2, "OIWALL"), (r.poi_wall, 1.2, "OIWALL"), (r.top1, 1.2, "GEXHEAVY"), (r.top2, 1.2, "GEXHEAVY"), (r.top3, 1.2, "GEXHEAVY"),
              (spot + em, 1.0, "EM"), (spot - em, 1.0, "EM"), (spot + 2 * em, 0.8, "SIGMA"), (spot - 2 * em, 0.8, "SIGMA"),
              (r.hod, 1.0, "PRIOR"), (r.lod, 1.0, "PRIOR"), (r.day_open, 1.0, "PRIOR"),
              (r.ivu_in_frz, 1.1, "IVWALL"), (r.ivl_in_frz, 1.1, "IVWALL")]
        cn = [(float(p), w, sx) for p, w, sx in cn if isinstance(p, (int, float)) and np.isfinite(p) and p > 0]
        if not cn or not (bw > 0): rows.append((np.nan, 0)); continue
        _, cnt = density_and_count(cn, r.K, bw)
        pctl = band_percentile(cn, r.K, spot, bw)
        rows.append((pctl, cnt))
    c["dens_pctl"] = [x[0] for x in rows]; c["n_sources"] = [x[1] for x in rows]
    c["run120"] = c.run15_120.astype(bool); c["run80"] = c.run15_80.astype(bool); c["precise"] = c.run15_40.astype(bool)
    return c


def main():
    out = []; pr = lambda x: (out.append(x), print(x))
    D = live(); H = history()
    D["precise"] = D.run120  # placeholder; verdict() uses run120
    pr("# KDE CONFLUENCE (the typhoon method) — does agreement across sources pick levels that react / travel?")
    pr(f"LIVE RTH fills with a KDE score: {len(D)} · base ≥120 explore {100 * D[D.half_ == 'explore'].run120.mean():.1f}% confirm {100 * D[D.half_ == 'confirm'].run120.mean():.1f}%")
    pr(f"HIST 2022-23 fills: {len(H)} · base ≥120 2022 {100 * H[H.half_ == '2022'].run120.mean():.1f}% 2023 {100 * H[H.half_ == '2023'].run120.mean():.1f}%")
    pr(f"source-count distribution (live): {dict(D.n_sources.value_counts().sort_index())}")
    D["K1"] = D.dens_pctl >= 2 / 3; D["K2"] = D.n_sources >= 4; D["K3"] = D.n_sources >= 6
    D["K5"] = D.K1 & D.K2
    H["K1"] = H.dens_pctl >= 2 / 3; H["K2"] = H.n_sources >= 4; H["K3"] = H.n_sources >= 6; H["K5"] = H.K1 & H.K2
    labels = {"K1": "top-tercile KDE density", "K2": "≥4 distinct sources agree", "K3": "≥6 distinct sources agree", "K5": "top density AND ≥4 sources"}
    passed = []
    for f, lab in labels.items():
        pr(f"\n## {f} {lab}")
        ok = FT.verdict(D, f, ("explore", "confirm"), pr)
        if f in H.columns: ok = FT.verdict(H, f, ("2022", "2023"), pr) and ok
        pr(f"   → {'PASS' if ok else 'fail'}")
        if ok: passed.append(f)
    pr("\n## monotone check — outcome by number of distinct sources (does more agreement = better?)")
    for name, DF, halves in (("LIVE", D, ("explore", "confirm")), ("HIST", H, ("2022", "2023"))):
        pr(f"  {name}:")
        for lo, hi in ((0, 2), (3, 3), (4, 5), (6, 99)):
            g = DF[(DF.n_sources >= lo) & (DF.n_sources <= hi)]
            if len(g) < 60: continue
            pr(f"    {lo}-{hi if hi < 99 else '+'} sources (n={len(g):4d}): react+40 {100 * g.precise.mean():5.1f}% · ≥80 {100 * g.run80.mean():5.1f}% · ≥120 {100 * g.run120.mean():5.1f}%")
    pr(f"\n## PASSED: {passed if passed else 'nothing'}")
    pr("\n## trades (≥40 in a half, net MNQ/trade, 1 MNQ cost)")
    pr(f"{'filter':>6} {'half':>8} {'trades':>7} {'≥120%':>6} {'net +120':>9} {'react%':>7} {'net +80':>8}")
    for f in list(labels) + ["ALL"]:
        for h in ("explore", "confirm"):
            g = D[D.half_ == h] if f == "ALL" else D[(D.half_ == h) & (D[f] == True)]
            if len(g) < 40: continue
            pr(f"{f:>6} {h:>8} {len(g):7d} {100 * g.run120.mean():6.1f} {g.pnl120.mean() - COST:+9.1f} {100 * g.precise.mean():7.1f} {g.pnl80.mean() - COST:+8.1f}")
    D.to_parquet(os.path.join(ST, "kde_confluence_live.parquet"), index=False)
    open(os.path.join(ST, "kde_confluence_report.md"), "w", encoding="utf-8").write("\n".join(out))


if __name__ == "__main__":
    main()
