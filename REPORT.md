# Poker banker foundation

Justin's home poker banker now has a working banking foundation with saved accounts, isolated records, recovery and a complete HTTP API. The phone workspace and installed PWA arrive in later rounds.

## What is ready

The project builds a React 19 placeholder and runs the same Hono API locally and through its Vercel entry. The ledger uses exact integer money, preserves corrections, hides results while players are playing, and derives balances, discrepancies and closed-session history.

Postgres enforces account ownership through composite foreign keys. Session locks serialize writes. Saved operation responses prevent duplicate writes on retry. Sharing exposes one session and supports rotation and disabling.

Accounts use Argon2id, secure sliding cookies, username and IP lockouts, and one-time recovery codes. Recovery revokes all sessions. The local database helpers need no credentials or remote services.

## Verification

All 54 tests passed on the mini with real embedded Postgres. Typecheck passed there. The production build passed locally using Node 22 and produced the static client.

The tests cover money edges, state derivation, account recovery, account isolation, viewers, idempotency, parallel writes and voids, revision-safe close, reopen and cumulative results, migration reruns and rollback, and the real Node HTTP adapter.

Review found and fixed lockout escalation after expiry, concurrent successful login handling, numeric event ordering, concurrent seating versus rename revisions, and HTTPS Origin checking behind TLS termination. The local server smoke check returned HTML for the app, 404 for a missing asset, and JSON 401 for unauthenticated API access.

## Remaining rounds

The UI, offline drafts and outbox, service worker and installed-PWA update verification, project verification skill, benchmarks, Neon provisioning and Vercel deployment remain intentionally unbuilt. No push, PR, deploy, remote database, account change or card event was performed.

The card report renderer is absent on this host. The orchestrator can render this report on its host. Specification and reference changes made concurrently by the orchestrator were left untouched and uncommitted by this implementation lane.

## Proof

- Branch `work/poker-banker`.
- Implementation commits, in order: `7f22910`, `47c4798`, `346a079`, `91e1398`, `24d86b4`, `76a45e7`.
- `scripts/mini.sh pnpm typecheck` passed. Output is [mini-typecheck.log](test-results/mini-typecheck.log).
- `scripts/mini.sh pnpm test` passed, 54 tests, 4 files, 0 failures. Output is [mini-test.log](test-results/mini-test.log), with [Vitest JSON](test-results/vitest.json) copied from the mini.
- `pnpm build` passed using Node `v22.23.4`. Output is [build.log](test-results/build.log).
- The mini bootstrap verified `node-v22.23.4-darwin-arm64.tar.gz` against the official SHASUMS256 manifest.
- A simulated unavailable mini made the runner exit 3 before syncing. An intentional command exit 7 was preserved and its [output artifact](test-results/runner-probe.txt) was copied back.
- Local HTTP receipts are [app headers](test-results/local-http.headers), [missing asset headers](test-results/local-missing.headers), and [API headers](test-results/local-api.headers).
- [README.md](README.md) explains local development, migrations, environment settings and API transport conventions.
