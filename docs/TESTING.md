# Verification

## Commands and ownership

Run scoped files while iterating. Run the complete gate once before release:

The mini runner prepares and transfers SHA-verified archives of the pinned previous and legacy clients from this local Git history. Its Git-less mirror receives the release inputs automatically; no extra environment variables are required.

```sh
scripts/mini.sh pnpm typecheck
scripts/mini.sh pnpm build
scripts/mini.sh pnpm test
scripts/mini.sh pnpm e2e
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

The [verification skill](../.claude/skills/verify-poker-banker/SKILL.md) owns launch, doctor, ledger/feature driving, evidence and cleanup. Its feature map supplies current selectors and reusable layout captures. Require saved-state proof alongside a Saved toast. Keep passwords, cookies and recovery codes out of artifacts: the mobile recipe masks every recovery-code element in its captures, records only counts, and refuses to capture that screen unmasked.

Layout captures check light/dark phone at 393×659 and 393×852, desktop 1440×1000, six/eight complete player rows, long names and maximum money, debt contrast, all money sheets and invalid fields, session picker/settings, and live/revoked viewers. Keyboard emulation uses a 380px visual viewport. The ready card restores two-control close; the footer retains its Buy-in/New session meaning. Undo has eight unpaused seconds and retains recorded timer history. Reports keep hand-computed values and grouped variation formatting.

The [mobile-UX recipe](../.claude/skills/verify-poker-banker/scripts/mobile.ts) walks the route and state inventory at 393×852 and 320×568 in light and dark. It records 44px targets, horizontal overflow, text and non-text contrast from rendered colours, input font size, focused-field and pinned-primary visibility with a 380px visual viewport, primary-action reach, safe-area clearance with the tokens overridden to 59px/34px, 200% text and WCAG 1.4.12 spacing, tabular money, reduced-motion durations, a back or close control on every non-root view and the offline line. It writes `mobile-ux.json` and one screenshot per state, viewport and scheme, and fails on a violation. The screen tour adds the layout contract: no word-level text overlap between painted runs (each clipped to its scroll area and the viewport), no word broken mid-word, no wrapped button label, and no money clipped by its box, at phone, mid and narrow in light and dark. It also captures one 1440 desktop state and one 393 state with the notch and home-indicator insets applied. It runs 108 states and fails on any issue. The mobile-UX recipe additionally switches colour scheme on a live table and re-measures button contrast, checks that no content starts inside the top safe-area inset (applying the 59px/34px override itself), and fails on any clipped `code` or `pre` element. It settles every viewport change by nudging the height until `innerHeight` and `visualViewport.height` agree, because WebKit emulation can leave a fixed bar at the previous height after a single post-load resize (a control page with no app code reproduces it); it measures the bar on the captured frame and again after a second. On every state with a visible toast it fails when the strip is not flush above the bar or does not span the viewport, and its `toast-dock` scenario fails when the just-changed row is not fully visible after a save, when the last row's money or buttons do not clear the chrome at max scroll, or when `scrollY` changes during the two seconds after the one permitted adjustment. `e2e/player-rows.spec.ts` asserts the same scroll stability in the browser suite. The recipe uses the real UI only.

Basic accessibility checks require named buttons, visible text of at least 11px, 44px control targets and no horizontal overflow at 375px. They do not replace a full accessibility audit.

## Limits

Browser emulation proves engine, viewport and controlled application behavior. It does not prove real Home Screen installation, iOS suspension/termination or worker lifetime, OS storage eviction, actual software-keyboard panning, physical home-indicator clearance or public HTTPS trust. Automated contrast samples rendered solid colours; gradients, images and pseudo-elements are not sampled, and safe-area/keyboard checks use overridden tokens and a visual viewport rather than a device. Those remain real-device acceptance items. Local benchmarks also do not establish deployed latency; see [PERFORMANCE](PERFORMANCE.md).

The earlier clean-copy `vercel build --prod` proof used only supplied project-link metadata, no downloaded/read environment files, and resides in `evidence/vercel/r5-final/`. Re-run it explicitly when deployment configuration changes; it is not part of local browser acceptance.
