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

## Turn 3 baseline and final measurements

These are isolated mini measurements, not production or physical-iPhone timings. The original UI baseline is source `ccec480`; retained formatter source `7c6c895`. Five fresh embedded databases per workload supplied one ordinary observation per metric per run, **555 valid observations and zero unexplained errors** overall. Values are milliseconds, median [minimum–maximum]; no p95 is claimed from five observations. Source, seed, queries, bytes, host observations and cleanup remain in `evidence/bench/turn3/baseline-final-{small,large,long}/`; exact rerun commands are in [performance verification](../.claude/skills/verify-poker-banker/features/performance.md).

| Workload | Primary closed sessions | Open players / ledger rows | Reusable players | Overall database |
| --- | ---: | ---: | ---: | --- |
| Small | 10 | 6 / 20 | 6 | One banker, 11 sessions |
| Standard | 300 | 9 / 60 | 40 | 22 bankers, 320 players, 1,602 sessions, 63,402 ledger rows |
| Long | 1,000 | 25 / 400 | 40 | Same database scale as standard; different selected banker |

Mini Apple M4/10 cores, Node 22, production build, standalone iPhone 15 WebKit emulation. Network adds 60 ms latency with aggregate 2 Mbps down / 512 Kbps up; CPU requests 25 ms runnable / 75 ms stopped on verified owned engine processes. The original observed runnable fraction was 21.3–22.5%. Installed cold opens a new document retaining worker/HTTP/IndexedDB state; warm return uses the existing DOM. First viewer starts empty. Readiness requires exact expected financial content and two animation frames. Sign-in runs before disposable sessions; other journey order alternates. The original small workload had two noisy runs; standard/long had none; no generator saturation was reported. Other CPU medians/ranges were 0.73 [0.19–9.50], 0.27 [0.18–3.46] and 0.35 [0.17–2.84] cores.

### Historical baseline, before transport correction

The original proxy compressed static assets through the local server but did not emulate Vercel's function compression. These measurements establish the original workload, not the current deployed transport, and must not be subtracted from the representative-transport results below.

| Journey | Small ms | Standard ms | Long ms |
| --- | ---: | ---: | ---: |
| Sign-in | 705 [595–723] | 722 [710–818] | 1597 [1585–1606] |
| Cash-out confirmed | 335 [249–352] | 591 [385–594] | 1723 [1697–1966] |
| Buy-in confirmed | 354 [263–455] | 588 [471–717] | 1598 [1454–1703] |
| Offline replay | 380 [373–397] | 521 [493–626] | 1835 [1611–1890] |
| Report open | 247 [139–343] | 488 [382–495] | 1229 [1114–1338] |
| Installed cold open | 393 [280–398] | 391 [382–396] | 649 [629–744] |
| Undo confirmed | 242 [134–251] | 244 [239–342] | 1365 [867–1475] |
| Viewer first open | 1124 [985–1217] | 1133 [1102–1231] | 2032 [1967–2096] |
| Viewer live delay | 1600 [1549–1731] | 1699 [1617–1807] | 2683 [2604–2797] |
| Automatic update adoption | 1979 [1958–2093] | 2090 [1977–3985] | 3554 [3535–4942] |

The initial long cash-out had about 726 ms before POST dispatch and 989 ms from dispatch to confirmation; component medians need not sum. Its response contained approximately 131–134 KB while app/database time was only 7.3/5.8 ms. The original unreported Chromium cycle profile attributed 262.6 ms self time to `formatMoney` and 112.0 ms to `currencyExponent` in a 1008.4 ms cycle. These are diagnostic CPU samples, not WebKit latency estimates.

### Comparison rule and retained formatter gain

Every application comparison uses five fresh paired A,B / B,A legs, matching harness, lockfile, release stamp, datasets and shaping. A target must improve in every pair and its median gap must exceed both sides' MADs; a guard's median rise must not exceed the larger MAD. Errors or incorrect financial work veto the attempt. The comparison table reports medians and ranges of **five leg medians**, not pooled observations. Two samples per leg give ten ordinary observations per side, insufficient for a p95 claim. Conditions and measurements from different campaigns cannot be multiplied into one gain.

