# Browser verification

Run `scripts/mini.sh pnpm e2e`. Playwright builds the app and starts `pnpm start:local` with a fresh throwaway embedded Postgres for each test. Each journey gets its own HTTPS loopback port, cookies and browser storage. The server generates a one-day self-signed certificate in its ignored temporary directory and removes it at shutdown. Browser contexts ignore certificate errors for that local test server; production Secure cookies stay enabled. Browser workers run sequentially because update verification replaces the local static build.

The four projects are iPhone WebKit with touch, iPhone WebKit with emulated standalone signals, desktop WebKit, and desktop Chromium. All browsers belong to Playwright. Existing browser caches are used when their revisions match the installed Playwright version.

## What the emulation proves

The journeys exercise authentication, recovery and session revocation, account isolation, session-scoped persistent drafts, roster history, money and corrections, closing and cumulative results, sharing, polling, offline replay, IndexedDB forward migration, payment methods, timer persistence, result displays, reporting and the waiting-worker update path.

The cross-tab late-acknowledgement regression blocks service workers so Playwright can hold a real HTTP response after its database write commits. All update, offline and other journeys keep workers enabled. It proves sign-out does not recreate cleared private storage when that response arrives later.

The standalone project sets `navigator.standalone` and the standalone display-mode media query before the page loads. The update journey dispatches hidden and visible document states, checks the waiting banner and activates a rebuilt worker on the same local server. It verifies retained authentication, drafts, session data and the new worker version.

## What remains open

Emulation does not prove a real iOS Home Screen installation, iOS process suspension or termination, real device storage eviction, a physical keyboard or the iOS software keyboard. Those acceptance items require a real iPhone. Local certificate-error bypass also does not prove production certificate trust or installation from a publicly trusted HTTPS origin. WebKit engine tests are evidence about the engine and viewport, not a claim that an actual Home Screen installation was tested.

## Visual checks

Screenshots are written under ignored `evidence/screenshots/` in phone and desktop projects, in light and dark color schemes. Basic checks reject buttons without accessible names, visible text below 11 px and horizontal page overflow at 375 px. These checks do not replace a complete accessibility audit or a physical-device review.
