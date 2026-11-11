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