The formatter cache reuses validated exponents and at most 64 currency/locale `Intl.NumberFormat` instances while retaining the exact BigInt algorithm. Its historical comparison used the original, uncorrected function transport, with 80 valid observations, zero errors and a noisy-host label. No current deployed latency estimate is inferred from it. Source patch and provenance: `turn3/attempt-formatter/`; paired raw proof: `turn3/compare-formatter/`.

| Formatter factor, long workload | Before ms [leg range] | After ms [leg range] | Median change | Wins / max MAD |
| --- | ---: | ---: | ---: | --- |
| Cash-out | 1862.5 [1576–1965] | 1233 [1137.5–1370.5] | -33.8% | 5/5 / 102.5 ms |
| Buy-in | 1695.5 [1607.5–1752] | 1203 [1080–1282] | -29.0% | 5/5 / 75 ms |
| Installed cold open | 643 [634–668] | 504.5 [465–530.5] | -21.5% | 5/5 / 26 ms |
| Report guard | 1219 [1155–1238.5] | 1229.5 [1149.5–1259] | +0.9%, within noise | 3/5 / 29.5 ms |

Supplementary unshaped Chromium, 50 buy-in/Undo cycles with explicit GC, preserved totals while appending 200 audit rows and 100 revisions. Long heap was 3.85→8.36 MiB before and 3.86→8.46 MiB after; interval blocking above 50 ms fell 3761→618 ms. This is a resource diagnostic with profiler overhead, not navigation TBT or a leak verdict. Proof: `turn3/memory-{long-02,after-formatter}/`; small/standard checks remain in `memory-final-{small,large}/`.

### Representative transport and final window comparison

The Round45 shaping proxy requests identity upstream, then compresses eligible nonempty text/JSON/JavaScript/XML/SVG/WASM responses before its byte budget. It follows Accept-Encoding quality preferences, prefers Brotli on ties and falls back to gzip/identity. Existing Content-Encoding, no-transform, ranges and HEAD/204/304 bodies are untouched; owner, cookie, timing and cache headers are preserved, with Vary: Accept-Encoding. Both function and static delivery cross this boundary. Local codecs are Node Brotli quality 4 / gzip level 6, buffered without a CDN cache. This emulates negotiated payload sizes, not Vercel codec/threshold fidelity, codec CPU, streaming, HTTP/2, geography or edge/database latency. Counters distinguish upstream from encoded payload bytes (excluding TLS/IP overhead); browser metadata records encoding and both sizes. 18 real HTTPS regressions passed. A measured financial response was about 15 KB br / 131 KB decoded, with about 5–6 ms driver time. No deployed request was made in Round45.

The window recheck used A=`8f66264` with only R44-05 removed, B=`8f66264`, and the same new proxy overlay, release and dependencies. Source diff: `turn5/window.patch` and `window-source.json`. Five AB/BA pairs, two observations per leg per selected metric, across long/small/standard yielded **140 valid observations, zero errors, no noisy-host flags**. The long gain survives representative transport, but the standard financial guard vetoes it. R44-05 is therefore **reverted**; complete newest-first Activity remains visible, with oldest correction, voids, player filtering and viewer access retained.

| Activity window, workload / metric | Before ms [leg range] | After ms [leg range] | Change | Wins / max MAD / verdict |
| --- | ---: | ---: | ---: | --- |
| long / cash_out.confirm | 778 [556.5–788] | 415.5 [324–430.5] | -46.6% | 5/5 / 10 ms / target pass |
| long / entry.confirm | 736 [625–911] | 412 [363.5–480] | -44.0% | 5/5 / 65.5 ms / target pass |
| long / ui.open.cold | 512.5 [505.5–519] | 391 [389.5–441.5] | -23.7% | 5/5 / 3 ms / target pass |
| small / cash_out.confirm | 245.5 [239.5–350] | 293 [239.5–359] | +19.3% | 3/5 / 52.5 ms / guard pass |
| small / entry.confirm | 301 [243.5–347.5] | 301.5 [185.5–340.5] | +0.2% | 3/5 / 39 ms / guard pass |
| standard / cash_out.confirm | 254.5 [241–301] | 350 [240–354.5] | +37.5% | 1/5 / 13.5 ms / **guard veto** |
| standard / entry.confirm | 309.5 [298–354.5] | 298 [291–357.5] | -3.7% | 4/5 / 7 ms / guard pass |

