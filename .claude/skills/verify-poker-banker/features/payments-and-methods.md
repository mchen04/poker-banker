# Payments and methods

Chip entries and actual payments remain separate. The banker can record Cash, Venmo or Zelle immediately, collect an unpaid buy-in later, pay a player, and correct a method while retaining the original row.

## Sub-features

- `payments-paid-buy-in` stores a paid-now method and survives reload.
- `payments-unpaid` leaves an unpaid buy-in out of money received.
- `payments-later` records a later payment through the player sheet.
- `payments-direction` supports player-to-bank and bank-to-player payments.
- `payments-cash-out` records immediate payment by selecting Cash, Venmo or Zelle.
- `payments-correct-method` shows both the voided method and effective replacement.

## How to get to it (user POV)

- In Buy-in, choose `Unpaid`, `Cash`, `Venmo` or `Zelle` in `Payment method`. A paid selection defaults only from this player’s own last method.
- In Cash out, choose a payment method to record payment now, or retain `Unpaid` to pay later.
- Open a player row → `Record payment`; choose `Player pays bank` or `Bank pays player` in the `Payment direction` group, then a method.
- In Activity or Player entries, correct the payment row and choose a button in `Replacement method`.

## Driving it with Playwright

Preconditions:

- Doctor succeeds and the owned banker is online. The recipe creates a new session and player.
- The method control must be a named button group with `aria-pressed`; a native select does not satisfy this UI proof.

- **Record, reload, settle and correct.** Save as `.cache/verify-payments.ts`, then run `.claude/skills/verify-poker-banker/scripts/verify.sh recipe .cache/verify-payments.ts --run RUN_ID --context iphone-webkit`. The assertions distinguish buy-in totals from actual money received and retain the old and corrected methods.

```ts
import { typeInput } from '../e2e/input';
import { expect } from '@playwright/test';
import { addPlayer, current, money, newSession, openMoney, workspaceReady } from '../e2e/helpers';
import type { RecipeContext } from '../.claude/skills/verify-poker-banker/scripts/control';

export default async function ({ page, runId, step, checkState }: RecipeContext) {
  await page.goto('/');
  await workspaceReady(page);
  await newSession(page, 'Verify payment methods');
  const player = await addPlayer(page, `Pay ${runId.slice(-8)}`);
  await money(page, player.id, '40', { method: 'venmo' });
  await page.reload();
  await expect(page.getByTestId('activity')).toContainText('Venmo');
  await step('payments-venmo-reloaded');
  await money(page, player.id, '20', { paid: false });
  let state = await checkState();
  expect(state.players.find(row => row.id === player.id)?.payment_in_minor).toBe('4000');
  expect(state.players.find(row => row.id === player.id)?.bought_in_minor).toBe('6000');
  await money(page, player.id, '20', { kind: 'Record payment', method: 'zelle' });
  state = await current(page);
  const original = state.entries.find(entry => entry.kind === 'payment_in' && entry.method === 'zelle' && !entry.voids_entry_id)!;
  expect(original).toBeTruthy();
  await page.getByTestId(`entry-${original.id}`).getByRole('button').click();
  await step('payments-method-correction-before');
  await page.getByRole('group', { name: 'Replacement method', exact: true }).getByRole('button', { name: 'Cash', exact: true }).click();
  await page.getByRole('button', { name: 'Save correction', exact: true }).click();
  await expect(page.getByTestId(`entry-${original.id}`)).toContainText('Zelle');
  await expect(page.getByTestId(`entry-${original.id}`)).toContainText('Voided');
  await expect(page.getByTestId('activity')).toContainText('Cash');
  state = await checkState();
  expect(state.entries.some(entry => entry.voids_entry_id === original.id)).toBe(true);
  expect(state.entries.some(entry => entry.kind === 'payment_in' && entry.method === 'cash' && entry.amount_minor === '2000' && !entry.voids_entry_id)).toBe(true);
  await money(page, player.id, '60', { kind: 'Cash out', paid: true, method: 'zelle' });
  await openMoney(page, player.id, 'Record payment');
  await page.getByRole('group', { name: 'Payment direction', exact: true }).getByRole('button', { name: 'Bank pays player', exact: true }).click();
  await typeInput(page.getByTestId('money-amount'), '1');
  await page.getByRole('group', { name: 'Payment method', exact: true }).getByRole('button', { name: 'Cash', exact: true }).click();
  await page.getByRole('button', { name: 'Save entry', exact: true }).click();
  await expect(page.getByTestId('saved-confirmation')).toContainText('$1.00');
  state = await checkState();
  expect(state.entries.some(entry => entry.kind === 'payment_out' && entry.method === 'cash' && entry.amount_minor === '100')).toBe(true);
  expect(state.entries.some(entry => entry.kind === 'payment_out' && entry.method === 'zelle' && entry.amount_minor === '6000')).toBe(true);
  await step('payments-methods-directions-and-correction-saved');
}
```

- **Check the viewer.** Run the sharing recipe against its own new game; it records a Venmo buy-in and verifies the visible method in a fresh logged-out viewer. The banker-only method proof above does not count as viewer proof.

## Gotchas

- A paid buy-in produces two rows. Correct `Player paid bank` to change its method; correcting the buy-in amount alone does not change a payment.
- The last method is a convenience default. Assert the selected button before Save rather than assuming Cash.
- The final extra bank-to-player payment deliberately creates an overpayment in this disposable session. It proves direction and must not be copied into another account.
- A method needs visible selected weight and outline as well as `aria-pressed`; see the repository polish journey for that appearance assertion.
