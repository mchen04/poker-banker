# Poker banker architecture

Decisions made by the orchestrator before implementation. The approved product specification is `docs/APPROVED-SPEC.md`. This file says how it is built. Change a decision here first, then in code.

## Stack

- Client: Vite, React 19, TypeScript, plain CSS with custom properties. Built as a static SPA in `dist/`.
- API: one Hono app (`src/server/app.ts`) mounted as a single Vercel Node function at `/api/*`. The same app also runs in a local Node server that serves `dist/` for development, tests and benchmarks.
- Database: Postgres. Production is a dedicated Neon project reached through `pg` and Neon's pooled connection string (`DATABASE_URL`). Migrations use the direct, unpooled string (`DATABASE_URL_UNPOOLED`). Tests and benchmarks use a throwaway local Postgres from the `embedded-postgres` dev dependency, so they need no secrets and run on the Mac mini.
- Validation: `zod` at every HTTP boundary. Internal code trusts parsed types.
- Passwords: Argon2id through `@node-rs/argon2`.
- Tests: Vitest for domain and API, Playwright for browser journeys (WebKit iPhone-sized, WebKit standalone emulation, desktop WebKit as the Safari engine, Chromium desktop).
- Node 22 everywhere (Vercel's default line).

Why not Next.js: the app is one authenticated workspace plus one viewer page. A static SPA with a hand-written service worker gives full control over update timing, which the spec treats as a correctness requirement. Pancake confirms that a static export with a hand-written worker works on Vercel.

## Data model

All money is `bigint` minor units with an ISO 4217 currency code on the session. Amount parsing is string-based (`"20.50"` to `2050` for USD, `"500"` to `500` for JPY). No floats touch money.

```
bankers(id uuid pk, username text unique  -- stored lowercased, 3-32 chars [a-z0-9_.-]
        password_hash text, created_at, password_changed_at)
auth_sessions(id uuid pk, banker_id fk, token_hash bytea unique, created_at, last_seen_at, expires_at)
recovery_codes(id uuid pk, banker_id fk, code_hash bytea, created_at, used_at null)
login_throttle(key text pk, failures int, window_started_at, locked_until null)
players(id uuid pk, banker_id fk, display_name text, name_key text, created_at)
        index (banker_id, name_key)  -- not unique: two real people can share a name
game_sessions(id uuid pk, banker_id fk, name text, played_on date, currency char(3),
              status 'open'|'closed', closed_balanced bool null, closed_at null,
              share_token text unique null, revision bigint, created_at, updated_at)
session_players(session_id fk, player_id fk, banker_id fk, added_at, pk(session_id, player_id))
ledger_entries(id uuid pk, banker_id fk, session_id fk, player_id fk,
               kind 'buy_in'|'cash_out'|'payment_in'|'payment_out',
               amount_minor bigint check (> 0, or = 0 for cash_out), note text null,
               voids_entry_id uuid null unique fk -> ledger_entries.id,
               created_at, revision bigint)
session_events(id uuid pk, session_id fk, banker_id fk, kind 'created'|'renamed'|'closed'|'reopened'|'share_enabled'|'share_rotated'|'share_disabled',
               detail jsonb, created_at, revision bigint)
idempotency_keys(banker_id fk, key uuid, request_hash bytea, response jsonb, status int, created_at,
                 pk(banker_id, key))
schema_migrations(version text pk, applied_at)
```

Every row carries `banker_id`, and every query filters by the signed-in banker. Composite foreign keys (`(session_id, banker_id)`, `(player_id, banker_id)`) make cross-account references impossible at the database level.

### Ledger semantics

- The ledger is append-only. Nothing is updated or deleted.
- Every amount is positive except a `cash_out`, which may be zero when a player lost everything. A zero cash-out never creates a payment.
- A correction is a void: a new row of the same kind with `voids_entry_id` pointing at the original, written with the same amount. The unique index on `voids_entry_id` stops a double void under concurrency. Editing an amount is a void plus a new entry in one transaction, and the API returns both.
- Live (effective) entries are the rows that are not voids and are not voided.
- Chips: `buy_in` gives a player chips, `cash_out` records chips returned. Money: `payment_in` is cash the player handed the banker, `payment_out` is cash the banker handed the player. The app records these and never moves money.
- A buy-in form has a "Paid now" switch, on by default. When on, the server writes `buy_in` and `payment_in` for the same amount in one transaction. A cash-out form has a "Paid out now" switch, off by default.

### Derived values

Per player in a session:

- `bought_in = sum(buy_in)`, `cashed_out = sum(cash_out)`.
- State: `playing` when the latest live chip entry is a `buy_in`; `cashed_out` when it is a `cash_out`; `seated` when there is none. Early cash-out followed by a rebuy returns the player to `playing`.
- `result = cashed_out - bought_in`, shown only when the state is `cashed_out`. While a player is playing the app shows money in, never a guessed result.
- `balance = bought_in - cashed_out - payment_in + payment_out`. Positive means the player owes the banker, negative means the banker owes the player, zero is settled.

Per session: `total_in`, `total_out`, `on_table = total_in - total_out` while anyone is playing, `discrepancy = total_out - total_in` once everyone has cashed out, outstanding owed to the banker and owed by the banker, all exact.

Cumulative, per player and per currency: sum of `result` over closed sessions only. Values are derived from the ledger on read, never stored, so reopening and re-closing cannot double count.

## Session lifecycle

- `open` accepts ledger writes. `closed` rejects them with `409 session_closed`.
- Close requires every seated player with entries to be `cashed_out` and the request's `expected_revision` to match the current revision. When totals match it closes as balanced. When they do not, the request must carry `accept_discrepancy_minor` equal to the current discrepancy, and the session closes with `closed_balanced = false`. The UI shows the discrepancy in words.
- Reopen requires a reason, writes a `reopened` event, and removes the session from cumulative results until it is closed again.

## Concurrency and idempotency

- Every mutating request carries an `op_id` (UUID v4) chosen by the client when the draft is created. Once submitted, the request body is frozen with that `op_id`. If the reply is lost, the client replays the same request: a stored success completes the draft; a validation rejection returns the draft to editing with a fresh `op_id`; an uncertain write can be discarded only after the server shows it was never applied or the banker accepts that it may exist. The server stores `(banker_id, op_id)` with a hash of the canonical request body and the response, in the same transaction as the write. A replay with the same body returns the stored response. The same key with a different body returns `409 idempotency_mismatch`.
- The client records each submitted operation's immutable method, path and body in the same IndexedDB transaction as freezing or enqueueing it, and keeps that binding after acknowledgement. Recovered editable work whose operation was already submitted receives a fresh `op_id` and a review notice before delivery. A verified `idempotency_mismatch` returns only the different body to fresh editable work; it cannot prove that the earlier request was not applied. Known original requests remain frozen and uncertain until confirmed, and replacements never send automatically.
- An edit from another tab is stored beside the frozen request as a later draft. Confirmation or a proven rejection promotes that edit with a fresh `op_id` in the same local transaction. The form explains that it was submitted in another tab; the original request stays unchanged. A successful draft write always represents a committed local write.
- Each open form keeps its own observation of the saved draft's editable value and any later edit. Draft writes, retries, discards, freezing, enqueueing, replay claims and success or rejection settlement compare that value fingerprint in the same IndexedDB transaction as the mutation. A newer value makes the operation leave storage unchanged, refresh the form and ask the banker to review it before submitting again. Background reads cannot advance an open form's observation. Frozen-request and replay-claim metadata have separate identity checks; freezing unchanged values does not prevent a later edit from being retained beside that request. Sign-out uses its existing atomic fingerprint of all local work.
- A fingerprint conflict is a terminal local rejection with a review notice. It clears only that attempt's matching dirty intent, including after frozen-form recovery, and never leaves a storage retry pending. Its non-pending warning remains available if the form closes before it is shown; acknowledging that warning never changes a freshly read fingerprint. Real storage failures retain their unsaved values and the device-saving warning. Late discard and readback callbacks cannot replace newer typing; adopting another tab's saved value requires a visible review notice.
- Confirmed mutation rejections include business conflicts such as `already_seated`, not just input validation. An explicit application error after the stored-operation lookup releases the submitted draft, preserves its values, removes its unconfirmed marker and gives the next submission a fresh `op_id`. The same proof makes an outbox item safely discardable after an earlier uncertain attempt. Network failures, timeouts, 5xx, missing application codes, authentication/origin/content-type checks, throttling and `idempotency_mismatch` cannot settle that earlier attempt and preserve uncertainty.
- Every signed-in request uses an immutable client bound to its banker, sends that expected banker and verifies the authenticated response banker before accepting data, including reads, polls and logout. Signup, login, recovery and public viewer requests stay neutral; only startup and explicit account reload use neutral identity discovery. An active owner mismatch blocks that banker's work and shows Account changed with Reload account state, preserving local work until verified identity discovery adopts the cookie account. Outbox and submitted-form settlement also requires the account, sync claim or form lifecycle to remain current; a stopped or superseded attempt preserves uncertainty and cannot acknowledge or release another attempt's work.
- Vercel can strip custom response headers from `304`. An unchanged GET poll that sent its expected banker and a nonempty `since` may accept that empty response without an owner header, because authentication checks the expected banker before the route returns it. An explicit foreign owner still blocks. This exception supplies no data and cannot acknowledge a write.
- Other private responses without owner proof are unverified failures, including platform errors such as `413`, `431`, `502` and `504`. Their bodies are not parsed and they cannot release drafts or settle outbox work. `HEAD`, `204`, `205` and unexpected `304` responses also cannot acknowledge work. A headerless `401` retains the generic HTTP authentication challenge without trusting its body; it never proves that an operation was not applied.
- Every write to a session first locks its row with `SELECT ... FOR UPDATE`, checks status, writes, and increments `revision`. Writes to one session serialize; different sessions do not contend.
- Close carries `expected_revision`. Ledger writes do not, because appends do not lose updates.

## Auth and recovery

- Sign-up takes username and password (minimum 10 characters, checked against a short list of common passwords). It returns 10 one-time recovery codes, shown once, stored as SHA-256 hashes.
- Recovery codes appear immediately when the server returns them and stay visible until the banker confirms saving them. The local backup and restore marker can fail independently without hiding the codes. Startup checks the authenticated banker's recovery-code draft even if the marker is missing; a failed read requires retry before opening the workspace. Update reload waits for authentication requests and recovery-code backup or acknowledgement to finish.
- Sessions are 32 random bytes in an `HttpOnly; Secure; SameSite=Lax; Path=/` cookie named `pb_session`, stored as SHA-256, with a 180-day sliding expiry. The installed iOS app keeps its own cookie jar, so a banker signs in once inside the installed app.
- Sign-in throttling: failures are counted per normalized username and per client IP. After 5 failures in 15 minutes the key locks for 15 minutes, doubling up to 24 hours. Errors never reveal whether a username exists, and unknown usernames still run a password hash for equal timing.
- Recovery: username plus one unused recovery code plus a new password. Success marks the code used, replaces the password, and revokes every session. A signed-in banker can regenerate codes after re-entering the password, which invalidates the old set.
- CSRF: mutating requests must send `Content-Type: application/json` and an `Origin` equal to the app origin.
- No email. The recovery codes are the recovery path, and the sign-up screen makes saving them an explicit step.

## Sharing

- A banker enables sharing per session. The token is 128 random bits, base64url. The viewer URL is `/v/<token>`. Rotating replaces the token, disabling clears it.
- `GET /api/view/<token>` returns only that session's players, entries and totals, with player display names and no banker, account or other-session data.
- The token is stored in plain text because it grants read access to data that already sits in the same database. Hashing it would only stop the banker from copying the link again.

## API

All JSON. Errors are `{ "error": { "code": "...", "message": "..." } }`.

```
POST /api/auth/signup            {username, password} -> {banker, recovery_codes}
POST /api/auth/login             {username, password} -> {banker}
POST /api/auth/logout
GET  /api/auth/me                -> {banker} | 401
POST /api/auth/recover           {username, recovery_code, new_password} -> {banker}
POST /api/auth/recovery-codes    {password} -> {recovery_codes}
POST /api/auth/password          {current_password, new_password}

GET  /api/sessions               ?before=<played_on,id cursor>&q= -> {sessions[], next}
POST /api/sessions               {op_id, name, played_on, currency} -> SessionState
GET  /api/sessions/:id           ?since=<revision> -> SessionState | 304
PATCH /api/sessions/:id          {op_id, name?, played_on?} -> SessionState
POST /api/sessions/:id/players   {op_id, player_id} | {op_id, new_player_name} -> SessionState
POST /api/sessions/:id/entries   {op_id, player_id, kind, amount_minor, note?, paid_now?} -> SessionState
POST /api/sessions/:id/entries/:entry_id/void  {op_id, replacement_amount_minor?} -> SessionState
POST /api/sessions/:id/close     {op_id, expected_revision, accept_discrepancy_minor?} -> SessionState
POST /api/sessions/:id/reopen    {op_id, reason} -> SessionState
POST /api/sessions/:id/share     {op_id, action: 'enable'|'rotate'|'disable'} -> SessionState

GET  /api/players                ?q= -> {players[] with per-currency cumulative and outstanding}
POST /api/players                {op_id, display_name}
PATCH /api/players/:id           {op_id, display_name}
GET  /api/players/:id            -> {player, cumulative[], sessions[]}

GET  /api/view/:token            ?since=<revision> -> ViewerState | 304 | 404
```

`SessionState` is the whole session: settings, seated players with derived values, entries newest first, totals, events and `revision`. Mutations return it so the client never merges partial updates.

## Live updates

Polling, not sockets. Neon's pooled connections cannot `LISTEN`, and Vercel functions are short-lived. Visible pages poll `?since=<revision>` every 2 seconds, which costs one indexed lookup and returns `304` when nothing changed. Polling stops while the page is hidden and runs immediately on `visibilitychange`, `pageshow`, `focus` and `online`. Target: a viewer sees a banker's saved entry within 3 seconds at p95.

## Client state, drafts and offline

- IndexedDB database `poker-banker`, versioned, with stores `drafts`, `outbox` and `snapshots`. Upgrades migrate old records forward and never drop drafts.
- A draft key is `banker_id / session_id / form / player_id`. Switching sessions shows only that session's drafts. Drafts survive reloads, updates and app kills.
- If operation recovery meets a newer saved draft, both editable versions remain local. Review recovered edit offers Use recovered edit or Keep saved edit. Either choice first flushes pending local writes and compares the saved and recovered fingerprints in one transaction; a concurrent change requires fresh review. Choosing a version never queues a request.
- Needs review enumerates recovered entries and commands independently of their ordinary form keys. Recovery retains the exact request template and current editable values, preserves payment direction, and offers guarded save, resubmit and discard. The editor uses ordinary draft autosave, pending-write tracking, account ownership and fingerprints. A conflict pauses further keystrokes and actions until explicit review, without advancing the observed cursor. Frozen request metadata is checked separately from the editable fingerprint. Legacy fields without an exact request remain visible; an earlier operation is never treated as proof of the missing request.
- A failed local draft write retains the latest value in memory across sheet closure and account changes, shows "Not saved on this device" and offers retry. Application reloads wait until every retained value persists or is explicitly discarded. Unsaved memory cannot survive a browser or device process being killed.
- Submitting moves the draft into the outbox with its `op_id`. The outbox sends in order per session and retries with backoff when online. Entries the server has not acknowledged show as "Not saved yet" and are excluded from totals. A server rejection keeps the item, shows the reason, and offers retry or discard.
- `snapshots` holds the last `SessionState` per session so the app opens offline read-only.
- `navigator.storage.persist()` is requested after sign-in.
- Signing out clears that banker's drafts, outbox and snapshots after confirming nothing unsent remains, or after explicit discard of the current work. The sheet tracks changes, and the clearing transaction compares the accepted work again before deleting anything. New work invalidates earlier discard consent. If work arrives while logout is in flight, it remains local and the banker can sign in again to review it.

## Service worker and updates

Hand-written `public/sw.js`, stamped at build with a release version and the precache list.

- Precache the shell and hashed assets. Navigations are network-first with a 3-second timeout, falling back to the cached shell. Hashed assets are cache-first. `/api/*`, non-GET requests and responses with `Set-Cookie` or `no-store` are never cached.
- A new worker installs and waits. The page checks for updates on load, on `visibilitychange` to visible (at most every 5 minutes) and on `online`.
- When a worker is waiting, the page shows "Update ready" with a Reload button. It activates and reloads by itself only when the page is visible, the outbox is empty and no sheet is open. Activation and reload both flush local writes and check again for pending or failed writes immediately before proceeding.
- Missing hashed assets return `404` with `no-store` from Vercel instead of the SPA fallback, so a stale chunk never receives HTML. A chunk-load failure triggers the update path.
- Auth lives in the cookie, which the worker never touches, so updates cannot sign anyone out.

## UI

One workspace, phone-first, readable vertical scrolling, no horizontal tables.

- Top: a session strip with the open and most recent sessions as tabs labeled `Nov 10 · Friday game`, scrollable sideways if needed, plus a History button that opens a searchable picker sheet grouped by month, and a New session action.
- Header: name, date, currency, status in words ("Open", "Closed, balanced", "Closed, off by $20").
- Totals strip: In, Out, On table or Off by, Owed to bank, Bank owes.
- Player list: two-line rows. Line one is name and either "Playing, in $100" or the result with sign and word ("+$40 up", "−$60 down", "Even"). Line two is the detail ("In $100, 1 rebuy, Out $140") and payment state as text with a glyph ("Settled", "Owes $60", "Bank owes $40").
- Player sheet: that player's entries with void or correct actions, plus Buy-in, Cash out, and Record payment.
- Money sheet: a large amount field with `inputmode="decimal"`, quick amounts (last buy-in, session default, double), the Paid now switch, and a saved confirmation showing the stored amount.
- Activity: newest first, one line per entry, voids struck through and labeled "Voided" in text.
- Bottom bar within thumb reach: Add player and Buy-in as the primary action, with Close or Reopen in the session menu.
- Players screen: the roster with per-currency cumulative results from closed sessions and outstanding balances. Player detail lists past sessions. Rename keeps history.
- Viewer page: the same session view without controls, labeled "View only, updated 9:42 PM".
- Design tokens: Apple-like type scale (28, 20, 17, 15, 13 px in rem), weights 400 and 600, spacing 4 to 32, warm grays plus one muted accent, tabular figures right-aligned, 44 px minimum targets, safe-area padding, light and dark themes, 4.5:1 contrast. Status always has a word or glyph, never color alone. No gradients, glass, emoji, avatar blobs or pills on every value.

## Deployment order

`api/[...route].ts` exports `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS` and `HEAD` as Hono's `app.fetch`. These [Vercel Node Web Handlers](https://vercel.com/docs/functions/runtimes/node-js) receive a Web `Request` and return a Web `Response`, so JSON bodies reach Hono without a Node request-stream adapter. `vercel.json` routes `/api/*` to this function in `cle1` with `maxDuration: 30`.

1. Create the Neon project and set `DATABASE_URL` and `DATABASE_URL_UNPOOLED` in Vercel's encrypted project env. Sessions are random tokens checked against the database, so no signing secret exists.
2. Run `pnpm db:migrate` against the unpooled URL. Migrations are forward-only, numbered SQL files, each in a transaction, recorded in `schema_migrations`, and safe to rerun.
3. Deploy the build that needs the new schema. Each migration must also work with the previous release, so a migration lands before its code.

## Justin's feedback additions

Added after the spec gained the "Justin's feedback" section. Nothing has been deployed yet, so these changes amend migration `0001` directly instead of adding a compatibility migration.

### Schema changes

```
game_sessions  + location text null, game text null        -- free text with suggestions from past sessions, used for report groupings
               + big_blind_minor bigint null check > 0      -- in the session currency
               + started_at timestamptz null, ended_at timestamptz null, check ended_at >= started_at
ledger_entries + kind 'expense'                             -- tips and meals, outside chips and settlement
               + method 'cash'|'venmo'|'zelle' null         -- required for payment_in and payment_out, null otherwise (check constraint)
               + occurred_at timestamptz null              -- null means the time is unknown
session_events + kinds 'timer_started', 'timing_corrected', 'details_changed' with old and new values in detail
```

### Payment method

- Paid now on a buy-in or rebuy shows a compact Cash, Venmo, Zelle selector. The default is the method last used in that session, else Cash. The server writes `buy_in` plus `payment_in` with the method.
- Recording a later payment (unpaid to paid) is a `payment_in` or `payment_out` with a required method. An unpaid buy-in has no payment row, so it is never shown as received.
- Changing a method is a correction: void the payment and write a replacement with the new method. The void endpoint accepts `replacement_method` alongside `replacement_amount_minor`. Activity shows both rows.
- The method is a label of how money arrived. Nothing initiates a transfer.

### Session timer

- `started_at` is set by Start timer, or automatically by the first buy-in when unset and that buy-in has a known `occurred_at` (it takes that time). A buy-in with an unknown time leaves an unset timer unset, shown as "Start time unknown" until the banker sets it through Correct times. `ended_at` is set by Close when unset. Reopen does not clear `ended_at`; the banker restarts timing explicitly if play resumes.
- Every timer write checks the proposed bounds against all effective, known-time chip entries under the session row lock in the same transaction. If an automatic start would exclude an earlier cash-out, the entire buy-in is rejected with `409 entries_outside_timing`, including its timer, revision, ledger and history changes; the banker can use Correct times to include the earlier entry, then retry the buy-in. Reopen does not write either timer bound.
- `PATCH /api/sessions/:id/timing {op_id, started_at, ended_at|null}` corrects times and writes a `timing_corrected` event with old and new values. The session menu shows that history.
- The client shows `(ended_at ?? server_now) - started_at`. The server returns `server_now` so device clocks do not matter, and the client advances it locally between polls.

### Per-player playing time

- A player's intervals come from live chip entries ordered by `occurred_at`: a `buy_in` while not playing opens an interval, a `cash_out` closes it. Rebuys while playing do not open a new one. Leaving and re-entering produces two intervals.
- The client stamps `occurred_at` when the banker submits, using a clock checked against the last `server_now`. When the device clock disagrees by more than 2 minutes, or no server time has been seen since the app opened, it sends `null` and the time is unknown. The banker may set or correct it later through a correction.
- Chip entries (`buy_in`, `cash_out`) with a known time must fall inside the session's timer bounds when they exist. Payments and expenses may fall after the game ends, so a late settlement after reopening is allowed.
- A player with any chip entry of unknown time has an unavailable duration, never a guessed one.
- A player's duration is the sum of their intervals. The table's duration is never used for a player.

### Result display

- A per-device toggle with Total, Per hour and Big blinds, stored in `localStorage`. It changes display only.
- Per hour is `result_minor * 3_600_000 / duration_ms`, computed with integers and rounded half-even at display. Without a positive duration it shows "No time recorded".
- Big blinds is `result_minor / big_blind_minor` to two decimals. Without a blind it shows "No big blind set".
- Labels keep net result, gross cash-out and outstanding payments distinct.

### Player reports

`GET /api/players/:id/report?group=overall|location|game|weekday|month&location=&game=&weekday=&month=&from=&to=` returns, per group and per currency, over that banker's closed sessions where the player has entries:

- Profit/loss: sum of results.
- Per hour: total result divided by total valid playing time, over sessions with a valid duration (weighted, not an average of rates).
- Per session: total result divided by session count.
- Duration: total valid playing time.
- Winning sessions: count with result above zero over all sessions, with percentage. Break-even counts in the denominator.
- Tips and meals: sum of `expense` entries, shown with net after tips and meals. Rates use the result before tips and meals, and the report labels this.
- Big blinds per hour: sum over sessions of `result / big_blind` divided by their hours, using only sessions with both a blind and a duration.
- Variation: sample standard deviation of session-level hourly rates in money and in big blinds, labeled "Variation across session rates". Unavailable below two valid sessions.
- Each metric reports how many sessions it used, so missing timing or blinds is visible.

Only one player's results are summed, never the whole table. Weekday and month come from `played_on`. Groupings and filters are exact matches on stored values. Reports live on the player detail screen with a segmented control for the five groupings and a Filter sheet, inside the same workspace.