### Two application attempts under representative transport

An unreported single unshaped Chromium save/Undo profile on the restored full-Activity build measured 355.5 ms application self time in a 650.8 ms interval: Activity mapper 162.3 ms, money defaults 73.0 ms, money formatting 40.4 ms. Reusing one freshly resolved time formatter per Activity render retains locale/timezone behavior and the complete ledger. The next diagnostic after this factor measured 180.1 ms application self time in 518.8 ms: money defaults 73.7 ms, Activity mapper 8.9 ms, money formatting 26.2 ms. Profiles cover form preparation outside the timed Save interval too, have overhead, and use a different engine; they locate work, not WebKit speedups. Proof: `turn5/profile-{restored,time}/{cpu-summary,attribution}.json` and their raw first-cycle profiles/bundles.

R45-01 is **kept**. A=`6cc29de`; B adds only per-render Activity time formatter reuse, with its label regression. Both sides keep all entries and use the same edge-emulating transport/release. Five alternating pairs × two observations per leg across long/small/standard produced **160 valid observations, zero errors, no noisy-host flags or generator saturation**. Actual runnable fraction across its 30 legs was median 22.08%, range 21.48–22.48%. Source/patch: `turn5/time-source.json`, `time.patch`; raw proof: `turn5/time-{long,small,standard}/`.

| Retained time formatter / long metric | Before ms [leg range] | After ms [leg range] | Change | Wins / max MAD |
| --- | ---: | ---: | ---: | --- |
| cash_out.confirm | 682 [616–838.5] | 482 [458.5–535.5] | -29.3% | 5/5 / 36.5 ms |
| entry.confirm | 715 [625.5–734] | 469.5 [430–483.5] | -34.3% | 5/5 / 19 ms |
| ui.open.cold | 513 [511–529] | 409.5 [400–415] | -20.2% | 5/5 / 4.5 ms |
| auth.signin; no gain claimed | 800.5 [795–849] | 795.5 [785.5–796] | -0.6% | 4/5 / 5.5 ms |

| Financial guards | Before ms [leg range] | After ms [leg range] | Maximum MAD / verdict |
| --- | ---: | ---: | --- |
| small / cash_out.confirm | 289.5 [241–291.5] | 290 [239–339.5] | 48 ms / pass |
| small / entry.confirm | 245 [188–301] | 247 [182.5–303.5] | 55.5 ms / pass |
| standard / cash_out.confirm | 253.5 [239.5–361.5] | 245.5 [190.5–354.5] | 48 ms / pass |
| standard / entry.confirm | 305 [254.5–355.5] | 287.5 [189–306] | 48 ms / pass |

R45-02 was the second and final candidate: one shared money-default preparation per session render rather than repeated filtering/sorting for each player. Its **160 valid observations** had zero errors; three of ten standard guard legs were marked noisy (A2, B3, B4), with load retained and no generator saturation; both long targets won all five pairs, but both small financial guards failed. It is fully reverted, including the helper and its helper-specific tests. The unchanged original money-default path remains. Proof: `turn5/money-source.json`, `money.patch`, and `money-{long,small,standard}/`; standard guards passed. No combined percentage is inferred across these separate host windows.

### Rejected attempts

