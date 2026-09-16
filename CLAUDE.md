# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> Trading-algorithm design rules (limit-orders-at-levels, strictly sequential SL/TP outcomes,
> no look-ahead/overfitting) live in the user-level `~/CLAUDE.md` and apply here. THIS project's
> objective (revised 2026-08-15): GREEK ALIGNMENT AT A STRIKE, ON A FIXED BRACKET. Every call is
> the same trade — a limit at the exact strike, **40 MNQ pts stop / 80 MNQ pts target**
> (`STOP_MNQ_PTS`/`TARGET_MNQ_PTS`, converted once in config.ts via `MNQ_PTS_PER_QQQ_PT` 40.7 into
> `hardStopPts` ≈ 0.98 and `callTpPts` ≈ 1.97 QQQ pts). There is **NO target selection** — no
> `target_strike` on levels, no `target` on the tape trade, no range pairing, no "how big is the
> move" reasoning anywhere. A level's score is one number: P(turns here and runs the 80 before it
> gives up the 40 | price reaches it). The two failure shapes to screen out: the REFLEX
> BOUNCE-THEN-BREAK (a wick, then blow-through — fills the limit, hits the stop) and the PURE
> PASS-THROUGH (level ignored). Both = mass without alignment/live defense. THIRD failure shape,
> added 2026-08-15: the UNREACHABLE level — 93% of levels published Jun 17–Aug 14 were never
> touched, so an unfilled limit is now treated as a wasted board slot, not a neutral outcome.
> (Prior spec, Jul 13–Aug 15: 0.5 QQQ stop / 3.0 QQQ target ≈ 20/122 MNQ, 1:6. `TP_MIN_PCT`/
> `TP_IDEAL_PCT` are deleted, not just unused — don't reintroduce move-size bars.)

## What this is

A local pipeline that pulls QQQ options-flow data from the YYY backend, finds price levels
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
npm run verify         # confirm the YYY capture + Yahoo bars + detector run (no scoring)
npm run web            # serve web/ on LAN for phone viewing
npm run preview        # local visual preview of the terminal (live YYY snapshot, no auth)
npm run publish        # re-deploy latest board to Netlify without re-scoring
npm run typecheck      # tsc --noEmit
```

No test runner, no build. `score:fixture` + `verify` + `typecheck` are the checks.
ESM throughout: relative imports must carry the `.js` extension even though files are `.ts`.

## Pipeline architecture

One cycle is orchestrated in `src/run.ts` (`scoreFromHistory`), four stages:

**PROVIDER (2026-09-01): YYY is the ONLY source — Altaris is gone.** The Altaris Railway app was
deleted (every path returns 404 `Application not found`), so `src/altaris.ts`, `src/auth.ts`, the
`buildAltarisRecord` capture fallback, `config.dataProvider` / `ALTARIS_*` config and
`netlify/functions/altaris-candles.mjs` are all DELETED. There is no provider switch and no
credentials any more — do not reintroduce a fallback to a service that does not exist.
`src/yyy.ts` fetches the public YYY backend (`YYY_BASE_URL`) and builds the `CaptureRecord`.
**`/heatmap` is the canonical per-strike greek source: ALL SIX greeks** (gex, dex, vex=vega,
tex=theta, cex=charm, vanna from `/vanna_surface`) as aggregate bars + 0DTE slices + tenor ladders
— but only the ~8 front expiries, so the `m` (15d+) tenor bucket is structurally 0 and `w2` is the
durability horizon. **UNITS:** YYY quotes $M-family per greek — the adapter scales ×1e6 into raw-$
bars (vanna ×1e9, smaller native base); skipping that scale zeroes every greek downstream (live bug
Jul 17-19). Magnitudes are internally consistent WITHIN a greek only — never compare across greeks.

**WHAT DIED WITH ALTARIS (do not write prompt text or code that expects these):**
- **Order-flow delta — permanently gone.** Altaris `/api/candles` carried per-bar traded delta
  (net buyer−seller). YYY has no traded-flow feed at all: `/chart` is OHLCV only, and `/dex` /
  `/dealer_delta` are OI/positioning-derived, not tape. So `recent_bars.delta`,
  `delta_profile_top5`, `strike_dex_flow` and `cum_dex_session` are removed from the scorer input,
  and `SYSTEM` carries an explicit "NO ORDER-FLOW DELTA EXISTS" instruction so the model stops
  claiming absorption/initiative "confirmed by flow". Approach quality is now judged from the shape
  of `recent_bars`, `vol_oi_pct`, HIRO direction and the Hurst/GEX regime.
- **12 context blocks YYY has no source for** (verified empty in live captures):
  `opex_gravity`, `oi_analytics`, `liquidity_map`, `unusual_activity`, `heston_surface`,
  `vol_stats`, `skew_index`, `vol_regime_score`, `regime_intraday`, `oi365`, `hedge_pressure`,
  `ladder`, plus day-over-day `oi_change`. `SYSTEM` still describes several of these — that text is
  stale and should be pruned or repointed at YYY's unused endpoints (see below).
- **The Altaris macro panel** (hawk/dove regime, VIX fair-value, real yields, NFCI/stress, sector
  rotation, net liquidity). Its FRED release calendar — which fed `DayContext.upcoming_events` and
  therefore the day gate's FOMC/CPI/NFP factors — is REPLACED by `upcomingEvents()` in `macro.ts`,
  the same public ForexFactory calendar `news-cron.mjs` uses. The composite `event_risk` score had
  no replacement and is deleted from `DayContext` + `dayGate`.
- **The intraday greek tape.** Altaris `/greek_timeseries` served a real multi-point session tape;
  `yyy.ts` can only synthesize a SINGLE current point, so `wall_drift` silently collapsed to one row
  when the provider switched on 2026-07-17. `buildGreekContext` now rebuilds the drift from the
  **capture history** (`<date>.data.jsonl`, genuinely multi-tick) by summing each tick's own greek
  bars — same arithmetic `yyy.ts` uses for its single point.

**YYY endpoint coverage.** `/openapi.json` lists ~45 routes. As of 2026-09-15 the FRONT END reads
30 of them through `netlify/functions/yyy.mjs` — the nine per-strike greeks, `/heatmap`-free tenor
grids, `/iv_surface`, `/net_iv`, `/probability`, `/expected_move`, `/zero_dte`, `/vol_forecast`,
`/atr`, `/flow`, `/dealer_delta`, `/dealer_anomalies`, `/dex_ladder`, `/option-matrix`, `/levels`,
`/hurst`, `/history`, `/flux`, `/bias`, `/macro`, `/macro_extended`, `/scanner`, `/chart`.
Still unread anywhere: `/macro_chart`, `/outlook` (upstream 404s), `/quote`, `/charm_surface`,
`/gex_surface`, `/vanna_surface`, `/snapshot_iv` (upstream NameError), `/bias_log`, `/probability`'s
terminal-density grid (trimmed server-side).
**The SCORER is a separate question** — `src/yyy.ts` still builds its `CaptureRecord` from a much
smaller subset, so the twelve dead context blocks above are dead *for scoring* even though the
terminal now renders equivalent data. Repointing the scorer at these routes has NOT been done.

BARS: all OHLC now comes from **Yahoo** via `fetchSessionBars` (US = QQQ 1-min, Asia = NQ=F
converted). This was already the Altaris-freeze fallback, so it is well-tested. `board.mts` calls
the same `fetchSessionBars`, so cloud and local grade identical bars. The dashboard chart is served
by `netlify/functions/yyy.mjs` proxying YYY `/chart` (no auth needed at the source).

2. **Detect** (`src/detect.ts` ← `src/market.ts`) — bar-by-bar grader on Yahoo OHLC wicks.
   Key thresholds: `fillTolPts` (0.15 pts), `hardStopPts` (0.98 = 40 MNQ pts — a level has "broken"
   exactly when price went far enough past it to take the stop), `cleanReversalPts` (0.10 ≈ 4 MNQ).
   The "reversed" swing is `callTpPts` (1.97 = 80 MNQ), so detector outcomes and the calls ledger
   agree by construction. NOTE: both widened on 2026-08-15 with the bracket change, so calibration
   history before that date was graded on stricter thresholds and is NOT directly comparable.
   Side-matched: `outcomeFor` in `src/dashboard.ts` requires side agreement.

3. **Score** (`src/score.ts`) — runs through **Claude Code headless (`claude -p`)**, not the API
   (Max-plan, no API key). **PURE GREEKS + REGIME (rewired 2026-07-17):** the scorer reads
   gex/dex/charm/vanna across DTEs (0DTE first) for SIGNS, ALIGNMENT, and FLIPS. The primary signal
   is the 0DTE charm/vanna sign-flip pivot (`buildGreekFlips` → `greek_flips` block + per-strike
   `*_0dte_sign` + `scoreStrike` pivotScore/"0DTE Flip Pivot"). All statistical layers were REMOVED
   — no sigma grid, GARCH stat-bands, expected-move exhaustion, volume-profile LVN/HVN, risk-neutral
   density, GTBR, shadow-gamma, or IV-skew smile (`src/profile.ts`/`sigmaGrid.ts`/`density.ts` are
   now unused by the scorer). Don't re-add them — see memory [[pure-greeks-flip-pivot]].
   AI scoring is **RTH only** (09:15–16:00 ET Mon–Fri); off-RTH holds the
   last board's levels and updates spot + detector outcomes via the deterministic fallback.
   To edit scoring behavior: edit `SYSTEM` / `buildInput` in `src/score.ts`.
   **NO ARITHMETIC SCORING (2026-07-19): coverage is AI-judged, not coefficient-summed.** The
   model scores EVERY near-spot strike (the "EVERY STRIKE" panel) through the five-pass
   ALIGNMENT EVALUATION in `SYSTEM` (structural role → forced-flow alignment across all six
   greeks, 0DTE first → tenor durability → live evidence → regime coherence) and returns a
   `coverage[]` alongside `levels[]`. Fallback chain in `scoreBoard`: `sanitizeAiCoverage` →
   `carryForwardCoverage` (last AI judgment, side re-based to live spot — also what off-RTH
   rule boards use) → `buildCoverage` (cold-start only). **The deterministic fallback is the
   same methodology, not coefficients:** `evaluateStrike` runs the five passes as ORDINAL
   decision tables (role/vector classes, scale-free band-relative comparisons — day-gate
   doctrine, no summed weights); `scoreBoardDeterministic` layers the board doctrine on top
   (opposed = pass-through, not entry; vol-trigger/neg-gamma gates; 0.25% spacing; board size 4,
   3 in negative gamma; the first-bracket blocker cap at 30). `scoreStrike`/`probFromConfluence`
   are DELETED — don't reintroduce coefficient sums anywhere. **Also deleted 2026-08-15:**
   `targetFor`, the "capped at 38 / no structure beyond the bracket" de-rate, and the forced
   range-pairing loop that injected a counterpart from the missing side. Board size was 7 —
   with no distance term in the ranking (`prob` then `gexAbs`) that made the selection march
   outward through the band to fill slots. A one-sided or one-level board is correct output.

4. **Persist + publish** (`src/dashboard.ts`, `src/publish.ts`) — writes `data/scored/latest.json`
   + `<date>.boards.jsonl` + `<date>.calibration.jsonl` + `<date>.calls.jsonl`/`.calls.graded.json`
   (the CALLS LEDGER: each tick's tape trade persisted as a distinct committed call and re-graded
   every tick like a real resting order — `gradeTradeCall` in detect.ts. EXECUTION SPEC is fixed:
   TP = `callTpPts` (1.97 QQQ = 80 MNQ) beyond entry, stop = `hardStopPts` (0.98 = 40 MNQ), fill requires trading
   THROUGH the limit not a touch, adverse-first within a bar, RTH bars only — the order dies at
   the cash close (`flat_close` if filled and unresolved), never graded into the Asia session.
   Calls are validated at placement: entry passive vs last bar close, else REJECTED from the
   ledger — the old side/target coherence test went away with the target itself, since the
   bracket is now derived from side + entry and cannot be incoherent). Merges board × detector outcomes into `web/dashboard.json`, deploys `web/`
   **and** `netlify/functions/` to Netlify.

**IV walls** (`src/ivWalls.ts`, added 2026-08-13, from `pdfs/IV Wall Derivation Spec.pdf`):
the four "IV wall" brackets — inner walls = the ~19Δ (|Δ|=0.1925) strikes of the front expiry,
interpolated over the captured `iv_skew` smile (per-strike IV is already in the feed, so no
BS price inversion; just delta from spot+T+σ(K)); outer walls = the spec's fixed widths
re-expressed as fractions of spot (1.56/750, 1.79/750 — SPY-points don't transfer to QQQ).
Computed ONCE per date from the first usable US-session chain (T anchored to the capture
timestamp; 0DTE = time to the 16:00 close), frozen to `data/scored/<date>.ivwalls.json`,
attached to every board (`board.iv_walls` → dashboard) and fed to the AI scorer as a
NOMINATION/CONTEXT prior only — chain-derived priced-move-edge, NOT a statistical band, so it
doesn't reopen the banned sigma/GARCH band layers; the five-pass alignment evaluation still
forms every score. The spec's v1.1 regime-dependent upper delta is deliberately not ported
(fit on 13 SPY days). Dashboard: the "V · IV WALLS" ladder panel (`renderIvWalls`, web/app.js).
**CARRY-FORWARD (2026-09-01):** the brackets were strictly same-ET-date, so the panel went blank
from 00:00 ET every night until the next US-session tick froze new ones — and for whole days when a
session produced no US tick at all (Fri 2026-08-28 had none: no walls Aug 28 → Aug 31 13:12).
`ivWallsForDate` now falls back to `loadRecentIvWalls` (up to `CARRY_BACK_DAYS` 5 back) when the
date has no bracket of its own; the carried bracket is deliberately NOT persisted under the new
date, so that date's first usable US chain still freezes its own. This matches the spec, which
builds the walls from the PRIOR EVENING's 16:00 chain. The dashboard footnote distinguishes them
("frozen HH:MM ET" vs "carried from MM-DD HH:MM ET") off `computed_at`'s date.
The cloud board (`board.mts`) computes its own walls from the FIRST capture blob of the date
(not the latest — the bracket must not depend on when a viewer loads the board), cached per date
in the `board` Blobs store; without that the panel vanished whenever the frontend swapped to the
cloud board.

## Side passes (also `src/run.ts`)

- **Pre-open narrative** (`src/narrative.ts` ← `src/macro.ts`) — `npm run narrative` or weekday
  09:00 ET cron. Macro bias × open-type call → `web/narrative.json`. Tilts per-tick board scoring
  via `dayContextFromNarrative`. The Altaris `/api/macro` panel enrichment is GONE (retired
  2026-09-01) — our own FRED/Treasury/COT/VIX9D/cross-asset/GDELT feeds are the whole macro
  picture, plus `upcomingEvents()` (public ForexFactory USD high-impact calendar) which replaced
  Altaris's FRED release calendar as the source of `MacroSnapshot.events`.
  Event proximity flows to the per-tick scorer via DayContext `upcoming_events`/`event_risk`.
- **Live macro pulse** (`fetchMacroPulse` in `macro.ts`) — the INTRADAY macro layer, fetched on
  every AI scoring tick (`live_macro` in the scorer input): 2Y/10Y + 2s10s with ~30-min velocity,
  USD/JPY carry, oil, DXY, VIX/VXN/VIX9D + term structure, plus the EVENT CLOCK (today's USD
  High-impact releases with minutes_until, same ForexFactory feed as news-cron). This is what
  lets the scorer see a 13:00 rate shock / carry unwind / vol-term flip that the 09:00 narrative
  can't. The day gate also grades scheduled releases (FOMC today = major; CPI/NFP/PCE/ISM = minor;
  event_risk EXTREME = minor) from DayContext.
- **Regime** — pure math, moved entirely to `netlify/functions/regime.mjs` (no local compute needed).

## Scheduler

Live scoring loop runs as **Windows Scheduled Task `AltarisLevels`** (name is historical — the task, repo dir and package name still say "altaris"; only the data source changed). After any `src/` change:

```powershell
scripts/restart-loop.ps1
```

The task is registered with `MultipleInstances=IgnoreNew`, so while a loop instance is running
`Start-ScheduledTask` is silently dropped (result `0x800710E0`) — the bare-Start takeover only
works when the old instance is already dead (discovered live 2026-07-10). The script uses the
loop's own ownership mechanism instead: it writes a sentinel into `data/.loop.pid`, the running
instance notices it lost ownership on its next cron fire (within 15 min) and exits itself, then
the script starts the task fresh. One-time permanent fix (UAC): set the task's
`MultipleInstances` to `Parallel` — command in the script header — after which plain
`Start-ScheduledTask` works again.

**`Stop-ScheduledTask` does NOT kill the spawned npm/node tree** — before the takeover mechanism
existed, nine stale elevated loop instances stacked up running outdated code. The task runs in an
S4U session this user can't open process handles to, so unelevated `taskkill`/`Stop-Process` are
Access Denied (same reason `isPidAlive` in `run.ts` must treat `EPERM` as alive — a manual
`npm run narrative`/`backfill` once stole the live loop's scoring lock mid-tick because of this).
If stale instances ever need killing, run `scripts/kill-stale-loops.ps1` elevated (UAC).

Do **not** also run `npm start` in a terminal — two schedulers double-score and double-deploy.

**Fast-tick override** (`src/run.ts` `main()`): the fixed 15-min grid can leave a converging
level with only one tick of lead time — a level 6+ pts from spot doesn't even appear on the
board until the tick that lands 1-2 pts out, near-simultaneous with the touch (seen live
2026-07-07: 705 support first appeared 9 min before the actual 10:42 ET low). A cheap spot-only
poll (`liveQqqSpot()`, no capture/no AI call) runs every `FAST_POLL_SEC` (60) during the RTH AI
window; if live spot has moved `FAST_TICK_MOVE_PCT` (0.25%) since the last scored board, it
fires a full tick early instead of waiting for the grid boundary. `FAST_TICK_COOLDOWN_SEC` (180)
stops it re-firing every poll while price keeps trending through the threshold. It ALSO fires
when live spot converges on a level the last board called — outside `FAST_TICK_APPROACH_PTS`
(1.25) at score time, inside it now — because a sub-threshold drift can still walk straight
into a called strike (2026-07-10: 722.44 → 724.04 tick was only 0.22%, under the move gate).

## Two sessions, two spot sources (`src/config.ts`)

- **US** (Mon–Fri 08:30–17:00 ET): QQQ live; AI re-scores 09:15–16:00 only.
- **Asia** (Sun–Thu 18:00 → Mon–Fri 04:00 ET, NQ Globex open): greeks are static prior-close. Spot from NQ=F
  converted via `nqToQqqRatio` (~last 100 overlapping US-hours minutes).

Always route price-dependent logic through `effectiveSpot`/`fetchSessionBars` — don't read
`snapshot.spot` directly in Asia.

## Netlify functions (cloud-side, survive box-off)

- **`dashboard.mjs`** — serves the scored board from Netlify Blobs behind the login token. The
  deploy does NOT ship `dashboard.json`/`narrative.json`/`regime.json` (they'd bypass auth) —
  `stageWebDir()` in `src/publish.ts` filters them out; `publish()` pushes the board to the
  `dashboard` Blobs store instead. The static files still exist in `web/` for LAN viewing.
- **`spot.mjs`** — live Yahoo spot server-side (CORS workaround). Mirrors `market.ts` session logic.
- **`yyy.mjs`** — THE front end's main data path (added 2026-09-15). One authed request fans out
  to N allowlisted YYY endpoints in parallel and returns `{ok:{ep:data}, err:{ep:msg}}`; a single
  bad route never fails the batch. 20s per-container memo, max 20 endpoints per call. The client
  picks endpoint NAMES from the allowlist, never URLs. `/heatmap` is deliberately NOT wired (its
  `vex`/`cex`/`vegaex` column names are the documented trap — the per-greek routes carry the same
  strike x expiry cells unambiguously). Superseded `candles.mjs`, which was deleted: `/chart` is
  just another endpoint in the allowlist now.
- **`regime.mjs`** — Yang-Zhang vol, GARCH(1,1), VXN VRP, topology pivots, Kaufman ER + Hurst.
  15-min Blobs cache. GOVERNS the AI board (`loadRegime` in run.ts reads the blob, rejects it if
  >30 min stale or "INSUFFICIENT DATA"). The front end renders only its `gauges` + `read`; the
  `pivots` array is computed but no longer drawn (see the front-end section).
- **`macro.mjs`** — the desk macro pulse (FRED yields/liquidity, COT, VIX9D term, cross-asset
  basket, bias score), 5-min Blobs cache. Desk CODE in the cloud, not desk OUTPUT, so it stays
  current with the box off — rendered as REGIME > R6 MACRO PULSE and presented as live.
- **`regime-cron.mjs`** — scheduled `*/15`, recomputes the regime blob 09:10–16:05 ET Mon–Fri so
  the headless scorer always has a fresh regime (the HTTP function only recomputes on view).
- **`capture.mjs`** — scheduled `*/15 * * * *`, snapshots **YYY** to Blobs during 09:00–16:00 ET
  Mon–Fri. Mapping mirrors `buildYyyRecord()` in `src/yyy.ts` — **keep in sync if either changes**.
  YYY is unauthenticated, so no `ALTARIS_USER`/`ALTARIS_PASS` needed; set `YYY_BASE_URL` in
  **Netlify** env if the backend URL changes.
- **`board.mts`** — on-demand cloud deterministic board (TypeScript, esbuild bundles actual `src/`).
  Serves when published board is stale during RTH. 5-min Blobs cache.
- **`watchdog.mjs`** — scheduled `*/15 * * * *`, 09:50–16:00 ET Mon–Fri. Alerts via ntfy if board
  stale > `WATCHDOG_STALE_MIN` (35). Fires once on stall + once on recovery (Blobs state).

## Front end (rebuilt 2026-09-15 · v2 2026-09-16 · v3 2026-09-16)

**v3 — user verdict on v2: "looks vibecoded… kept the same font and logo… 'TORII · QQQ
optionsflow with YYY' is incredibly corny… forget all my old design requirements… monochrome
sleek futuristic Bloomberg terminal, ASCII designs throughout, not the ugly green".**
- **Identity.** Kanji, tagline and the 鳥居 mark are GONE. The brand is a three-line block-glyph
  wordmark (`<pre class="wordmark">`, in index.html + login.html) that decodes out of ░▒▓ noise
  at boot (`ui.decode`). Face is **Geist Mono** (Google Fonts), one weight axis. Controls are
  bracketed text `[ levels ]` (`.kbtn`), not buttons. A blinking `.cur` block marks "alive".
- **Frame.** Panels are bracketed boxes: 1px edge + four corner ticks drawn as background
  gradients (no extra elements), title set into a dashed rule (`.p-line`) with a lit `▮ NN`
  index. Every meter is glyph-based (`repeating-linear-gradient` tick bars, `asciiBar`).
  Skeletons are strips of `░` with a light band sweeping across. Reveal is a top-down `wipe`
  with a 1px accent scan line, once per tab visit; panel titles decode on first reveal.
  No radius, no glass blur, no cursor spotlight — those were the "vibecoded" tells.
- **Sticky rail.** `.rail` is `position: sticky; top: 0`; an IntersectionObserver on
  `#railSentinel` adds `.compact` once the header scrolls away (numeral 40→24px, spark
  60→34px, `.chip.opt` chips hidden). The spark now prints session hi/lo at its right edge.
