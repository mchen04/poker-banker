# Timer

Session time is server state. A timer can start manually or with the first buy-in, continue across reload and another browser context, keep correction history and stop when the game closes.

## Sub-features

- `timer-manual` starts from the header before the first buy-in.
- `timer-auto` starts with a first buy-in in a different fresh session.
- `timer-persistence` keeps the same start after reload and another context.
- `timer-correction` saves corrected bounds and visible history.
- `timer-invalid-range` rejects an end before its start.
- `timer-close` freezes elapsed time when closed.

## How to get to it (user POV)

- Choose `Start timer` beside the session timer in a new game.
- Alternatively record the game's first buy-in.
- Choose `Session menu` → `Correct times`, edit `Started at` and `Ended at`, then `Save timing`.
- Close through `Session menu` → `Close game`.

## Driving it with Playwright

Preconditions:

- Doctor succeeds. The selected context is online; its locale is en-US and timezone UTC.
- A second context below receives only this run's cookie in memory. It does not read a browser profile or authentication file.

- **Start by both paths and verify persistence.** Save as `.cache/verify-timer.ts`, then run `.claude/skills/verify-poker-banker/scripts/verify.sh recipe .cache/verify-timer.ts --run RUN_ID --context iphone-webkit`. Manual start and first-buy-in start use different sessions, so one cannot hide a failure in the other.

```ts
import { typeInput } from '../e2e/input';
import { expect } from '@playwright/test';
import { addPlayer, call, closeSession, current, menu, money, newSession } from '../e2e/helpers';
import type { SessionState } from '../src/domain/session';
import type { RecipeContext } from '../.claude/skills/verify-poker-banker/scripts/control';

export default async function ({ page, context, browser, baseURL, runId, step, checkState }: RecipeContext) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'New session', exact: true })).toBeVisible();
  await newSession(page, 'Verify manual timer');
  await expect(page.getByTestId('session-timer')).toHaveText('Timer not started');
  await step('timer-manual-start-before');
  await page.getByRole('button', { name: 'Start timer', exact: true }).click();
  await expect(page.getByTestId('session-timer')).toContainText('Playing time');
  expect((await checkState()).session.started_at).not.toBeNull();
  await newSession(page, 'Verify automatic timer');
  const player = await addPlayer(page, `Time ${runId.slice(-8)}`);
  await money(page, player.id, '20');
  const started = (await current(page)).session.started_at!;
  const sessionId = new URL(page.url()).searchParams.get('session')!;
  const firstText = await page.getByTestId('session-timer').textContent();
  await expect.poll(() => page.getByTestId('session-timer').textContent()).not.toBe(firstText);
  await page.reload();
  expect((await checkState()).session.started_at).toBe(started);
  const otherContext = await browser.newContext({ baseURL, ignoreHTTPSErrors: new URL(baseURL).hostname === '127.0.0.1', locale: 'en-US', timezoneId: 'UTC' });
  try {
    await otherContext.addCookies(await context.cookies());
    const other = await otherContext.newPage();
    await other.goto(`/?session=${sessionId}`);
    await expect(other.getByTestId('session-timer')).toContainText('Playing time');
    expect((await call<SessionState>(other, `/sessions/${sessionId}`)).session.started_at).toBe(started);
    await step('timer-live-after-reload-and-other-context');
    await menu(page, 'Correct times');
    const corrected = new Date(Date.parse(started) - 3600000).toISOString();
    await typeInput(page.getByLabel('Started at', { exact: true }), corrected.slice(0, 19));
    await typeInput(page.getByLabel('Ended at', { exact: true }), new Date(Date.parse(corrected) - 1000).toISOString().slice(0, 19));
    await page.getByRole('button', { name: 'Save timing', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Request validation failed');
    expect((await checkState()).session.started_at).toBe(started);
    await typeInput(page.getByLabel('Ended at', { exact: true }), '');
    await page.getByRole('button', { name: 'Save timing', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await menu(page, 'Correct times');
    await expect(page.getByText('Timing corrected', { exact: true })).toBeVisible();
    await step('timer-correction-history');
    await page.getByRole('button', { name: 'Close sheet', exact: true }).click();
    await money(page, player.id, '20', { kind: 'Cash out', paid: true });
    await closeSession(page);
    await expect(page.getByTestId('session-timer')).toContainText('Finished');
    await expect(other.getByTestId('session-timer')).toContainText('Finished', { timeout: 3000 });
    const ended = await checkState();
    expect(ended.session.ended_at).not.toBeNull();
    const frozen = await page.getByTestId('session-timer').textContent();
    await page.reload();
    await expect(page.getByTestId('session-timer')).toHaveText(frozen!);
    expect((await checkState()).session.ended_at).toBe(ended.session.ended_at);
    await step('timer-stopped-after-reload');
  } finally { await otherContext.close(); }
}
```

## Gotchas

- Running elapsed time may show seconds. Finished durations use whole minutes, such as `3 h 05 min` or `0 min`.
- Timing bounds must include effective entries. Move the start earlier for the correction fixture; do not move it past an existing buy-in.
- Reopen preserves the recorded end. Clear Ended at through Correct times before resuming play.
- Another browser context proves server-backed state. It does not prove physical iOS suspension or clock behavior on real hardware.
