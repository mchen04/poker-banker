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

## Round 6 players query batching

The required read-path fix replaces the per-player loop with one scoped set-based history load and the same pure session derivations and currency reducers. The complete authenticated roster request falls from **125 database calls to seven** for 40 players. That includes auth, BEGIN, SET TRANSACTION and COMMIT; roster data uses three SELECTs. Individual player history already used a constant seven calls and remains seven, now sharing the batch helper. Empty roster responses use fewer calls, never a per-player loop.

Before deleting the old path, an actual embedded-Postgres comparison checked all 63 roster/search responses and 280 player histories across 21 bankers against the new implementation. JSON was byte-identical. Both paths used the same actual SELECT literal for server time so open-player durations were comparable. The comparison was repeated against the integrated Round 6 domain and schema. Temporary legacy code was removed from application/test sources afterward; its source and test receipt remain in `evidence/round-6/R6/equivalence-current.json` and adjacent evidence. The permanent real-Postgres query-budget test failed before with 125 calls and passed after with seven. Existing hand-computed lifecycle, reports and isolation tests remain the behavioral gates.

Client roster searches now debounce for 250 ms on both player search screens. A six-character typing burst sends one settled query. New-player creation waits for that query, so an outstanding lookup cannot bypass the exact-name warning. The original same-day session/draft warning journey and new search journey passed on all four projects, without retries or increased timeouts.

### Alternating measurements

Five A,B pairs ran sequentially on the shared mini with fresh realistic databases and the same production release, Node and dependency versions. Each case used `pnpm bench --runs 1 --samples 1 --wait-ms 0 --skip-build --metrics api.players`. The campaign used `scripts/bench-compare.ts`; raw samples, versions, host observations, status, bytes and cleanup receipts are in `evidence/bench/hillclimb/roster-r6/`. Other work stayed running. This is a loopback server-duration measurement through the benchmark-only Server-Timing header; it does not measure Neon or Vercel latency.

| Metric | Before median ms | Before p95 ms | Before range ms | After median ms | After p95 ms | After range ms | Errors / samples per side | Work per measured response | p95 goal ms | Before / after |
| --- | ---: | ---: | --- | ---: | ---: | --- | --- | --- | ---: | --- |
| api.players | 128.275 | 163.313 | 113.296 to 163.313 | 83.289 | 100.138 | 80.360 to 100.138 | 0 / 5 | 40 players, 300 closed sessions, 10,311 response bytes | 150 | miss / pass |

Median latency decreased **35.1%**. All five paired runs improved, the ranges do not overlap, and the 44.986 ms median difference exceeds the 14.791 ms MAD noise floor. With only five independent runs, nearest-rank p95 is the maximum; this is not a production SLO estimate. There are ten measured requests, 400 returned player summaries in total and zero errors. Each database also contained the nine-player/60-entry open session and 20 other bankers.

| Side | Other CPU median (cores) | Other CPU range (cores) | Noisy-host threshold crossed |
| --- | ---: | --- | --- |
| A | 2.374 | 1.545 to 3.684 | no |
| B | 2.302 | 1.594 to 2.644 | no |

The host has ten logical cores; the policy threshold is five cores of other CPU. These are lifetime-decayed macOS ps readings, not instantaneous utilization. Per-case observations and load-generator checks remain attached to the samples. No other work was stopped.

The before limiter was 118 extra serialized calls and repeated per-player ledger scans. After batching, an unreported diagnostic SQL plan aggregated 12,148 ledger rows into 2,409 player/session groups in about 46.9 ms, dominated by JSON aggregation; the ledger scan itself took about 0.74 ms. Remaining work includes JSON transfer/decoding and pure derivation. The separate whole-roster diagnostic was 84.0 ms; this is an explanatory single sample, not an A/B latency result or exact CPU attribution. See `evidence/round-6/R6/bulk-plan.txt` and `bulk-diagnostic.json`. Further SQL/domain optimizations and deployed latency remain unmeasured; no speculative index or stored totals were added.

The measured server app/store files match the integrated R6 files. Final R3 follow-ups only affect client timestamp reliability and are outside this timed server-read path. The decision is recorded in `evidence/bench/hillclimb.tsv` as R6. One required batching change is kept, with no rejected optimization attempts this round.


## Round 12: players diagnosis and candidate

The operator's supplied production baseline reports `api.players` at 551.985 ms median / 574.003 ms p95, versus roughly 90 ms transport floor from unchanged-state and history reads. That suggests about 460 ms beyond the floor against the 150 ms server-work goal. These are the operator's measurements, not a new live run. This round contacted only owned loopback servers. The candidate's deployed performance and production goal remain **unverified** until the live comparison below.

### Local diagnosis

`scripts/bench/players-profile.ts` profiles the real production-built local server, real embedded PostgreSQL and the unchanged realistic seed: 40 main players, 300 closed sessions, a nine-player/60-entry open session, and 20 other bankers. The main banker has 2,409 player/session seats and 12,148 ledger rows. Five warmed samples at each scale capture driver awaits, rows, incoming PostgreSQL socket bytes, JavaScript residual time, response size and HTTP `Server-Timing`. Five separate complete Hono-handler traces include auth and transaction statements. Row serialization for byte counting runs outside the measured interval. Separate `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` and own-process CPU profiles are explanatory diagnostics, excluded from latency samples.

The following full-request query medians are from `evidence/bench/players-r12/diagnosis-wire/` and `candidate-wire/`. Socket bytes are actual `pg` connection `bytesRead` deltas, including PostgreSQL result/protocol framing on the local plain TCP connection; they exclude TCP packet headers and TLS. Decoded JSON bytes independently describe the JavaScript rows and are not network bytes. Transaction statements return no rows but still exchange protocol messages.

| Query | Before rows | Before PG bytes | Before decoded JSON bytes | Before driver ms | After rows | After PG bytes | After decoded JSON bytes | After driver ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Auth sliding-expiry UPDATE | 1 | 157 | 82 | 0.456 | 1 | 157 | 82 | 0.289 |
| BEGIN | 0 | 17 | 2 | 0.078 | 0 | 17 | 2 | 0.079 |
| SET repeatable-read/read-only | 0 | 15 | 2 | 0.080 | 0 | 15 | 2 | 0.069 |
| Matching players SELECT | 40 | 3,559 | 4,441 | 0.180 | 40 | 3,559 | 4,441 | 0.184 |
| History JSON / candidate numeric summaries | 2,409 | 4,582,587 | 4,828,113 | 53.767 | 40 | 3,140 | 5,899 | 15.854 |
| Server clock SELECT | 1 | 91 | 43 | 0.989 | absent | 0 | 0 | absent |
| COMMIT | 0 | 18 | 2 | 0.146 | 0 | 18 | 2 | 0.146 |

