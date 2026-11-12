import { typeInput } from './input';
import type { Request } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { test, expect, screen } from './fixtures';
import { addPlayer, call, createAccount, current, keepMoneyDraft, money, newSession, openMoney } from './helpers';
import type { SessionState } from '../src/domain/session';

test('a version 1 database upgrades forward and preserves both session drafts exactly', async ({ page }) => {
  const user = await createAccount(page);
  const first = await newSession(page, 'Migration first');
  const player = await addPlayer(page, 'Justin');
  let second = await call<SessionState>(page, '/sessions', 'POST', { op_id: randomUUID(), name: 'Migration second', played_on: '2026-11-10', currency: 'USD' });
  second = await call<SessionState>(page, `/sessions/${second.session.id}/players`, 'POST', { op_id: randomUUID(), player_id: player.id });
  const key = `${user.banker.id}/${first.session.id}/buy_in/${player.id}`;
  const otherKey = `${user.banker.id}/${second.session.id}/buy_in/${player.id}`;
  const value = { op_id: randomUUID(), amount: '73.45', paid_now: true, method: 'venmo', occurred_at: '', note: 'Draft before upgrade', kind: 'buy_in' };
  const otherValue = { ...value, op_id: randomUUID(), amount: '91.', method: 'cash' };
  await page.goto('/assets/storage-seed-missing.js');
  await page.evaluate(async records => {
    await new Promise<void>((resolve, reject) => { const remove = indexedDB.deleteDatabase('poker-banker'); remove.onsuccess = () => resolve(); remove.onerror = () => reject(remove.error); remove.onblocked = () => reject(new Error('Previous page kept storage open')); });
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('poker-banker', 1);
      open.onupgradeneeded = () => {
        open.result.createObjectStore('drafts', { keyPath: 'key' });
        open.result.createObjectStore('outbox', { keyPath: 'op_id' });
        open.result.createObjectStore('snapshots', { keyPath: 'key' });
      };
      open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
    });
    await new Promise<void>((resolve, reject) => { const tx = db.transaction('drafts', 'readwrite'); for (const record of records) tx.objectStore('drafts').put(record); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
    db.close();
  }, [{ key, value }, { key: otherKey, value: otherValue }]);
  await page.goto(`/?session=${first.session.id}`);
  await openMoney(page, player.id);
  await expect(page.getByTestId('money-amount')).toHaveValue('73.45');
  await expect(page.getByRole('group', { name: 'Payment method', exact: true }).getByRole('button', { name: 'Venmo', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await keepMoneyDraft(page);
  await page.getByTestId(`session-tab-${second.session.id}`).click();
  await openMoney(page, player.id);
  await expect(page.getByTestId('money-amount')).toHaveValue('91.');
  const migrated = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const open = indexedDB.open('poker-banker'); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
    const records = await new Promise<Record<string, unknown>[]>((resolve, reject) => { const read = db.transaction('drafts').objectStore('drafts').getAll(); read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error); });
    const version = db.version; db.close(); return { version, records };
  });
  expect(migrated.version).toBe(2);
  expect(migrated.records.find(record => record.key === key)).toMatchObject({ key, value, banker_id: user.banker.id });
  expect(migrated.records.find(record => record.key === otherKey)).toMatchObject({ key: otherKey, value: otherValue, banker_id: user.banker.id });
});

