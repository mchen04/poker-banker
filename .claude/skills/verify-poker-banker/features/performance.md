# Performance verification

Use this after the affected functional flows pass. This procedure extends the existing `pnpm bench` and `scripts/bench-compare.ts` harnesses; it does not establish a result until their evidence has been collected. Run bounded synthetic work only against their fresh embedded PostgreSQL and owned local server/browser. Do not run `bench:live`, supply a deployed URL, read environment files or use existing banker credentials for this procedure.

## Conditions and fixtures

Run heavy commands through `./scripts/mini.sh`, serially. It checks mini capacity, synchronizes the checkout, uses Node 22 and installs the frozen lockfile. Keep other verification, builds and benchmark processes stopped while a campaign owns `dist/`. Do not start a verification daemon alongside the benchmark: each benchmark owns its database, server, browser and cleanup.

Record the source revision and any uncommitted application diff, frozen harness/seed revision or hashes, dependency lockfile, host, build release, engine hashes, workload, network/CPU profile and cache state with each result. The harness records machine/build/bundle information in `method.json` and sample evidence; retain source/patch provenance alongside it. This is a synthetic macOS WebKit profile: a requested 25 ms runnable/75 ms stopped budget, 60 ms network latency, 2 Mbps aggregate download and 512 Kbps upload. Check the actual shaping observations in each run's `profile.json`; these conditions do not represent a physical iPhone or a deployed edge/database configuration.

| Workload | Primary reusable players | Primary closed sessions | Primary open players / ledger rows | Other owned accounts |
| --- | ---: | ---: | ---: | --- |
| `small` | 6 | 10 | 6 / 20 | None |
| `large` | 40 | 300 | 9 / 60 | Separate long-history banker plus 20 background bankers |
| `long` | 40 | 1,000 | 25 / 400 | Separate large banker plus 20 background bankers |

Large and long use the same overall database scale: 22 bankers, 320 reusable players, 1,600 closed sessions and two open sessions. Only the selected primary banker is signed in for measured journeys. The smaller background histories exercise isolation and planner selectivity. `seed.json` reports primary and overall counts; primary report histories contain 10, 60 and 200 closed sessions respectively. Seed validation retains paid methods, unpaid/later payments, correction/void pairs, re-entry, expenses, exact money arithmetic, balanced closed sessions and timer-bounded rows. Credentials and viewer tokens remain in harness memory and must not be copied into reports.

## Baseline commands

From the Mac repository root, use a fresh output label for every invocation. These commands are sequential; wait for each exit and inspect its result before starting the next:

```sh
PB_PERF_LABEL="recheck-$(date -u +%Y%m%d%H%M%S)"
./scripts/mini.sh mkdir -p .cache
./scripts/mini.sh pnpm bench --journeys --workload small --runs 5 --samples 1 --memory-cycles 0 --output "evidence/bench/turn3/${PB_PERF_LABEL}-small"
./scripts/mini.sh pnpm bench --journeys --workload large --runs 5 --samples 1 --memory-cycles 0 --output "evidence/bench/turn3/${PB_PERF_LABEL}-large"
./scripts/mini.sh pnpm bench --journeys --workload long --runs 5 --samples 1 --memory-cycles 0 --output "evidence/bench/turn3/${PB_PERF_LABEL}-long"
```

The runner builds production assets and gives every repetition a fresh database. Unfiltered journey runs include these user actions:

- `ui.open.cold`, `ui.return.warm`, `auth.signin`, `nav.players` and `session.switch` measure opening/returning, signin and navigation to usable content.
- `entry.confirm`, `cash_out.confirm`, `undo.confirm`, `payment.confirm` and `session.close` measure real UI actions through confirmed visible financial state. Short per-fixture diagnostic notes identify writes without flooding draft persistence with rapid generated UUID text. Payment uses a later Zelle settlement of an unpaid buy-in and checks the exact persisted row and restored balance.
- `report.open`, `report.filter`, `share.enable`, `viewer.first`, `viewer.open` and `viewer.delay.1` measure player detail/report loading, filtered reports, creation of a usable share link, first uncached and installed cached readonly viewer readiness, and propagation from a banker action. Sharing checks the returned link against the saved session and opens it in a logged-out context.
- `offline.replay` measures reconnect through confirmed single replay while checking the offline entry was excluded from confirmed totals. `update.adoption` measures automatic foreground adoption between the harness's separately stamped A/B production assets without a manual B update/reload. Setup drains A's initial registration check before deployment; otherwise a concurrent initial check can defer discovery to the separate 60-second idle interval.