Full-handler medians: before 71.403 ms wall, 55.702 ms summed driver awaits, 16.384 ms residual JavaScript; after 16.946 / 16.610 / 0.318 ms. Medians of components need not add to the median total. Residual time includes derivation, allocation, scheduling, GC and instrumentation; it is not a pure CPU measurement. Full-handler process CPU is 34.924 ms before and 0.851 ms after, measured separately from wall time. Driver time includes PostgreSQL execution, transfer, decoding and scheduling, so it cannot all be called SQL execution.

The largest measured cost is the history JSON query. Its isolated before plan executes in 45.881 ms: the aggregate finishes at 42.169 ms after its input sort finishes at 6.428 ms. The final sort spills 4,296 KiB (537 temp blocks read, 538 written); all 474 shared blocks are cache hits, with zero shared reads. Building and sorting the wide JSON result dominates this plan, then transferring/decoding 4.58 MB and deriving full sessions adds work. The unchanged client response is only 10,311 bytes, so HTTP payload is not the limiter. Own-process profiles also show row parsing and session derivation; they do not establish Vercel CPU attribution.

The candidate retains the ledger scan but returns exact per-player/currency summaries. Its isolated plan executes in 18.417 ms, including a 1.310 ms ledger scan and 2.100 ms correction-ancestry recursive union; all 474 shared blocks are hits, no shared reads or temporary blocks. Data-query incoming PG bytes fall from 4,586,237 to 6,699. The complete authenticated request uses six database calls instead of seven; player history remains seven.

| Main closed sessions | Main ledger rows | Before / after data-query rows | Before / after PG bytes | Before / after decoded JSON bytes | Before / after driver ms | Before / after JS residual ms | Before / after HTTP app ms | Response bytes on both paths |
| --- | ---: | --- | --- | --- | --- | --- | --- | ---: |
| 30 | 1,272 | 290 / 80 | 483,043 / 6,651 | 508,444 / 10,292 | 5.862 / 2.309 | 1.494 / 0.021 | 8.005 / 3.083 | 10,263 |
| 100 | 4,090 | 850 / 80 | 1,546,264 / 6,640 | 1,628,985 / 10,281 | 20.061 / 6.106 | 4.922 / 0.022 | 25.539 / 6.928 | 10,252 |
| 300 | 12,148 | 2,450 / 80 | 4,586,237 / 6,699 | 4,832,597 / 10,340 | 53.722 / 16.123 | 16.518 / 0.040 | 72.509 / 17.272 | 10,311 |

These scale samples keep all 40 main players and the background bankers fixed, retaining the oldest 30/100/300 sessions in each owned fixture. Response amounts change with history length; size equality is before-versus-after at each scale. Before transport and derivation grow with ledger history. After transport stays bounded by players/currencies, while database scan/aggregation still grows with entries. The scale runs are diagnostic, sequential campaigns rather than an interleaved gain estimate. Every profile completed with zero errors and an owned-stack cleanup receipt. Raw SQL, plans with synthetic UUID literals redacted, sample traces, byte counters, source hashes and host observations remain alongside each summary. Query parameters stay in memory and are not persisted.

### Exact summaries and supporting A/B

The retained change is limited to the roster reducer: scoped SQL excludes voids, follows correction ancestry for unknown-time ordering, preserves millisecond occurrence ordering, and computes numeric integer sums per player/session before currency aggregation. Results remain hidden while playing and cumulative results include only closed, cashed-out sessions. Positive and negative outstanding balances are bucketed per session before summing, so debts never cancel across games. Zero cash-outs, expenses, unseated players and empty sessions retain their existing behavior. There is no migration, cache, stored total or index change.

The permanent real-Postgres equivalence test compares byte-identical JSON with the unchanged history/domain path for all 280 players across 21 bankers and six search variants (126 complete roster comparisons), plus five API normalization/search variants. Eight additional hand-written fixtures cover currencies, debts, open/closed lifecycle, expenses, zero cash-outs, correction chains, unknown times, millisecond ties and sums beyond signed 64-bit range. The authenticated query-budget check requires six calls, and history still requires seven. Money/domain tests remain unchanged.

Five alternating A,B pairs used frozen main `c0180bf` versus the candidate, the same production UI build, dependencies and Node, fresh realistic databases and one measured request per side per pair. This is warm loopback **app Server-Timing**, not HTTP latency to Vercel. Evidence: `evidence/bench/hillclimb/players-r12/comparison.json`, all ten case directories, and `evidence/round-12/local-comparison-mini.log`.

| Metric | Before median / p95 / range ms | After median / p95 / range ms | Change | Paired wins | Errors / samples per side | Local p95 goal |
| --- | --- | --- | ---: | --- | --- | --- |
| api.players | 75.869 / 76.302 / 75.636–76.302 | 17.699 / 17.804 / 17.369–17.804 | -76.7% | 5 of 5 | 0 / 5 | 150 ms: pass on both sides |

The median difference is 58.170 ms, above both MADs (A 0.144 ms, B 0.105 ms). Other CPU was median 0.367 cores, range 0.207–0.486 on A; median 0.364, range 0.348–0.534 on B. Neither crossed the shared ten-core machine's five-core noisy-host threshold. Other work continued. Ten measured responses return 400 player summaries total, 300 closed sessions represented per response, 10,311 response bytes each and zero errors. With five observations the nearest-rank p95 is the maximum, not a production SLO estimate. Byte identity is proved on the same database by the regression tests; the local comparison's separate random-ID databases cannot have identical response hashes.

One candidate is kept; none were timed and rejected. The local limiter and reduction justify a live experiment, **not a claimed live gain**. Remaining scan/aggregation cost scales with ledger size. The live goal stays pending until both deployments are measured against the same reused seed. The decision is appended to `evidence/bench/hillclimb.tsv` as R12.

