import { typeInput } from './input';
import type { Page } from '@playwright/test';
import type { OutboxItem } from '../src/client/data';
import { test, expect } from './fixtures';
import { addPlayer, createAccount, keepMoneyDraft, newSession, openMoney, workerReady } from './helpers';
import { buildRelease } from './global-setup';

type Draft = { key: string; banker_id: string; value: { amount?: string } };
type Work = { drafts: Draft[]; outbox: OutboxItem[] };

async function localWork(page: Page): Promise<Work> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('poker-banker');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const read = <T>(store: string) => new Promise<T[]>((resolve, reject) => {
      const request = db.transaction(store).objectStore(store).getAll();
      request.onsuccess = () => resolve(request.result as T[]);
      request.onerror = () => reject(request.error);
    });
    try { return { drafts: await read<Draft>('drafts'), outbox: await read<OutboxItem>('outbox') }; }
    finally { db.close(); }
  });
}

async function addOtherTabWork(page: Page, banker: string, session: string, player: string) {
  await openMoney(page, player);
  await typeInput(page.getByTestId('money-amount'), '123');
  const key = `${banker}/${session}/buy_in/${player}`;
  await expect.poll(async () => (await localWork(page)).drafts.find(draft => draft.key === key)?.value.amount).toBe('123');
  const op = await page.evaluate(async ({ banker, session, player }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('poker-banker');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const op_id = crypto.randomUUID();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction('outbox', 'readwrite');
        transaction.oncomplete = () => resolve();
        transaction.onabort = transaction.onerror = () => reject(transaction.error);
        transaction.objectStore('outbox').put({
          op_id, banker_id: banker, session_id: session, path: `/api/sessions/${session}/entries`, method: 'POST',
          body: { op_id, player_id: player, kind: 'buy_in', amount_minor: '4400', paid_now: false },
          label: 'Buy-in · $44.00', order: Date.now(), status: 'rejected', delivery: 'not_applied',
          attempts: 0, next_attempt_at: 0, error: 'Retry this saved entry',
        } satisfies OutboxItem);
      });
    } finally { db.close(); }
    const channel = new BroadcastChannel('poker-banker');
    channel.postMessage('changed');
    channel.close();
    return op_id;
  }, { banker, session, player });
  return { key, op };
}

async function openCleanSignout(page: Page) {
  await page.getByRole('button', { name: 'Players', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Confirm sign out', exact: true })).toBeEnabled();
  await expect(page.getByLabel('Discard unsent entries and drafts', { exact: true })).toHaveCount(0);
}

test('a quota failure blocks a waiting update until the typed draft is saved and restored', async ({ page }, testInfo) => {
  const releaseA = `durability-A-${testInfo.project.name}`;
  const releaseB = `durability-B-${testInfo.project.name}`;
  await buildRelease(releaseA);
  const account = await createAccount(page);
  const session = await newSession(page, 'Durable update');
  const player = await addPlayer(page, 'Justin');
  await workerReady(page);
  await openMoney(page, player.id);
  const amount = page.getByTestId('money-amount');
  const key = `${account.banker.id}/${session.session.id}/buy_in/${player.id}`;
  await typeInput(amount, '10');
  await expect.poll(async () => (await localWork(page)).drafts.find(draft => draft.key === key)?.value.amount).toBe('10');
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      if (this.name === 'drafts') throw new DOMException('Storage quota exceeded', 'QuotaExceededError');
      return key === undefined ? original.call(this, value) : original.call(this, value, key);
    };
    window.addEventListener('durability-storage-recovered', () => { IDBObjectStore.prototype.put = original; }, { once: true });
  });
  await amount.press('ControlOrMeta+A');
  await amount.press('ArrowLeft');
  await amount.press('ArrowRight');
  await page.keyboard.type('2');
  await expect(page.getByRole('button', { name: 'Retry saving draft', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog').locator('.error').filter({ hasText: 'Not saved on this device' })).toBeVisible();
  await expect(amount).toHaveValue('120');
  await expect(amount).toBeFocused();
  expect(await amount.evaluate(input => [(input as HTMLInputElement).selectionStart, (input as HTMLInputElement).selectionEnd])).toEqual([2, 2]);
  await expect(amount).toBeInViewport({ ratio: 1 });
  const warning = page.getByRole('dialog').getByRole('status').filter({ hasText: 'Not saved on this device.' });
  await expect(warning).toBeVisible();
  await expect(warning).toHaveAttribute('aria-live', 'polite');
  await typeInput(amount, '123');
  await expect(amount).toHaveValue('123');
  expect((await localWork(page)).drafts.find(draft => draft.key === key)?.value.amount).toBe('10');
  await buildRelease(releaseB);
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration('/');
    if (!registration) throw new Error('The local service worker is missing');
    await registration.update();
  });
  await expect.poll(() => page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration('/'))?.waiting)).toBe(true);
  await expect(page.getByTestId('update-reload')).toBeVisible();
  await page.getByTestId('update-reload').click();
  await expect(page.getByText(/not saved on this device/i).first()).toBeVisible();
  await expect(amount).toHaveValue('123');
  await expect(page.locator('meta[name="pb-release"]')).toHaveAttribute('content', releaseA);
  expect((await localWork(page)).drafts.find(draft => draft.key === key)?.value.amount).toBe('10');
  await page.evaluate(() => window.dispatchEvent(new Event('durability-storage-recovered')));
  await page.getByRole('button', { name: /retry saving draft/i }).click();
  await expect.poll(async () => (await localWork(page)).drafts.find(draft => draft.key === key)?.value.amount).toBe('123');
  await Promise.all([page.waitForEvent('domcontentloaded'), page.getByTestId('update-reload').click()]);
  await expect(page.locator('meta[name="pb-release"]')).toHaveAttribute('content', releaseB);
  await openMoney(page, player.id);
  await expect(page.getByTestId('money-amount')).toHaveValue('123');
  expect((await page.request.get('/api/auth/me')).status()).toBe(200);
});

