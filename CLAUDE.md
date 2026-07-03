# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> Trading-algorithm design rules (limit-orders-at-levels, strictly sequential SL/TP outcomes,
> no look-ahead/overfitting) live in the user-level `~/CLAUDE.md` and apply here. THIS project's
> objective is LARGE reversals: 0.5% of spot minimum (TP_MIN_PCT), 1%+ ideal (TP_IDEAL_PCT) —
> the archetype is a bottom/top tick at a pre-called strike running the full range (30-60R on
> the ~20-MNQ-pt stop). Sub-0.5% bounce candidates are noise by design.

## What this is

A local pipeline that pulls QQQ options-flow data from the Altaris terminal, finds price levels
where a reversal is likely, scores each level with an LLM, and publishes a phone/PC-viewable board.
The trader enters on **MNQ futures** via limit orders at QQQ strike prices (~20 MNQ point stop).
System is **level-finding first**: output is a ranked set of strikes to rest limit orders at.

## Commands

```bash
npm run capture        # one full capture → detect → score → publish cycle
npm run backfill [date] # recover a window the PC missed (pull cloud snapshots → score gap)
npm run narrative      # one pre-open narrative pass → web/narrative.json
npm start              # scheduled loop: every SCORE_INTERVAL_MIN during US + Asia windows
npm run score:fixture  # score bundled fixtures/ offline — smoke test
npm run verify         # confirm Altaris cookie is live + detector runs (no scoring)
npm run web            # serve web/ on LAN for phone viewing
npm run publish        # re-deploy latest board to Netlify without re-scoring
npm run typecheck      # tsc --noEmit
```

No test runner, no build. `score:fixture` + `verify` + `typecheck` are the checks.
ESM throughout: relative imports must carry the `.js` extension even though files are `.ts`.

## Pipeline architecture

One cycle is orchestrated in `src/run.ts` (`scoreFromHistory`), four stages:

1. **Capture** (`src/capture.ts` ← `src/altaris.ts` ← `src/auth.ts`) — fetches `/api/data`,
   `/api/greek_timeseries`, `/api/iv_tracker`. Auto-logins via `ALTARIS_USER`/`ALTARIS_PASS`; refreshes
   cookie on 401. `compactSnapshot` drops `*_hm` heatmaps but aggregates `cex_hm`/`tex_hm`/`vannex_hm`
   into per-strike `charm_bar`/`tex_bar`/`vanna_bar`, and isolates 0DTE slice
   (`gex_0dte_bar`/`charm_0dte_bar`/`vanna_0dte_bar`). Also fetches `/api/vol_skew_multi` →
   `data.iv_skew` and `/api/oi_change` → `data.oi_day_bar`. Non-data endpoints are non-fatal.
   Also captures compact summaries onto the CaptureRecord: `level_assessment` (Altaris's own per-strike
   grading — Bedrock/Trapdoor archetypes, hedge alignment), `opex_gravity` (front-expiry pin_score),
   `oi_analytics`, `liquidity_map`, `unusual_activity` (sweeps), `hiro` (live dealer-flow tape),
   `heston_surface` (rich/cheap), `regime_v2` + `vol_stats` (regime consensus / IVR / VRP / VIX term),
   `anomalies` (z-scored return prints), `pc_skew` (RR term structure), `skew_index`,
   `vol_regime_score` (MR/BO/NT), `regime_intraday` (intraday regime + execution hint), `oi365`
   (OI by expiry). GARCH compact carries `ranges` (±1σ/2σ price bands) + `forecast`. All flow into
   the scorer input (see `buildInput`).
   **Capture is STAGED** (critical `data`+`greek_timeseries` first, cheap optional second, slow
   computes `unusual_activity`/`heston_surface`/`regime_intraday` last) — firing everything at once
   starves `/api/data` past its timeout on the Altaris server's small worker pool. Keep new
   endpoints in the right wave.

2. **Detect** (`src/detect.ts` ← `src/market.ts`) — bar-by-bar grader on Yahoo OHLC wicks.
   Key thresholds: `fillTolPts` (0.15 pts), `hardStopPts` (0.48 ≈ 20 MNQ pts), `cleanReversalPts`
   (0.10 ≈ 4 MNQ pts). Side-matched: `outcomeFor` in `src/dashboard.ts` requires side agreement.