### Protected live A/B commands (operator-run)

Set `PB_BASELINE_URL` and `PB_CANDIDATE_URL` to the two deployment origins for the same project/database. Optionally provide `PB_VERCEL_BYPASS` through the environment. The harness sends `x-vercel-protection-bypass` on controller and browser requests to the exact selected origin; redirects are rejected and the value is never printed or saved in evidence. Artifacts record only `bypass: true` or `false`.

```sh
pnpm bench:live --seed-only --state .cache/players-live-seed.json --base "$PB_BASELINE_URL" --label players-seed
pnpm bench:live --reuse .cache/players-live-seed.json --base "$PB_CANDIDATE_URL" --metrics api.players --label players-candidate --runs 5 --samples 3
pnpm bench:live:compare --baseline-url "$PB_BASELINE_URL" --candidate-url "$PB_CANDIDATE_URL" --reuse .cache/players-live-seed.json --metrics api.players --samples 3 --order alternating --output evidence/bench/live/players-ab
```

Seed-only creates its own uniquely named banker and realistic history through public APIs once. The versioned state contains only its base origin, owned banker/fixture IDs, viewer token and session cookie; it is an exclusive-create regular mode-0600 file under ignored `.cache/`. Existing files, symlinks, unsafe permissions and missing option arguments are rejected. Treat this file as private account access; it is never copied to evidence. Reuse adapts only that cookie to the selected deployment, checks `/api/auth/me` against the stored banker and verifies its session is visible. A different database, expired cookie or mismatched banker fails before measuring. Selected read metrics do not seed or issue mutations.

The comparison supports exactly one metric, `api.players`, and five pairs. `--order alternating` runs A,B then B,A across successive pairs; `--order abba` runs A,B,B,A in every pair. `--samples 3` gives three reads per leg (15 per side in alternating mode, 30 per side in ABBA mode). Both sides use the same owned seed without writes. Raw JSONL retains order, pair/leg, status, body bytes, SHA-256, latency, completed work and per-sample client load. `comparison.json` includes per-pair medians, overall medians, both MADs, errors, request/mutation counts and the verdict. Keep requires all five pairs improve, the median improvement exceed both MADs, zero request/sample/campaign errors, and identical response body hashes and byte counts across both sides. Hashes cover the decoded HTTP response entity's original bytes, without JSON reserialization; they do not measure compressed wire payloads. Server host load remains unavailable through the public API. A completed no-gain comparison records `accepted: false` without inventing an operational failure.

Protected browser measurements use Playwright `route.fetch`/fulfill to scope the header safely and refuse redirects on WebKit, so they include proxy overhead and should not be compared to native-transport browser baselines. Without bypass the browser keeps native transport. The API-only paired comparison uses the controller directly and does not use that browser proxy. Browser service workers are blocked for deterministic request coverage. No header value, cookie, viewer token or response error body is persisted in diagnostics.

Local proof uses two owned loopback origins backed by the same disposable PostgreSQL, with `localhost` to `127.0.0.1` cookie remapping. Actual CLI seed-only/reuse and five-pair alternating/ABBA comparisons pass with matching body hashes and zero mutations on reuse; actual WebKit document, asset and API requests carry the synthetic bypass, while foreign-origin requests do not. Tests reject redirected credentials, invisible/mismatched bankers, unsafe state files and malformed reuse before network access. Targeted mini receipt: `evidence/round-12/final-targeted-mini.log` (47/47). These are local harness checks, not deployed measurements.

## Live baseline and players comparison

Live baseline, `pnpm bench:live --label baseline` from the mini against https://poker-banker.vercel.app (function in cle1, Neon in AWS us-east-2), five repetitions, 10,982 controller requests, zero errors. Values are HTTP round trips from California including the response body; unchanged `?since` (94.8 ms median) and history (91.0 ms) set a transport floor of roughly 90 ms.

| Metric | Median ms | p95 ms | Range ms |
| --- | ---: | ---: | --- |
| api.history | 90.98 | 94.30 | 87.15–94.30 |
| api.since | 94.78 | 97.34 | 93.74–97.34 |
| api.session | 108.49 | 119.41 | 100.51–119.41 |
| api.report.overall | 110.71 | 121.38 | 106.54–121.38 |
| api.report.location | 111.50 | 115.35 | 107.03–115.35 |
| api.report.game | 109.98 | 121.53 | 104.55–121.53 |
| api.report.weekday | 106.02 | 122.36 | 103.15–122.36 |
| api.report.month | 111.99 | 129.16 | 102.98–129.16 |
| api.players | 551.99 | 574.00 | 404.90–574.00 |
| api.write10 (50 writes) | 219.30 | 439.65 | 115.81–5161.86 |
| entry.confirm | 185.00 | 198.00 | 165.00–198.00 |
| viewer.delay.1 | 1782 | 1831 | 1765–1831 |
| viewer.delay.10 (50 renders) | 1082 | 1932 | 214–2213 |
| viewer.delay.25 (125 renders) | 1246 | 2115 | 198–2182 |

After subtracting the floor, only `api.players` missed its goal. Ten concurrent writes reached p95 440 ms with one 5.2 s outlier; server time is not observable through the public API, so its cause is unverified.

Live A/B of the Round 12 players aggregation: side A was the deployed production build at main 15eeea3 and side B the same project with this change, both production builds against the same Neon database and one reused seed, reached through deployment URLs with the automation bypass. `pnpm bench:live:compare --metrics api.players --samples 3 --order alternating`, five pairs, 30 samples, zero errors, 34 requests, zero mutations, identical response body hash on both sides.

| Pair | Order | A median ms | B median ms |
| ---: | --- | ---: | ---: |
| 1 | A,B | 506.06 | 158.41 |
| 2 | B,A | 507.89 | 155.60 |
| 3 | A,B | 405.61 | 136.23 |
| 4 | B,A | 408.59 | 139.76 |
| 5 | A,B | 447.38 | 135.59 |

Overall median 447.38 → 139.76 ms (−307.6 ms, −68.8%); MAD 41.78 ms before, 4.18 ms after. Every pair improves and the improvement exceeds both MADs, so the change is kept. Evidence: `evidence/bench/live/players-ab/` on the test machine.

## Turn 3 baseline

