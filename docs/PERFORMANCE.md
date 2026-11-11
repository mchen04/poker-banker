# Performance baseline

Round 5 measures the current production build and keeps only improvements supported by alternating comparisons. Goals below are proposed p95 budgets, chosen before baseline collection. Each miss is investigated before an application change is considered.

| Metric | Proposed p95 goal |
| --- | ---: |
| Workspace cold meaningful render | 2,500 ms |
| Workspace warm meaningful render | 750 ms |
| Viewer cold meaningful render | 2,000 ms |
| Viewer warm meaningful render | 500 ms |
| Save to confirmed entry | 500 ms |
| Save to viewer render, 1 viewer | 3,000 ms |
| Save to viewer render, 10 viewers | 3,000 ms |
| Save to viewer render, 25 viewers | 3,000 ms |
| GET session state, server duration | 25 ms |
| GET unchanged since, server duration | 10 ms |
| Players cumulative list, server duration | 150 ms |
| Player report Overall, server duration | 75 ms |
| Player report Location, server duration | 75 ms |
| Player report Game, server duration | 75 ms |
| Player report Weekday, server duration | 75 ms |
| Player report Month, server duration | 75 ms |
| Session history list, server duration | 25 ms |
| Ledger write with 10 concurrent writers, server duration | 150 ms |

`pnpm bench` builds production assets and uses a fresh, owned embedded Postgres for each repetition. It never reads environment files or connects to a remote database. The seed contains one banker with 40 reusable players, 300 closed sessions spanning 1,095 days and one open session with nine players and 60 ledger rows. Twenty other bankers each have 12 players and 15 closed sessions. Historical idempotency response snapshots are not fabricated; new measured writes create real idempotency records. This baseline does not model a large historical idempotency-response table. Seed tests check hand-computed ledger values and the viewer endpoint.

Five repetitions alternate the order of workspace/viewer, cold/warm and 1/10/25-viewer scenarios. Each read and browser metric has one sample within each repetition, reduced from the initial five-sample plan to bound runtime while retaining all five repetitions. The five load and Save samples give a coarse nearest-rank p95 equal to their maximum; this is a baseline, not a production SLO estimate. Concurrent writes run in batches of ten. Raw samples retain status, bytes, completed work, revisions and errors. Failed work is never included as a fast success. Server duration comes from a benchmark-only `Server-Timing` header around the same Hono app; raw samples also retain loopback request duration.

Cold means a fresh browser context with empty HTTP cache, IndexedDB and service-worker storage. A banker receives only its own valid test cookie. Warm means the same release has loaded and its worker has activated in that context before a timed reload. Browser and operating-system processes remain warm. Meaningful render is an operational paint opportunity: the actual session heading, totals and nine player rows have rendered, followed by two animation frames. It is not the deprecated browser First Meaningful Paint API, and nine rows do not all fit in the first viewport. Warm snapshots may render before current HTTP confirmation; the raw sample records that distinction and the harness subsequently verifies the request completed.

Load and single-Save scenarios use WebKit with iPhone 15 touch settings and synthetic phone constraints. Network shaping adds 60 ms response latency, 2 Mbps aggregate downstream and 512 Kbps upstream. It preserves normal HTTP caching and service workers. CPU shaping allows the benchmark's own WebKit executables to run for a target 25 ms of each 100 ms. Every signal checks an exclusive copied engine path; executable hashes match the installed Playwright build. macOS WebContent XPC processes have their own process groups, so pausing only the browser group is insufficient. Copying preserves relative symlinks so those services also execute under the exclusive path. Actual duty fractions are recorded. This budget pauses the owned UI, WebContent, networking and GPU executables together, so frame scheduling can be more restricted than renderer-only CPU emulation. This is not native WebKit CPU emulation or a measurement of a physical iPhone.

Concurrent-viewer scenarios use visible, unthrottled WebKit contexts as a load generator. They measure from the banker's actual Save click to each viewer rendering the uniquely identified stored entry and updated totals, followed by two animation frames. Raw work also includes banker-confirmation time and the difference between banker confirmation and viewer render. API reads and loads start with 60 open-session entries. The timed user writes then grow that ledger; every sample records its work. Databases are reseeded between repetitions. Viewer observations within a saved write are correlated; five runs are the independent repetitions. Different polling phases and observation counts can change the per-viewer median; a lower median with more viewers is not a speedup. Local TLS handshakes and DNS are not shaped. No Vercel edge, Neon round trip or physical iPhone performance is measured.