| Attempt | Change | Evidence and rejection reason |
| --- | --- | --- |
| R44-01 | Memoize full Activity | Long cash-out 1166.5→962.5 ms, but small 269→340 exceeded its 26 ms MAD. Reverted. `turn4/memo-{long,small-bounded,standard-bounded}/comparison.json`. |
| R44-02 | Compress every API response in app | Long cash-out 1239→716 ms, but small 292→344.5 exceeded 18.5 ms MAD. Reverted. `turn4/compression-{long,small,standard}/comparison.json`. |
| R44-03 | Outer compression middleware at ≥32 KiB | Long cash-out 1105→731 ms, but small 303.5→314 exceeded 7.5 ms MAD. Reverted. `turn4/threshold-{long,small,standard}/comparison.json`. |
| R44-04 | Inline large-JSON compression | Local cash-out 1231→628 ms passed the numerical rule, but the baseline omitted edge function compression. Fully reverted: Vercel already negotiates JSON Brotli/gzip; no deployed benefit demonstrated. `turn4/inline-{long,small,standard}/comparison.json`, `turn4/continued/vercel-negotiation.json`. |
| R45-02 | Batch money defaults | Long cash-out 531→363 ms and buy-in 479→415 passed 5/5, but small cash-out 304→337 exceeded 16.5 ms MAD and buy-in 239→286.5 exceeded 7.5 ms. Fully reverted. `turn5/money-{long,small,standard}/comparison.json`. |
| R45-window | Recheck newest 50 Activity under edge compression | Long cash-out 778→415.5 ms, but standard 254.5→350 exceeded 13.5 ms MAD. Fully reverted. `turn5/window-{long,small,standard}/comparison.json`. |

The edge conclusion used three authorized public read-only GETs of the unknown-viewer endpoint, with identical decoded 404 JSON and explicit `br`/`gzip` response headers. It establishes negotiation, not authenticated performance. [Vercel documents automatic compression](https://vercel.com/docs/how-vercel-cdn-works/compression). Application-level compression remains absent. Historical R44 window timing under app gzip is superseded by the representative-transport comparison above, not counted as an additional gain.

### Remaining costs and correctness

Historical long `EXPLAIN (ANALYZE, BUFFERS)` measured session-ledger 0.276 ms, roster summary 75.623 ms (CTE spill at default work_mem), selected-player history 7.740 ms, history page 0.460 ms and write lock 0.021 ms. Request query counts include auth/transactions: session 10, unchanged 5, roster 6, report 7, history 2. No index, migration or database setting was changed. Current profile and plans, rather than historical cost alone, decide the next bottleneck.

The final application is byte-identical to `a741fa7`; no API, schema, update-worker or updater logic changed. Long sign-in remains about 795.5 ms in this synthetic profile, without a demonstrated gain. Repeated money defaults remain the largest named application self-time group in the final-build diagnostic (73.7 ms of 180.1 ms). Complete state/history transfer is compressed already; it still incurs bandwidth/latency and client rendering work. The batch attempt did not meet the small-workload gate, so a plausible CPU saving is not retained. Another client-preparation/sign-in attempt could help, but would need fresh profiling and a passing matched comparison; this round stops at the requested two attempts, without claiming the search exhausted. No index, API-delta protocol or migration was introduced.

Final mini gate: **typecheck; 128/128 scoped Vitest; 12/12 Playwright**, with no Unhandled Errors or Uncaught Exception markers. Browser scope on iPhone standalone and desktop WebKit covers full 106-row Activity/corrections/voids/times/viewer, cents/precision/zero cash-out/results/reports, chosen-player/default-method money flows and safe Undo, banking/re-entry/cumulative closure, payment corrections/reload and offline once-only replay. Eighteen HTTPS proxy checks are included in the unit total. Read-only scoped review found no material issue. Proof: `turn5/final-scoped.log`, `final-gate.json`; raw earlier gates remain in `proxy-tests.log`, `time-tests.log`, `money-tests.log` and `restored-profile.log`.

All three comparisons supplied 460 valid observations, zero sample errors and 90 completed owned-stack cleanup receipts. Window/time campaigns had no noisy flags; the rejected batching standard guard had three noisy legs. None reported generator saturation. No live URL, remote database or real account was contacted; all databases were isolated embedded fixtures. No full suite ran.

All decision rows remain in ignored `evidence/bench/hillclimb.tsv`. Baseline and final Round45 proof are preserved. Superseded setup/smoke, prior conditional window/profile evidence and rejected per-leg duplicates were pruned; rejected comparisons retain complete samples in runs.json, comparison.json and provenance/cleanup in turn4/rejected-archive.json. Exact deletion manifest: turn5/pruned-evidence.json. Full suite, live load, production latency and physical iOS were not run this round. The old-client compatibility, account boundaries, exact money, draft/outbox and automatic-update guarantees remain correctness requirements rather than optimization trade-offs.