Round 43 measures the approved phone UI/update code, without a layout change. Frozen measurement source `ccec480`; retained formatter change `7c6c895`. Raw evidence: `evidence/bench/turn3/baseline-final-{small,large,long}/`, `baseline-diagnostics.json`, `compare-formatter/`, memory runs and `final-scoped.log`. Failed setup/smoke campaigns are separate and excluded. Procedures and exact commands are in [performance verification](../.claude/skills/verify-poker-banker/features/performance.md).

Two database datasets, three selected banker workloads:

| Workload | Primary closed sessions | Open players / ledger rows | Reusable players | Global database |
| --- | ---: | ---: | ---: | --- |
| Small | 10 | 6 / 20 | 6 | One banker, 11 sessions |
| Standard large | 300 | 9 / 60 | 40 | 22 bankers, 320 players, 1,602 sessions, 63,402 ledger rows |
| Long-history, in large dataset | 1,000 | 25 / 400 | 40 | Same scale; includes standard banker and 20 smaller accounts |

Five fresh databases per workload, one ordinary observation per metric per repetition: **median/range only; no UI p95**. Ten concurrent writes per repetition give 50 correlated request observations in five batches. In total: **555 timed observations, zero unexplained errors**. Sign-in precedes disposable session creation; other journey/API order alternates. Switching pins seeded history; closing uses a different player from the report fixture. Exact amounts, players, revisions, once-only writes, offline exclusion/replay and read-only viewers are checked. Historical idempotency response bodies are not fabricated.

Mini: Apple M4, 10 cores, arm64 Node 22.23.4; React 19.3.1, Vite 7.3.8, Playwright 1.65.0, embedded PostgreSQL 18.1 (reported x86_64 binary). iPhone 15 WebKit standalone emulation; 60 ms added latency, 2 Mbps aggregate down / 512 Kbps up. Requested CPU duty is 25%; observed per-run duty was **21.3–22.5%**. Only individually verified processes under the exclusive byte-identical engine copy are paused, including networking/GPU XPC processes. This is not a physical iPhone or Vercel/Neon measurement.

Installed cold retains HTTP/IndexedDB/worker caches but opens a new document; warm return times the existing DOM becoming visible, not completed HTTP revalidation. First viewer starts empty. Readiness checks expected financial content and two animation frames. Update timing is foreground discovery/adoption after A’s initial worker check drains; B is adopted automatically. It does not measure the separate 60-second idle discovery cadence. Short diagnostic notes avoid timing a generated UUID typing backlog. The raw request-start observations retain late response metadata, bytes, duplicate/refetched requests and per-request `Server-Timing` query count/elapsed time. WebKit heap, Event Timing and Long Tasks are explicitly unavailable; supplementary Chromium provides the supported resource diagnostic below.

Host noise stayed in the results; no generator saturation was flagged. The threshold is five other cores, based on lifetime-decayed `ps` observations. Expected WebKit unload diagnostics are retained with matching GET status/navigation timestamps and confirmed new-release proof; unmatched errors and write failures fail the run.

| Workload | Noisy runs / 5 | Other CPU cores, median [range] | Unexplained errors / observations |
| --- | ---: | ---: | ---: |
| Small | 2 | 0.73 [0.19–9.50] | 0 / 185 |
| Standard large | 0 | 0.27 [0.18–3.46] | 0 / 185 |
| Long-history | 0 | 0.35 [0.17–2.84] | 0 / 185 |

All values below are milliseconds: median [minimum–maximum]. API rows are app processing durations; browser rows are confirmed useful-content/render times under the profile. Each row has five samples per workload except `api.write10`, which has 50.

| Metric | Small ms: median [range] | Standard large ms | Long-history ms |
| --- | ---: | ---: | ---: |
| auth.signin | 705.0 [595.0–723.0] | 722.0 [710.0–818.0] | 1597.0 [1585.0–1606.0] |
| cash_out.confirm | 335.0 [249.0–352.0] | 591.0 [385.0–594.0] | 1723.0 [1697.0–1966.0] |
| entry.confirm | 354.0 [263.0–455.0] | 588.0 [471.0–717.0] | 1598.0 [1454.0–1703.0] |
| nav.players | 215.0 [135.0–253.0] | 248.0 [244.0–263.0] | 250.0 [245.0–364.0] |
| offline.replay | 380.0 [373.0–397.0] | 521.0 [493.0–626.0] | 1835.0 [1611.0–1890.0] |
| payment.confirm | 354.0 [279.0–364.0] | 478.0 [388.0–487.0] | 1687.0 [1471.0–1738.0] |
| report.filter | 228.0 [150.0–240.0] | 382.0 [378.0–482.0] | 1115.0 [1098.0–1343.0] |
| report.open | 247.0 [139.0–343.0] | 488.0 [382.0–495.0] | 1229.0 [1114.0–1338.0] |
| session.close | 231.0 [138.0–258.0] | 240.0 [144.0–248.0] | 141.0 [137.0–243.0] |
| session.switch | 242.0 [235.0–340.0] | 358.0 [265.0–370.0] | 475.0 [474.0–486.0] |
| share.enable | 140.0 [127.0–234.0] | 136.0 [130.0–138.0] | 138.0 [137.0–233.0] |
| ui.open.cold | 393.0 [280.0–398.0] | 391.0 [382.0–396.0] | 649.0 [629.0–744.0] |
| ui.return.warm | 17.0 [13.0–28.0] | 19.0 [12.0–25.0] | 19.0 [11.0–27.0] |
| undo.confirm | 242.0 [134.0–251.0] | 244.0 [239.0–342.0] | 1365.0 [867.0–1475.0] |
| update.adoption | 1979.0 [1958.0–2093.0] | 2090.0 [1977.0–3985.0] | 3554.0 [3535.0–4942.0] |
| viewer.delay.1 | 1600.0 [1549.0–1731.0] | 1699.0 [1617.0–1807.0] | 2683.0 [2604.0–2797.0] |
| viewer.first | 1124.0 [985.0–1217.0] | 1133.0 [1102.0–1231.0] | 2032.0 [1967.0–2096.0] |
| viewer.open | 491.0 [392.0–518.0] | 523.0 [407.0–623.0] | 1141.0 [954.0–1148.0] |
| api.history | 0.4 [0.4–0.8] | 0.7 [0.6–0.9] | 1.1 [0.9–1.2] |
| api.players | 1.8 [1.6–1.9] | 17.7 [16.9–19.6] | 67.6 [66.9–88.7] |
| api.report.game | 1.7 [1.4–1.9] | 4.0 [3.9–4.4] | 12.4 [12.0–15.8] |
| api.report.location | 1.7 [1.5–1.9] | 4.5 [3.7–5.4] | 11.6 [11.3–15.3] |
| api.report.month | 1.6 [1.5–2.2] | 4.6 [3.7–5.0] | 13.4 [11.8–15.4] |
| api.report.overall | 1.9 [1.6–2.2] | 4.3 [3.7–4.8] | 12.7 [12.3–16.9] |
| api.report.weekday | 2.0 [1.5–2.1] | 4.4 [3.8–4.5] | 12.9 [12.8–16.9] |
| api.session | 1.7 [1.3–2.0] | 1.7 [1.4–2.2] | 2.8 [2.3–3.6] |
| api.since | 0.9 [0.7–1.0] | 0.8 [0.7–1.0] | 0.8 [0.8–1.0] |
| api.write10 | 38.0 [9.0–54.2] | 38.7 [8.5–61.0] | 54.6 [12.9–111.4] |

