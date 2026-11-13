# Performance

## Current harness

Heavy commands run serially through `scripts/mini.sh`, using production builds, owned embedded Postgres and Playwright engines. Never benchmark a real account. Record source/diff, build, dependency/harness hashes, workload, cache state, host observations, profile, error counts and completed financial work. Each run cleans only its owned processes, database and TLS scratch; evidence remains under ignored `evidence/bench/`.

```sh
scripts/mini.sh pnpm bench --journeys --workload long --runs 5 --samples 1 --memory-cycles 0 --output evidence/bench/current-long
scripts/mini.sh pnpm build
scripts/mini.sh pnpm exec tsx scripts/bench/players-profile.ts --samples 5 --output evidence/bench/players-profile
```

Use fresh output directories. `--workload small|large|long` chooses the primary banker described below; `--metrics` narrows the existing journey/API runner. `--memory-cycles 50 --metrics memory.cycles` performs the supplementary unshaped Chromium resource check. `players-profile` separately measures 30/100/300-session SQL rows, socket/JSON bytes, driver/JavaScript residual time, plans and an unreported CPU profile. Its byte accounting is Postgres framing, not TLS/IP traffic. No speculative index or setting is applied.

The shared-host policy waits at most two minutes for unrelated CPU below half the core capacity, then proceeds with recorded noisy-host flags. Other work is never stopped. A/B uses five interleaved pairs under the same window. Each target must win every pair and exceed both sides' MAD; guard median increases must not exceed the larger MAD. Any error or incorrect financial work vetoes a result. Medians/ranges below are identified as observations or paired-leg medians; fewer than 20 successful observations never supplies a p95 estimate. Do not combine different campaigns into one percentage.

[Performance verification](../.claude/skills/verify-poker-banker/features/performance.md) contains dataset details, baseline/resource commands and exact source-copy/build/compare instructions. The comparator remains `pnpm exec tsx scripts/bench-compare.ts ID BEFORE_DIRECTORY AFTER_DIRECTORY METRICS --journeys --workload long --samples 2 --output evidence/bench/compare-ID`.

## Live measurement commands

Live mode requires an explicitly authorized HTTPS `PB_BASE_URL`. It creates a uniquely named synthetic banker and seeds through public APIs only; it never touches existing accounts or removes remote data. The default is 300 closed sessions, 40 players and a nine-player/60-entry open session. Five alternating repetitions measure API/body round trips, Save confirmation and 1/10/25-viewer delay, retaining errors, work counts and client host load. Server load/timing is unavailable. Local TLS bypass is restricted to explicit loopback.

```sh
pnpm bench:live --seed-only --state .cache/players-live-seed.json --base "$PB_BASELINE_URL" --label players-seed
pnpm bench:live --reuse .cache/players-live-seed.json --base "$PB_CANDIDATE_URL" --metrics api.players --label players-candidate --runs 5 --samples 3
pnpm bench:live:compare --baseline-url "$PB_BASELINE_URL" --candidate-url "$PB_CANDIDATE_URL" --reuse .cache/players-live-seed.json --metrics api.players --samples 3 --order alternating --output evidence/bench/live/players-ab
```

Reuse state contains private access to that synthetic account: a new mode-0600 regular file under `.cache/`, never evidence. Unsafe files/symlinks, redirects, mismatched or invisible bankers and wrong databases are rejected. Reuse reads do not seed or mutate. Both deployments must use the same project/database and seed. The comparator supports `api.players`, five AB/BA or `--order abba` pairs, identical decoded body hashes/bytes, zero errors and the same keep rule.

Optional `PB_VERCEL_BYPASS` is sent only to the selected origin as `x-vercel-protection-bypass`; only its presence is recorded. Protected WebKit browser paths use a scoped forwarding route and block workers, adding proxy overhead; do not compare them with native unprotected browser baselines. API comparison does not use that browser route. Cookies, passwords, viewer tokens, error bodies and bypass values never enter diagnostics.

## Deployed roster baseline and retained aggregation

