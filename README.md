# Justin's poker banker

This round supplies the banking domain, Postgres schema, account recovery and HTTP API. The React screen is a placeholder. UI, offline storage, the service worker, browser verification and benchmarks come in later rounds.

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

For production in a later round, the application uses `DATABASE_URL` for its pool and the migration runner uses the unpooled URL. `APP_ORIGIN` optionally fixes the canonical HTTPS origin. Without it, the API checks the request host, using HTTPS under Vercel's TLS termination. No production database or deployment is configured in this round.

## Verify

```sh
scripts/mini.sh pnpm typecheck
scripts/mini.sh pnpm test
pnpm build
```

The runner checks mini capacity before syncing, installs the lockfile with official checksum-verified Node 22, and copies back `test-results/` and `evidence/`. It preserves a failed command's exit code. Database tests start isolated embedded Postgres clusters under ignored `.cache/` with no external database access. Vitest writes its JSON result to `test-results/vitest.json`.

## API conventions

The routes and ledger semantics are specified in [the architecture](docs/ARCHITECTURE.md). Money and revisions are decimal strings in responses. Entry amounts are positive integer strings within the Postgres bigint range. Derived totals and accepted discrepancies can exceed one entry's range. Close accepts an exact decimal revision string or a safe integer for `expected_revision`.

Business mutations require a UUID v4 `op_id`. Retries use the same ID and canonical JSON body. The key also identifies the method and path. Replays return the exact saved JSON response, even if the session has since changed. A new operation needs a new ID. Auth routes follow their specified credential bodies instead of using `op_id`.

All mutations require an equal `Origin` and `Content-Type: application/json`. The authentication cookie is `pb_session`, with HttpOnly, Secure, SameSite=Lax and a 180-day sliding expiry. Recovery codes are returned only when created. Recovery consumes one code and revokes all sessions. Password changes keep the current session and revoke other sessions.

Session writes serialize on the session row. Each successful operation increments its revision once, including paired chip/payment entries and corrections. Player renames also lock and revise affected sessions so pollers receive the new name. An owner can share a session through its `share_token`; viewer responses omit that token and all banker identity fields.

## Payment, timing and report additions

Session create and PATCH accept nullable `location`, `game` and positive `big_blind_minor` strings. Omitted PATCH fields keep their values; null clears them. `GET /api/suggestions` returns sorted distinct `locations` and `games` from that banker's saved sessions.

`POST /api/sessions/:id/start {op_id}` starts an unset timer. The first buy-in also starts it automatically when unset, using the entry's occurrence time. Both write `timer_started` history. Each operation still increments revision once.

`PATCH /api/sessions/:id/timing {op_id, started_at, ended_at}` records corrected timing, where `ended_at` can be null. The event includes old and new values. Effective entries must fit inside the corrected bounds. Closing sets an unset end; reopening retains it. To resume an ended game, reopen and correct timing with `ended_at: null`. Reopen before correcting a closed session.

Entries accept `occurred_at` as a timezone-qualified ISO timestamp and normalize it to UTC milliseconds. Entry times must fit existing timer bounds. Live chip entries in occurrence order determine player intervals. Rebuys while playing continue one interval, and cash-out followed by re-entry creates another. Corrections preserve original order when timestamps tie.

Payment entries require `method: 'cash' | 'venmo' | 'zelle'`. A paid buy-in or cash-out also requires the method for its paired payment. Unpaid chip entries and `expense` entries have no method. The ledger stores the method on the payment row only. An expense affects reported fees and net after expenses, while chip totals and settlement balances stay the same.

The void endpoint accepts `replacement_amount_minor`, `replacement_method` and `replacement_occurred_at`. Any replacement field creates a replacement, preserving other values. Method changes apply only to payments. The original, void and replacement remain visible in entries.

Session responses include `server_now`, persisted `timing`, and each player's `intervals`, `duration_ms` and `performance`. Performance supplies result, duration, blind and exact `per_hour` and `big_blinds` numerator/denominator strings. A playing result or a rate without its required denominator is null. A player's duration comes from their intervals, never table time.

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