- **IV SURFACE + IV ANOMALIES** (VOL tab, panels V0/V1). `draw.ridgeline()` stacks the eight
  expiry smiles back-to-front as terrain (0DTE front, lit); `draw.heatSurface()` is the same
  grid lit by IV level. `lib/ivanom.js` finds kinked strikes three ways — per-expiry quadratic
  smile residual in log-moneyness (|z|≥2, ≥0.8 vp, ±6% window), per-expiry linear skew residual
  on `flow.skew_data` (|z|≥2, ≥1.5 vp), and YYY's own `flow.sentiment_data.iv_zscore` (|z|≥2.5
  with OI/volume) — merges per strike with 0DTE weighted 1.25×, and scales by proximity to spot
  (1 at ATM → 0.35 at the ±6% edge) so the ladder ranks what is reachable. Rich = above the
  curve (paid up), cheap = below. Strikes scoring ≥2 (top six) are added to LEVELS as
  `IV Rich 3.2` / `IV Cheap 2.7`. `net_iv` and `flow` joined `CORE_EPS` for this.
- Views still pass `jp:` to `panel()`; it is accepted and ignored.

**v3.2 — the reference was the trifekta site (`~/Downloads/YYYmacropad/macropad/src/components/fx/
AsciiContour.tsx`).** `lib/bg.js` is now a faithful port: layered-sine elevation, one glyph per
contour LEVEL (`· : - = + * ─ # %`), line width normalised by the local gradient so contours stay
one cell wide on flat ground, alpha by elevation × edge distance, cell 14, 9 levels, maxAlpha .5,
12fps, plus `.bg-vignette` (radial fade to `--bg`). The 3D ridge terrain and the line-only
contour map that preceded it are gone — do not reintroduce a heightfield.
- **Tooltips everywhere** (`lib/tip.js`): one delegated listener; any element with `data-tip`
  shows a bracketed tag that follows the pointer (`
` = line break, `key: value` lines dim the
  key). Every renderer in `draw.js` puts `data-tip` on its bars/cells or on invisible `.hit`
  columns over lines; ladder rows, greek-book rows and meters carry it in HTML. Renderers take
  optional `xTips`/`tips`/`name` for the head line and series names.
