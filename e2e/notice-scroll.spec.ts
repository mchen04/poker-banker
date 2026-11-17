import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { addPlayer, createAccount, current, newSession } from './helpers';
import { typeInput } from './input';

async function addDuplicate(page: Page, name: string) {
  await page.getByRole('button', { name: 'Add player', exact: true }).click();
  await typeInput(page.getByLabel('Search players', { exact: true }), name);
  await page.getByRole('checkbox', { name: 'This is a different person' }).check();
  await page.getByRole('button', { name: `Add '${name}' as new`, exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const state = await current(page);
  return state.players.filter(player => player.display_name === name).at(-1)!;
}

async function queueBuyIn(page: Page, playerId: string) {
  await page.getByTestId('session-bottom-bar').getByRole('button', { name: 'Buy-in', exact: true }).click();
  await page.getByTestId(`choose-buy-in-${playerId}`).click();
  await typeInput(page.getByTestId('money-amount'), '20');
  await page.getByRole('button', { name: 'Save entry', exact: true }).click();
}

test('the post-save scroll targets the submitted row, not a prefix or the first duplicate', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 659 });
  await createAccount(page);
  await newSession(page, 'Scroll target');
  const firstAlice = await addPlayer(page, 'Alice');
  for (const name of ['Bea', 'Cy', 'Dee', 'Eve', 'Fay', 'Gus', 'Hal', 'Ivy', 'Jo']) await addPlayer(page, name);
  await addPlayer(page, 'Al');
  const secondAlice = await addDuplicate(page, 'Alice');
  await page.evaluate(() => window.scrollTo(0, 0));
  await queueBuyIn(page, secondAlice.id);
  const toast = page.getByTestId('saved-confirmation');
  await expect(toast).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  const toastBox = await toast.boundingBox();
  const target = await page.getByTestId(`player-${secondAlice.id}`).boundingBox();
  const prefix = await page.getByTestId(`player-${firstAlice.id}`).boundingBox();
  expect(target && toastBox && target.y + target.height <= toastBox.y + 1).toBe(true);
  expect(prefix && prefix.y < 0).toBe(true);
  await expect(page.locator('.notice .sr-only')).toHaveText('Saved buy-in · Alice · $20.00');
  await expect(page.locator('.notice-visual')).toHaveAttribute('aria-hidden', 'true');
});

test('a replayed offline entry does not scroll the page, even with a sheet open', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 659 });
  await createAccount(page);
  await newSession(page, 'Replay');
  await addPlayer(page, 'Alice');
  for (const name of ['Bea', 'Cy', 'Dee', 'Eve', 'Fay', 'Gus', 'Hal', 'Ivy', 'Jo']) await addPlayer(page, name);
  const last = await addDuplicate(page, 'Alice');
  await page.context().setOffline(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await queueBuyIn(page, last.id);
  await expect(page.getByTestId('save-status')).toContainText('Not saved yet');
  await page.getByRole('button', { name: 'Add player', exact: true }).click();
  await page.context().setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByTestId('saved-confirmation')).toBeVisible({ timeout: 20000 });
  await page.waitForTimeout(900);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test('a replayed offline entry does not scroll the page with no sheet open', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 659 });
  await createAccount(page);
  await newSession(page, 'Replay alone');
  await addPlayer(page, 'Alice');
  for (const name of ['Bea', 'Cy', 'Dee', 'Eve', 'Fay', 'Gus', 'Hal', 'Ivy', 'Jo']) await addPlayer(page, name);
  const last = await addDuplicate(page, 'Alice');
  await page.context().setOffline(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await queueBuyIn(page, last.id);
  await expect(page.getByTestId('save-status')).toContainText('Not saved yet');
  await page.context().setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByTestId('saved-confirmation')).toBeVisible({ timeout: 20000 });
  await page.waitForTimeout(900);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});