The copied engine is primed outside reported timing. The runner waits at most two minutes once before a campaign for other CPU to fall below half the machine's core capacity, then proceeds either way. Every repetition and sample records host load; summaries say "noisy host" whenever this threshold was exceeded. Background work is left running. Alternating metric order, and A/B alternation during hill-climbing, expose both sides to the same shared-host noise. Host CPU, memory and controller event-loop delay identify load-generator saturation. Query plans use `EXPLAIN (ANALYZE, BUFFERS)` outside timed samples.

## Round 5 measured baseline

Evidence: `evidence/bench/baseline-r5-verified/summary.json` and `run-01` through `run-05` (raw samples, host observations, resources, query plans and cleanup receipts). Five independent fresh-database repetitions, forward/reverse/forward/reverse/forward; one within-repetition sample. 300 timed observations; 0 errors. **Host below threshold**: other work stayed running. These are local synthetic measurements, not deployed-app timings.

| Metric | Median ms | p95 ms | Range ms | Errors / samples | Completed work | Other CPU median / range (cores) | p95 goal ms | Result | Limiter when missed |
| --- | ---: | ---: | --- | --- | --- | --- | ---: | --- | --- |
| api.history | 0.77 | 1.04 | 0.54–1.04 | 0 / 5 | 5 pages; 30 returned / 31 selected each | 0.72 / 0.41–1.16 | 25 | pass | — |
| api.players | 117.51 | 144.95 | 116.23–144.95 | 0 / 5 | 5 responses; 40 players / 300 closed sessions each | 0.61 / 0.43–1.30 | 150 | pass | — |
| api.report.game | 4.61 | 4.88 | 4.24–4.88 | 0 / 5 | 5 reports; 60 closed sessions each; 2 groups | 0.70 / 0.41–1.36 | 75 | pass | — |
| api.report.location | 4.50 | 4.68 | 3.83–4.68 | 0 / 5 | 5 reports; 60 closed sessions each; 3 groups | 0.70 / 0.35–1.36 | 75 | pass | — |
| api.report.month | 4.67 | 5.93 | 4.00–5.93 | 0 / 5 | 5 reports; 60 closed sessions each; 37 groups | 0.70 / 0.41–1.16 | 75 | pass | — |
| api.report.overall | 4.73 | 7.01 | 4.31–7.01 | 0 / 5 | 5 reports; 60 closed sessions each; 1 groups | 0.61 / 0.35–1.36 | 75 | pass | — |
| api.report.weekday | 5.10 | 5.70 | 4.14–5.70 | 0 / 5 | 5 reports; 60 closed sessions each; 7 groups | 0.70 / 0.41–1.26 | 75 | pass | — |
| api.session | 1.56 | 9.96 | 1.36–9.96 | 0 / 5 | 5 responses; 9 players / 60 rows each | 0.47 / 0.32–1.40 | 25 | pass | — |
| api.since | 0.93 | 8.67 | 0.64–8.67 | 0 / 5 | 5 unchanged 304; 0 body bytes | 0.47 / 0.32–1.40 | 10 | pass | — |
| api.write10 | 44.38 | 57.20 | 8.90–61.91 | 0 / 50 | 50 writes; 5 batches; 50 unique revisions | 1.49 / 1.03–2.04 | 150 | pass | — |
| entry.confirm | 415.00 | 491.00 | 286.00–491.00 | 0 / 5 | 5 saves; 10 ledger rows | 0.70 / 0.43–1.30 | 500 | pass | — |
| viewer.cold | 2294.00 | 3081.00 | 2216.00–3081.00 | 0 / 5 | 5 renders; 9 players / 60 rows each | 0.76 / 0.42–1.12 | 2000 | miss | Same uncompressed boot bundle and CPU-budgeted startup as workspace. |
| viewer.delay.1 | 1764.00 | 1798.00 | 1730.00–1798.00 | 0 / 5 | 5 saved writes; 5 viewer renders | 0.86 / 0.55–1.36 | 3000 | pass | — |
| viewer.delay.10 | 1239.00 | 1931.00 | 112.00–2031.00 | 0 / 50 | 5 saved writes; 50 viewer renders | 0.80 / 0.40–1.27 | 3000 | pass | — |
| viewer.delay.25 | 1082.00 | 1947.00 | 81.00–2050.00 | 0 / 125 | 5 saved writes; 125 viewer renders | 0.81 / 0.47–2.10 | 3000 | pass | — |
| viewer.warm | 423.00 | 427.00 | 402.00–427.00 | 0 / 5 | 5 renders; 9 players / 60 rows each | 0.57 / 0.49–2.22 | 500 | pass | — |
| workspace.cold | 2523.00 | 3540.00 | 2454.00–3540.00 | 0 / 5 | 5 renders; 9 players / 60 rows each | 0.82 / 0.47–2.12 | 2500 | miss | Uncompressed JS transfer under the 2 Mbps proxy, then CPU-budgeted WebKit startup; first-run startup variation. |
| workspace.warm | 299.00 | 307.00 | 291.00–307.00 | 0 / 5 | 5 renders; 9 players / 60 rows each | 1.02 / 0.59–3.15 | 750 | pass | — |

