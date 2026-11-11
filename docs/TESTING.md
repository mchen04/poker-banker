# Browser verification

Run `scripts/mini.sh pnpm e2e`. Playwright builds the app and starts the local Hono server used by `pnpm start:local` with a fresh throwaway embedded Postgres for each application test. The native-input-only probe uses synthetic page content and does not need a database. The harness owns the server’s Node process directly so shutdown waits for the server, its connection pool and Postgres before removing its scratch directories. Each journey gets its own HTTPS loopback port, cookies and browser storage. The server generates a one-day self-signed certificate in its ignored temporary directory and removes it at shutdown. Browser contexts ignore certificate errors for that local test server; production Secure cookies stay enabled. The Chromium project also launches its Playwright-owned browser with `--ignore-certificate-errors`, because Chromium's service-worker script fetch does not honor the context-only bypass. This flag applies only to the local browser test process. The tests do not change any account, certificate trust store or production TLS settings. Browser workers run sequentially because update verification replaces the local static build.

The four projects are iPhone WebKit with touch, iPhone WebKit with emulated standalone signals, desktop WebKit, and desktop Chromium. All browsers belong to Playwright. Existing browser caches are used when their revisions match the installed Playwright version.

All typed fields in E2E helpers, specs and maintained verification recipes use `e2e/input.ts`. The driver selects, deletes and types through physical keyboard events. Native date and datetime fields use explicit keyboard segments for the suite's `en-US` locale; unsupported locales fail before entry. Normal typing checks native retention immediately. An explicit expected application value is used only for the stale-edit rejection check. A captured WebKit bulk fill reported success while the same input remained empty before submission; the trace does not record native React events. The earlier instrumented same-symptom probe and the native-input checks establish the keyboard path. The native probe covers both browser engines, prefixes, replacements, clear, leap dates, midnight, noon and AM/PM replacement. No retries or longer timeouts are added.

The disposable e2e server sets `PB_TEST_EDGE_HEADERS=1`. The local server then removes non-cache headers from `304` responses after timing instrumentation, including `X-PB-Banker-ID`, to reproduce Vercel's response behavior. The verification skill launches this same disposable server, so its local recipes exercise stripped-header polling too. Normal `200` responses retain their owner proof. The wrapper is absent from the Vercel function entry and is off for an ordinary `pnpm start:local` launch unless explicitly enabled.

## What the emulation proves

The recovery matrix covers all ledger kinds, new and existing players, session creation and settings, timing, close and reopen, sharing, timer start, pure void correction, rename and an unknown legacy command. UI checks edit and resubmit real requests, then inspect saved state; an unknown endpoint remains editable after its explicit rejection and can be discarded. Cross-tab checks retain typing, require conflict review, and preserve frozen requests.

The journeys exercise authentication, recovery and session revocation, account isolation, session-scoped persistent drafts, roster history, money and corrections, closing and cumulative results, sharing, polling, offline replay, IndexedDB forward migration, payment methods, timer persistence, result displays, reporting and the waiting-worker update path.

Fault-injection and unchanged-poll checks block service workers when Playwright needs direct network observation. The cross-tab late-acknowledgement regression holds a real response after its database write commits and verifies that sign-out cancels the request without restoring cleared private storage. Update and offline journeys keep workers enabled.

The standalone project sets `navigator.standalone` and the standalone display-mode media query before the page loads. The update journey dispatches hidden and visible document states, checks the waiting banner and activates a rebuilt worker on the same local server. It verifies retained authentication, drafts, session data and the new worker version.

## What remains open

Emulation does not prove a real iOS Home Screen installation, iOS process suspension or termination, real device storage eviction, a physical keyboard or the iOS software keyboard. Those acceptance items require a real iPhone. Local certificate-error bypass also does not prove production certificate trust or installation from a publicly trusted HTTPS origin. WebKit engine tests are evidence about the engine and viewport, not a claim that an actual Home Screen installation was tested.

## Visual checks

Screenshots are written under ignored `evidence/screenshots/` in phone and desktop projects, in light and dark color schemes. Basic checks reject buttons without accessible names, visible text below 11 px and horizontal page overflow at 375 px. These checks do not replace a complete accessibility audit or a physical-device review.


## Vercel production-build check

Round 5 was built from a clean source archive on this Mac with Node 22, a fresh frozen-lockfile install and `vercel build --prod`. Only the explicitly supplied `.vercel/project.json` link metadata was copied; no environment files were copied, read or downloaded. The clean copy received nonsecret local build settings (Vite, `pnpm build`, `pnpm install --frozen-lockfile`, `dist`, Node `22.x`) so the check did not need `vercel pull` or `--yes`. Receipts and exact source/patch hashes are in `evidence/vercel/r5-final/`.

`cle1` is the function region. Existing locked optional dependencies now include the Linux ARM64 binding required by the emitted function. Server/domain/API relative imports use explicit `.js` suffixes so the emitted ESM loads under plain Node 22. The artifact check imported the complete handler, loaded bundled `pg`, and hashed/verified Argon2id with zero database queries. It verified the matching Linux GNU ELF binding is present; this Mac cannot prove that binary executes on Linux. No deploy or remote database was used. The mini runner excludes `.vercel/` along with environment files.
