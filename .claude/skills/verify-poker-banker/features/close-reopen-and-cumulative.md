# Close and reopen with cumulative results

The banker closes only after everyone with entries has cashed out. A mismatch needs explicit acceptance. Reopening removes the game from finalized totals until it closes again, and reclosure counts that game once.

## Sub-features

- `close-playing-blocker` explains who still needs to cash out.
- `close-pending-blocker` explains unsaved entries separately.
- `close-balanced` closes matching chip totals.
- `close-discrepancy` requires acceptance of the exact displayed difference.
- `reopen-reason` records why the game reopened.
- `cumulative-reclose-once` counts closed games once and keeps outstanding payments separate.

## How to get to it (user POV)

- In an open session, choose `Session menu` → `Close game`, or use the footer’s `Close game` when everyone has cashed out.
- Cash out blockers through their player sheets. Save or discard Not saved yet entries before closing.
- If chip totals differ, check `Accept discrepancy of …`, then choose `Close session`.
- In a closed game, choose `Session menu` → `Reopen game`, enter `Reason`, then choose `Reopen session`.
- Choose `Players` and a player to inspect finalized and outstanding amounts and Past sessions.

## Driving it with Playwright

Preconditions:

- Doctor succeeds. The recipe creates two players and its own new sessions.
- Run the offline recipe for the separate unsaved-entry blocker; no queued item is manufactured inside storage.

- **Close, reopen and count once.** Save as `.cache/verify-close.ts`, then run `.claude/skills/verify-poker-banker/scripts/verify.sh recipe .cache/verify-close.ts --run RUN_ID --context iphone-webkit`. The balanced game's two player results are +$40 and −$40. The second game's −$10 result makes the first player's finalized total +$30.

```ts
import { typeInput } from '../e2e/input';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { expect } from '@playwright/test';
import { addPlayer, call, closeSession, menu, money, newSession, workspaceReady } from '../e2e/helpers';
import type { RecipeContext } from '../.claude/skills/verify-poker-banker/scripts/control';

type History = { cumulative: { currency: string; result_minor: string }[]; sessions: { session: { id: string; status: string } }[] };

export default async function ({ page, runId, evidence, step }: RecipeContext) {
  await page.goto('/');
  await workspaceReady(page);
  const tag = `${runId.slice(-8)}-${randomUUID().slice(0, 6)}`;
  const first = await newSession(page, `Verify balanced close ${tag}`);
  const winner = await addPlayer(page, `Win ${tag}`);
  const loser = await addPlayer(page, `Loss ${tag}`);
  await money(page, winner.id, '100');
  await money(page, loser.id, '100');
  await menu(page, 'Close session');
  await expect(page.getByText('Cash out everyone with entries before closing.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close session', exact: true })).toBeDisabled();
  await step('close-playing-blocker');
  await page.getByRole('button', { name: 'Close sheet', exact: true }).click();
  await money(page, winner.id, '140', { kind: 'Cash out', paid: true });
  await money(page, loser.id, '60', { kind: 'Cash out', paid: true });
  await closeSession(page);
  await step('close-balanced-result');
  await menu(page, 'Reopen session');
  await typeInput(page.getByLabel('Reason', { exact: true }), 'Verify one cumulative result');
  await page.getByRole('dialog').getByRole('button', { name: 'Reopen session', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await call<History>(page, `/players/${winner.id}`)).cumulative).toEqual([]);
  await closeSession(page);
  let history = await call<History>(page, `/players/${winner.id}`);
  expect(history.cumulative).toContainEqual({ currency: 'USD', result_minor: '4000' });
  expect(history.sessions.filter(row => row.session.id === first.session.id)).toHaveLength(1);
  await newSession(page, `Verify accepted discrepancy ${tag}`);
  await page.getByRole('button', { name: 'Add player', exact: true }).click();
  await typeInput(page.getByLabel('Search players', { exact: true }), winner.display_name);
  await page.getByRole('dialog').getByRole('button', { name: winner.display_name, exact: true }).click();
  await money(page, winner.id, '100');
  await money(page, winner.id, '90', { kind: 'Cash out', paid: true });
  await menu(page, 'Close session');
  await expect(page.getByRole('button', { name: 'Close session', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Accept discrepancy of −$10.00', { exact: true })).toBeVisible();
  await step('close-discrepancy-before-acceptance');
  await page.getByLabel('Accept discrepancy of −$10.00', { exact: true }).check();
  await page.getByRole('dialog').getByRole('button', { name: 'Close session', exact: true }).click();
  await expect(page.getByText('Closed · chip discrepancy', { exact: true })).toBeVisible();
  history = await call<History>(page, `/players/${winner.id}`);
  expect(history.cumulative).toContainEqual({ currency: 'USD', result_minor: '3000' });
  expect(history.sessions.filter(row => row.session.status === 'closed')).toHaveLength(2);
  await writeFile(`${evidence}/close-history-proof.json`, JSON.stringify(history, null, 2));
  await page.getByRole('button', { name: 'Players', exact: true }).click();
  await expect(page.getByTestId(`roster-player-${winner.id}`)).toContainText('+$30.00');
  await page.getByTestId(`roster-player-${winner.id}`).click();
  await expect(page.getByTestId('report-winning_sessions')).toContainText('1 of 2 (50%)');
  await step('close-finalized-two-games-counted-once');
}
```

## Gotchas

- Outstanding payments do not block a balanced chip close. They remain visible separately and are not player profit.
- Discrepancy is chips returned minus chips bought; it is separate from payments. A $90 cash-out against a $100 buy-in displays −$10.00, including the consent label and closed recap.
- Discrepancy consent belongs to the displayed revision. If another write changes it, inspect the new amount and consent again.
- Reopen does not erase timing history or unset the end. This recipe re-closes without resuming play.
- A positive result must show a plus sign, a negative result a minus sign and zero Even. Color alone is insufficient.
- A queued-write blocker is a different path from a playing-player blocker and needs its own offline evidence.