### Limiter and plans

The long cash-out median was 1,723 ms: approximately 726 ms before POST dispatch and 989 ms from dispatch through confirmation (medians of components need not sum to the overall median). The POST itself used 7.3 ms app / 5.8 ms driver time and returned about 131–134 KB, imposing roughly 0.53 seconds of transfer at 2 Mbps before latency/rendering. Save-tap to next animation frame was 130 ms median (not INP). An unreported owned-Chromium first-cycle V8 profile attributed 262.6 ms self time to `formatMoney` and 112.0 ms to `currencyExponent` in a 1,008.4 ms cycle. These include formatting as well as construction; they are diagnostic self time, not a WebKit speedup estimate. See `memory-long-02/run-01/{first-cycle-cpu,cpu-summary}.json` and its recorded bundle.

Current `EXPLAIN (ANALYZE, BUFFERS)` captures actual roster/history SQL plus session, ledger, events, history-list and lock queries in every repetition. Long-workload median execution times:

| Query | Plan execution ms | Finding |
| --- | ---: | --- |
| state-ledger | 0.276 | Existing banker/session bitmap index; roughly 430 post-workload rows, in-memory sort. |
| roster-summary | 75.623 | Recursive effective-entry/window aggregation; CTE materialization spills at the local default work_mem. |
| player-sessions | 7.740 | Selected player history aggregation; 200 closed sessions. |
| history | 0.460 | 31 selected rows for the 30-row page. |
| write-session-lock | 0.021 | Indexed session row lock; no new index justified for the selected UI bottleneck. |

Standalone API query counts remain fixed: session 10, unchanged 5, roster 6, report 7 and history 2, including authentication/transaction commands. Long roster app time was 67.6 ms, mostly driver time (67.3 ms); it is a separate database aggregation/spill candidate, not the dominant financial UI wait. No migration or database tuning was applied.

### First hill-climb attempt

**Kept: reuse validated currency exponents and up to 64 currency/locale `Intl.NumberFormat` instances.** The BigInt parts/fraction algorithm and parser are unchanged. This removes repeated formatter construction without caching financial values. Mixed-locale/currency, cache-churn and exact signed/maximum-value regressions supplement existing money/report checks.

Five pairs alternate A,B / B,A with identical release `bench-turn3-formatter`, dependencies, seed and harness hash; each leg has two samples per metric. **80 valid observations, zero unexplained errors; noisy host marked.** The target must win every pair and its median improvement exceed both sides’ MADs; no guard median may rise beyond the larger MAD. Compare five leg medians, not baseline observations from a different host window. No p95 is claimed from ten observations per side.

| Metric | A median ms [leg range] | B median ms [leg range] | Delta | Paired wins | Max MAD ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| cash_out.confirm | 1862.5 [1576.0–1965.0] | 1233.0 [1137.5–1370.5] | -33.8% | 5/5 | 102.5 |
| entry.confirm | 1695.5 [1607.5–1752.0] | 1203.0 [1080.0–1282.0] | -29.0% | 5/5 | 75.0 |
| ui.open.cold | 643.0 [634.0–668.0] | 504.5 [465.0–530.5] | -21.5% | 5/5 | 26.0 |
| report.open | 1219.0 [1155.0–1238.5] | 1229.5 [1149.5–1259.0] | +0.9% | 3/5 | 29.5 |

Cash-out improves **33.8%**; its 629.5 ms gap exceeds the 102.5 ms noise floor. Report open is **no measurable difference**, not an improvement or meaningful regression (+10.5 ms versus 29.5 ms MAD). All legs preserve exact financial work. Source patch/provenance and decision are in `attempt-formatter/`; every attempt is appended to `evidence/bench/hillclimb.tsv`. One application attempt was made and kept; none was rejected. Fixture/input/diagnostic corrections before freezing are not optimization gains.

### Fifty-cycle resource check

Each unshaped owned-Chromium run explicitly collects garbage before and after 50 paid buy-in/Undo cycles: **100 revisions, 200 additional append-only ledger rows, unchanged totals, no reload**. Chromium trusts only the generated loopback certificate SPKI. DOM includes text/internal nodes; these snapshots and the profiler/observer overhead are not a leak diagnosis or an A/B latency statistic. Every workload grows by 2,757 DOM nodes as audit history grows.

| Workload / code | JS heap MiB before → after | DOM nodes before → after | Long tasks / interval blocking ms |
| --- | ---: | ---: | ---: |
| Small / before | 2.63 → 6.65 | 538 → 3,295 | 0 / 0 |
| Standard large / before | 2.85 → 6.94 | 1,161 → 3,918 | 0 / 0 |
| Long / before | 3.85 → 8.36 | 6,257 → 9,014 | 150 / 3761 |
| Long / after | 3.86 → 8.46 | 6,257 → 9,014 | 48 / 618 |

This blocking sum is time above 50 ms within observed long tasks, not Lighthouse navigation TBT. The after profile’s largest application self-time group is now the Activity row mapper (162.1 ms), followed by entry filtering/sorting; money formatting is 38.4 ms in that single diagnostic. Full-state transfer, Activity row/time rendering and roster CTE spill remain measured targets for the next phase. No live gain is claimed, and no second factor was stacked into this phase’s experiment.

