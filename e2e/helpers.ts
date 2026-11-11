import { randomUUID } from 'node:crypto';
import type { Page, TestInfo } from '@playwright/test';
import type { SessionState } from '../src/domain/session';
import { expect, screen } from './fixtures';

export const password = 'a-secure-browser-game-password';
export async function call<T>(page: Page, path: string, method = 'GET', body?: unknown): Promise<T> {
  const origin = new URL(page.url()).origin;
  const response = await page.request.fetch(`${origin}/api${path}`, { method, headers: { origin, 'content-type': 'application/json' }, ...(body === undefined ? {} : { data: body }) });
  const value: unknown = await response.json();
  expect(response.status(), JSON.stringify(value)).toBe(200);
  return value as T;
}
export async function createAccount(page: Page, testInfo?: TestInfo) {
  const username = `browser-${randomUUID().slice(0, 12)}`;
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign up', exact: true }).click();
  if (testInfo) await screen(page, testInfo, 'signup');
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByTestId('recovery-codes')).toBeVisible();
  const codes = (await page.getByTestId('recovery-codes').textContent())!.match(/[a-f0-9]{8}(?:-[a-f0-9]{8}){3}/g)!;
  expect(codes).toHaveLength(10);
  if (testInfo) {
    await screen(page, testInfo, 'recovery-codes');
    await page.reload();
    await expect(page.getByTestId('recovery-codes')).toBeVisible();
    expect((await page.getByTestId('recovery-codes').textContent())!.match(/[a-f0-9]{8}(?:-[a-f0-9]{8}){3}/g)).toEqual(codes);
  }
  await expect(page.getByRole('button', { name: 'Continue to workspace', exact: true })).toBeDisabled();
  await page.getByLabel('I saved these codes', { exact: true }).check();
  await page.getByRole('button', { name: 'Continue to workspace', exact: true }).click();
  await expect(page.getByRole('button', { name: 'New session', exact: true })).toBeVisible();
  return { username, codes, ...(await call<{ banker: { id: string; username: string } }>(page, '/auth/me')) };
}
export async function signIn(page: Page, username: string, secret = password) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(secret);
  await page.getByRole('button', { name: 'Sign in to workspace', exact: true }).click();
  await expect(page.getByRole('button', { name: 'New session', exact: true })).toBeVisible();
}
export async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Players', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  const discard = page.getByLabel('Discard unsent entries and drafts', { exact: true });
  const confirm = page.getByRole('button', { name: 'Confirm sign out', exact: true });
  await expect(confirm).toBeVisible();
  await expect.poll(async () => await discard.isVisible() || await confirm.isEnabled()).toBe(true);
  if (await discard.isVisible()) await discard.check();
  await confirm.click();
  await expect(page.getByLabel('Username', { exact: true })).toBeVisible();
}
export async function newSession(page: Page, name: string, testInfo?: TestInfo) {
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  await page.getByLabel('Session name', { exact: true }).fill(name);
  await page.getByLabel('Session date', { exact: true }).fill('2026-11-10');
  if (testInfo) await screen(page, testInfo, 'new-session');
  await page.getByRole('button', { name: 'Create session', exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  return current(page);
}
export async function current(page: Page, id?: string) {
  const sessionId = id ?? new URL(page.url()).searchParams.get('session');
  if (!sessionId) throw new Error(`No selected session in ${page.url()}`);
  return call<SessionState>(page, `/sessions/${sessionId}`);
}
export async function addPlayer(page: Page, name: string, testInfo?: TestInfo) {
  await page.getByRole('button', { name: 'Add player', exact: true }).click();
  const search = page.getByLabel('Search players', { exact: true });
  await search.click();
  await search.fill('');
  await search.pressSequentially(name);
  if (testInfo) await screen(page, testInfo, 'add-player');
  await page.getByRole('button', { name: `Add '${name}' as new`, exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const state = await current(page);
  const player = state.players.find(player => player.display_name === name)!;
  await expect(page.getByTestId(`player-${player.id}`)).toBeVisible();
  return player;
}
export async function openMoney(page: Page, player: string, kind: 'Buy-in' | 'Cash out' | 'Record payment' | 'Tips and meals' = 'Buy-in') {
  await page.getByTestId(`player-${player}`).click();
  await page.getByRole('dialog').getByRole('button', { name: kind, exact: true }).click();
  await expect(page.getByLabel('Amount', { exact: true })).toBeEnabled();
}
export async function money(page: Page, player: string, amount: string, options: { kind?: 'Buy-in' | 'Cash out' | 'Record payment' | 'Tips and meals'; paid?: boolean; method?: 'cash' | 'venmo' | 'zelle'; testInfo?: TestInfo } = {}) {
  const kind = options.kind ?? 'Buy-in';
  await openMoney(page, player, kind);
  await page.getByLabel('Amount', { exact: true }).fill(amount);
  if (options.paid !== undefined && (kind === 'Buy-in' || kind === 'Cash out')) await page.getByLabel(kind === 'Buy-in' ? 'Paid now' : 'Paid out now', { exact: true }).setChecked(options.paid);
  if (options.method) await page.getByRole('group', { name: 'Payment method', exact: true }).getByRole('button', { name: options.method[0]!.toUpperCase() + options.method.slice(1), exact: true }).click();
  if (options.testInfo) await screen(page, options.testInfo, kind === 'Buy-in' ? 'buy-in' : kind === 'Cash out' ? 'cash-out' : kind === 'Record payment' ? 'payment' : 'expense');
  await page.getByRole('button', { name: 'Save entry', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('saved-confirmation')).toContainText(amount.includes('.') ? amount : `${amount}.00`);
  await expect(page.getByText('Not saved yet', { exact: true })).toHaveCount(0);
  return current(page);
}
export async function menu(page: Page, action: string) {
  await page.getByRole('button', { name: 'Session menu', exact: true }).click();
  const names: Record<string, string> = { 'Close session': 'Close game', 'Reopen session': 'Reopen game', Share: 'Share session' };
  await page.getByRole('dialog').getByRole('button', { name: names[action] ?? action, exact: true }).click();
}
export async function closeSession(page: Page, discrepancy = false) {
  await menu(page, 'Close session');
  if (discrepancy) await page.getByRole('checkbox').check();
  await page.getByRole('dialog').getByRole('button', { name: 'Close session', exact: true }).click();
  await expect(page.getByText(discrepancy ? /Closed, off by/ : 'Closed, balanced', { exact: !discrepancy })).toBeVisible();
  return current(page);
}
export async function share(page: Page) {
  await menu(page, 'Share');
  const enable = page.getByRole('button', { name: 'Enable sharing', exact: true });
  if (await enable.isVisible()) await enable.click();
  const link = await page.getByLabel('Viewer link', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'Close sheet', exact: true }).click();
  return link;
}
export async function fixtureSession(page: Page, player: string | undefined, options: { name: string; day: string; result: string; hours: number; blind?: string; location?: string; game?: string; expense?: string; currency?: string }) {
  let state = await call<SessionState>(page, '/sessions', 'POST', { op_id: randomUUID(), name: options.name, played_on: options.day, currency: options.currency ?? 'USD', big_blind_minor: options.blind ?? null, location: options.location ?? 'Home', game: options.game ?? 'NLH' });
  state = await call<SessionState>(page, `/sessions/${state.session.id}/players`, 'POST', { op_id: randomUUID(), ...(player ? { player_id: player } : { new_player_name: 'Report Justin' }) });
  const playerId = state.players[0]!.id;
  state = await call<SessionState>(page, `/sessions/${state.session.id}/timing`, 'PATCH', { op_id: randomUUID(), started_at: `${options.day}T00:00:00Z`, ended_at: `${options.day}T06:00:00Z` });
  state = await call<SessionState>(page, `/sessions/${state.session.id}/entries`, 'POST', { op_id: randomUUID(), player_id: playerId, kind: 'buy_in', amount_minor: '10000', paid_now: false, occurred_at: `${options.day}T01:00:00Z` });
  state = await call<SessionState>(page, `/sessions/${state.session.id}/entries`, 'POST', { op_id: randomUUID(), player_id: playerId, kind: 'cash_out', amount_minor: String(10000n + BigInt(options.result)), occurred_at: `${options.day}T0${1 + options.hours}:00:00Z` });
  if (options.expense) state = await call<SessionState>(page, `/sessions/${state.session.id}/entries`, 'POST', { op_id: randomUUID(), player_id: playerId, kind: 'expense', amount_minor: options.expense, occurred_at: `${options.day}T01:30:00Z` });
  return call<SessionState>(page, `/sessions/${state.session.id}/close`, 'POST', { op_id: randomUUID(), expected_revision: state.revision, accept_discrepancy_minor: state.totals.discrepancy_minor });
}

export async function workerReady(page: Page) {
  await expect.poll(() => page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration('/'))?.active), {
    message: 'The local service worker must activate; inspect browser certificate and registration errors if it does not',
  }).toBe(true);
}

export async function keepMoneyDraft(page: Page) {
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Keep draft and close', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}
