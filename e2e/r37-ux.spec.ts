import { test, expect } from './fixtures';
import type { Route } from '@playwright/test';
import { addPlayer, createAccount, current, menu, money, newSession } from './helpers';
import { typeInput } from './input';
import { uxApproval } from './ux-approval';

test('phone controls preserve chosen-player money, safe Undo, compact rows and reviewable errors', async ({ page, browser, baseURL }, info) => {
  test.setTimeout(180000);
  if (!baseURL) throw new Error('The owned local server is required');
  await createAccount(page);
  const result = await uxApproval({ page, browser, baseURL, evidence: info.outputPath('ux-approval'), runId: info.project.name });
  expect(result.taps).toHaveLength(14);
});

test('session, correction, timing and filter errors retain and focus their invalid fields', async ({ page }) => {
  await createAccount(page);
  await newSession(page, 'Review fields before saving');
  const player = await addPlayer(page, 'Reviewable fields');
  await money(page, player.id, '10');
  await menu(page, 'Close session');
  await page.getByRole('button', { name: `${player.display_name} is still playing. Cash out`, exact: true }).click();
  await expect(page.getByTestId('money-player')).toHaveText(player.display_name);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await menu(page, 'Session settings');
  await typeInput(page.getByLabel('Big blind', { exact: true }), '1.005');
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(page.getByLabel('Big blind', { exact: true })).toHaveValue('1.005');
  await expect(page.getByLabel('Big blind', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByLabel('Big blind', { exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Close sheet', exact: true }).click();
  const before = await current(page);
  const entry = before.entries.find(entry => entry.kind === 'buy_in')!;
  await page.getByTestId(`entry-${entry.id}`).getByRole('button').click();
  await typeInput(page.getByLabel('Replacement amount', { exact: true }), '10.005');
  await page.getByRole('button', { name: 'Save correction', exact: true }).click();
  await expect(page.getByLabel('Replacement amount', { exact: true })).toHaveValue('10.005');
  await expect(page.getByLabel('Replacement amount', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByLabel('Replacement amount', { exact: true })).toBeFocused();
  expect((await current(page)).entries).toEqual(before.entries);
  await page.getByRole('button', { name: 'Close sheet', exact: true }).click();
  await menu(page, 'Correct times');
  await typeInput(page.getByLabel('Started at', { exact: true }), '2026-11-10T10:00:00');
  await typeInput(page.getByLabel('Ended at', { exact: true }), '2026-11-10T09:00:00');
  await page.getByRole('button', { name: 'Save timing', exact: true }).click();
  await expect(page.getByLabel('Ended at', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByLabel('Ended at', { exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Close sheet', exact: true }).click();
  await page.getByRole('navigation', { name: 'Table navigation', exact: true }).getByRole('button', { name: 'Players', exact: true }).click();
  await page.getByTestId(`roster-player-${player.id}`).click();
  await page.getByRole('button', { name: 'Filter: Off', exact: true }).click();
  await typeInput(page.getByLabel('From date', { exact: true }), '2026-11-17');
  await typeInput(page.getByLabel('To date', { exact: true }), '2026-11-10');
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect(page.getByLabel('To date', { exact: true })).toHaveValue('2026-11-10');
  await expect(page.getByLabel('To date', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByLabel('To date', { exact: true })).toBeFocused();
});

test.describe('Undo with a held HTTP response', () => {
  test.use({ serviceWorkers: 'block' });
  test('Undo keeps another form disabled until its atomic paid-entry reversal is confirmed', async ({ page }) => {
  await createAccount(page);
  const session = await newSession(page, 'Undo while reviewing a player');
  const player = await addPlayer(page, 'Two identical paid entries');
  await money(page, player.id, '10', { method: 'venmo' });
  await money(page, player.id, '10', { method: 'venmo' });
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  let held = false;
  let voidRequests = 0;
  const pattern = '**/entries/*/undo';
  const holdFirst = async (route: Route) => {
    const response = await route.fetch();
    voidRequests++;
    if (voidRequests === 1) { held = true; await released; }
    await route.fulfill({ response });
  };
  await page.route(pattern, holdFirst);
  try {
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(() => held).toBe(true);
    await page.getByRole('navigation', { name: 'Table navigation', exact: true }).getByRole('button', { name: 'Players', exact: true }).click();
    await page.getByTestId(`roster-player-${player.id}`).click();
    await page.getByRole('button', { name: 'Rename player', exact: true }).click();
    const save = page.getByRole('button', { name: 'Save name', exact: true });
    await expect(page.getByLabel('Player name', { exact: true })).toHaveValue(player.display_name);
    await expect(save).toBeDisabled();
    release();
    await expect(save).toBeEnabled();
    await expect.poll(async () => (await current(page, session.session.id)).entries.filter(entry => entry.voids_entry_id).length).toBe(2);
    expect(voidRequests).toBe(1);
    const state = await current(page, session.session.id);
    expect(state.totals.total_in_minor).toBe('1000');
    expect(state.players[0]!.payment_in_minor).toBe('1000');
  } finally {
    release();
    await page.unroute(pattern, holdFirst);
  }
});

});