API samples cover session/since, roster, history, five report groupings and committed write batches. Inspect request counts, database elapsed time and server timing separately from browser end-to-end time. Database elapsed time includes client query elapsed time; it is not PostgreSQL CPU time. Request observations include response/payload work and repeated requests. Browser observations include completion time, next paint where available, resources/cache, rendering/long tasks and errors. Bundle evidence includes raw/gzip/Brotli sizes and asset hashes.

`ui.open.cold` uses a cold document with an installed service worker and retained HTTP/IndexedDB state. `ui.return.warm` foregrounds an existing installed DOM. Keep those labels and recorded conditions when reporting results; neither measures a fresh physical installation. The WebKit standalone context emulates installed display mode. `viewer.first` separately starts with empty HTTP/IndexedDB/worker storage. All navigation and reports are checked against the selected seeded banker; session switching targets the same seeded closed session regardless of journey order. Update and reconnect evidence supplements the complete correctness recipes in [offline and app updates](offline-and-app-updates.md).

Sign-in runs before disposable sessions are created, so its return target stays fixed. The other journeys alternate order. Five repetitions with one sample give five independent fresh-fixture observations for most journey metrics. This broad baseline reports medians and ranges, not p95. Report median, range, errors, per-run medians and noise flags. The summarizer withholds p95 below 20 successful observations; reaching 20 permits an empirical statistic but does not establish a reliable population tail. Update adoption runs once per repetition, so five repetitions yield five observations and no p95. Count actual completed work rather than assuming every metric uses `runs × samples` (write batches have their own multiplicity).

## Resource growth

Run memory separately so its unshaped Chromium measurements cannot be pooled with the shaped WebKit journey timings:

```sh
PB_MEMORY_LABEL="memory-recheck-$(date -u +%Y%m%d%H%M%S)"
for PB_BENCH_WORKLOAD in small large long; do
  ./scripts/mini.sh pnpm bench --journeys --workload "$PB_BENCH_WORKLOAD" --metrics memory.cycles --runs 1 --samples 1 --memory-cycles 50 --output "evidence/bench/turn3/${PB_MEMORY_LABEL}-${PB_BENCH_WORKLOAD}"
done
```

Retain `memory-cycles.json` with its Chromium version, explicit-GC heap snapshots, DOM counters and per-cycle save/Undo observations. This is supplementary owned Chromium CDP evidence; WebKit has no supported JS heap measurement here. The first cycle also saves an unreported V8 CPU profile; its timing includes profiler overhead. Chromium trusts only the generated local certificate SPKI. Fifty cycles intentionally append four audit ledger rows per paid buy-in/Undo pair and render that history. Compare retained heap and DOM with that expected growth, unchanged financial totals and revisions. DOM/history growth alone does not prove a leak; do not substitute browser RSS for unavailable WebKit heap data or call this an iOS suspension test.

## Matched experiment

Choose one bottleneck from the baseline and actual query plans. State a specific hypothesis, one coherent application change, target metric and guard metric before running the comparison. Use current `EXPLAIN (ANALYZE, BUFFERS)` output to justify database work; the harness captures the current exported roster/history SQL, not a reconstructed historical query. Match the fixture, harness, dependencies, profile, build release and selected metrics on both sides.

Prepare two fresh source copies with one application factor differing. Harness, seed, dependencies, build stamp and telemetry must match. The pinned example below replays the retained formatter factor; a new hypothesis instead starts from one current frozen baseline plus its candidate patch. Record any shared overlay.

To replay the retained formatter experiment, use these pinned application revisions. The shared overlay puts the same current benchmark/seed/reporting code on both sides; it includes the later viewer-count reporting fix, which does not change timed work. Use fresh directories or labels rather than overwriting previous receipts. No environment or local-data files are archived:

```sh
mkdir -p .cache/round43
test ! -e .cache/round43/formatter-replay-A
test ! -e .cache/round43/formatter-replay-B
mkdir .cache/round43/formatter-replay-A .cache/round43/formatter-replay-B
git archive ccec480 | tar -x -C .cache/round43/formatter-replay-A
git archive 7c6c895 | tar -x -C .cache/round43/formatter-replay-B
git archive 7c6c895 scripts/bench scripts/bench.ts scripts/bench-compare.ts tests/benchmark-stats.test.ts package.json pnpm-lock.yaml | tar -x -C .cache/round43/formatter-replay-A
```

