import { typeInput } from './input';
import { test, expect } from './fixtures';
import { createAccount, newSession, addPlayer, money, openMoney, current, menu } from './helpers';

test('a player losing the full buy-in cashes out zero with no zero payment', async ({ page }) => {
  await createAccount(page);
  await newSession(page, 'Lost whole stack');
  const player = await addPlayer(page, 'Justin');
  await openMoney(page, player.id);
  await typeInput(page.getByLabel('Amount', { exact: true }), '0');
  await page.getByRole('button', { name: 'Save entry', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Enter an amount above zero');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Discard draft', exact: true }).click();
  await money(page, player.id, '100', { paid: true, method: 'cash' });
  let state = await money(page, player.id, '0', { kind: 'Cash out', paid: true });
  expect(state.players[0]).toMatchObject({ state: 'cashed_out', result_minor: '-10000' });
  expect(state.entries.filter(entry => entry.kind === 'payment_out')).toHaveLength(0);
  await expect(page.getByTestId(`player-${player.id}`)).toContainText('−$100.00');
  for (const amount of ['20', '0']) {
    const voided = new Set(state.entries.flatMap(entry => entry.voids_entry_id ? [entry.voids_entry_id] : []));
    const cashout = state.entries.find(entry => entry.kind === 'cash_out' && !entry.voids_entry_id && !voided.has(entry.id))!;
    await page.getByTestId(`entry-${cashout.id}`).getByRole('button', { name: /^Correct/ }).click();
    await typeInput(page.getByLabel('Replacement amount', { exact: true }), amount);
    await page.getByRole('button', { name: 'Save correction', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    state = await current(page);
  }
  await expect(page.getByTestId(`player-${player.id}`)).toContainText('−$100.00');
  await menu(page, 'Close session');
  await page.getByLabel('Accept discrepancy of −$100.00', { exact: true }).check();
  await page.getByRole('button', { name: 'Close session', exact: true }).click();
  await expect.poll(async () => (await current(page)).session.status).toBe('closed');
});