- **IV SURFACE is a projected mesh** (`draw.surface3d`): x = moneyness, depth = expiry (0DTE
  front), height = IV; quads drawn back-to-front, filled and lit by IV so the mesh is solid, the
  0DTE front edge and the ATM ridge in the accent, anomaly marks on the surface. The heat grid
  stays beneath it.
- **USER-ARRANGEABLE LAYOUT (v3.6).** Every panel carries `data-key` (its `idx`) and three
  controls in its label bar (↑ ↓ ⇔); the label bar is also an HTML5 drag handle. `app.js`
  `applyLayout(host)` runs after every render and imposes the saved order + width overrides
  from `localStorage["layout.v1.<view>"]` (`{order:[keys], half:{key:bool}}`); unknown keys
  keep their default position after the known ones, so adding a panel never wipes a user's
  arrangement. `[ reset layout ]` in the footer clears the current tab. DEFAULT ORDERS are set
  by the order of `host.replaceChildren(...)` in each view — BOARD is structure, IV walls, desk,
  gamma ladder, surface, expected move, 0DTE, price last (user: "I'll never use price").
- **Ladders default to today's expiry.** `expIdx = 0` in board/greeks; the segmented control
  lists `0DTE, 1DTE, … , CHAIN` (chain last). greeks clamps the index to what the chosen greek
  carries (/gex has three columns, the rest eight).
