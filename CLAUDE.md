# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> Trading-algorithm design rules (minimum 0.25% TP, limit-orders-at-levels, strictly sequential
> SL/TP outcomes, no look-ahead/overfitting) live in the user-level `~/CLAUDE.md` and apply here.

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

2. **Detect** (`src/detect.ts` ← `src/market.ts`) — bar-by-bar grader on Yahoo OHLC wicks.
   Key thresholds: `fillTolPts` (0.15 pts), `hardStopPts` (0.48 ≈ 20 MNQ pts), `cleanReversalPts`
   (0.10 ≈ 4 MNQ pts). Side-matched: `outcomeFor` in `src/dashboard.ts` requires side agreement.

3. **Score** (`src/score.ts`) — runs through **Claude Code headless (`claude -p`)**, not the API
   (Max-plan, no API key). AI scoring is **RTH only** (09:15–16:00 ET Mon–Fri); off-RTH holds the
   last board's levels and updates spot + detector outcomes via the deterministic fallback.
   To edit scoring behavior: edit `SYSTEM` / `buildInput` in `src/score.ts`.
   `buildCoverage` scores EVERY near-spot strike (the "EVERY STRIKE" panel) — differentiated
   from the curated AI `levels` (don't compare their `prob` scales 1:1).

4. **Persist + publish** (`src/dashboard.ts`, `src/publish.ts`) — writes `data/scored/latest.json`
   + `<date>.boards.jsonl` + `<date>.calibration.jsonl`, merges board × detector outcomes into
   `web/dashboard.json`, deploys `web/` **and** `netlify/functions/` to Netlify.

## Side passes (also `src/run.ts`)

- **Pre-open narrative** (`src/narrative.ts` ← `src/macro.ts`) — `npm run narrative` or weekday
  09:00 ET cron. Macro bias × open-type call → `web/narrative.json`. Tilts per-tick board scoring
  via `dayContextFromNarrative`.
- **Regime** — pure math, moved entirely to `netlify/functions/regime.mjs` (no local compute needed).

## Scheduler

Live scoring loop runs as **Windows Scheduled Task `AltarisLevels`**. After any `src/` change:

```powershell
Stop-ScheduledTask -TaskName "AltarisLevels"
Start-ScheduledTask -TaskName "AltarisLevels"
```

Do **not** also run `npm start` in a terminal — two schedulers double-score and double-deploy.

## Two sessions, two spot sources (`src/config.ts`)

- **US** (Mon–Fri 08:30–17:00 ET): QQQ live; AI re-scores 09:15–16:00 only.
- **Asia** (Sun–Thu 20:00 → Mon–Fri 04:00 ET): greeks are static prior-close. Spot from NQ=F
  converted via `nqToQqqRatio` (~last 100 overlapping US-hours minutes).

Always route price-dependent logic through `effectiveSpot`/`fetchSessionBars` — don't read
`snapshot.spot` directly in Asia.

## Netlify functions (cloud-side, survive box-off)

- **`spot.mjs`** — live Yahoo spot server-side (CORS workaround). Mirrors `market.ts` session logic.
- **`altaris-candles.mjs`** — candle/VWAP feed for the board chart.
- **`regime.mjs`** — entire Regime tab: Yang-Zhang vol, GARCH(1,1), VXN VRP, topology pivots,
  Kaufman ER + Hurst. 15-min Blobs cache. Display-only (does not tilt board scoring).
- **`capture.mjs`** — scheduled `*/15 * * * *`, snapshots Altaris to Blobs during 09:00–16:00 ET
  Mon–Fri. Compaction mirrors `src/capture.ts` — **keep in sync if either changes**.
  Needs `ALTARIS_USER`/`ALTARIS_PASS` in **Netlify** env.
- **`board.mts`** — on-demand cloud deterministic board (TypeScript, esbuild bundles actual `src/`).
  Serves when published board is stale during RTH. 5-min Blobs cache.
- **`watchdog.mjs`** — scheduled `*/15 * * * *`, 09:50–16:00 ET Mon–Fri. Alerts via ntfy if board
  stale > `WATCHDOG_STALE_MIN` (35). Fires once on stall + once on recovery (Blobs state).

## Dashboard data fields (non-obvious)

- `scored_at`: epoch ms — use for staleness (not `as_of`, which breaks in non-ET browsers)
- `hard_stop_pts` / `clean_reversal_pts`: thresholds for live break detection in the browser
- Per level: `reaction` ("clean"/"chop"/"mixed"), `tags`, `overshoot`, `clean` (bool)

## Gotchas

- **Cookie auto-refresh.** 401 triggers auto-login if `ALTARIS_USER`/`ALTARIS_PASS` are set.
- **Altaris field names:** `vex_bar`/VEX = **vega**; vanna is `vannex_hm`/VANNEX. Don't conflate.
- **`data/`, `fixtures/`, `.env` gitignored.** `web/dashboard.json` **is** tracked (Netlify needs a board on first deploy).
- **Windows:** `netlify` is a `.cmd` shim — spawn with `shell: true` (handled in `publish.ts`).
- **Netlify deploy must include `--functions netlify/functions`** or the live-spot function won't deploy.
- **`nqToQqqRatio` uses 96h lookback** (not 36h): weekend gap can be 50h+; don't shrink it.
- **Watchdog needs `NTFY_TOPIC` in Netlify env** (not local `.env`). Tunables: `WATCHDOG_STALE_MIN`, `NTFY_SERVER`.
- **Regime is cloud-only.** If stale, check `regime.mjs` logs / Yahoo, not the local scorer.
- **`[hidden]` in CSS:** keep `[hidden] { display: none !important }` before any `display: flex/grid` rules.
- After CSS/JS changes: `npm run publish`. After `src/` changes: restart the scheduled task.
- `backfill` needs `NETLIFY_SITE_ID` + `NETLIFY_AUTH_TOKEN` in the **local** `.env`.
- Higher-order greeks (speed/zomma/color) intentionally skipped.