3. **Score** (`src/score.ts`) — runs through **Claude Code headless (`claude -p`)**, not the API
   (Max-plan, no API key). Also builds a composite VOLUME PROFILE of the prior ~5 RTH sessions
   (`src/profile.ts`, Yahoo 5-min, excludes today) → `volume_profile` block + per-strike `vp_node`
   (LVN/HVN): bare LVN = accelerant, defended optflow level inside an LVN = cleanest single-touch
   rejection (YYY doctrine), HVN = rotation/chop + natural targets. AI scoring is **RTH only** (09:15–16:00 ET Mon–Fri); off-RTH holds the
   last board's levels and updates spot + detector outcomes via the deterministic fallback.
   To edit scoring behavior: edit `SYSTEM` / `buildInput` in `src/score.ts`.
   `buildCoverage` scores EVERY near-spot strike (the "EVERY STRIKE" panel) — differentiated
   from the curated AI `levels` (don't compare their `prob` scales 1:1).

4. **Persist + publish** (`src/dashboard.ts`, `src/publish.ts`) — writes `data/scored/latest.json`
   + `<date>.boards.jsonl` + `<date>.calibration.jsonl` + `<date>.calls.jsonl`/`.calls.graded.json`
   (the CALLS LEDGER: each tick's tape trade persisted as a distinct committed call and re-graded
   every tick like a real resting order — fill → target-before-stop, adverse-first; `gradeTradeCall`
   in detect.ts). Merges board × detector outcomes into `web/dashboard.json`, deploys `web/`
   **and** `netlify/functions/` to Netlify.

## Side passes (also `src/run.ts`)

- **Pre-open narrative** (`src/narrative.ts` ← `src/macro.ts`) — `npm run narrative` or weekday
  09:00 ET cron. Macro bias × open-type call → `web/narrative.json`. Tilts per-tick board scoring
  via `dayContextFromNarrative`. `macro.ts` also pulls the Altaris `/api/macro` panel
  (`MacroSnapshot.altaris`: hawk/dove regime, FRED release calendar + event-risk, VIX fair-value,
  real yields, NFCI/stress, sector rotation) as enrichment — our direct FRED/Treasury feeds stay
  (daily-DTS TGA beats its weekly WTREGEN; COT/VIX9D/cross-assets/GDELT have no Altaris source).
  Event proximity flows to the per-tick scorer via DayContext `upcoming_events`/`event_risk`.
- **Regime** — pure math, moved entirely to `netlify/functions/regime.mjs` (no local compute needed).

## Scheduler

Live scoring loop runs as **Windows Scheduled Task `AltarisLevels`**. After any `src/` change:

```powershell
Start-ScheduledTask -TaskName "AltarisLevels"
```

That alone is the restart: the new instance writes `data/.loop.pid` and any older instance
exits itself on its next cron fire (within 15 min). **`Stop-ScheduledTask` does NOT kill the
spawned npm/node tree** — before the takeover mechanism existed, nine stale elevated loop
instances stacked up running outdated code. If stale pre-takeover instances ever need killing,
run `scripts/kill-stale-loops.ps1` elevated (UAC).

Do **not** also run `npm start` in a terminal — two schedulers double-score and double-deploy.

## Two sessions, two spot sources (`src/config.ts`)

- **US** (Mon–Fri 08:30–17:00 ET): QQQ live; AI re-scores 09:15–16:00 only.
- **Asia** (Sun–Thu 20:00 → Mon–Fri 04:00 ET): greeks are static prior-close. Spot from NQ=F
  converted via `nqToQqqRatio` (~last 100 overlapping US-hours minutes).

Always route price-dependent logic through `effectiveSpot`/`fetchSessionBars` — don't read
`snapshot.spot` directly in Asia.

## Netlify functions (cloud-side, survive box-off)

- **`dashboard.mjs`** — serves the scored board from Netlify Blobs behind the login token. The
  deploy does NOT ship `dashboard.json`/`narrative.json`/`regime.json` (they'd bypass auth) —
  `stageWebDir()` in `src/publish.ts` filters them out; `publish()` pushes the board to the
  `dashboard` Blobs store instead. The static files still exist in `web/` for LAN viewing.
- **`spot.mjs`** — live Yahoo spot server-side (CORS workaround). Mirrors `market.ts` session logic.
- **`altaris-candles.mjs`** — candle/VWAP feed for the board chart.
- **`regime.mjs`** — entire Regime tab: Yang-Zhang vol, GARCH(1,1), VXN VRP, topology pivots,
  Kaufman ER + Hurst. 15-min Blobs cache. Also GOVERNS the AI board (`loadRegime` in run.ts reads
  the blob, rejects it if >30 min stale or "INSUFFICIENT DATA").
- **`regime-cron.mjs`** — scheduled `*/15`, recomputes the regime blob 09:10–16:05 ET Mon–Fri so
  the headless scorer always has a fresh regime (the HTTP function only recomputes on view).
- **`capture.mjs`** — scheduled `*/15 * * * *`, snapshots Altaris to Blobs during 09:00–16:00 ET
  Mon–Fri. Compaction mirrors `src/capture.ts` — **keep in sync if either changes** — EXCEPT it
  skips `heston_surface` (~22s) and `unusual_activity` (~10s), too slow for the function budget.
  Needs `ALTARIS_USER`/`ALTARIS_PASS` in **Netlify** env.
- **`board.mts`** — on-demand cloud deterministic board (TypeScript, esbuild bundles actual `src/`).
  Serves when published board is stale during RTH. 5-min Blobs cache.
- **`watchdog.mjs`** — scheduled `*/15 * * * *`, 09:50–16:00 ET Mon–Fri. Alerts via ntfy if board
  stale > `WATCHDOG_STALE_MIN` (35). Fires once on stall + once on recovery (Blobs state).

## Dashboard data fields (non-obvious)

- `scored_at`: epoch ms — use for staleness (not `as_of`, which breaks in non-ET browsers)
- `tape`: the committed first-person play-by-play (now / direction / path waypoints classified
  reversal|chop|speed_bump|accelerate / trade / narrative) — AI boards only; the rule fallback omits
  it so a stale narrative never lingers off-RTH. Rendered as the "03A TAPE" panel. The scorer's
  register is DECISION LAYER, not commentator — keep hedging language out of any prompt edits.
- `hard_stop_pts` / `clean_reversal_pts`: thresholds for live break detection in the browser
- Per level: `reaction` ("clean"/"chop"/"mixed"), `tags`, `overshoot`, `clean` (bool)

## Gotchas

- **Cookie auto-refresh.** 401 triggers auto-login if `ALTARIS_USER`/`ALTARIS_PASS` are set.
- **Altaris field names:** `vex_bar`/VEX = **vega**; vanna is `vannex_hm`/VANNEX. Don't conflate.
- **`data/`, `fixtures/`, `.env` gitignored.** `web/dashboard.json` is tracked for LAN viewing but
  is NOT deployed to Netlify (auth bypass) — the board reaches the phone via the `dashboard` Blobs
  store + `dashboard.mjs`. The Blobs push needs `NETLIFY_SITE_ID`/`NETLIFY_AUTH_TOKEN` in local `.env`.
- **US market holidays** are hardcoded (2026–27) in `US_MARKET_HOLIDAYS` (`src/config.ts`) and
  mirrored in `capture.mjs`/`watchdog.mjs`/`regime-cron.mjs`/`news-cron.mjs` — extend annually, keep in sync.
- **Windows:** `netlify` is a `.cmd` shim — spawn with `shell: true` (handled in `publish.ts`).
- **Netlify deploy must include `--functions netlify/functions`** or the live-spot function won't deploy.
- **NEVER deploy from the Netlify UI** (the "trigger/publish deploy" button, incl. the prompt after
  changing env vars). UI deploys build from the last git-COMMITTED state — the login system and
  recent work live in uncommitted files, so a UI deploy resurrects the pre-auth site AND re-exposes
  `web/dashboard.json` publicly (seen live 2026-07-03). After any env-var change, run
  `npm run publish` from the PC instead — that redeploys functions so they pick up the new env.
- **`nqToQqqRatio` uses 96h lookback** (not 36h): weekend gap can be 50h+; don't shrink it.
- **Watchdog needs `NTFY_TOPIC` in Netlify env** (not local `.env`). Tunables: `WATCHDOG_STALE_MIN`, `NTFY_SERVER`.
- **`news-cron.mjs`** — scheduled `*/15`, 06:00–16:00 ET Mon-Fri. Pulls today's USD "High"-impact
  events from the public ForexFactory feed (`nfs.faireconomy.media/ff_calendar_thisweek.json`),
  sends one morning digest + a ~20-min-ahead ntfy ping per release (NFP, CPI, FOMC, etc.). Reuses
  `NTFY_TOPIC`/`NTFY_SERVER`; tunable `NEWS_LEAD_MIN` (default 20). State in Blobs store
  `news-watchdog`, keyed by ET date.
- **Regime is cloud-only.** If stale, check `regime.mjs` logs / Yahoo, not the local scorer.
- **Altaris `/api/candles` can FREEZE on a prior day** (seen 2026-06-29 + 2026-07-02: days=1..3 all
  ended at the prior close) — `fetchSessionBars` falls back to Yahoo QQQ bars for detection, and
  `scoreBoard` drops non-today bars from `intraday_flow` (honest null over a stale tape). If a
  day's calibration shows zero touches, check the feed first.
- **`[hidden]` in CSS:** keep `[hidden] { display: none !important }` before any `display: flex/grid` rules.
- After CSS/JS changes: `npm run publish`. After `src/` changes: restart the scheduled task.
- `backfill` needs `NETLIFY_SITE_ID` + `NETLIFY_AUTH_TOKEN` in the **local** `.env`.
- Higher-order greeks (speed/zomma/color) intentionally skipped.