- **IV-wall zones on every ladder.** `spine()` takes `zones:[{lo,hi,label}]` and shades the
  bands (`wallZones()` in ivwalls.js); board gamma, greeks ladder, flow dealer + delta all pass
  them. The IV SURFACE panel is also mounted on BOARD (`buildSurfacePanel` exported from vol.js).
- **Sticky rail compacts on scroll position with hysteresis** (compact past sentinel+28px,
  expand below sentinel−4px) — the IntersectionObserver version flickered because compacting
  shrank the rail, moved the page, and flipped the observer back.
- **IV WALLS are computed live in the browser** (`lib/ivwalls.js`, a port of `src/ivWalls.ts`:
  |Δ| 0.1925 strikes of the front expiry over its own smile from `/net_iv`, outer = spec widths
  as fractions of spot, T anchored to 16:00 ET for 0DTE). Panel 01b on BOARD, half width, next
  to STRUCTURE; the desk's frozen bracket is shown alongside when present. LEVELS uses the live
  bracket and falls back to the desk one.

**v3.1 — "actually getting very very nice… just a bit bland, more animations, a background
that matches the theme."** The motion layer, all in the `MOTION LAYER` block at the end of
`styles.css` plus small hooks in `app.js`:
- **Background** (`lib/bg.js`) is now an ASCII contour map: 2D fbm sampled per character cell,
  contour boundaries drawn as `+` in the accent, high ground as a `·∙:░▒▓` density ramp, a slow
  scan band lifting whatever it crosses; glyphs are pre-rendered sprites blitted with drawImage.
  The WebGL shader is gone. The CSS grid behind it drifts 48px every 90s.
