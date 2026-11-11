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

- Doctor succeeds. The recipe returns to Workspace and creates its own uniquely named sessions; earlier recipes may already have sessions.
- This recipe intentionally creates 31 additional empty sessions through the public API as history-pagination setup. That setup does not prove the Create session UI.

- **Create, reuse, switch and restore.** Save as `.cache/verify-sessions.ts`, then run `.claude/skills/verify-poker-banker/scripts/verify.sh recipe .cache/verify-sessions.ts --run RUN_ID --context iphone-webkit`. The two named games share one date, while their typed amounts remain different after reload.

```ts
import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { addPlayer, call, current, keepMoneyDraft, menu, newSession, openMoney } from '../e2e/helpers';
import type { RecipeContext } from '../.claude/skills/verify-poker-banker/scripts/control';

export default async function ({ page, runId, step, checkState }: RecipeContext) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'New session', exact: true })).toBeVisible();
  const tag = `${runId.slice(-8)}-${randomUUID().slice(0, 6)}`;
  const name = `Verify ${tag}`;
  const firstName = `${name} early`;
  const secondName = `${name} late`;
  const welcome = page.getByRole('button', { name: 'Create your first session', exact: true });
  const existing = await call<{ sessions: { id: string }[] }>(page, '/sessions');
  const empty = existing.sessions.length === 0;
  if (empty) await expect(welcome).toBeVisible();
  else {
    await expect(page.getByRole('tab', { selected: true })).toBeVisible();
    await expect(welcome).toHaveCount(0);
  }
  await step(empty ? 'sessions-welcome-create-before' : 'sessions-strip-create-before');
  await (empty ? welcome : page.getByRole('button', { name: 'New session', exact: true })).click();
  await page.getByLabel('Session name', { exact: true }).fill(firstName);
  await page.getByLabel('Session date', { exact: true }).fill('2026-11-10');
  await page.getByLabel('Location', { exact: true }).fill('Verify Home');
  await page.getByLabel('Game', { exact: true }).fill('NLH');
  await page.getByLabel('Big blind', { exact: true }).fill('2');
  await page.getByRole('button', { name: 'Create session', exact: true }).click();
  await expect(page.getByRole('heading', { name: firstName, exact: true })).toBeVisible();
  const first = await current(page);
  const player = await addPlayer(page, name);
  await openMoney(page, player.id);
  await page.getByLabel('Amount', { exact: true }).fill('12.');
  await keepMoneyDraft(page);
  const second = await newSession(page, secondName);
  await menu(page, 'Session settings');
  await expect(page.locator('#past-locations option').filter({ hasText: 'Verify Home' })).toHaveCount(1);
  await expect(page.locator('#past-games option').filter({ hasText: 'NLH' })).toHaveCount(1);
  await page.getByLabel('Location', { exact: true }).fill('Verify Home');
  await page.getByLabel('Game', { exact: true }).fill('NLH');
  await page.getByLabel('Big blind', { exact: true }).fill('1');
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
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
  for (let index = 0; index < 31; index++) await call(page, '/sessions', 'POST', { op_id: randomUUID(), name: `${name} older ${index}`, played_on: `2025-${String(1 + index % 12).padStart(2, '0')}-01`, currency: 'USD' });
  await page.getByRole('button', { name: 'History', exact: true }).click();
  const matchingHistory = page.waitForResponse(response => {
    const url = new URL(response.url());
    return response.request().method() === 'GET' && url.pathname === '/api/sessions' && url.searchParams.get('q') === name && !url.searchParams.has('before');
  });
  await page.getByLabel('Search sessions', { exact: true }).fill(name);
  expect((await matchingHistory).status()).toBe(200);
  await expect(page.getByRole('dialog').getByRole('button', { name: new RegExp(name) })).toHaveCount(30);
  await expect(page.getByRole('button', { name: 'Load more sessions', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Load more sessions', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Load more sessions', exact: true })).toHaveCount(0);
  const lateHistory = page.waitForResponse(response => {
    const url = new URL(response.url());
    return response.request().method() === 'GET' && url.pathname === '/api/sessions' && url.searchParams.get('q') === secondName;
  });
  await page.getByLabel('Search sessions', { exact: true }).fill(secondName);
  expect((await lateHistory).status()).toBe(200);
  await expect(page.getByRole('dialog').getByRole('button', { name: new RegExp(name) })).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'November 2026', exact: true })).toBeVisible();
  await step('sessions-history-month-search');
  await page.getByRole('dialog').getByRole('button', { name: new RegExp(secondName) }).click();
  await expect(page.getByRole('heading', { name: secondName, exact: true })).toBeVisible();
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
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await checkState()).players.filter(player => player.display_name === name)).toHaveLength(2);
  await step('sessions-distinct-person-confirmed');
}
```

- **Open from player history.** The report recipe exercises Players → player detail → Past sessions, then proves the session heading and selected session ID. That entry point is not counted by the tabs/history proof above.

## Gotchas

- Workspace can briefly show the welcome before its history arrives. The recipe reads this banker's public session list and waits for the matching loaded UI before choosing the entry.
- The recipe records the actual creation entry point. Its isolated fresh run proves the welcome path; a shared run with prior sessions proves the strip path. Neither is reported as the other.
- Save settings and Add player must close their sheets before saved-state reads. A completed click alone does not mean the request has committed.
- Search must retain the actual typed text while results load. Wait for the warning or matching result, not a fixed sleep or a retry.
- Exact duplicate names represent separate IDs only after `This is a different person` is checked. Never merge them by text alone.
- Drafts are scoped to banker, session, form and player. Test two different partial values; identical values cannot detect mixing.
- History pagination searches this invocation's unique prefix before loading its 33 matching sessions. Earlier recipes' sessions do not change that fixture.
