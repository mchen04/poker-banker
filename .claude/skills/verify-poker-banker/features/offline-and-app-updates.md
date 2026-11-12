# Offline and app updates

A saved session opens offline with confirmed totals. New entries wait visibly without changing those totals, then save once after reconnection. Rejected work remains actionable. An application update preserves sign-in, drafts and session data and waits while editing or unsent work makes reload unsafe.

## Sub-features

- `offline-snapshot` opens confirmed session data after an offline reload.
- `offline-queue` marks a new entry Not saved yet and excludes it from totals.
- `offline-once` reconnects and confirms one stored entry, including an idempotent HTTP replay.
- `offline-rejected` preserves the reason and offers Retry or Discard in session order.
- `offline-close-signout-guards` prevents closing or silently discarding unsent work.
- `updates-hidden-visible` discovers a waiting release on foreground return while preserving an editing draft.
- `updates-safe-activation` waits for visibility, closed editors, drained requests/outbox and successful local persistence, then adopts the release without a tap.
- `updates-chunk-failure` serves a genuine old lazy module through a newer controller after its server URL disappears, then applies the release safely.

## How to get to it (user POV)

- Open a previously loaded session without connectivity, then enter a buy-in normally.
- Reconnect to save, or use Retry/Discard on a rejected pending row.
- Attempt Close game or Players → Account → Sign out while an entry is pending.
- A visible idle workspace applies a discovered release automatically. While editing or offline work holds it, Update ready stays available; save/close/reconnect naturally reaches the next safe point. Explicit Reload remains an optional persisted-draft choice.

## Driving it with Playwright

Preconditions:

- Doctor succeeds. A production build and active controlling service worker are required; Vite development mode is insufficient.
- Run A/B update work only on the owned local server. Building the checkout does not update a supplied deployed URL.
- Offline/visibility emulation changes browser boundary conditions, not application stores or internal state.

- **Queue, reload, reconnect and replay.** Save as `.cache/verify-offline.ts`, then run `.claude/skills/verify-poker-banker/scripts/verify.sh recipe .cache/verify-offline.ts --run RUN_ID --context iphone-webkit`. The recipe captures the real POST body when connectivity returns and replays that production request without editing the outbox.

```ts
import { typeInput } from '../e2e/input';
import { expect } from '@playwright/test';
import { addPlayer, current, menu, newSession, openMoney, workerReady, workspaceReady } from '../e2e/helpers';
import type { RecipeContext } from '../.claude/skills/verify-poker-banker/scripts/control';

export default async function ({ page, context, baseURL, runId, step, checkState }: RecipeContext) {
  await page.goto('/');
  await workspaceReady(page);
  const session = await newSession(page, 'Verify offline queue');
  const player = await addPlayer(page, `Offline ${runId.slice(-8)}`);
  await workerReady(page);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await context.setOffline(true);
  try {
    await openMoney(page, player.id);
    await typeInput(page.getByTestId('money-amount'), '20');
    await page.getByRole('button', { name: 'Save entry', exact: true }).dblclick();
    await expect(page.getByText('Not saved yet', { exact: true }).first()).toBeVisible();
    await expect(page.getByTestId('totals')).not.toContainText('$20.00');
    await step('offline-unconfirmed-excluded');
    await page.reload();
    await expect(page.getByText(/Offline/).first()).toBeVisible();
    await expect(page.getByTestId(`player-${player.id}`)).toBeVisible();
    await expect(page.getByTestId('totals')).not.toContainText('$20.00');
    await menu(page, 'Close session');
    await expect(page.getByRole('button', { name: 'Close session', exact: true })).toBeDisabled();
    await expect(page.getByText(/not saved yet\. Save or discard/)).toBeVisible();
    await step('offline-close-pending-blocker');
    await page.getByRole('button', { name: 'Close sheet', exact: true }).click();
    await page.getByRole('button', { name: 'Players', exact: true }).click();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByLabel('Discard unsent entries and drafts', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Confirm sign out', exact: true })).toBeDisabled();
    await step('offline-signout-unsent-guard');
    await page.getByRole('button', { name: 'Close sheet', exact: true }).click();
    await page.getByRole('button', { name: 'Workspace', exact: true }).click();
    const responsePromise = page.waitForResponse(response => response.url() === `${baseURL}/api/sessions/${session.session.id}/entries` && response.request().method() === 'POST');
    await context.setOffline(false);
    const response = await responsePromise;
    expect(response.status()).toBe(200);
    const requestBody = response.request().postDataJSON();
    const firstResponse = await response.json();
    await expect(page.getByTestId('saved-confirmation')).toContainText('$20.00');
    await expect(page.getByText('Not saved yet', { exact: true })).toHaveCount(0);
    const confirmed = await checkState();
    expect(confirmed.entries.filter(entry => entry.kind === 'buy_in')).toHaveLength(1);
    const replay = await page.request.post(`${baseURL}/api/sessions/${session.session.id}/entries`, { headers: { origin: baseURL }, data: requestBody });
    expect(replay.status()).toBe(200);
    expect(await replay.json()).toEqual(firstResponse);
    expect((await current(page)).revision).toBe(confirmed.revision);
    expect((await current(page)).entries.filter(entry => entry.kind === 'buy_in')).toHaveLength(1);
    await step('offline-confirmed-once-after-http-replay');
  } finally { await context.setOffline(false); }
}
```