- **Boot log** under the wordmark (`#bootlog`): real events (auth · snapshot · session · link
  yyy) typed as they happen; the last line resolves on the `yyy:first` event (first live part
  merged) and the log folds away. Braille spinner (`#spin`) while any endpoint is pending.
- **Change flash** (`flashChanged` in app.js): a `.stat-val` / ladder price / greek-book net /
  meter value / rail chip whose text differs from the previous paint of the same view gets
  `.flash` (accent + glow, 1.1s). First paint of a view only records. Keyed by view + label.
- First-reveal-only motions (all disabled under `.views.no-reveal`): spark draw-on (once ever),
  matrix/heat cells fade in per cell (`--i` on each rect), meters/ladder fills grow from zero,
  stat cells step in. Idle loops (only these): spot-rail dash march, rail-edge breathe, grid
  drift, blinking cursor. Hover: rows get a lit left edge, panel corner ticks grow, tab
  underline slides.


**v2 (2026-09-16) — user verdict on v1 was "very very bland… same vibe, things just moved around".**
Three changes, all in `web/`:
- **DESIGN → dark-first glass + MONO + glow.** Tokens in `styles.css` `:root`: near-black field,
  glass panels (`--glass`/`--edge`, 12px radius), and a TWO-TONE data language — `--acc` (ice)
  for positive/active/live, `--neg` graphite for negative/inert. Red is brand mark + alarm only.
  Glow is structural (rail hairline, big numeral, lit bars, live dot, hovered panel spotlight),
  never on body text. Motion: `reveal` blur→sharp per panel (staggered by `--i`, once per tab
  visit — `.views.no-reveal` suppresses it on data repaints), spine/bar `growR`/`growY` from the
  spine, spot numeral ticks (`tickSpot`), skeleton shimmer while in flight. Background is ONE
  WebGL fbm-noise shader (`lib/bg.js`, quarter-res, 12fps-ish) + a CSS dot grid; the ASCII field
  is gone. Panels can be `cls: "half"` for the two-column bento grid ≥1100px.
