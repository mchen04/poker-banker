# Justin's poker banker

The phone-first workspace includes banking, account recovery, reusable players, reports, offline drafts and a waiting-worker update path. Production deployment and physical iPhone verification remain separate work.

## Run locally

Use Node 22 and the pinned pnpm version through Corepack.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm db:local pnpm start:local
```

Open http://127.0.0.1:3000. The helper starts embedded Postgres on loopback port 55432, initializes UTF-8 data in ignored `.local-db/`, applies migrations and runs the command with local database URLs. Closing the server stops Postgres. Running `pnpm db:local` alone keeps the database available until Ctrl-C. Set `PG_LOCAL_PORT` to change its port.

`pnpm start:local` serves `dist/` and the same Hono app used by the Vercel function. It requires `DATABASE_URL` when started without the database helper. `PORT` defaults to 3000. The secure cookie requires a secure browser context, such as localhost or HTTPS.

## Apply migrations

```sh
pnpm db:migrate
```

Set `DATABASE_URL_UNPOOLED`, or `DATABASE_URL` as a fallback, in the calling shell. The runner applies numbered SQL files in order, each in its own transaction, and records committed files in `schema_migrations`. A database advisory lock also prevents two migration runners from applying the same file at once.

For production in a later round, the application uses `DATABASE_URL` for its pool and the migration runner uses the unpooled URL. `APP_ORIGIN` optionally fixes the canonical HTTPS origin. Without it, the API checks the request host, using HTTPS under Vercel's TLS termination. These local commands do not provision a database or deploy the application.

## Verify

```sh
scripts/mini.sh pnpm typecheck
scripts/mini.sh pnpm test
scripts/mini.sh pnpm e2e
pnpm build
```

The runner checks mini capacity before syncing, installs the lockfile with official checksum-verified Node 22, and copies back `test-results/` and `evidence/`. It preserves a failed command's exit code. Database tests start isolated embedded Postgres clusters under ignored `.cache/` with no external database access. Vitest writes its JSON result to `test-results/vitest.json`.

## API conventions

The routes and ledger semantics are specified in [the architecture](docs/ARCHITECTURE.md). Money and revisions are decimal strings in responses. Entry amounts are positive integer strings within the Postgres bigint range, except `cash_out`, which also accepts `"0"` for a complete loss, including in corrections. A zero cash-out never creates a payment, even with `paid_now: true`. Derived totals and accepted discrepancies can exceed one entry's range. Close accepts an exact decimal revision string or a safe integer for `expected_revision`.

Business mutations require a UUID v4 `op_id`. Retries use the same ID and canonical JSON body. The key also identifies the method and path. Replays return the exact saved JSON response, even if the session has since changed. A new operation needs a new ID. Submitted form drafts freeze the path, method and body before sending. If a reply is lost, Check saved result replays that exact request. A stored success clears the draft; a proven validation rejection preserves its fields, returns it to editing and assigns a fresh `op_id`. Validation includes `400 invalid_request`, `400 outside_timer_bounds` and `409 entries_outside_timing`. Authentication, throttling and transport failures keep an uncertain draft frozen. A verified `409 idempotency_mismatch` preserves the different submitted body as an editable draft with a fresh ID and a review notice. It does not prove that the earlier request was never applied; a known original request remains replayable until confirmed. Auth routes follow their specified credential bodies instead of using `op_id`.

All mutations require an equal `Origin` and `Content-Type: application/json`. The authentication cookie is `pb_session`, with HttpOnly, Secure, SameSite=Lax and a 180-day sliding expiry. Recovery codes are returned only when created. Recovery consumes one code and revokes all sessions. Password changes keep the current session and revoke other sessions.

Session writes serialize on the session row. Each successful operation increments its revision once, including paired chip/payment entries and corrections. Player renames also lock and revise affected sessions so pollers receive the new name. An owner can share a session through its `share_token`; viewer responses omit that token and all banker identity fields.

## Payment, timing and report additions

Session create and PATCH accept nullable `location`, `game` and positive `big_blind_minor` strings. Omitted PATCH fields keep their values; null clears them. `GET /api/suggestions` returns sorted distinct `locations` and `games` from that banker's saved sessions.

`POST /api/sessions/:id/start {op_id}` starts an unset timer. A first buy-in with known `occurred_at` also starts an unset timer at that occurrence time, even if saved later. An unknown-time first buy-in leaves the start unset. The header shows Start time unknown and offers Correct times; a later rebuy does not guess the original start. A start writes `timer_started` history. Each operation still increments revision once.

`PATCH /api/sessions/:id/timing {op_id, started_at, ended_at}` records corrected timing, where `ended_at` can be null. The event includes old and new values. Effective chip entries with known times must fit inside the corrected bounds. Unknown times remain unknown; payments and expenses do not restrict timer bounds. Closing sets an unset end; reopening retains it. To resume an ended game, reopen and correct timing with `ended_at: null`. Reopen before correcting a closed session.

Entries accept `occurred_at` as a timezone-qualified ISO timestamp, normalized to UTC milliseconds, or `null` for unknown time. Omission also stores `null`; the server never substitutes receipt time. The client stamps the submit time against its last live `server_now`. Without that clock sample, or with device clock skew beyond two minutes, it sends `null`. Known chip times must fit existing timer bounds. Payments and expenses may occur after the game ends when the session is reopened. Live chip entries in occurrence order determine player intervals. Rebuys while playing continue one interval, and cash-out followed by re-entry creates another. Corrections preserve original order when timestamps tie.

Payment entries require `method: 'cash' | 'venmo' | 'zelle'`. A paid buy-in or positive cash-out also requires the method for its paired payment. Zero cash-outs have no paired payment. Unpaid chip entries and `expense` entries have no method. The ledger stores the method on the payment row only. An expense affects reported fees and net after expenses, while chip totals and settlement balances stay the same.

The void endpoint accepts `replacement_amount_minor`, `replacement_method` and `replacement_occurred_at`. Any replacement field creates a replacement, preserving other values. Method changes apply only to payments. The original, void and replacement remain visible in entries.

Session responses include `server_now`, persisted `timing`, and each player's `intervals`, `duration_ms` and `performance`. Performance supplies result, duration, blind and exact `per_hour` and `big_blinds` numerator/denominator strings. A playing result or a rate without its required denominator is null. A player's duration comes from their intervals, never table time. Any effective chip entry with unknown time makes that player's duration and hourly rate unavailable until the entry is corrected. Correcting table timing alone does not invent missing player times.

`GET /api/players/:id/report` accepts these optional filters:

- `group` is `overall`, `location`, `game`, `weekday` or `month`, defaulting to `overall`.
- `location` and `game` match stored text exactly, including case.
- `weekday` uses ISO weekday numbers, Monday `1` through Sunday `7`, from `played_on`.
- `month` uses `YYYY-MM`, from `played_on`.
- `from` and `to` use inclusive `YYYY-MM-DD` bounds on `played_on`.

The response has one `groups` row per group key and currency, with `sessions_count` and `metrics`. Only that player's effective entries in closed sessions contribute. An empty history returns no groups. Missing location or game uses a null group key.

Every metric has `sessions_used`, `value` and `unavailable`. Available values are exact `{numerator, denominator}` strings, with no rounding. Variation values use `{sqrt_of: {numerator, denominator}}` to represent sample standard deviation exactly. The radicand is the sample variance, and the displayed value is its square root. Below two valid session rates variation is unavailable.

Money values are in minor units. Hourly metrics use only sessions with valid positive player duration. Big-blind rates also require that session's positive blind. Rates divide total results by total time over the matching subset. Fees have separate expense and net-after-expense metrics; rate numerators use results before fees. Winning sessions have strictly positive results, while breakeven remains in the denominator. `formatRational` and `formatSquareRoot` apply half-even rounding only when preparing display text.

Migration `0001` was amended before deployment. Development clusters that already recorded its older version need a fresh local database to use this schema. The migration runner does not alter an already recorded migration. Test clusters always start empty.


## Client storage and updates

Drafts, queued writes and confirmed snapshots live in the versioned `poker-banker` IndexedDB database. The v1 to v2 upgrade preserves records and adds banker indexes and metadata. Drafts are scoped by banker, session, form and player. Save atomically moves a draft to the outbox and records the immutable operation request. That binding survives acknowledgement. A recovered edit never reuses an operation already bound to different content. If another tab saved a newer draft, Review recovered edit keeps both versions until you choose Use recovered edit or Keep saved edit. The choice rechecks both versions and pending local writes, and never sends automatically. Only server-confirmed records affect totals.

The outbox sends session heads in order and retries transient failures with backoff. An unconfirmed response may already have committed; Check saved entry replays the same `op_id` and body. Discard is allowed only when the request is known not to have applied, or after explicit acceptance that it may already exist and re-entry could duplicate it. A rejected head stays visible with its reason and blocks later entries in that session until retry or permitted discard. Other sessions can continue. Sign-out requires explicit discard when unsent work exists, then clears that banker's local data. Confirmed snapshots can reopen offline while new entries wait to sync.

`pnpm build` generates icons and stamps a unique release and precache list into the hand-written worker. Set `RELEASE_VERSION` to an explicit unique identifier when preparing a release. Direct Vite builds without a release fail. An installed update waits while a sheet is open, the page is hidden, or the outbox is not empty. The Update ready banner offers Reload, which flushes drafts before activation.

## Browser journeys

```sh
scripts/mini.sh pnpm e2e
```

Playwright uses its own browsers and a new embedded database for every journey. Screenshots are copied to ignored `evidence/screenshots/`. See [TESTING.md](docs/TESTING.md) for the projects and physical-device acceptance items that emulation cannot prove.

WebKit requires HTTPS for the Secure authentication cookie. The browser fixture generates a temporary self-signed certificate inside `.cache/` and runs the same local server with `LOCAL_TLS_KEY` and `LOCAL_TLS_CERT`. Both paths must be set together. For manual local HTTPS development, generate your own certificate in the ignored cache and pass those explicit paths to `pnpm start:local`. Test contexts accept their generated certificate; production uses normal HTTPS trust.