- **Prove rejection, Retry and Discard.** Save the next block as `.cache/verify-rejected.ts`, then run `.claude/skills/verify-poker-banker/scripts/verify.sh recipe .cache/verify-rejected.ts --run RUN_ID --context iphone-webkit`. A second owned context closes the game while the first is offline. The visible rejection is therefore produced by the real server lifecycle.

```ts
import { typeInput } from '../e2e/input';
import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { newContextLike, addPlayer, closeSession, menu, money, newSession, openMoney, workspaceReady } from '../e2e/helpers';
import type { RecipeContext } from '../.claude/skills/verify-poker-banker/scripts/control';

export default async function ({ page, context, browser, baseURL, runId, step, checkState }: RecipeContext) {
  await page.goto('/');
  await workspaceReady(page);
  const tag = `${runId.slice(-8)}-${randomUUID().slice(0, 6)}`;
  const sessionName = `Verify rejected queue ${tag}`;
  const session = await newSession(page, sessionName);
  const player = await addPlayer(page, `Reject ${tag}`);
  await money(page, player.id, '100');
  await money(page, player.id, '100', { kind: 'Cash out' });
  const otherContext = await newContextLike(page, browser, baseURL);
  try {
    await otherContext.addCookies(await context.cookies());
    const other = await otherContext.newPage();
    await other.goto(`/?session=${session.session.id}`);
    await expect(other.getByRole('heading', { name: sessionName, exact: true })).toBeVisible();
    await context.setOffline(true);
    for (const amount of ['20', '30']) {
      await openMoney(page, player.id);
      await typeInput(page.getByTestId('money-amount'), amount);
      await page.getByRole('button', { name: 'Save entry', exact: true }).click();
    }
    await closeSession(other);
    await context.setOffline(false);
    await expect(page.getByText('Reopen this session before writing', { exact: false })).toBeVisible();
    await step('offline-rejected-with-reason');
    await menu(other, 'Reopen session');
    await typeInput(other.getByLabel('Reason', { exact: true }), 'Apply owned queued entries');
    await other.getByRole('dialog').getByRole('button', { name: 'Reopen session', exact: true }).click();
    await expect(other.getByRole('dialog')).toHaveCount(0);
    await menu(other, 'Correct times');
    await typeInput(other.getByLabel('Ended at', { exact: true }), '');
    await other.getByRole('button', { name: 'Save timing', exact: true }).click();
    await expect(other.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(page.getByTestId(`player-${player.id}`)).toContainText('Bought $150.00');
    await expect(page.getByText('Not saved yet', { exact: true })).toHaveCount(0);
    const buyIns = (await checkState()).entries.filter(entry => entry.kind === 'buy_in').sort((left, right) => BigInt(left.revision) < BigInt(right.revision) ? -1 : BigInt(left.revision) > BigInt(right.revision) ? 1 : 0);
    expect(buyIns.map(entry => entry.amount_minor)).toEqual(['10000', '2000', '3000']);
    expect(new Set(buyIns.map(entry => entry.revision)).size).toBe(3);
    await context.setOffline(true);
    await openMoney(page, player.id);
    await typeInput(page.getByTestId('money-amount'), '99');
    await page.getByRole('button', { name: 'Save entry', exact: true }).click();
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
    await context.setOffline(false);
    await expect(page.getByText('Not saved yet', { exact: true })).toHaveCount(0);
    expect((await checkState()).entries.filter(entry => entry.kind === 'buy_in')).toHaveLength(3);
    await step('offline-retry-order-and-discard-result');
  } finally { await context.setOffline(false); await otherContext.close(); }
}
```

- **Prove safe automatic release adoption.** This local-only recipe uses the production builder and real service workers, Cache Storage, UI writes and PostgreSQL. It never routes or mocks a response, edits IndexedDB or calls `registration.update()` to manufacture post-deployment discovery. It builds the tracked previous client, current A and current B in sequence. Run it last in an exclusive checkout; it deliberately changes `dist/`.

Prepare the pinned previous-source fixture on this Mac because the mini checkout intentionally has no `.git`. The archive contains tracked project files only. The helper verifies both hashes and the pinned commit, and refuses credential/traversal paths before extracting into its own temporary directory.