- **LOAD PATH.** v1 fired one 12-endpoint batch and painted "NO DATA"/"UPSTREAM unreachable"
  until the slowest upstream route (probability, ~15s cold) returned, then everything flashed in.
  Now: (1) `api.loadSnapshot()` paints the last localStorage frame instantly, stamped CACHED;
  (2) `api.yyy()` splits into batches of 4 with the HEAVY set (iv_surface, probability, bias,
  hurst, flow, chart, history) each on its own request, and `onPart` merges + repaints per batch;
  (3) `ctx.wait(ep, kind)` gives every panel a skeleton while its endpoint is in `S.pending` —
  "NO DATA" is only ever an actual failure now; (4) the proxy has a shared Netlify Blobs cache
  (`yyy-cache`, 75s TTL, stale-on-error to 30 min) kept warm every 5 min in market hours by
  `yyy-warm.mjs`. `CORE_EPS` grew to include levels/zero_dte/dealer_delta (all tiny) so the
  LEVELS button works from any tab.
- **⧉ LEVELS button** (top bar) → `lib/levels.js` `collectLevels()` → clipboard, one line per
  price, descending, `705 "Call Wall / Max Pain"` — the exact `Batch Strikes` input format of
  `converter.pine`. Same-price sources merge into one line. Sources: GEX walls 1&2 / vol trigger /
  max pain, 0DTE flip + walls + ±1σ, delta flip, EM ±1d, HOD/LOD confluence, session VWAP, desk
  levels (with prob), IV walls.