test('rejected writes stay visible, block the session in order, and support retry or discard', async ({ page }, testInfo) => {
  await createAccount(page);
  await newSession(page, 'Rejected queue');
  const player = await addPlayer(page, 'Justin');
  let state = await money(page, player.id, '100');
  await page.context().setOffline(true);
  for (const amount of ['20', '30']) {
    await openMoney(page, player.id);
    await typeInput(page.getByTestId('money-amount'), amount);
    await page.getByRole('button', { name: 'Save entry', exact: true }).click();
  }
  state = await call<SessionState>(page, `/sessions/${state.session.id}/entries`, 'POST', { op_id: randomUUID(), player_id: player.id, kind: 'cash_out', amount_minor: '10000' });
  state = await call<SessionState>(page, `/sessions/${state.session.id}/close`, 'POST', { op_id: randomUUID(), expected_revision: state.revision });
  await page.context().setOffline(false);
  await expect(page.getByText('Reopen this session before writing', { exact: false })).toBeVisible();
  const queued = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const open = indexedDB.open('poker-banker'); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
    const rows = await new Promise<{ op_id: string; status: string; order: number }[]>((resolve, reject) => { const read = db.transaction('outbox').objectStore('outbox').getAll(); read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error); });
    db.close(); return rows.sort((a, b) => a.order - b.order);
  });
  expect(queued.map(item => item.status)).toEqual(['rejected', 'pending']);
  expect((await current(page)).entries.filter(entry => entry.kind === 'buy_in')).toHaveLength(1);
  await screen(page, testInfo, 'rejected-outbox');
  state = await call<SessionState>(page, `/sessions/${state.session.id}/reopen`, 'POST', { op_id: randomUUID(), reason: 'Apply queued entries' });
  state = await call<SessionState>(page, `/sessions/${state.session.id}/timing`, 'PATCH', { op_id: randomUUID(), started_at: state.session.started_at, ended_at: null });
  await page.getByTestId(`pending-${queued[0]!.op_id}`).getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByTestId(`player-${player.id}`)).toContainText('in $150.00');
  state = await current(page);
  expect(state.entries.filter(entry => entry.kind === 'buy_in')).toHaveLength(3);
  const buys = state.entries.filter(entry => entry.kind === 'buy_in').sort((a, b) => Number(a.revision) - Number(b.revision));
  expect(buys.map(entry => entry.amount_minor)).toEqual(['10000', '2000', '3000']);
  await page.context().setOffline(true);
  await openMoney(page, player.id);
  await typeInput(page.getByTestId('money-amount'), '99');
  await page.getByRole('button', { name: 'Save entry', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Discard', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await page.context().setOffline(false);
  await expect(page.getByText('Not saved yet', { exact: true })).toHaveCount(0);
  expect((await current(page)).entries.filter(entry => entry.kind === 'buy_in')).toHaveLength(3);
});

test.describe('cross-tab acknowledgement', () => {
  test.use({ serviceWorkers: 'block' });

test('signing out in another tab prevents a late acknowledged write from restoring private storage', async ({ page, context }) => {
  const user = await createAccount(page);
  const state = await newSession(page, 'Late acknowledgement');
  const player = await addPlayer(page, 'Justin');
  let release!: () => void;
  let committed = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  let settled!: () => void;
  const completed = new Promise<void>(resolve => { settled = resolve; });
  let heldRequest: Request | undefined;
  await page.route(`**/api/sessions/${state.session.id}/entries`, async route => {
    if (route.request().method() !== 'POST' || heldRequest) { await route.continue(); return; }
    heldRequest = route.request();
    try {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      committed = true;
      await held;
      if (!heldRequest.failure()) await route.fulfill({ response });
    } finally { settled(); }
  });
  await openMoney(page, player.id);
  await typeInput(page.getByTestId('money-amount'), '25');
  await page.getByRole('button', { name: 'Save entry', exact: true }).click();
  await expect.poll(() => committed).toBe(true);
  const other = await context.newPage();
  try {
    await other.goto(`/?session=${state.session.id}`);
    expect((await current(other)).entries.filter(entry => entry.kind === 'buy_in')).toHaveLength(1);
    await other.getByRole('button', { name: 'Players', exact: true }).click();
    await other.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(other.getByLabel('Discard unsent entries and drafts', { exact: true })).toBeVisible();
    await other.getByLabel('Discard unsent entries and drafts', { exact: true }).check();
    const canceled = page.waitForEvent('requestfailed', { predicate: request => request === heldRequest });
    await other.getByRole('button', { name: 'Confirm sign out', exact: true }).click();
    await expect(other.getByLabel('Username', { exact: true })).toBeVisible();
    expect((await canceled).failure()).not.toBeNull();
    release();
    await completed;
    await expect.poll(() => other.evaluate(async bankerId => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const open = indexedDB.open('poker-banker'); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
      const counts: number[] = [];
      for (const store of ['drafts', 'outbox', 'snapshots']) {
        const rows = await new Promise<{ banker_id: string }[]>((resolve, reject) => { const read = db.transaction(store).objectStore(store).getAll(); read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error); });
        counts.push(rows.filter(row => row.banker_id === bankerId).length);
      }
      db.close(); return counts;
    }, user.banker.id)).toEqual([0, 0, 0]);
    await expect(page.getByTestId('saved-confirmation')).toHaveCount(0);
  } finally { release(); await completed; await other.close(); }
});

});
