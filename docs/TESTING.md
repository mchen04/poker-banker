# Verification

## Commands and ownership

Run scoped files while iterating. Run the complete gate once before release:

Before the mini E2E command, [prepare and copy the public update archives](../.claude/skills/verify-poker-banker/features/offline-and-app-updates.md) and set their printed hashes as `MANIFEST_SHA` and `LEGACY_MANIFEST_SHA`. The mirror has no `.git`, so the command passes those inputs explicitly.

```sh
scripts/mini.sh pnpm typecheck
scripts/mini.sh pnpm build
scripts/mini.sh pnpm test
scripts/mini.sh env PB_UPDATE_PREVIOUS_MANIFEST=.cache/update-fixtures/previous/manifest.json PB_UPDATE_PREVIOUS_MANIFEST_SHA256="$MANIFEST_SHA" PB_UPDATE_LIVE_LEGACY_MANIFEST=.cache/update-fixtures/legacy/manifest.json PB_UPDATE_LIVE_LEGACY_MANIFEST_SHA256="$LEGACY_MANIFEST_SHA" pnpm e2e
```

The runner checks shared-host capacity, installs the frozen lockfile under Node 22 and copies ignored `test-results/` and `evidence/` back. Vitest reports to `test-results/vitest.json`; Playwright retains its JSON/HTML report, failed traces and screenshots. No test uses a remote database. Keep builds, browser suites, update proofs and benchmarks serial because they share `dist/`.

Database/API tests use real disposable embedded Postgres. Every browser application test owns a fresh database, HTTPS loopback server, cookies and storage. The input-only probe needs no database. All processes start through the owned-process registry; shutdown waits for registered groups, escalates with bounded waits, ends pools before Postgres, and removes only that run's PG/TLS/scratch directories. Pool error listeners consume idle-connection errors without leaking connection strings. Cleanup failures remain nonzero; evidence survives.

Four projects use Playwright-owned browsers: `iphone-webkit`, `iphone-standalone`, `desktop-webkit` and `desktop-chromium`, with one worker and retries zero. Standalone emulates iPhone 15 touch/display-mode and `navigator.standalone`. Test contexts trust only their generated loopback certificate; Chromium's owned process also needs its local certificate-error flag for service workers. No system trust store or user browser is changed.

The disposable server strips non-cache headers from `304`, including banker identity, to reproduce Vercel. Ordinary `200` retains identity. This wrapper is absent from the function and disabled in an ordinary local launch unless `PB_TEST_EDGE_HEADERS=1` is explicit. The real Vercel entry is imported by its HTTP regression test to verify Web Request JSON bodies reach Hono.

## Coverage and browser input

The permanent suites cover exact money and rational reports; append-only corrections/Undo; zero cash-outs; partial/late settlements; timers and unknown times; closed/reopened cumulative results; account/viewer isolation; idempotency/concurrency; request ownership and stripped `304`; persistent drafts, cross-tab conflicts and frozen-request recovery; quota failures, atomic sign-out consent, offline replay and recovery-code backup.

All typed fields use `e2e/input.ts`: select/delete/type through physical keyboard events, with native retention checked immediately. Date/datetime entry uses explicit `en-US` segments; unsupported locales fail. WebKit bulk fill previously reported success with an empty React input, so retries or longer timeouts are not substitutes for this input path.

Fault-injection tests block workers only when direct network observation is required. They hold genuine responses after database commit, then verify ownership, retained uncertainty and exactly-once replay. Offline/update proofs retain workers. API fixture setup is identified separately from UI actions; saved-state checks use read-only public endpoints.

## Update proof

Follow [offline and app updates](../.claude/skills/verify-poker-banker/features/offline-and-app-updates.md) for pinned tracked-source archives and launch variables. `drive updates` and the browser suite share `scripts/verify-update-journey.ts` and `scripts/verify-update-review.ts`. Run it last, then clean up; it changes the shared static build.

Real builds, HTTPS, workers, Cache Storage, UI writes and Postgres prove:

- Idle A discovers/adopts B automatically; an editing sheet, offline outbox, active request or held committed Undo blocks unsafe reload. Drafts and authentication survive; replay writes once.
- Previous `dc2082b` v2 drafts/outbox replay unchanged against the current API, and the actual archived reader accepts current records.
- Overlapping lifecycle signals and stalled headers/bodies initiate one navigation. The navigation deadline covers the body and falls back to the cached shell.
- Server-deleted lazy modules remain reachable from retained release caches. Normal app builds have one static entry; proof-only modules are emitted by the same build/precache path.
- Real HTML/bundle skew recovers before the entry executes, with at most two recovery navigations. A healthy real module held 18 seconds completes without a timeout reload.
- Seven deployments, including a failed B installation whose document stays open, retain complete manifests and finite per-cache URL/body-byte inventories. Unknown-client fallback pins clear after identification. Original live assets/drafts remain; closing documents collects unreferenced metadata/assets.
- Exact legacy `30209c1` cannot acquire request guards retroactively. Its waiting worker receives ACTIVATE but no old-controller fetch events during a held POST, so quiet time cannot establish safety. Activation remains deferred until legacy documents close or navigate; cold adoption preserves drafts and queued bodies. This is deliberately not a claim of hot adoption after legacy resume.

The owned TLS proof forwarder delays genuine upstream responses or modules; it does not manufacture response bodies. Normal builds reject the diagnostic observer. Cache byte counts are decoded response sizes, not physical disk allocation. Named opt-in review cases are documented in the feature file; never run them alongside the shared full update journey.

## UX and evidence

The [verification skill](../.claude/skills/verify-poker-banker/SKILL.md) owns launch, doctor, ledger/feature driving, evidence and cleanup. Its feature map supplies current selectors and reusable layout captures. Require saved-state proof alongside a Saved toast. Keep passwords, cookies and recovery codes out of artifacts.

Layout captures check light/dark phone at 393×659 and 393×852, desktop 1440×1000, four/six complete player rows, long names and maximum money, debt contrast, all money sheets and invalid fields, session picker/settings, and live/revoked viewers. Keyboard emulation uses a 380px visual viewport. The ready card restores two-control close; the footer retains its Buy-in/New session meaning. Undo has eight unpaused seconds and retains recorded timer history. Reports keep hand-computed values and grouped variation formatting.

Basic accessibility checks require named buttons, visible text of at least 11px, 44px control targets and no horizontal overflow at 375px. They do not replace a full accessibility audit.

## Limits

Browser emulation proves engine, viewport and controlled application behavior. It does not prove real Home Screen installation, iOS suspension/termination or worker lifetime, OS storage eviction, actual software-keyboard panning, physical home-indicator clearance or public HTTPS trust. Those remain real-device acceptance items. Local benchmarks also do not establish deployed latency; see [PERFORMANCE](PERFORMANCE.md).

The earlier clean-copy `vercel build --prod` proof used only supplied project-link metadata, no downloaded/read environment files, and resides in `evidence/vercel/r5-final/`. Re-run it explicitly when deployment configuration changes; it is not part of local browser acceptance.
