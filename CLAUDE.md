# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> Trading-algorithm design rules (minimum 0.25% TP, limit-orders-at-levels, strictly
> sequential SL/TP outcomes, no look-ahead/overfitting) live in the user-level `~/CLAUDE.md`
> and apply here. This file covers only what's specific to this repo.

## What this is

A local pipeline that pulls QQQ options-flow data from the Altaris terminal, finds price
levels where a reversal is likely, scores each level's reversal probability with an LLM, and
publishes a phone-viewable board. It runs on a schedule during two trading sessions and is
**level-finding first**: the output is a ranked set of strikes to rest limit orders at, not
real-time signals.

## Commands

```bash
npm run capture        # one full capture → detect → score → publish cycle, now
npm start              # scheduled loop: every SCORE_INTERVAL_MIN during US + Asia windows
npm run score:fixture  # score the bundled fixtures/ offline (no Altaris call) — the smoke test
npm run verify         # confirm the Altaris cookie is live + the detector runs (no scoring)
npm run web            # serve web/ on the LAN for phone viewing (prints LAN URL)
npm run publish        # re-deploy the latest board to Netlify without re-scoring
npm run typecheck      # tsc --noEmit  (there is no compile step; tsx runs the TS directly)
```

There is **no test runner** and no build. `score:fixture` + `verify` + `typecheck` are the
checks. To exercise one stage in isolation, import its module under `tsx` or use the fixture run.

ESM throughout: relative imports must carry the `.js` extension (e.g. `import { config } from
"./config.js"`) even though the files are `.ts`.

## Pipeline architecture (the big picture)

One cycle is orchestrated in `src/run.ts` (`scoreFromHistory`) and chains four stages:

1. **Capture** (`src/capture.ts` ← `src/altaris.ts`) — fetches `/api/data`,
   `/api/greek_timeseries`, `/api/iv_tracker` with the session cookie. `compactSnapshot` drops
   the giant `*_hm` heatmaps but **aggregates `cex_hm`/`tex_hm`/`vannex_hm` into per-strike
   `charm_bar`/`tex_bar`/`vanna_bar`** (those greeks have no native per-strike `*_bar`).
   Appends each tick to `data/raw/<date>.data.jsonl`; greek timeseries overwrites
   `data/raw/<date>.greek.json` (it's cumulative-for-the-day).

2. **Detect** (`src/detect.ts` ← `src/market.ts`) — reversal outcomes are computed on **Yahoo
   OHLC wicks, not the Altaris spot tape**. `detectLevel` classifies each candidate strike as
   `reversed` / `broke` / `pending` / `untouched` by where price *lived* across the session
   (closes for acceptance, wicks for tests). This is the sequential, no-look-ahead grader — it
   only grades levels price actually reached. Two tuning knobs differ in intent:
   `REVERSAL_SWING_PCT` (what confirms a *hold*) is deliberately larger than `TP_MIN_PCT` (the
   trade target) so chop near a level isn't mislabeled a reversal.

3. **Score** (`src/score.ts`) — runs through **Claude Code headless (`claude -p`), not the
   Anthropic API** (Max-plan, no API key). Model is `ANTHROPIC_MODEL` (default `sonnet`). The
   long `SYSTEM` prompt is the core scoring logic: it's fed per-near-spot-strike greek rows
   (gex/dex/vega/vanna/charm/tex/rho in $M **with deltas vs the oldest snapshot in the
   lookback**), IV regime, the prior board (revise-don't-recompute, anti-jitter), and which
   levels already played out. Output is conditional `P(reverse ≥ TP_MIN | price reaches strike)`.
   Editing scoring behavior usually means editing `SYSTEM` / `buildInput`, not adding code.

4. **Persist + publish** (`persist` in `run.ts`, `src/dashboard.ts`, `src/publish.ts`) — writes
   `data/scored/latest.json` (+ `<date>.boards.jsonl` + `<date>.calibration.jsonl` for grading),
   then merges board × detector outcomes into `web/dashboard.json` and (if
   `PUBLISH_TARGET=netlify`) deploys `web/`. Publish failures are non-fatal — a scored board is
   never lost to a deploy hiccup.

## Two sessions, two spot sources (`src/config.ts` `activeSession`)

The scheduler runs in two ET windows and the **effective spot differs**:
- **US** (Mon–Fri 08:30–17:00): QQQ is live; spot/levels come from QQQ directly.
- **Asia** (Sun–Thu eve 20:00 → Mon–Fri 04:00, wraps midnight): US options are closed, so the
  Altaris OI/greeks are **static prior-close positioning** and the Altaris spot is stale. The
  effective spot is **NQ=F futures converted to QQQ-equiv** via a smoothed NQ/QQQ ratio
  (`src/market.ts` `nqToQqqRatio`, ~last 100 overlapping US-hours minutes; mirrors
  `converter.pine`). Asia is scored more conservatively — see `SESSION_NOTES` in `score.ts`.

When adding logic that depends on price, route it through `effectiveSpot`/`fetchSessionBars`,
which already handle the conversion — don't read `snapshot.spot` directly in Asia.

## Dashboard / hosting (hybrid model — settled)

Scoring stays local on Max (free); each board auto-publishes to a static, no-build dashboard in
`web/` (vanilla HTML/CSS/JS, polls `dashboard.json`). View it on the LAN (`npm run web`) or, for
computer-off viewing, via Netlify (`PUBLISH_TARGET=netlify`, site already linked: `aaravaltai`).
Do not re-pitch the cloud-native/API-key path — it was considered and rejected on cost. The
dashboard renders levels at their true price on a vertical scale with spot as a datum line; see
`TODO.md` for the full rationale.

## Gotchas

- **Cookie expires.** When capture returns HTTP 401/403, re-paste a fresh `altaris_session=...`
  into `.env` (`ALTARIS_COOKIE`). This is the most common failure.
- **Altaris field names:** `vex_bar`/VEX = **vega**; vanna is the separate `vannex_hm`/VANNEX
  (confirmed by magnitude). Don't conflate them.
- **`data/`, `fixtures/`, `.env` are gitignored** (live account data + secrets).
  `web/dashboard.json` **is** tracked so the git-connected Netlify site has a board to render.
- **Windows:** `netlify` is a `.cmd` shim — Node must spawn it with `shell: true` (already
  handled in `publish.ts`); spawning it directly throws `EINVAL`.
- Higher-order greeks (speed/zomma/color) are intentionally skipped.