For a new hypothesis, instead start both copies from the same frozen current revision and apply only the predeclared candidate patch in B. Do not compare different harnesses or combine multiple application factors.

Retain the baseline source revision/diff, candidate patch and frozen harness/lockfile hashes with the comparison. Audit the A/B source diff to confirm it contains only the stated factor. The copies above are ordinary source directories; the comparator does not require a `.git` directory. Existing `.cache/` content is excluded by `mini.sh`, so copy only these prepared source directories explicitly:

```sh
./scripts/mini.sh true
rsync -az --relative --exclude='.git/' --exclude='node_modules/' --exclude='dist/' --exclude='.env*' .cache/round43/formatter-replay-A .cache/round43/formatter-replay-B mini:worktrees/poker-banker/
```

Build both copies serially under the same explicit release stamp, then use the existing five-pair comparator. This example remeasures the formatter experiment, targeting cash-out and guarding buy-in, installed table open and report open; change the ID, release stamp and metric list to the predeclared experiment, preserving matching values on both sides:

```sh
./scripts/mini.sh bash -c '
set -euo pipefail
PB_BENCH_ROOT="$PWD"
PB_COMPARE_ID="formatter-replay-$(date -u +%Y%m%d%H%M%S)"
for PB_BENCH_TREE in .cache/round43/formatter-replay-A .cache/round43/formatter-replay-B; do
  cd "$PB_BENCH_ROOT/$PB_BENCH_TREE"
  pnpm install --frozen-lockfile
  mkdir -p .cache
  RELEASE_VERSION=bench-turn3-formatter pnpm build
done
cd "$PB_BENCH_ROOT"
pnpm exec tsx scripts/bench-compare.ts "$PB_COMPARE_ID" .cache/round43/formatter-replay-A .cache/round43/formatter-replay-B cash_out.confirm,entry.confirm,ui.open.cold,report.open --journeys --workload long --samples 2 --output "evidence/bench/turn3/${PB_COMPARE_ID}"
'
```

The command form is `pnpm exec tsx scripts/bench-compare.ts ID .cache/round43/formatter-replay-A .cache/round43/formatter-replay-B TARGET,GUARD --journeys --workload long --samples 2 --output evidence/bench/turn3/compare-ID`. It uses prebuilt assets (`--skip-build` internally), one fresh fixture per leg and five alternating A/B then B/A pairs. Keep `update.adoption` out of this identical-release comparison; its own recipe deliberately builds a second release. Each side has 10 observations per ordinary selected metric, so no p95 is justified. Compare the five paired leg medians, ranges, paired wins and noise floor in `comparison.json`. `clearsNoise` is a harness heuristic, not statistical significance or a correctness verdict.

Retain a change only when its benefit survives matched repetitions and guard paths remain correct without a meaningful regression. Investigate noisy or saturated runs using their recorded host observations; retain the failed/noisy evidence and use a fresh label for a justified rerun. Reject or revert ineffective/harmful experiments and record that result. After a retained change, rerun the affected complete functional flows and the representative workloads before release; do not claim a universal speed target or stop because an arbitrary round count has been reached.

## Evidence and cleanup

Keep `method.json`, overall/per-run summaries, raw `samples.json`, seed counts, host observations, profile/browser error evidence, query-plan text and `index.json`, screenshots/resource observations where produced, update release assets/identities, memory evidence, source/patch provenance and every `cleanup.json`. Comparison output additionally retains each A/B leg, `runs.json` and `comparison.json`. The mini runner copies top-level evidence back to this checkout after the command, including a failed command when its connection remains available.

Each harness handles its own owned-process cleanup on completion, failure and interruption. Inspect cleanup receipts and reported cleanup failures; a missing receipt is not proof of successful teardown. Do not kill processes by name or delete evidence to make an attempt appear clean. Preserve essential baseline, final proof and rejected-experiment evidence while pruning only genuinely redundant scratch copies after review.

The final report must identify actual measured builds, conditions, repetitions, completed-work checks, errors/noise, retained before/after changes, rejected/no-gain attempts and remaining constraints. Distinguish local synthetic evidence from live behavior and real device verification. These instructions and an unexecuted command are not performance results.
