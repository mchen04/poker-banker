# Offline and app updates

A saved session opens offline with confirmed totals. New entries wait visibly without changing those totals, then save once after reconnection. Rejected work remains actionable. An application update preserves sign-in, drafts and session data and waits while editing or unsent work makes reload unsafe.

## Sub-features

- `offline-snapshot` opens confirmed session data after an offline reload.
- `offline-queue` marks a new entry Not saved yet and excludes it from totals.
- `offline-once` reconnects and confirms one stored entry, including an idempotent HTTP replay.
- `offline-rejected` preserves the reason and offers Retry or Discard in session order.
- `offline-close-signout-guards` prevents closing or silently discarding unsent work.
- `updates-hidden-visible` exposes Update ready after a new local release and preserves a draft through Reload.
- `updates-safe-activation` waits while hidden, a sheet is open or the outbox is nonempty.
- `updates-chunk-failure` routes a real dynamic-import failure to the update check when such an entry point exists.

## How to get to it (user POV)

- Open a previously loaded session without connectivity, then enter a buy-in normally.
- Reconnect to save, or use Retry/Discard on a rejected pending row.
- Attempt Close game or Players → Account → Sign out while an entry is pending.
- When Update ready appears, choose Reload; otherwise a safe visible idle app can activate automatically.

## Driving it with Playwright

Preconditions:

- Doctor succeeds. A production build and active controlling service worker are required; Vite development mode is insufficient.
- Run A/B update work only on the owned local server. Building the checkout does not update a supplied deployed URL.
- Offline/visibility emulation changes browser boundary conditions, not application stores or internal state.

- **Queue, reload, reconnect and replay.** Save as `.cache/verify-offline.ts`, then run `.claude/skills/verify-poker-banker/scripts/verify.sh recipe .cache/verify-offline.ts --run RUN_ID --context iphone-webkit`. The recipe captures the real POST body when connectivity returns and replays that production request without editing the outbox.

```ts
import { typeInput } from '../e2e/input';
import { expect } from '@playwright/test';
import { addPlayer, current, menu, newSession, openMoney, workerReady } from '../e2e/helpers';
import type { RecipeContext } from '../.claude/skills/verify-poker-banker/scripts/control';

export default async function ({ page, context, baseURL, runId, step, checkState }: RecipeContext) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'New session', exact: true })).toBeVisible();
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
import { addPlayer, closeSession, menu, money, newSession, openMoney } from '../e2e/helpers';
import type { RecipeContext } from '../.claude/skills/verify-poker-banker/scripts/control';

export default async function ({ page, context, browser, baseURL, runId, step, checkState }: RecipeContext) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'New session', exact: true })).toBeVisible();
  const tag = `${runId.slice(-8)}-${randomUUID().slice(0, 6)}`;
  const sessionName = `Verify rejected queue ${tag}`;
  const session = await newSession(page, sessionName);
  const player = await addPlayer(page, `Reject ${tag}`);
  await money(page, player.id, '100');
  await money(page, player.id, '100', { kind: 'Cash out' });
  const otherContext = await browser.newContext({ baseURL, ignoreHTTPSErrors: new URL(baseURL).hostname === '127.0.0.1', locale: 'en-US', timezoneId: 'UTC' });
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
    await expect(page.getByTestId(`player-${player.id}`)).toContainText('in $150.00');
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

- **Prove the update path.** Save as `.cache/verify-update.ts`, then run `.claude/skills/verify-poker-banker/scripts/verify.sh recipe .cache/verify-update.ts --run RUN_ID --context iphone-standalone`. This recipe deliberately refuses live URLs and builds release B only into this checkout's local `dist/`.

```ts
import { typeInput } from '../e2e/input';
import { execFileSync } from 'node:child_process';
import { expect } from '@playwright/test';
import { addPlayer, newSession, openMoney, workerReady } from '../e2e/helpers';
import type { RecipeContext } from '../.claude/skills/verify-poker-banker/scripts/control';

