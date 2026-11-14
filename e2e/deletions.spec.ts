import type { Page } from '@playwright/test';
import type { SessionState } from '../src/domain/session';
import { test, expect, screen } from './fixtures';
import { randomUUID } from 'node:crypto';
import { addPlayer, call, createAccount, current, menu, money, newContextLike, newSession, openMoney, share } from './helpers';
import { typeInput } from './input';

const longName = 'Alexandria Montgomery-Whitfield';

function activityRow(page: Page, id: string) {
  return page.locator('.session-board').getByTestId('activity').getByTestId(`entry-${id}`);
}
function toast(page: Page) {
  return page.getByTestId('save-status');
}
function bought(state: SessionState, id: string) {
  return state.players.find(player => player.id === id)?.bought_in_minor;
}
async function players(page: Page) {
  await page.getByRole('navigation', { name: 'Table navigation', exact: true }).getByRole('button', { name: 'Players', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Players', exact: true })).toBeVisible();
}
async function table(page: Page) {
  await page.getByRole('navigation', { name: 'Table navigation', exact: true }).getByRole('button', { name: 'Table', exact: true }).click();
}

test('deleting an entry offers Undo, a later Restore and an offline delete that syncs on reconnect', async ({ page }, info) => {
  await createAccount(page);
  await newSession(page, 'Deletion ledger');
  const sam = await addPlayer(page, 'Sam');
  const priya = await addPlayer(page, 'Priya');
  await money(page, sam.id, '50', { paid: false });
  let state = await money(page, priya.id, '100', { paid: false });
  expect(state.totals.total_in_minor).toBe('15000');
  const samBuy = state.entries.find(entry => entry.player_id === sam.id && entry.kind === 'buy_in')!;

  await activityRow(page, samBuy.id).getByRole('button').click();
  await page.getByRole('button', { name: 'Delete entry', exact: true }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Delete entry', exact: true });
  await expect(confirm).toContainText("Delete Sam's $50.00 buy-in?");
  await expect(confirm).toContainText('Totals update right away.');
  expect((await current(page)).revision).toBe(state.revision);
  await screen(page, info, 'delete-entry-confirm');
  await page.getByRole('button', { name: 'Confirm delete', exact: true }).click();
  await expect(toast(page)).toContainText('Deleted buy-in · Sam · $50.00');
  await expect(toast(page).getByRole('button', { name: 'Undo', exact: true })).toBeVisible();
  await expect(activityRow(page, samBuy.id)).toContainText('Deleted');
  for (const part of ['.entry-title.voided', '.entry-amount.voided']) await expect(activityRow(page, samBuy.id).locator(part)).toHaveCSS('text-decoration-line', 'line-through');
  state = await current(page);
  expect(state.totals.total_in_minor).toBe('10000');
  expect(bought(state, sam.id)).toBe('0');
  await screen(page, info, 'delete-entry-toast');

  await toast(page).getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(toast(page)).toContainText('Restored buy-in · Sam · $50.00');
  state = await current(page);
  expect(state.totals.total_in_minor).toBe('15000');
  expect(bought(state, sam.id)).toBe('5000');
  await expect(activityRow(page, samBuy.id)).toHaveCount(0);
  const restored = state.entries.find(entry => entry.restores_entry_id === samBuy.id)!;
  await expect(activityRow(page, restored.id)).toContainText('$50.00');

  await activityRow(page, restored.id).getByRole('button').click();
  await page.getByRole('button', { name: 'Delete entry', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm delete', exact: true }).click();
  await expect(toast(page)).toContainText('Deleted buy-in · Sam · $50.00');
  expect((await current(page)).totals.total_in_minor).toBe('10000');
  await activityRow(page, restored.id).getByRole('button', { name: /^Deleted Buy-in \$50\.00 · Sam · / }).click();
  const sheet = page.getByRole('dialog', { name: 'Deleted entry', exact: true });
  await expect(sheet).toContainText('Buy-in · Sam');
  await screen(page, info, 'restore-entry-sheet');
  await sheet.getByRole('button', { name: 'Restore entry', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(toast(page)).toContainText('Restored buy-in · Sam · $50.00');
  state = await current(page);
  expect(state.totals.total_in_minor).toBe('15000');
  expect(bought(state, sam.id)).toBe('5000');

  const priyaBuy = state.entries.find(entry => entry.player_id === priya.id && entry.kind === 'buy_in')!;
  await page.context().setOffline(true);
  await activityRow(page, priyaBuy.id).getByRole('button').focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Delete entry', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm delete', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(activityRow(page, priyaBuy.id).getByRole('button')).toBeFocused();
  await expect(page.getByLabel('Unsent entries', { exact: true })).toContainText('Delete buy-in · Priya · $100.00');
  await expect(activityRow(page, priyaBuy.id)).toContainText('Delete pending');
  await expect(page.getByTestId('totals')).toContainText('$150.00');
  await expect(page.getByTestId(`player-${priya.id}`)).toContainText('$100.00');
  await screen(page, info, 'offline-delete-pending');
  await page.reload();
  await expect(page.getByLabel('Unsent entries', { exact: true })).toContainText('Delete buy-in · Priya · $100.00');
  await expect(page.getByTestId('totals')).toContainText('$150.00');
  await page.context().setOffline(false);
  await expect(toast(page)).toContainText('Deleted buy-in · Priya · $100.00');
  await expect(page.getByLabel('Unsent entries', { exact: true })).toHaveCount(0);
  await expect(activityRow(page, priyaBuy.id)).toContainText('Deleted');
  state = await current(page);
  expect(state.totals.total_in_minor).toBe('5000');
  expect(bought(state, priya.id)).toBe('0');
  expect(state.entries.filter(entry => entry.voids_entry_id === priyaBuy.id)).toHaveLength(1);
});

test('removing a player deletes their entries recoverably through Undo and the Removed list', async ({ page }, info) => {
  await createAccount(page);
  await newSession(page, 'Removal game');
  const sam = await addPlayer(page, 'Sam');
  const alexandria = await addPlayer(page, longName);
  await money(page, sam.id, '50', { paid: false });
  await money(page, alexandria.id, '100', { paid: false });
  let state = await money(page, alexandria.id, '25', { paid: false });
  expect(state.totals.total_in_minor).toBe('17500');

  await page.getByTestId(`player-${alexandria.id}`).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove from game', exact: true }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Remove player', exact: true });
  await expect(confirm).toContainText(`Remove ${longName} from this game?`);
  await expect(confirm).toContainText('Their 2 entries will be deleted. Totals update right away.');
  await screen(page, info, 'remove-player-confirm');
  await confirm.getByRole('button', { name: 'Confirm remove', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(toast(page)).toContainText(`Removed ${longName}`);
  state = await current(page);
  expect(state.players.map(player => player.id)).toEqual([sam.id]);
  expect(state.removed_players.map(player => player.id)).toEqual([alexandria.id]);
  expect(state.totals.total_in_minor).toBe('5000');
  await expect(page.getByTestId(`player-${alexandria.id}`)).toHaveCount(0);

  await toast(page).getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(toast(page)).toContainText(`Restored ${longName}`);
  await expect(page.getByTestId(`player-${alexandria.id}`)).toBeVisible();
  state = await current(page);
  expect(state.removed_players).toHaveLength(0);
  expect(state.totals.total_in_minor).toBe('17500');
  expect(bought(state, alexandria.id)).toBe('12500');

  await page.getByTestId(`player-${alexandria.id}`).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove from game', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm remove', exact: true }).click();
  await expect(toast(page)).toContainText(`Removed ${longName}`);
  expect((await current(page)).totals.total_in_minor).toBe('5000');
  const removed = page.getByTestId('removed-players');
  await removed.getByText('Removed (1)', { exact: true }).click();
  await screen(page, info, 'removed-disclosure');
  await removed.getByRole('button', { name: `Restore ${longName}`, exact: true }).click();
  await expect(page.getByTestId(`player-${alexandria.id}`)).toBeVisible();
  await expect(removed).toHaveCount(0);
  state = await current(page);
  expect(state.totals.total_in_minor).toBe('17500');
  expect(bought(state, alexandria.id)).toBe('12500');
});

test('deleting a session moves to the next session, kills its viewer link and restores from Undo or Recently deleted', async ({ page, browser, baseURL }, info) => {
  await createAccount(page);
  const older = await newSession(page, 'Older game');
  await newSession(page, 'Friday home game');
  const sam = await addPlayer(page, 'Sam');
  let state = await money(page, sam.id, '80', { paid: false });
  const sessionId = state.session.id;
  const link = await share(page);

  await menu(page, 'Delete session');
  const confirm = page.getByRole('alertdialog', { name: 'Delete session', exact: true });
  await expect(confirm).toContainText('Delete Friday home game?');
  await expect(confirm).toContainText('It disappears from history and reports, and its viewer link stops working.');
  await expect(confirm).toContainText('Not settled yet: $80.00 owed to you. These amounts leave player balances until you restore the session.');
  await screen(page, info, 'delete-session-confirm');
  await confirm.getByRole('button', { name: 'Confirm delete', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Older game', exact: true })).toBeVisible();
  await expect(toast(page)).toContainText('Deleted Friday home game');
  await expect.poll(() => new URL(page.url()).searchParams.get('session')).toBe(older.session.id);
  expect((await call<{ sessions: { id: string }[] }>(page, '/sessions')).sessions.map(row => row.id)).toEqual([older.session.id]);
  expect((await call<{ sessions: { id: string }[] }>(page, '/sessions/deleted')).sessions.map(row => row.id)).toEqual([sessionId]);
  await screen(page, info, 'delete-session-toast');

  const viewerContext = await newContextLike(page, browser, baseURL!);
  try {
    const viewer = await viewerContext.newPage();
    await viewer.goto(link);
    await expect(viewer.getByText('This viewer link is unavailable. Ask the banker for a current link.', { exact: true })).toBeVisible();
  } finally { await viewerContext.close(); }

  await toast(page).getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Friday home game', exact: true })).toBeVisible();
  await expect(toast(page)).toContainText('Restored Friday home game');
  state = await current(page);
  expect(state.session.id).toBe(sessionId);
  expect(state.totals.total_in_minor).toBe('8000');

  await menu(page, 'Delete session');
  await page.getByRole('button', { name: 'Confirm delete', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Older game', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Switch session', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Sessions', exact: true });
  await picker.getByText('Recently deleted (1)', { exact: true }).click();
  await screen(page, info, 'recently-deleted-sessions');
  await picker.getByRole('button', { name: 'Restore Friday home game', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Friday home game', exact: true })).toBeVisible();
  await expect(toast(page)).toContainText('Restored Friday home game');
  state = await current(page);
  expect(state.totals.total_in_minor).toBe('8000');
  expect(bought(state, sam.id)).toBe('8000');
  expect((await call<{ sessions: unknown[] }>(page, '/sessions/deleted')).sessions).toHaveLength(0);
});

test('restores a deleted session from the second page of Recently deleted', async ({ page }) => {
  await createAccount(page);
  await newSession(page, 'Current game');
  let oldest = '';
  for (let index = 0; index < 32; index++) {
    const created = await call<SessionState>(page, '/sessions', 'POST', { op_id: randomUUID(), name: index === 0 ? 'Oldest deleted' : `Deleted page ${index}`, played_on: '2026-11-10', currency: 'USD' });
    if (index === 0) oldest = created.session.id;
    await call(page, `/sessions/${created.session.id}/delete`, 'POST', { op_id: randomUUID() });
  }
  await page.getByRole('button', { name: 'Switch session', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Sessions', exact: true });
  await picker.getByText('Recently deleted', { exact: true }).click();
  await expect(picker.getByRole('button', { name: 'Restore Oldest deleted', exact: true })).toHaveCount(0);
  await picker.getByRole('button', { name: 'Load more deleted sessions', exact: true }).click();
  await picker.getByRole('button', { name: 'Restore Oldest deleted', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Oldest deleted', exact: true })).toBeVisible();
  expect((await current(page)).session.id).toBe(oldest);
});

async function deletedPlayers(page: Page, count: number) {
  for (let index = 0; index < count; index++) {
    const created = await call<{ player: { id: string } }>(page, '/players', 'POST', { op_id: randomUUID(), display_name: `Race player ${index}` });
    await call(page, `/players/${created.player.id}/delete`, 'POST', { op_id: randomUUID() });
  }
}

test.describe('deleted-player paging with routed responses', () => {
  test.use({ serviceWorkers: 'block' });
  test('discards a deleted-player page that started before a restore', async ({ page }) => {
    await createAccount(page);
    await deletedPlayers(page, 32);
    await players(page);
    const list = page.getByTestId('recently-deleted-players');
    await expect(list).toBeVisible();
    await list.getByText('Recently deleted', { exact: true }).click();
    await page.route(url => url.pathname === '/api/players/deleted' && url.searchParams.has('before'), async route => {
      await new Promise(resolve => setTimeout(resolve, 600));
      await route.continue();
    });
    await list.getByRole('button', { name: 'Load more deleted players', exact: true }).click();
    await list.getByRole('button', { name: /^Restore / }).first().click();
    await expect(list.getByText('Race player 31', { exact: true })).toHaveCount(0);
    await expect.poll(async () => {
      const names = await list.locator('.recover-name').allTextContents();
      return names.length === new Set(names).size;
    }).toBe(true);
  });
  test('shows an error when loading more deleted players fails', async ({ page }) => {
    const account = await createAccount(page);
    await deletedPlayers(page, 32);
    await players(page);
    const list = page.getByTestId('recently-deleted-players');
    await expect(list).toBeVisible();
    await list.getByText('Recently deleted', { exact: true }).click();
    let fail = true;
    await page.route(url => url.pathname === '/api/players/deleted' && url.searchParams.has('before'), route => fail
      ? route.fulfill({ status: 500, contentType: 'application/json', headers: { 'X-PB-Banker-ID': account.banker.id }, body: JSON.stringify({ error: { code: 'request_failed', message: 'Deleted players unavailable' } }) })
      : route.continue());
    await list.getByRole('button', { name: 'Load more deleted players', exact: true }).click();
    await expect(list.getByText('Deleted players unavailable', { exact: true })).toBeVisible();
    await list.getByRole('button', { name: /^Restore / }).first().click();
    await expect(list.getByText('Deleted players unavailable', { exact: true })).toHaveCount(0);
    fail = false;
    await list.getByRole('button', { name: 'Load more deleted players', exact: true }).click();
    await expect(list.locator('.recover-name')).toHaveCount(31);
  });
});

test.describe('session-list paging with routed responses', () => {
  test.use({ serviceWorkers: 'block' });
  async function friSessions(page: Page, count: number) {
    for (let index = 0; index < count; index++) await call(page, '/sessions', 'POST', { op_id: randomUUID(), name: `Fri game ${index}`, played_on: '2026-11-10', currency: 'USD' });
  }
  test('discards a session page that started before a search change', async ({ page }) => {
    await createAccount(page);
    await newSession(page, 'Friday current');
    await friSessions(page, 40);
    await page.getByRole('button', { name: 'Switch session', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'Sessions', exact: true });
    let release!: () => void;
    const stale = new Promise<void>(resolve => { release = resolve; });
    await page.route(url => url.pathname === '/api/sessions' && url.searchParams.get('q') === '' && url.searchParams.has('before'), async route => {
      await new Promise(resolve => setTimeout(resolve, 600));
      await route.continue();
      release();
    });
    await picker.getByRole('button', { name: 'Load more sessions', exact: true }).click();
    await picker.getByLabel('Search sessions', { exact: true }).fill('Fri');
    await expect(picker.getByText(/Fri game 39/)).toBeVisible();
    await stale;
    await page.waitForTimeout(200);
    await expect(picker.getByRole('button', { name: 'Load more sessions', exact: true })).toBeVisible();
  });
  test('ignores a session page failure from before a search change', async ({ page }) => {
    const account = await createAccount(page);
    await newSession(page, 'Friday current');
    await friSessions(page, 40);
    await page.getByRole('button', { name: 'Switch session', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'Sessions', exact: true });
    let release!: () => void;
    const stale = new Promise<void>(resolve => { release = resolve; });
    await page.route(url => url.pathname === '/api/sessions' && url.searchParams.get('q') === '' && url.searchParams.has('before'), async route => {
      await new Promise(resolve => setTimeout(resolve, 600));
      await route.fulfill({ status: 500, contentType: 'application/json', headers: { 'X-PB-Banker-ID': account.banker.id }, body: JSON.stringify({ error: { code: 'request_failed', message: 'Stale session error' } }) });
      release();
    });
    await picker.getByRole('button', { name: 'Load more sessions', exact: true }).click();
    await picker.getByLabel('Search sessions', { exact: true }).fill('Fri');
    await expect(picker.getByText(/Fri game 39/)).toBeVisible();
    await stale;
    await page.waitForTimeout(200);
    await expect(picker.getByText('Stale session error', { exact: true })).toHaveCount(0);
  });
});


test('an offline buy-in for a session deleted on another device stays listed until discarded', async ({ page }) => {
  await createAccount(page);
  await newSession(page, 'Older game');
  const friday = await newSession(page, 'Friday home game');
  const sam = await addPlayer(page, 'Sam');
  await page.context().setOffline(true);
  await openMoney(page, sam.id);
  await typeInput(page.getByTestId('money-amount'), '40');
  await page.getByRole('button', { name: 'Save entry', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const unsent = page.getByLabel('Unsent entries', { exact: true });
  await expect(unsent).toContainText('$40.00');
  await call(page, `/sessions/${friday.session.id}/delete`, 'POST', { op_id: randomUUID() });
  await page.context().setOffline(false);
  await expect(unsent.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
  await expect(unsent).toContainText('$40.00');
  await unsent.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(unsent).toHaveCount(0);
});

test('a roster player can be deleted only once out of every game, with Undo and Recently deleted restore', async ({ page }, info) => {
  await createAccount(page);
  await newSession(page, 'Roster game');
  const jordan = await addPlayer(page, 'Jordan');

  await players(page);
  await page.getByTestId(`roster-player-${jordan.id}`).click();
  await page.getByRole('button', { name: 'Delete player', exact: true }).click();
  const blocked = page.getByRole('dialog', { name: 'Delete player', exact: true });
  await expect(blocked).toContainText('Remove them from their games first');
  await expect(blocked.getByRole('button', { name: 'Confirm delete', exact: true })).toHaveCount(0);
  await blocked.getByRole('button', { name: 'Close sheet', exact: true }).click();

  await table(page);
  await page.getByTestId(`player-${jordan.id}`).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove from game', exact: true }).click();
  await expect(page.getByRole('alertdialog', { name: 'Remove player', exact: true })).toContainText('They have no entries.');
  await page.getByRole('button', { name: 'Confirm remove', exact: true }).click();
  await expect(toast(page)).toContainText('Removed Jordan');

  await players(page);
  await page.getByTestId(`roster-player-${jordan.id}`).click();
  await page.getByRole('button', { name: 'Delete player', exact: true }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Delete player', exact: true });
  await expect(confirm).toContainText('Delete Jordan?');
  await expect(confirm).toBeFocused();
  await screen(page, info, 'delete-player-confirm');
  await confirm.getByRole('button', { name: 'Confirm delete', exact: true }).click();
  await expect(toast(page)).toContainText('Deleted Jordan');
  await expect(page.getByRole('searchbox', { name: 'Find a player', exact: true })).toBeFocused();
  await expect(page.getByTestId(`roster-player-${jordan.id}`)).toHaveCount(0);
  expect((await call<{ players: { id: string }[] }>(page, '/players')).players.map(row => row.id)).not.toContain(jordan.id);

  await toast(page).getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(toast(page)).toContainText('Restored Jordan');
  await expect(page.getByTestId(`roster-player-${jordan.id}`)).toBeVisible();
  expect((await call<{ players: { id: string }[] }>(page, '/players')).players.map(row => row.id)).toContain(jordan.id);

  await page.getByTestId(`roster-player-${jordan.id}`).click();
  await page.getByRole('button', { name: 'Delete player', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm delete', exact: true }).click();
  await expect(toast(page)).toContainText('Deleted Jordan');
  const recent = page.getByTestId('recently-deleted-players');
  await recent.getByText('Recently deleted (1)', { exact: true }).click();
  await screen(page, info, 'recently-deleted-players');
  await recent.getByRole('button', { name: 'Restore Jordan', exact: true }).click();
  await expect(page.getByTestId(`roster-player-${jordan.id}`)).toBeVisible();
  await expect(recent).toHaveCount(0);
  expect((await call<{ players: { id: string }[] }>(page, '/players')).players.map(row => row.id)).toContain(jordan.id);
});

test('a long name with a nine-digit amount stays fully readable with reachable actions at 320, 375 and 393', async ({ page }, info) => {
  await createAccount(page);
  await newSession(page, 'Readable rows');
  const sam = await addPlayer(page, 'Sam');
  const alexandria = await addPlayer(page, longName);
  await money(page, sam.id, '50', { paid: false });
  const state = await money(page, alexandria.id, '123456789', { paid: false });
  const buy = state.entries.find(entry => entry.player_id === alexandria.id && entry.kind === 'buy_in')!;
  for (const width of [320, 375, 393]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(150);
    const row = page.getByTestId(`player-${alexandria.id}`);
    const name = await row.locator('strong[title]').evaluate(element => ({ text: element.textContent, overflow: getComputedStyle(element).textOverflow, scroll: element.scrollWidth, client: element.clientWidth }));
    expect(name, `name at ${width}`).toMatchObject({ text: longName });
    expect(name.overflow).not.toBe('ellipsis');
    expect(name.scroll).toBeLessThanOrEqual(name.client);
    const amount = await row.locator('.player-position').evaluate(element => ({ text: element.textContent, scroll: element.scrollWidth, client: element.clientWidth }));
    expect(amount.text).toBe('$123,456,789.00');
    expect(amount.scroll).toBeLessThanOrEqual(amount.client);
    await expect(row.locator('.player-balance')).toHaveText('Owes $123,456,789.00');
    const balance = await row.locator('.player-balance').evaluate(element => ({ scroll: element.scrollWidth, client: element.clientWidth, right: element.getBoundingClientRect().right }));
    expect(balance.scroll).toBeLessThanOrEqual(balance.client);
    expect(balance.right).toBeLessThanOrEqual(width);
    for (const action of [`cash-out-${alexandria.id}`, `repeat-buy-in-${alexandria.id}`]) {
      const control = page.getByTestId(action);
      await control.scrollIntoViewIfNeeded();
      await expect(control).toBeInViewport({ ratio: 1 });
      await control.click({ trial: true });
    }
    const label = await activityRow(page, buy.id).locator('.entry-label').evaluate(element => ({ text: element.textContent, scroll: element.scrollWidth, client: element.clientWidth }));
    expect(label.text).toMatch(/^Buy-in/);
    expect(label.scroll).toBeLessThanOrEqual(label.client);
    await page.evaluate(() => scrollTo(0, 0));
    await screen(page, info, `long-name-row-${width}`);
  }
});
