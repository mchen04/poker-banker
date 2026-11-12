# Justin's poker banker

A phone-first banking PWA for home cash games: reusable players, exact buy-ins/cash-outs and payments, traceable corrections, reports, login-free viewers and durable offline work. It records money; it does not transfer funds.

## Local development

Use Node 22 and the pinned pnpm through Corepack:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm db:local pnpm start:local
```

Open http://127.0.0.1:3000. The helper starts embedded Postgres on loopback port 55432, migrates ignored `.local-db/` and stops its owned processes on exit. `PG_LOCAL_PORT` changes the database port; `PORT` changes the HTTP port. `pnpm db:local` alone keeps the database running until Ctrl-C. Without this helper, `pnpm start:local` requires `DATABASE_URL` and serves `dist/` plus the same Hono app used by Vercel.

## Verify

Before the mini E2E command, [prepare and copy the public update archives](docs/TESTING.md#update-proof) and set their printed hashes as `MANIFEST_SHA` and `LEGACY_MANIFEST_SHA`. The mirror has no `.git`, so the command passes those inputs explicitly.

```sh
scripts/mini.sh pnpm typecheck
scripts/mini.sh pnpm build
scripts/mini.sh pnpm test
scripts/mini.sh env PB_UPDATE_PREVIOUS_MANIFEST=.cache/update-fixtures/previous/manifest.json PB_UPDATE_PREVIOUS_MANIFEST_SHA256="$MANIFEST_SHA" PB_UPDATE_LIVE_LEGACY_MANIFEST=.cache/update-fixtures/legacy/manifest.json PB_UPDATE_LIVE_LEGACY_MANIFEST_SHA256="$LEGACY_MANIFEST_SHA" pnpm e2e
```

The runner checks capacity, syncs source without credentials/local data, installs the lockfile under checksum-verified Node 22 and copies results back. Tests use owned disposable embedded Postgres and Playwright browsers. See [TESTING](docs/TESTING.md) and the [verification skill](.claude/skills/verify-poker-banker/SKILL.md) for scoped commands, evidence and cleanup. Real iOS installation, suspension and keyboard behavior require device acceptance.

## Contracts

- Money is exact bigint minor units in one currency per session. Only cash-out may be zero; zero never generates a payment. Results appear only after cash-out, and cumulative results include closed sessions only.
- The ledger is append-only. Corrections append a void and optional replacement. Undo atomically voids the latest receipt and its generated payment; it preserves recorded timing.
- Each financial operation freezes a UUID `op_id`, path, method and body. Lost replies replay that exact request. Proven rejections release editable work with a fresh ID; uncertain work remains frozen until checked or explicitly discarded with its duplicate-risk warning.
- Drafts, queued writes and confirmed snapshots use IndexedDB. Cross-tab changes require review; failed local saving remains dirty and blocks app reload/clearing. Pending writes never contribute to totals.
- Signed-in requests bind to the displayed banker. Account changes block acceptance and preserve local work. Viewer links expose one session only.
- Session creation sets a fixed 180-day HttpOnly/Secure/SameSite cookie. Other responses never renew or clear it. Logout/recovery revoke server sessions; recovery codes are shown immediately and require acknowledgement.
- Timer bounds apply to known-time chip entries, not late payments or expenses. Unknown times stay unknown. Reports use each player's participation intervals, exact rational inputs and display-only half-even rounding.
- Guarded clients discover updates on launch, foreground/online and visible idle checks. Activation/reload waits for safe input/request/storage/outbox state. Legacy clients without request guards must close or navigate before adoption; they cannot be upgraded safely in place.

[APPROVED-SPEC](docs/APPROVED-SPEC.md) defines the product; [ARCHITECTURE](docs/ARCHITECTURE.md) defines schema, API and safety contracts; [UX](docs/UX.md) contains the screen inventory and measured taps. [PERFORMANCE](docs/PERFORMANCE.md) documents the current harness, baselines and kept/rejected attempts.

## Migrations and deployment

```sh
pnpm db:migrate
```

Supply `DATABASE_URL_UNPOOLED` in the calling environment, with `DATABASE_URL` as fallback. Each numbered SQL file runs in its own transaction and is recorded in `schema_migrations`; an advisory lock serializes runners. Never amend an applied migration. Deploy compatible schema before code that needs it.

Vercel serves the static build and Web Request handlers at `/api/*` in `cle1`; production uses the dedicated Neon pooled URL. `APP_ORIGIN` can set the canonical HTTPS origin. Authenticated mutations require equal Origin and JSON content type. For local HTTPS, explicitly supply both `LOCAL_TLS_KEY` and `LOCAL_TLS_CERT`; tests create and remove their own certificates. These commands do not provision, push or deploy anything.
