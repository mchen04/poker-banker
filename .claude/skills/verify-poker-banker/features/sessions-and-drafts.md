# Sessions, tabs and drafts

Each game has its own settings and drafts. A banker can create multiple games on one day, switch by tabs or month-grouped history, reuse players and reopen exactly the unfinished amount for the selected session.

## Sub-features

- `sessions-welcome-create` creates through the empty workspace.
- `sessions-strip-create` creates through New session beside the tabs.
- `sessions-settings` saves location, game and big blind with past-value suggestions.
- `sessions-tabs-history` switches by tab, searchable month history and player history.
- `sessions-pagination` loads another history page when more than 30 sessions exist.
- `sessions-reuse-player` searches before adding, warns on exact matches and allows explicitly different people.
- `sessions-draft-scope` restores separate drafts after reload; Cancel can keep or discard one.

## How to get to it (user POV)

- Choose `Create your first session` in an empty Workspace, or `New session` beside the tabs.
- Choose a session tab or `History`, then search and choose a dated game; choose `Load more sessions` for older games.
- Choose `Session menu` → `Session settings` to edit settings.
- Choose `Add player` in a session, search an existing name, or choose `Add 'Name' as new`.
- Open a player through `Players` and choose one of their Past sessions.
- In a money sheet, choose `Cancel`, then `Keep draft and close`, `Discard draft` or `Keep editing`.

## Driving it with Playwright

Preconditions:

- Use a fresh launched banker with no sessions. Doctor succeeds.
- This recipe intentionally creates 31 additional empty sessions through the public API as history-pagination setup. That setup does not prove the Create session UI.

- **Create, reuse, switch and restore.** Save as `.cache/verify-sessions.ts`, then run `.claude/skills/verify-poker-banker/scripts/verify.sh recipe .cache/verify-sessions.ts --run RUN_ID --context iphone-webkit`. The two named games share one date, while their typed amounts remain different after reload.

```ts
import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { addPlayer, call, current, keepMoneyDraft, menu, newSession, openMoney } from '../e2e/helpers';
import type { RecipeContext } from '../.claude/skills/verify-poker-banker/scripts/control';

export default async function ({ page, runId, step, checkState }: RecipeContext) {
  const name = `Verify ${runId.slice(-8)}`;
  await expect(page.getByRole('button', { name: 'Create your first session', exact: true })).toBeVisible();
  await step('sessions-welcome-create-before');
  await page.getByRole('button', { name: 'Create your first session', exact: true }).click();
  await page.getByLabel('Session name', { exact: true }).fill('Verify early');
  await page.getByLabel('Session date', { exact: true }).fill('2026-11-10');
  await page.getByLabel('Location', { exact: true }).fill('Verify Home');
  await page.getByLabel('Game', { exact: true }).fill('NLH');
  await page.getByLabel('Big blind', { exact: true }).fill('2');
  await page.getByRole('button', { name: 'Create session', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Verify early', exact: true })).toBeVisible();
  const first = await current(page);
  const player = await addPlayer(page, name);
  await openMoney(page, player.id);
  await page.getByLabel('Amount', { exact: true }).fill('12.');
  await keepMoneyDraft(page);
  const second = await newSession(page, 'Verify late');
  await menu(page, 'Session settings');
  await expect(page.locator('#past-locations option').filter({ hasText: 'Verify Home' })).toHaveCount(1);
  await expect(page.locator('#past-games option').filter({ hasText: 'NLH' })).toHaveCount(1);
  await page.getByLabel('Location', { exact: true }).fill('Verify Home');
  await page.getByLabel('Game', { exact: true }).fill('NLH');
  await page.getByLabel('Big blind', { exact: true }).fill('1');
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  expect((await checkState()).session.big_blind_minor).toBe('100');
  await page.getByRole('button', { name: 'Add player', exact: true }).click();
  await page.getByLabel('Search players', { exact: true }).fill(name);
  await expect(page.getByLabel('Search players', { exact: true })).toHaveValue(name);
  await expect(page.getByText('An exact name match already exists.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: `Add '${name}' as new`, exact: true })).toBeDisabled();
  await step('sessions-existing-player-warning');
  await page.getByRole('dialog').getByRole('button', { name, exact: true }).click();
  await openMoney(page, player.id);
  await page.getByLabel('Amount', { exact: true }).fill('34.');
  await page.reload();
  await openMoney(page, player.id);
  await expect(page.getByLabel('Amount', { exact: true })).toHaveValue('34.');
  await step('sessions-late-draft-restored');
  await keepMoneyDraft(page);
  await page.getByTestId(`session-tab-${first.session.id}`).click();
  await openMoney(page, player.id);
  await expect(page.getByLabel('Amount', { exact: true })).toHaveValue('12.');
  await step('sessions-early-draft-restored');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(page.getByLabel('Amount', { exact: true })).toHaveValue('12.');
  await keepMoneyDraft(page);
  for (let index = 0; index < 31; index++) await call(page, '/sessions', 'POST', { op_id: randomUUID(), name: `Verify older ${index}`, played_on: `2025-${String(1 + index % 12).padStart(2, '0')}-01`, currency: 'USD' });
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Load more sessions', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Load more sessions', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Load more sessions', exact: true })).toHaveCount(0);
  await page.getByLabel('Search sessions', { exact: true }).fill('Verify late');
  await expect(page.getByRole('heading', { name: 'November 2026', exact: true })).toBeVisible();
  await step('sessions-history-month-search');
  await page.getByRole('dialog').getByRole('button', { name: /Verify late/ }).click();
  expect(new URL(page.url()).searchParams.get('session')).toBe(second.session.id);
  await openMoney(page, player.id);
  await expect(page.getByLabel('Amount', { exact: true })).toHaveValue('34.');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Discard draft', exact: true }).click();
  await openMoney(page, player.id);
  await expect(page.getByLabel('Amount', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Add player', exact: true }).click();
  await page.getByLabel('Search players', { exact: true }).fill(name);
  await expect(page.getByText('An exact name match already exists.', { exact: false })).toBeVisible();
  await page.getByLabel('This is a different person', { exact: true }).check();
  await page.getByRole('button', { name: `Add '${name}' as new`, exact: true }).click();
  expect((await checkState()).players.filter(player => player.display_name === name)).toHaveLength(2);
  await step('sessions-distinct-person-confirmed');
}
```

- **Open from player history.** The report recipe exercises Players → player detail → Past sessions, then proves the session heading and selected session ID. That entry point is not counted by the tabs/history proof above.

## Gotchas

- Use a fresh run for the empty-workspace entry. Do not skip it because earlier feature data exists.
- Search must retain the actual typed text while results load. Wait for the warning or matching result, not a fixed sleep or a retry.
- Exact duplicate names represent separate IDs only after `This is a different person` is checked. Never merge them by text alone.
- Drafts are scoped to banker, session, form and player. Test two different partial values; identical values cannot detect mixing.
- History pagination needs more than 30 matching sessions. Absence of Load more without that setup is not a pass.