Host samples use macOS `ps` lifetime-decayed CPU readings: 100% is one core, not an instantaneous utilization counter. The mini has ten cores; the threshold is five cores of other CPU. Run and per-sample records retain this approximation rather than claiming a quiet machine. The p95 for five observations is their maximum; viewer observations within a write are correlated. EXPLAIN plans live in each run’s `explain/`.

| Repetition | Order | Other CPU at start (cores) | Noisy during run | Generator saturated | Proxy errors |
| --- | --- | ---: | --- | --- | ---: |
| 1 | forward | 1.79 | False | False | 0 |
| 2 | reverse | 0.92 | False | False | 0 |
| 3 | forward | 0.98 | False | False | 0 |
| 4 | reverse | 0.49 | False | False | 0 |
| 5 | forward | 0.86 | False | False | 0 |

## Hill-climb decisions

Comparisons freeze the `4e17486` harness and seed. `scripts/bench-compare.ts` runs A,B five times with fresh databases, the same production release and one sample per metric per side per pair. Targeted metric selection bounds runtime. Both sides see the shared host in the same window; host observations stay with every sample. Keep requires all five paired run medians to improve, median improvement larger than both sides’ median absolute deviation, and the relevant regression checks green. Five observations cannot establish a production p95 SLO. The append-only decision log is `evidence/bench/hillclimb.tsv`.

The first two-sample campaign (`evidence/bench/baseline-r5/`) stopped during repetition 5 on one WebKit network access-control pageerror. Its four completed repetitions and failed receipt are retained and excluded from this baseline. A caught-fetch reproducer explains the Playwright event classification, but does not establish the original same-origin network failure cause. No measured network error is filtered. Cleanup events are recorded separately by lifecycle phase. The fresh reported campaign completed without errors.

### Kept attempt: compressed local assets

Existing Hono compression middleware negotiates gzip for local static assets. No dependency was added. This corrects local production-server transport toward Vercel’s already-compressed static delivery; **it is not a Vercel performance improvement**. The identical production JS decoded to 292,793 bytes on both sides; the first paired resource records show encoded JS 292,793 → 90,211 bytes and transfer duration 1,773 → 676 ms, explaining the approximately 1.1 s render saving. All resource records are retained. Work is unchanged: nine players, 60 ledger rows, actual totals and two animation frames per render.

| Metric | Before median / p95 / range ms | After median / p95 / range ms | Median change | Paired wins | Errors / observations | After goal |
| --- | --- | --- | ---: | --- | --- | --- |
| workspace.cold | 2463 / 2491 / 2460–2491 | 1365 / 1388 / 1268–1388 | -44.6% | 5 of 5 | 0 / 10 | pass, 2500 ms |
| viewer.cold | 2354 / 2439 / 2228–2439 | 1134 / 1141 / 1117–1141 | -51.8% | 5 of 5 | 0 / 10 | pass, 2000 ms |

