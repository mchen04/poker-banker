import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures';
import { call, createAccount } from './helpers';
import type { SessionState } from '../src/domain/session';

test.use({ serviceWorkers: 'block' });

test('an unchanged poll without an owner header keeps the game open and a changed poll verifies its owner', async ({ page }) => {
  const account = await createAccount(page);
  const session = await call<SessionState>(page, '/sessions', 'POST', { op_id: randomUUID(), name: 'Unchanged polling game', played_on: '2026-11-10', currency: 'USD' });
  const id = session.session.id;
  const state = await call<SessionState>(page, `/sessions/${id}/players`, 'POST', { op_id: randomUUID(), new_player_name: 'Polling player' });
  const path = `/api/sessions/${id}`;
  const unchanged = page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'GET' && response.status() === 304);
  await page.goto(`/?session=${id}`);
  const response = await unchanged;
  expect(new URL(response.url()).searchParams.get('since')).toBe(String(state.revision));
  expect(response.request().headers()['x-pb-expected-banker-id']).toBe(account.banker.id);
  expect(response.headers()['x-pb-banker-id']).toBeUndefined();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByRole('heading', { name: 'Account changed', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Unchanged polling game', exact: true })).toBeVisible();
  await expect(page.getByTestId(`player-${state.players[0]!.id}`)).toBeVisible();
  const changed = page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'GET' && new URL(response.url()).searchParams.has('since') && response.status() === 200);
  await call(page, `/sessions/${id}/players`, 'POST', { op_id: randomUUID(), new_player_name: 'Changed polling player' });
  const updated = await changed;
  expect(updated.request().headers()['x-pb-expected-banker-id']).toBe(account.banker.id);
  expect(updated.headers()['x-pb-banker-id']).toBe(account.banker.id);
  const next = await updated.json() as SessionState;
  expect(next.revision).not.toBe(state.revision);
  await expect(page.getByTestId(`player-${next.players.find(player => player.display_name === 'Changed polling player')!.id}`)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Account changed', exact: true })).toHaveCount(0);
});