The operator's California-to-cle1 baseline used five repetitions and 10,982 controller requests, zero errors. History 90.98 ms and unchanged polls 94.78 ms established a roughly 90 ms transport floor; `api.players` was 551.99 ms median (range 404.90–574.00), while session 108.49 ms, reports 106.02–111.99 ms and Save 185 ms were near their goals after that floor. Ten-concurrent writes had median 219.30 ms and one 5.16 s outlier of 50; its cause was unverified. Viewer p95 was 1.83–2.12 s. Raw operator baseline and live receipts are `evidence/bench/live/`.

The retained scoped SQL aggregation replaces transfer/derivation of every ledger row with exact per-player/currency summaries. It excludes voids, preserves correction ordering, cash-out-only closed results and separate positive/negative debts. Full authenticated roster requests use six database calls; individual history remains seven. Real-Postgres parity fixtures compare every banker/search result byte-for-byte with the domain path.

Five live interleaved pairs, three reads per leg, shared reused seed and identical response hashes produced 30 observations, 34 requests, zero mutations/errors:

| Roster comparison | Before ms | After ms | Evidence |
| --- | ---: | ---: | --- |
| Median of pair medians | 447.38 | 139.76 | `evidence/bench/live/players-ab/` |
| Pair-median range | 405.61–507.89 | 135.59–158.41 | all five pairs improve |
| MAD | 41.78 | 4.18 | 307.62 ms gap exceeds both |

This 68.8% deployed gain is distinct from the local synthetic UI results below. Local diagnosis returned 40 summaries instead of 2,409 wide history rows: data-query incoming bytes fell 4,586,237→6,699 and full-handler median 71.403→16.946 ms; SQL plan 18.417 ms had no temporary blocks. Detailed diagnostic/scale proof remains in `evidence/bench/players-r12/`; no index was added.

## UI baseline and retained gains

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

The shaping proxy requests identity upstream, then compresses eligible nonempty text/JSON/JavaScript/XML/SVG/WASM responses before its byte budget. It follows Accept-Encoding quality preferences, prefers Brotli on ties and falls back to gzip/identity. Existing Content-Encoding, no-transform, ranges and HEAD/204/304 bodies are untouched; owner, cookie, timing and cache headers are preserved, with Vary: Accept-Encoding. Both function and static delivery cross this boundary. Local codecs are Node Brotli quality 4 / gzip level 6, buffered without a CDN cache. This emulates negotiated payload sizes, not Vercel codec/threshold fidelity, codec CPU, streaming, HTTP/2, geography or edge/database latency. Counters distinguish upstream from encoded payload bytes (excluding TLS/IP overhead); browser metadata records encoding and both sizes. 18 real HTTPS regressions passed. A measured financial response was about 15 KB br / 131 KB decoded, with about 5–6 ms driver time. This transport correction does not establish a deployed latency gain.

### Retained Activity formatting

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

The final application is byte-identical to `a741fa7`; no API, schema, update-worker or updater logic changed. Long sign-in remains about 795.5 ms in this synthetic profile, without a demonstrated gain. Repeated money defaults remain the largest named application self-time group in the final-build diagnostic (73.7 ms of 180.1 ms). Complete state/history transfer is compressed already; it still incurs bandwidth/latency and client rendering work. The batch attempt did not meet the small-workload gate, so a plausible CPU saving is not retained. Another client-preparation/sign-in attempt could help, but would need fresh profiling and a passing matched comparison; further attempts need fresh matched evidence, rather than assuming the search is exhausted. No index, API-delta protocol or migration was introduced.

Regression coverage preserves exact money, query budgets and roster parity, chosen-player methods, full Activity/corrections, account ownership, offline once-only replay and update safety. The recorded performance gate was 128 scoped unit and 12 browser cases; current release verification is in the turn report. All three final comparison campaigns supplied 460 valid observations, zero sample errors and 90 completed cleanup receipts. The rejected batch standard guard had three noisy legs; no generator saturation was reported. Proof: `turn5/final-scoped.log`, `final-gate.json`, `time-source.json` and `time.patch`.

The decision trail is ignored `evidence/bench/hillclimb.tsv`; baseline/final proof remains under `evidence/bench/turn3/` and `turn5/`. Rejected intermediate cases retain samples/comparison/provenance summaries in `turn4/`, including `rejected-archive.json`. No performance claim here establishes physical iOS behavior.