Other client work continued throughout the interleaved A,B window; sampled other CPU was median 0.73 cores, range 0.42–1.54; no threshold breach or load-generator saturation. Both median changes exceed the observed run-to-run variation (workspace MAD floor 5 ms; viewer 10 ms), and before/after ranges do not overlap. Evidence: `evidence/bench/hillclimb/transport/comparison.json`, ten case directories and `evidence/bench/hill-transport.log`. Seven compression behavior checks passed, including exact decompression, negotiation, cache headers, HEAD and missing-asset 404; affected payment/reload/viewer and offline/replay regressions passed 4/4 on iPhone WebKit and desktop Chromium (`evidence/bench/transport-regression.log`).

Stop: **all 18 measured goals are met**: the 16 baseline passes plus both previously missed cold loads now passing. One attempt kept; none reverted. The optional formatter cache, code splitting, ledger index and batched roster candidates were prepared but never applied or timed as attempts, because their target metrics already passed. They are not claimed wins. Further work should start from deployed `bench:live` results: Neon round trips may justify batching the 40-player history queries; a measured ledger scan may justify the composite player lookup index; boot CPU traces may justify formatter reuse or code splitting. None is added speculatively.

The unused server CPU-profile mode was removed after measurement. The retained harness consists of measurements, validation, shared-host observations, requested SQL plans, and the owned WebKit/network shaping required for the stated profile. Measurement boundaries and workload remain those frozen for the comparison.

## Live benchmark mode

Run `PB_BASE_URL=https://your-app.example pnpm bench:live --label initial` from the project. Matching Playwright WebKit must be installed before seeding. The command creates one uniquely named benchmark banker, 40 players, 300 closed sessions over three years and one open nine-player/60-row session through public HTTP endpoints. It never reads or changes another account. The synthetic account remains for inspection; no delete-account endpoint exists. Credentials and recovery codes stay out of receipts.

Five repetitions alternate API/browser/write order and forward/reverse report and viewer order. The 14 metrics are the nine API reads, ten-concurrent-writer latency, Save confirmation, and viewer delay with 1, 10 and 25 visible contexts. API values are **HTTP round trips including the response body**, not the local-only app `Server-Timing` values. UI contexts use unthrottled iPhone WebKit. Remote server load is explicitly unavailable through the public API; client host load is attached to each sample. Controller request counts exclude browser traffic; completed saves, writes and viewer renders are counted in metric work. Errors and work counts print at exit and remain in raw JSONL plus per-repetition JSON under `evidence/bench/live/<label>/`.

The default 300-session seed and all five repetitions were proved locally against an owned production server and fresh embedded Postgres: `evidence/bench/live/local-r5-cumulative-5/`. There are 280 successful observations across 14 metrics, 10,982 controller HTTP requests, 10,897 controller mutations, and zero request/sample/campaign errors. Fifty concurrent API writes, five paid UI saves and fifteen viewer writes each were verified stored exactly once. The 180 correlated viewer renders are separate observations. `cleanup.json` proves only the owned server, database and TLS scratch were removed while evidence survived; `proof-manifest.json` hashes the exact six live-source files. Five targeted Vitest tests cover public seeding, isolation, dimensions, origin/TLS restrictions, transport/error-count failures, and hand-computed cumulative values. The players metric validates every returned closed-session USD aggregate using exact integer inputs; missing or incorrect results are rejected. No deployed URL or remote database was contacted this round.

`--runs`, `--samples`, `--sessions` and `--api-only` support short diagnostic runs; reduced runs are not a five-repetition default baseline. `--output` must stay under `evidence/bench/live/`. `--allow-loopback-certificate` is restricted to an explicitly selected local server and cannot disable deployed-target TLS validation. A missing-browser first attempt and a reproduced error-counter bug are retained in the live evidence; subsequent full receipts use the fixed source.

The independent audit found and closed a live-work validation gap after the full application suite had started: only the benchmark validator and its existing test changed. Final mini typecheck and the five affected tests passed (`evidence/bench/live/mini-cumulative-validation.log`), followed by a fresh full 300-session/five-repetition live proof with exact source hashes. Application/API/domain code stayed unchanged. The single full mini run passed typecheck, Vitest 136/136 and Playwright 52/52 across all four projects with retries zero; receipt `evidence/round-5-full-suite.log`. Screenshots were refreshed to `evidence/screenshots/` (256 PNGs). No full-suite repeat was needed for the isolated validator check.