**THE PREMISE CHANGED.** The scoring box is almost never on now, so a dashboard whose primary
content is `dashboard.json` shows a frozen board for days. The terminal is therefore **live-first**:
every panel that CAN be driven from YYY is, through `netlify/functions/yyy.mjs`, and the desk
artefacts (scored board, pre-open brief, vol engine) are secondary, always age-stamped, and dimmed
(`.p-desk.is-old`) once stale. Nothing on screen requires the PC.

ES modules, no bundler, no framework, no chart library (Chart.js is gone):

```
web/index.html      shell: top bar, the always-visible SPOT RAIL, tab strip, view root
web/app.js          entry — state, polling cadence, routing, theme, the rail
web/lib/util.js     DOM factory (`el`/`svg`), number + ET-time formatting, ASCII meters
web/lib/api.js      the entire network surface (LIVE = yyy/spot; DESK = board/narrative/regime/macro)
web/lib/data.js     YYY payloads -> {rows:[{strike,put,call,net}], expiries, totals}
web/lib/draw.js     hand-built SVG: spine, matrix, termMatrix, lineChart, bars, smile, candles, cone
web/lib/ui.js       panel frame, tags, segmented control, stat grid, ASCII rules
web/lib/bg.js       the character field (one canvas)
web/lib/views/*.js  one module per tab: {ID, LABEL, JP, EPS, render(host, ctx)}
```

A view declares the YYY endpoints it needs in `EPS`; `app.js` fetches `CORE_EPS ∪ view.EPS` in one
proxy call and MERGES the result into the cache, so switching tabs never blanks the rail. Cadence
is session-aware: 60s in RTH, 120s in extended hours, 300s otherwise; spot polls separately.

