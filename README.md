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