```sh
mkdir -p .cache/round36/previous
git archive --format=tar --output .cache/round36/previous/previous.tar dc2082b09d7bf8ad124f0e21f8826ef75c0b4e1f
python3 - <<'PYTHON'
from hashlib import sha256
from pathlib import Path
import json
root = Path('.cache/round36/previous')
manifest = root / 'manifest.json'
manifest.write_text(json.dumps({'sourceSha': 'dc2082b09d7bf8ad124f0e21f8826ef75c0b4e1f', 'archive': 'previous.tar', 'archiveSha256': sha256((root / 'previous.tar').read_bytes()).hexdigest()}, indent=2) + '\n')
print(sha256(manifest.read_bytes()).hexdigest())
PYTHON
rsync -az .cache/round36/previous/ mini:worktrees/poker-banker/.cache/round36/previous/
```

Use the printed manifest hash as `MANIFEST_SHA` below. These public fixture metadata variables must be present at **launch**, because the existing daemon executes later recipes.

```sh
scripts/mini.sh env PB_UPDATE_PREVIOUS_MANIFEST=.cache/round36/previous/manifest.json PB_UPDATE_PREVIOUS_MANIFEST_SHA256=MANIFEST_SHA .claude/skills/verify-poker-banker/scripts/verify.sh launch --local
scripts/mini.sh .claude/skills/verify-poker-banker/scripts/verify.sh doctor --run RUN_ID
scripts/mini.sh .claude/skills/verify-poker-banker/scripts/verify.sh drive updates --run RUN_ID --context iphone-standalone
scripts/mini.sh .claude/skills/verify-poker-banker/scripts/verify.sh evidence --run RUN_ID
scripts/mini.sh .claude/skills/verify-poker-banker/scripts/verify.sh cleanup --run RUN_ID
```

The same reusable helper can be invoked as a recipe. Save as `.cache/verify-update.ts`, copy that file explicitly as described in SKILL.md, then use `recipe .cache/verify-update.ts` instead of `drive updates`.

```ts
import { verifyUpdateJourney } from '../scripts/verify-update-journey';
import type { RecipeContext } from '../.claude/skills/verify-poker-banker/scripts/control';

export default async function ({ page, browser, baseURL, evidence, runId }: RecipeContext) {
  await verifyUpdateJourney({ page, browser, baseURL, evidence, tag: `verify-${runId.slice(-8)}` });
}
```

Proofs in `automatic-updates-summary.json`:

| Case | Actual path and required result |
| --- | --- |
| Previous-client compatibility | Boot tracked `dc2082b`, create a durable draft and offline financial write, close that page, then cold-load current A. IDB stays version 2, draft hashes match, old body/op_id replays once through the current API, and an HTTP replay writes nothing twice. An actual archived reader also reads A-written draft/outbox records without changing them. |
| Idle Workspace | A is visible before B deploys. No tap, visibility signal or manual update follows deployment; the real periodic check discovers B and the app adopts it. |
| Open buy-in | Waiting B leaves A's typed amount/method in place for an observed safety window. Keep draft and close supplies the natural safe point; B opens with that draft intact. |
| Offline | A reloads its cached shell and keeps a queued entry excluded from totals. Reconnection sends the same body/op_id once and the app adopts B. |
| Stale lazy asset | A first imports one cached, server-deleted module before the idle timer: asset access discovers B without a tap. A second tab activates B while the first edits. A distinct module's first import still succeeds from retained A assets under B; closing the sheet permits B. |
| Cold launch | A's page is closed before deployment. A new page starts B with authentication, session data and draft unchanged. |

The two lazy modules and previous storage reader are test-build fixtures emitted before the shared production precache stamp. Normal builds contain neither. Every case has screenshots, ARIA/landmarks and explicit before/after release identities. The helper owns and closes its contexts, archive scratch and journey lock; the skill's cleanup then stops its existing owned browser/server/database and keeps evidence.

## Gotchas

- `RELEASE_VERSION` stamps the local build. Serialize builds with other runs because they share `dist/`; do not run another browser suite or benchmark while changing it.
- Visibility overrides use scalar properties so tsx does not inject a function-name helper into a serialized getter. They emulate browser suspension signals. They do not prove actual iOS suspension, Home Screen installation or a real keyboard.
- Run update verification last. Doctor pins the launch release, so it intentionally reports a build mismatch after this recipe changes the local build; clean up and relaunch before other features.
- The normal app still has one static JS entry. The proof uses an actual hashed, precached lazy fixture and a server-deleted URL; it does not claim a production React lazy route or manufacture an internal failure event.
- Playwright API requests can bypass browser offline emulation. A successful API request is not offline-browser proof; use the actual offline reload and perform stored-state checks after reconnection.
- Retry needs the reopened timer end cleared. Wait for Save timing to close the sheet before retrying; Reopen alone preserves the old end.
- Activity is returned newest first. The queue-order proof orders buy-ins by ascending revision before checking their submission order.
- Service-worker or certificate failure is a failed prerequisite. Do not bypass the worker requirement or replace an offline reload with an online one.
