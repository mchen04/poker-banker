import { typeInput } from '../../../../e2e/input';
import { expect } from '@playwright/test';
import { addPlayer, current, menu, newSession, openMoney, workerReady, workspaceReady } from '../../../../e2e/helpers';
import type { RecipeContext } from './control';

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
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Close session', exact: true })).toBeDisabled();
    await expect(page.getByText(/not saved yet\. Save or discard/)).toBeVisible();
    await step('offline-close-pending-blocker');
    await page.getByRole('button', { name: 'Close sheet', exact: true }).click();
    await page.getByRole('button', { name: 'Players', exact: true }).click();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByLabel('Discard unsent entries and drafts', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Confirm sign out', exact: true })).toBeDisabled();
    await step('offline-signout-unsent-guard');
    await page.getByRole('button', { name: 'Close sheet', exact: true }).click();
    await page.getByRole('button', { name: 'Table', exact: true }).click();
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
