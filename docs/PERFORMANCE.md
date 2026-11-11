# Performance baseline

This round measures the current production build. It makes no performance optimization or speedup claim. Goals below are proposed p95 budgets, chosen before baseline collection. Missing a goal is a finding, not a reason to change the application during this round.

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

Five repetitions alternate the order of workspace/viewer, cold/warm and 1/10/25-viewer scenarios. Each read and browser metric has two samples within each repetition, reduced from the initial five-sample plan to bound runtime while retaining all five repetitions. The ten load and Save samples give a coarse nearest-rank p95 equal to their maximum; this is a baseline, not a production SLO estimate. Concurrent writes run in batches of ten. Raw samples retain status, bytes, completed work, revisions and errors. Failed work is never included as a fast success. Server duration comes from a benchmark-only `Server-Timing` header around the same Hono app; raw samples also retain loopback request duration.

Cold means a fresh browser context with empty HTTP cache, IndexedDB and service-worker storage. A banker receives only its own valid test cookie. Warm means the same release has loaded and its worker has activated in that context before a timed reload. Browser and operating-system processes remain warm. Meaningful render is an operational paint opportunity: the actual session heading, totals and nine player rows have rendered, followed by two animation frames. It is not the deprecated browser First Meaningful Paint API, and nine rows do not all fit in the first viewport. Warm snapshots may render before current HTTP confirmation; the raw sample records that distinction and the harness subsequently verifies the request completed.

Load and single-Save scenarios use WebKit with iPhone 15 touch settings and synthetic phone constraints. Network shaping adds 60 ms response latency, 2 Mbps aggregate downstream and 512 Kbps upstream. It preserves normal HTTP caching and service workers. CPU shaping allows the benchmark's own WebKit executables to run for a target 25 ms of each 100 ms. Every signal checks an exclusive copied engine path; executable hashes match the installed Playwright build. macOS WebContent XPC processes have their own process groups, so pausing only the browser group is insufficient. Copying preserves relative symlinks so those services also execute under the exclusive path. Actual duty fractions are recorded. This budget pauses the owned UI, WebContent, networking and GPU executables together, so frame scheduling can be more restricted than renderer-only CPU emulation. This is not native WebKit CPU emulation or a measurement of a physical iPhone.

Concurrent-viewer scenarios use visible, unthrottled WebKit contexts as a load generator. They measure from the banker's actual Save click to each viewer rendering the uniquely identified stored entry and updated totals, followed by two animation frames. Raw work also includes banker-confirmation time and the difference between banker confirmation and viewer render. API reads and loads start with 60 open-session entries. The timed user writes then grow that ledger; every sample records its work. Databases are reseeded between repetitions. Viewer observations within a saved write are correlated; five runs are the independent repetitions. Different polling phases and observation counts can change the per-viewer median; a lower median with more viewers is not a speedup. Local TLS handshakes and DNS are not shaped. No Vercel edge, Neon round trip or physical iPhone performance is measured.

The copied engine is primed outside reported timing so operating-system security scanning can settle. Before building a reported baseline the runner requires 60 quiet seconds. Before each repetition it requires three quiet process checks five seconds apart and records load and core count. A heavy process uses at least one full core; aggregate unrelated CPU must stay below 20% of the machine’s core capacity. An unrelated heavy workload observed during a repetition invalidates it. It does not stop anyone else's work. Host CPU, memory and controller event-loop delay are retained to identify load-generator saturation. Query plans use `EXPLAIN (ANALYZE, BUFFERS)` outside timed samples. An additional unreported CPU-profile pass diagnoses server work. Baseline results and limiter findings will be filled from those receipts after collection.