External entry bundle on the long baseline: 368,521 raw / 111,495 gzip / 96,132 Brotli bytes; CSS 24,349 / 5,545 / 4,842. Each sample retains exact asset hashes/sizes and actual request/cache observations. Compression figures are file estimates, distinct from observed wire bytes and cached zero-byte transfers.

Final scoped gate: **typecheck; 178/178 Vitest; 10/10 Playwright** (iPhone standalone and desktop WebKit: cents/precision, zero loss cash-out, isolation, offline replay and timer/display). No Unhandled Errors. Post-change replay and automatic adoption also pass; the resource checks preserve exact work. Cleanup audit found zero owned PG/TLS/engine scratch directories or surviving cloned WebKit processes. Full suite, production, physical iOS keyboard/suspension and live benchmarks were deliberately not run.


## Turn 3 continued hill climb (Round 44)

The starting application is `363841e`, including Round 43’s retained formatter cache. These comparisons do not claim that earlier gain again. They use the existing five-pair A,B / B,A comparator, isolated fresh embedded databases, matching release stamps/harness/dependencies and the same shaped standalone WebKit profile. The local comparison campaigns contacted no deployed URL or remote database; the follow-up below used three authorized public read-only GETs. The numerical keep rule requires all five target pairs to improve, the median gap to exceed max(before MAD, after MAD), and each guard median rise to stay at or below that guard’s maximum MAD. Small and standard workloads are guards. A candidate must also address a cost relevant to the deployed target; passing a local transport comparison alone does not meet that requirement. No p95 is inferred from five or ten observations.

A fresh owned-Chromium diagnostic (`evidence/bench/turn4/profile-current/run-01/first-cycle-cpu.json`) measured a 681.3 ms first cycle: Activity mapping 162.9 ms self time, money-option comparison/sorting about 73.9 ms, and cached money formatting 26.9 ms. This is unshaped diagnostic CPU, not a WebKit latency claim.

| Attempt | Hypothesis / one factor | Long before → after ms | Guards / verdict | Evidence |
| --- | --- | --- | --- | --- |
| R44-01 | Skip unchanged full Activity mapping; current-context correction buttons | Cash-out 1166.5 → 962.5; buy-in 1206 → 973; installed open 488.5 → 414.5 | **Rejected**: small cash-out 269 → 340, a 71 ms rise above its 26 ms MAD floor. Small buy-in 353 → 353; standard cash-out 368 → 363. | `turn4/memo-{long,small-bounded,standard-bounded}/comparison.json` |
| R44-02 | Compress every API response with existing Hono middleware | Cash-out 1239 → 716; buy-in 1202 → 730; sign-in 1349 → 841; first viewer 2152 → 1255; offline replay 1497 → 514 | **Rejected**: small cash-out 292 → 344.5, a 52.5 ms rise above 18.5 ms MAD. | `turn4/compression-{long,small,standard}/comparison.json` |
| R44-03 | Compress full session states only at ≥32 KiB, via outer middleware | Cash-out 1105 → 731; buy-in 1111 → 743; sign-in 1346 → 748; first viewer 2140 → 1260; offline replay 1502 → 615 | **Rejected**: small cash-out 303.5 → 314, a 10.5 ms rise above 7.5 ms MAD. Standard cash-out 359 → 362.5 stayed within 51 ms MAD. | `turn4/threshold-{long,small,standard}/comparison.json` |
| R44-04 | Inline compression only for ≥32 KiB full JSON; include player history | Historical local experiment only: cash-out 1231 → 628; report open 1210 → 358; report filter 1120 → 248 | **Rejected for production; fully reverted**: all seven local targets won 5/5 pairs with gaps above maximum MAD and both guards passed, but Vercel already compresses JSON. No deployed benefit demonstrated. | `turn4/inline-{long,small,standard}/comparison.json`; `turn4/continued/vercel-{br,gzip,identity}.{headers,body}` |
| R44-05 | Render newest 50 Activity rows; reveal 50 earlier per click | Conditional synthetic comparison with R44-04 on both sides: cash-out 781 → 429.5; buy-in 727.5 → 415; installed open 514.5 → 388.5 | **Kept**: all three targets won 5/5 pairs, gaps exceeded maximum MAD; small cash-out 304 → 302, standard 362 → 366 (4 ms rise ≤46.5 ms MAD). DOM 2853 → 706 addresses client rendering independently of CDN compression; final transport-reverted latency remains unmeasured. | `turn4/window-{long,small,standard}/comparison.json` |

R44-01’s long target won all five pairs (204 ms gap, 68 ms maximum MAD), but its small-workload guard vetoes it. The candidate never entered application source. There are 120 valid observations across those three complete campaigns; the long campaign was marked noisy, both guard campaigns were not. Time before POST dispatch fell 253.5 → 126 ms for cash-out and 281 → 119.5 ms for buy-in, supporting the mechanism without overriding the veto.

Two earlier guard campaigns failed after UI measurement during owned WebKit teardown and are excluded in full (`memo-guards.log`, `memo-guards-clean.log`). SIGTERM succeeded, then SIGCONT returned EPERM at `owned-process.ts:91:73`, bypassing the grace wait and immediately attempting SIGKILL. Both groups were absent at the subsequent registered-group inspection. Shared tooling fix `d25c764` retains the existing bounded disappearance wait specifically for that CONT error; success still requires ESRCH, while persistent groups still require forced-shutdown failure. Both sides of the fresh guards used that identical fix. Two deterministic regressions failed before it; 35 scoped ownership/cleanup tests and typecheck passed afterward (`continuation-{red,green-02}.log`). No timing or application behavior was changed by that cleanup repair.

R44-02 also remains rejected. All five long targets won every pair, and real HTTP tests proved identical decoded replay bytes, owner/cookie/error/304/HEAD behavior and one stored write. Median write wire bytes were 130,497 → 15,394.5; HTTP resource duration 720.5 → 225 ms. Complete decoded state remained, including all entries. Offline reconnect fetched one current state and replayed one write, so both large transfers shrank. Sign-in’s small login and history requests precede that same large selected-state load; it does not load the full roster. Standard cash-out improved 364.5 → 299 ms, but the small guard vetoes the unconditional version. Its 170 valid observations had zero sample errors.