**Six tabs.** BOARD (structure / price / gamma ladder / 0DTE / expected move / desk board),
GREEKS (greek book / alignment-at-strike / ladder / tenor), VOL (state / smile / term+skew /
IV-vs-ATM / cone / distribution / realized), FLOW (dealer inventory / bar pressure / delta ladder /
expiry matrix / cross asset / feed limits), REGIME, BRIEF.

**The spine is the house chart.** One row per strike, puts left of a centre spine, calls right, bar
length `|value|^0.62` against the window max (raw linear turns a 40-row ladder into one bar and 39
slivers) and bar COLOUR is the SIGN of that side, not which side it is. All nine per-strike greeks
render through it because YYY serves them in one envelope: `{expiries[8], rows[{strike, call_cells,
put_cells, total}]}`. `/gex` and `/theta` are the two that deviate — `src`-side that is handled once
in `data.js:greek()`, and views never see the difference.

**Per-column scaling is a correctness rule, not a style choice.** `matrix()` normalises each column
on its own because greek magnitudes are consistent WITHIN a greek only — theta is raw dollars,
vomma is near 1e-3, and a shared scale would blank eight columns and imply theta dominates.

**What was removed, and why (do not re-add):**
- **TOPOGRAPHY** — the rotating WebGL terrain of the dealer book (`web/topo.js`, 37KB). Never read
  as a number; the same data is legible as a spine.
- **TOPOLOGY PIVOTS** — a persistence-ranked price list from `regime.mjs` sitting next to the GEX
  walls and desk levels saying different numbers. Nothing in the trading spec consumed it.
- **THE MONITORS BLOCK** — Hurst oscillator, regime radar, and an "IV SMILE" wired to the scored
  board's `coverage[]`, which is empty off-RTH and empty with the box off, so the smile was blank
  essentially always. The Hurst read survives in REGIME on YYY's own series; the smile is now in
  VOL, drawn from `/iv_surface`'s live moneyness x dte grid.
- **`web/fx.js`** — cypher/glitch/ASCII-torii effects. Replaced by one canvas (`lib/bg.js`).
- **Chart.js** — the only CDN script tag; every chart is hand-built SVG now, sized to real pixels
  so text never scales or blurs.

**CSS contract** (`web/styles.css`): one typeface (JetBrains Mono + Noto Sans JP for kanji),
hairlines, zero radius, no shadow, no glow. Exactly three data colours — `--cool` positive,
`--hot` negative, muted zero — with `--red` reserved for the brand mark and real alarms.
**v3 tokens:** `--edge/-2/-3` (hairlines), `--acc` ice, `--neg`/`--neg-2` graphite, `--red` alarm.
**The panel class is `.pnl`, NOT `.p`** — `.p` is the positive-value class and a bare `.p` rule
would put a border and background on every positive number on the page.
**Data colour classes:** `.p`/`.cool`/`.pos` → `--acc`; `.n`/`.hot` → `--neg-2` graphite; `.neg` →
red (alarm only: NEGATIVE GAMMA chip, KILLED). There is no third hue — don't add amber back.

`npm run preview` serves the real modules and the real stylesheet against a one-shot live YYY
snapshot with auth bypassed (`?all=1` stacks every tab, `&theme=dark` flips it). It generates its
page in memory from `scripts/`, so nothing preview-related is ever deployed.

### Dashboard data fields (non-obvious)

- `scored_at`: epoch ms — use for staleness (not `as_of`, which breaks in non-ET browsers)
- `tape`: the committed first-person play-by-play (now / direction / path waypoints classified
  reversal|chop|speed_bump|accelerate / trade / narrative) — AI boards only; the rule fallback omits
  it so a stale narrative never lingers off-RTH. Rendered inside the DESK BOARD panel. The scorer's
  register is DECISION LAYER, not commentator — keep hedging language out of any prompt edits.
- `hard_stop_pts` / `clean_reversal_pts`: thresholds for live break detection in the browser
- Per level: `reaction` ("clean"/"chop"/"mixed"), `tags`, `overshoot`, `clean` (bool)

## Gotchas

- **Greek field names:** `vex_bar`/VEX = **vega**; charm is `cex`, vanna is its own bar. Don't conflate.
  This is why the front end reads the nine per-strike routes instead of `/heatmap`'s grids.
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
- **The panel CSS class is `.pnl`.** `.p` means "positive value" and is on hundreds of spans;
  a bare `.p` panel rule borders every positive number on the page. This was caught once.
- **`web/lib/**` must stay `no-cache`** in `netlify.toml`. The front end is an unhashed ES-module
  graph, so a cached `lib/` against a fresh `app.js` ships two halves that disagree.
- After CSS/JS changes: `npm run publish` (check it first with `npm run preview`).
  After `src/` changes: restart the scheduled task.
- `backfill` needs `NETLIFY_SITE_ID` + `NETLIFY_AUTH_TOKEN` in the **local** `.env`.
- Higher-order greeks (speed/zomma/color) intentionally skipped.