test.describe('sign-out with another tab writing local work', () => {
  test.use({ serviceWorkers: 'block' });

  test('a clean confirmation sheet requires an explicit discard when another tab adds work', async ({ page, context }) => {
    const account = await createAccount(page);
    const session = await newSession(page, 'Work after sign-out opens');
    const player = await addPlayer(page, 'Justin');
    const laterPlayer = await addPlayer(page, 'Riley');
    const other = await context.newPage();
    try {
      await other.goto(`/?session=${session.session.id}`);
      await expect(other.getByTestId(`player-${player.id}`)).toBeVisible();
      await openCleanSignout(page);
      const work = await addOtherTabWork(other, account.banker.id, session.session.id, player.id);
      const discard = page.getByLabel('Discard unsent entries and drafts', { exact: true });
      await expect(discard).toBeVisible();
      await expect(page.getByRole('button', { name: 'Confirm sign out', exact: true })).toBeDisabled();
      const retained = await localWork(page);
      expect(retained.drafts.find(draft => draft.key === work.key)?.value.amount).toBe('123');
      expect(retained.outbox.map(item => item.op_id)).toContain(work.op);
      expect((await page.request.get('/api/auth/me')).status()).toBe(200);
      await discard.check();
      await keepMoneyDraft(other);
      const laterWork = await addOtherTabWork(other, account.banker.id, session.session.id, laterPlayer.id);
      await expect(discard).not.toBeChecked();
      await expect(page.getByRole('button', { name: 'Confirm sign out', exact: true })).toBeDisabled();
      const afterConsent = await localWork(page);
      expect(afterConsent.drafts.find(draft => draft.key === laterWork.key)?.value.amount).toBe('123');
      expect(afterConsent.outbox.map(item => item.op_id)).toContain(laterWork.op);
      await discard.check();
      await page.getByRole('button', { name: 'Confirm sign out', exact: true }).click();
      await expect(page.getByLabel('Username', { exact: true })).toBeVisible();
      const cleared = await localWork(page);
      expect(cleared.drafts.some(draft => draft.key === work.key)).toBe(false);
      expect(cleared.outbox.some(item => item.op_id === work.op)).toBe(false);
      expect(cleared.drafts.some(draft => draft.key === laterWork.key)).toBe(false);
      expect(cleared.outbox.some(item => item.op_id === laterWork.op)).toBe(false);
    } finally { await other.close(); }
  });

  test('work written after confirmation starts survives the final clear without discard consent', async ({ page, context }) => {
    const account = await createAccount(page);
    const session = await newSession(page, 'Work during sign-out');
    const player = await addPlayer(page, 'Justin');
    const other = await context.newPage();
    let release!: () => void;
    let requested!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const logoutRequested = new Promise<void>(resolve => { requested = resolve; });
    await page.route('**/api/auth/logout', async route => {
      requested();
      await held;
      const response = await route.fetch();
      await route.fulfill({ response });
    });
    try {
      await other.goto(`/?session=${session.session.id}`);
      await expect(other.getByTestId(`player-${player.id}`)).toBeVisible();
      await openCleanSignout(page);
      await page.getByRole('button', { name: 'Confirm sign out', exact: true }).click();
      await logoutRequested;
      const work = await addOtherTabWork(other, account.banker.id, session.session.id, player.id);
      const replied = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/logout');
      release();
      await replied;
      await expect(page.getByRole('button', { name: 'Signing out…', exact: true })).toHaveCount(0);
      const retained = await localWork(page);
      expect(retained.drafts.find(draft => draft.key === work.key)?.value.amount).toBe('123');
      expect(retained.outbox.map(item => item.op_id)).toContain(work.op);
    } finally { release(); await other.close(); }
  });
});