R44-01 used two observations per long leg and one per guard leg. Before any subsequent guard result, the protocol increased guard legs to two observations to reduce synthetic 100 ms CPU-duty phase granularity; five fresh paired databases and the keep rule remain unchanged. This does not rescue or resample R44-01. R44-02 used one observation per long leg and two per guard leg. No p95 is claimed.

R44-03 retained the full JSON contract and left smaller responses uncompressed; all five long targets won every pair. Nevertheless it missed the declared small cash-out guard, so it also never entered application source. Five real-HTTP tests passed and 170 comparison observations completed without sample errors. These guard vetoes are decisions under this conservative synthetic-profile rule, not proof of a universal device slowdown. The same API byte contract is tested with UTF-8 names, zero-body responses, native legacy-style fetch, private owner headers and idempotent replay.

### Rejected application compression: historical local experiment

R44-04 is fully reverted from the final candidate. In the historical experiment it removed the outer middleware hop: smaller payloads returned synchronously from the existing JSON serialization path; only responses of at least 32,768 UTF-8 bytes invoked installed Hono 4.13.17 compression. The same writer served complete session mutation/poll/viewer responses and player history. No state fields, ledger entries or API versions were omitted, and no client merged partial state. The report summary itself was only about 1.5 KB; its concurrently fetched player history was about 216 KB and was refetched on filter changes. The local experiment compressed that unchanged history too. The following numbers preserve the local finding and do not describe a retained or deployed gain.

Five alternating pairs per workload. Long legs have one observation per metric; small/standard guard legs have two, declared before this attempt: cash-out represents financial responses and report open represents history loading. There are **150 valid observations, zero errors**. All long targets win five of five pairs and exceed both sides’ MADs. Guards: small cash-out 351 → 347.5 ms and report 234 → 189; standard cash-out 368.5 → 360 and report 499.5 → 189. No guard worsens.

| Long metric | A median ms | B median ms | Change | Max MAD ms | Paired wins |
| --- | ---: | ---: | ---: | ---: | --- |
| cash_out.confirm | 1231 | 628 | -49.0% | 15 | 5/5 |
| entry.confirm | 1101 | 624 | -43.3% | 32 | 5/5 |
| auth.signin | 1351 | 843 | -37.6% | 6 | 5/5 |
| viewer.first | 2133 | 1233 | -42.2% | 34 | 5/5 |
| offline.replay | 1512 | 519 | -65.7% | 11 | 5/5 |
| report.open | 1210 | 358 | -70.4% | 9 | 5/5 |
| report.filter | 1120 | 248 | -77.9% | 6 | 5/5 |

Historical validation of R44-04 passed six real-HTTP regressions: exact decoded identity/gzip/deflate replay bytes and one stored write, native legacy-style requests, private owner/cookie/error/304/HEAD behavior, viewer redaction, and byte-identical history for 200 closed sessions with another banker rejected. Typecheck passed. An installed-source review found no blocking header, context-finalization or transaction issue. These results validate that experimental source, not the final transport-reverted candidate. `public/sw.js` and `src/client/pwa.ts` are unchanged.