export default async function ({ page, context, baseURL, runId, step, checkState }: RecipeContext) {
  if (new URL(baseURL).hostname !== '127.0.0.1') throw new Error('A/B update proof requires an owned local server; no deployment is authorized');
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'New session', exact: true })).toBeVisible();
  await newSession(page, 'Verify update preservation');
  const player = await addPlayer(page, `Update ${runId.slice(-8)}`);
  await workerReady(page);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  const releaseA = await page.locator('meta[name="pb-release"]').getAttribute('content');
  await openMoney(page, player.id);
  await typeInput(page.getByTestId('money-amount'), '37.');
  await page.getByRole('group', { name: 'Payment method', exact: true }).getByRole('button', { name: 'Venmo', exact: true }).click();
  await step('updates-draft-before-new-release');
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const releaseB = `verify-B-${runId}`;
  execFileSync('pnpm', ['build'], { env: { ...process.env, RELEASE_VERSION: releaseB }, stdio: 'inherit' });
  await page.evaluate(async () => { const registration = await navigator.serviceWorker.getRegistration('/'); if (!registration) throw new Error('No service worker'); await registration.update(); });
  await expect.poll(() => page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration('/'))?.waiting)).toBe(true);
  expect(await page.locator('meta[name="pb-release"]').getAttribute('content')).toBe(releaseA);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.getByText('Update ready', { exact: true })).toBeVisible();
  await expect(page.getByTestId('money-amount')).toHaveValue('37.');
  await step('updates-ready-with-sheet-open');
  await Promise.all([page.waitForEvent('domcontentloaded'), page.getByTestId('update-reload').click()]);
  await expect(page.locator('meta[name="pb-release"]')).toHaveAttribute('content', releaseB);
  await expect(page.getByRole('heading', { name: 'Verify update preservation', exact: true })).toBeVisible();
  await openMoney(page, player.id);
  await expect(page.getByTestId('money-amount')).toHaveValue('37.');
  await expect(page.getByRole('group', { name: 'Payment method', exact: true }).getByRole('button', { name: 'Venmo', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect((await checkState()).players.some(row => row.id === player.id)).toBe(true);
  expect((await page.request.get(`${baseURL}/api/auth/me`)).status()).toBe(200);
  await step('updates-new-release-draft-and-data-preserved');
  await typeInput(page.getByTestId('money-amount'), '37');
  const releaseC = `verify-C-${runId}`;
  execFileSync('pnpm', ['build'], { env: { ...process.env, RELEASE_VERSION: releaseC }, stdio: 'inherit' });
  await page.evaluate(async () => { const registration = await navigator.serviceWorker.getRegistration('/'); if (!registration) throw new Error('No service worker'); await registration.update(); });
  await expect(page.getByText('Update ready', { exact: true })).toBeVisible();
  await context.setOffline(true);
  try {
    await page.getByRole('button', { name: 'Save entry', exact: true }).click();
    await expect(page.getByText('Not saved yet', { exact: true }).first()).toBeVisible();
    await expect(page.getByTestId('update-reload')).toBeDisabled();
    expect(await page.locator('meta[name="pb-release"]').getAttribute('content')).toBe(releaseB);
    await step('updates-outbox-holds-activation');
    const reloaded = page.waitForEvent('domcontentloaded');
    await context.setOffline(false);
    await reloaded;
    await expect(page.locator('meta[name="pb-release"]')).toHaveAttribute('content', releaseC);
    await expect(page.getByText('Not saved yet', { exact: true })).toHaveCount(0);
    expect((await checkState()).entries.filter(entry => entry.kind === 'buy_in' && entry.amount_minor === '3700')).toHaveLength(1);
    await step('updates-idle-visible-auto-activation-after-save');
  } finally { await context.setOffline(false); }
}
```

## Gotchas

- `RELEASE_VERSION` stamps the local build. Serialize builds with other runs because they share `dist/`; do not run another browser suite or benchmark while changing it.
- Visibility overrides use scalar properties so tsx does not inject a function-name helper into a serialized getter. They emulate browser suspension signals. They do not prove actual iOS suspension, Home Screen installation or a real keyboard.
- Run update verification last. Doctor pins the launch release, so it intentionally reports a build mismatch after this recipe changes the local build; clean up and relaunch before other features.
- The current client is one statically imported bundle. A genuine lazy-chunk failure entry point is absent, so that proof reports an unmet prerequisite until one exists. Dispatching an internal failure event is not a real-user proof.
- Playwright API requests can bypass browser offline emulation. A successful API request is not offline-browser proof; use the actual offline reload and perform stored-state checks after reconnection.
- Retry needs the reopened timer end cleared. Wait for Save timing to close the sheet before retrying; Reopen alone preserves the old end.
- Activity is returned newest first. The queue-order proof orders buy-ins by ascending revision before checking their submission order.
- Service-worker or certificate failure is a failed prerequisite. Do not bypass the worker requirement or replace an offline reload with an online one.