The follow-up used exactly three authorized public read-only GETs to `https://poker-banker.vercel.app/api/view/unknown`, requesting `br`, `gzip` and `identity`. All returned the same 404 JSON: identity was 59 bytes, Brotli 60 encoded bytes and gzip 83 encoded bytes. The compressed responses explicitly set `Content-Encoding: br` or `gzip`; all three had `Cache-Control: no-store`, `x-vercel-cache: MISS` and an `x-vercel-id` beginning `sfo1::cle1`. Raw headers and bodies are in `evidence/bench/turn4/continued/vercel-{br,gzip,identity}.{headers,body}`. This checks negotiation on a public error response, not authenticated full-state performance. [Vercel’s compression documentation](https://vercel.com/docs/how-vercel-cdn-works/compression) confirms that `Accept-Encoding` enables automatic compression, JSON is eligible, and Brotli takes precedence when supported. Together these establish that the local uncompressed baseline does not represent the deployed transport; the evidence demonstrates no incremental deployed benefit from adding application compression. R44-04 therefore fails deployed relevance despite passing its local numerical rule.

In the historical experiment, app `Server-Timing` measured handler construction and excluded the later streaming-compression drain; end-to-end HTTP and confirmed-render timings included it. Raw responses, resource sizes, query counts, exact financial checks, host observations, matching build/harness hashes, source patches and cleanup receipts remain under `evidence/bench/turn4/`.

### Retained recent Activity window

R44-05 was measured with experimental transport `7beb0e3` on both sides, without rejected memoization. The Activity window is kept after the transport revert because it removes client rendering and DOM work that remains relevant on Vercel. It renders the newest 50 Activity rows and reveals 50 earlier rows per click. Full state, ledger order, void detection, player filtering, correction access and viewer data remain intact. Expansion resets by session/player; no API, IndexedDB or outbox schema changes.

Five alternating pairs, two observations per long metric and two per financial guard leg: **100 valid observations, zero errors**. Long cash-out 781 → 429.5 ms (5/5 wins, 351.5 ms gap >52.5 ms MAD); buy-in 727.5 → 415 (5/5, MAD48); installed open 514.5 → 388.5 (5/5, MAD3.5). Small cash-out 304 → 302; standard 362 → 366, within46.5 ms MAD. These are conditional synthetic render measurements with application compression on both sides. They do not establish latency for the final candidate after its transport revert or for production. The comparisons use different host windows; do not multiply gains or compare them as one matched end-to-end baseline.

The 106-entry real-UI regression passed on iPhone standalone and desktop WebKit, covering expansion to every entry, oldest correction, void, player filtering, expansion reset and read-only viewing. Its first candidate run caught an incorrect end-of-array assumption; the domain returns newest-first, so the candidate was corrected before any timed run. The two failing setup checks remain in `window-long.log`; corrected proof and comparisons are in `window-long-02.log` and `window-{long,small,standard}/`.

The existing roster parity test’s fixture counts also now match the Round43 seed expansion:22 bankers/320 players rather than21/280. Its six-query budget and financial comparison are unchanged. No roster SQL, index, migration or database setting was changed. The prepared NOT MATERIALIZED hint and money-default batching have not been timed or retained. Remaining named costs are full-ledger Activity preparation and repeated formatting of visible rows, full-ledger money-option sorting/preparation, the roster CTE spill (~75 ms in the captured long plan), repeated player-history fetching and the fixed polling cadence. Another batching or query attempt is plausibly material but remains unmeasured. No universal speed target or live improvement is claimed.

### Historical verification and checkpoint

The pre-revert checkpoint passed mini typecheck and 199/199 scoped tests across 12 files, with no Unhandled Errors section. These are historical results from the earlier source; fresh verification of the transport-reverted candidate is recorded below. The earlier ownership repair passed35/35 scoped tests. Eight complete financial/payment-viewer/report/offline journeys passed on iPhone standalone and desktop WebKit; the106-entry Activity test passed2/2 in those contexts. Receipt: `evidence/bench/turn4/final-scoped.log`, `window-long-02.log` and `continuation-green-02.log`. The full suite was intentionally not run.

All 250 observations across the historical inline-compression and Activity-window comparisons passed their exact-work checks; only the Activity window is retained. Recorded other CPU: inline long median0.25 cores/range0.17–3.23, small0.27/0.20–1.65, standard0.37/0.19–2.72; Activity long0.29/0.18–2.04, small0.30/0.20–2.17, standard0.42/0.20–2.16. These campaigns were not marked noisy. Median long cash-out DOM nodes fell 2853 →706 with the Activity window under the shared experimental transport. No physical-iOS or deployed latency gain was checked. The previous owned run’s cleanup receipt stopped at `2026-11-12T20:38:26.561Z`; `continued/cleanup-confirmation.json`, recorded at `20:40:24.882Z`, confirms all recorded PIDs absent and no listener on port 58060, without further signals.

This historical checkpoint does not exhaust the optimization search: full Activity preparation, money-option batching/sorting and roster-query candidates remain unmeasured on the final build. Further hill climbing should profile that build and test those costs; the evidence does not justify a universal stopping claim. Four application attempts are rejected and the Activity window is kept, with the transport condition above. No migrations, settings, push or deployment occurred.


### Final continued verification

The final application delegates JSON encoding to Vercel (`0626f04`): `src/server/app.ts` is byte-identical to the Round 44 starting source `363841e`. The existing local static-asset compression remains; it predates this experiment and emulates CDN asset delivery. The unfinished gzip-specific update-helper and feature-file edits were reverted. No worker, updater, API shape or draft/outbox schema change is retained from the compression experiment.

Fresh mini verification, serial after capacity checks:

- `pnpm typecheck` and the eight-file scoped Vitest command passed **145/145**, including API, Vercel entry, roster parity/query budget, money/domain and response identity. `tests/response-encoding.test.ts` uses real HTTP and embedded Postgres, sends a >32 KiB financial response under identity/gzip/Brotli negotiation, and checks unchanged owner/cache/cookie headers, exact decoded replay bytes and one stored write. It failed against the isolated old inline-gzip candidate (1/1 expected failure), then passed against the reverted source. Logs: `continued/{scoped,encoding-red,encoding-control}.log`.
- `pnpm e2e e2e/activity-window.spec.ts --project iphone-standalone --project desktop-webkit` passed **2/2**, retaining expansion, oldest-entry correction, voids, filtering and viewer access. No Unhandled Errors or Uncaught Exception markers appeared in the final logs. This is scoped verification, not a full-suite run.
- The existing local update recipe passed in owned iPhone standalone WebKit: archived previous source `dc2082b09d7bf8ad124f0e21f8826ef75c0b4e1f` uses IndexedDB v2 before and after; draft and old outbox body hashes match, exactly one server entry is stored, replay does not increment revision, and the actual previous reader accepts current records. Its five main adoption cases and seven accumulated review cases also passed with zero review errors. Evidence: `evidence/verify/20261112T205126594Z-636679a2/iphone-standalone/drive-1794516693693-131a8e/automatic-updates-summary.json` and `review/review-cases-summary.json`; concise extraction: `continued/compatibility-proof.json`.

The new verification run's normal registered cleanup completed at `20:57:20.506Z` with no errors. Independent inspection at `21:00:13.937Z` found all 18 captured process identities and all 17 captured owned groups absent, no listeners on 58060/59068/59069, and the run's `pg-CapM5g` directory removed. Evidence survived cleanup. No inspector signals were necessary for either the old timeout run or this fresh run. Proof: `continued/{cleanup-confirmation,new-run-ownership,new-run-cleanup-confirmation}.json`; fresh cleanup: `evidence/verify/20261112T205126594Z-636679a2/cleanup.json`.

The remaining known deployed cost is complete session/history transport and client preparation, rather than a missing gzip layer. Full-state responses still contain all ledger rows; windowing only limits rendered Activity rows. Repeated history fetching, money-option preparation and the measured roster spill are plausible next attempts, but the final transport-reverted build needs a fresh profile and paired measurements before choosing one. A material gain remains plausible; this continuation did not establish it and did not exhaust those ideas. No additional latency campaign, full suite, private deployed request, push or deployment was run.


### Round 45 representative-transport recheck

The shaping proxy now requests identity upstream and negotiates Brotli/gzip for eligible JSON and static responses before applying bandwidth shaping. It preserves existing encodings, no-transform/range/bodiless responses and owner/cookie/cache headers. Codec settings are local Node Brotli quality 4 and gzip level 6; responses are buffered, with no CDN cache or claim of exact Vercel codec, streaming, geography or CPU cost. Eighteen real HTTPS regressions and mini typecheck passed.

R44-05 is **reverted** after five alternating pairs per workload, two observations per leg. Long cash-out 778→415.5 ms, buy-in 736→412 and installed cold open 512.5→391 won all five pairs beyond MAD. Small guards stayed within maximum MAD, but standard cash-out 254.5→350 ms rose 95.5 ms above its 13.5 ms MAD allowance. The declared guard vetoes the factor. Source copies differ only by the window; `turn5/window-{long,small,standard}/` retains 140 valid observations, zero errors and no noisy-host flags. The prior compression-conditioned window claim is superseded. Full newest-first Activity, oldest correction, filtered voids and anonymous viewing passed 2/2 scoped browser tests after restoration.
