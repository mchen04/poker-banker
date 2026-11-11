import { typeInput } from './input';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { addPlayer, createAccount, keepMoneyDraft, newSession, openMoney, password } from './helpers';

async function storedAmount(page: Page, key: string): Promise<string | undefined> {
  return page.evaluate(async key => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('poker-banker');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const draft = await new Promise<{ value: { amount?: string } } | undefined>((resolve, reject) => {
        const request = db.transaction('drafts').objectStore('drafts').get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return draft?.value.amount;
    } finally { db.close(); }
  }, key);
}

async function failDraftWrites(page: Page) {
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      if (this.name === 'drafts') throw new DOMException('Storage quota exceeded', 'QuotaExceededError');
      return key === undefined ? original.call(this, value) : original.call(this, value, key);
    };
    window.addEventListener('retention-storage-recovered', () => { IDBObjectStore.prototype.put = original; }, { once: true });
  });
}

async function failedAmount(page: Page, key: string) {
  const amount = page.getByLabel('Amount', { exact: true });
  await typeInput(amount, '10');
  await expect.poll(() => storedAmount(page, key)).toBe('10');
  await failDraftWrites(page);
  await typeInput(amount, '123');
  await expect(amount).toHaveValue('123');
  await expect(page.getByRole('button', { name: 'Retry saving draft', exact: true })).toBeVisible();
  expect(await storedAmount(page, key)).toBe('10');
}

test.use({ serviceWorkers: 'block' });

test('a failed draft survives closing its sheet and explicit discard clears both versions while quota remains full', async ({ page }) => {
  const account = await createAccount(page);
  const session = await newSession(page, 'Retain the latest typed draft');
  const player = await addPlayer(page, 'Justin');
  const key = `${account.banker.id}/${session.session.id}/buy_in/${player.id}`;
  await openMoney(page, player.id);
  await failedAmount(page, key);
  await keepMoneyDraft(page);
  await openMoney(page, player.id);
  await expect(page.getByLabel('Amount', { exact: true })).toHaveValue('123');
  await expect(page.getByRole('button', { name: 'Retry saving draft', exact: true })).toBeVisible();
  expect(await storedAmount(page, key)).toBe('10');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Discard draft', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(() => storedAmount(page, key)).toBeUndefined();
  await expect(page.getByRole('button', { name: 'Retry saving draft', exact: true })).toHaveCount(0);
  await openMoney(page, player.id);
  await expect(page.getByLabel('Amount', { exact: true })).toHaveValue('');
  expect(await storedAmount(page, key)).toBeUndefined();
});

test('another tab signing out preserves the failed draft through auth reset and signing back in', async ({ page, context }) => {
  const account = await createAccount(page);
  const session = await newSession(page, 'Retain a draft through auth reset');
  const player = await addPlayer(page, 'Justin');
  const key = `${account.banker.id}/${session.session.id}/buy_in/${player.id}`;
  await openMoney(page, player.id);
  await failedAmount(page, key);
  const other = await context.newPage();
  try {
    await other.goto(`/?session=${session.session.id}`);
    await expect(other.getByTestId(`player-${player.id}`)).toBeVisible();
    await other.getByRole('button', { name: 'Players', exact: true }).click();
    await other.getByRole('button', { name: 'Sign out', exact: true }).click();
    await other.getByLabel('Discard unsent entries and drafts', { exact: true }).check();
    await other.getByRole('button', { name: 'Confirm sign out', exact: true }).click();
    await expect(other.getByLabel('Username', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Username', { exact: true })).toBeVisible();
    expect(await storedAmount(page, key)).toBeUndefined();
    await typeInput(page.getByLabel('Username', { exact: true }), account.username);
    await typeInput(page.getByLabel('Password', { exact: true }), password);
    await page.getByRole('button', { name: 'Sign in to workspace', exact: true }).click();
    await expect(page.getByTestId(`player-${player.id}`)).toBeVisible();
    await openMoney(page, player.id);
    await expect(page.getByLabel('Amount', { exact: true })).toHaveValue('123');
    await expect(page.getByRole('button', { name: 'Retry saving draft', exact: true })).toBeVisible();
    expect(await storedAmount(page, key)).toBeUndefined();
    await page.evaluate(() => window.dispatchEvent(new Event('retention-storage-recovered')));
    await page.getByRole('button', { name: 'Retry saving draft', exact: true }).click();
    await expect.poll(() => storedAmount(page, key)).toBe('123');
    await expect(page.getByRole('button', { name: 'Retry saving draft', exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Amount', { exact: true })).toHaveValue('123');
  } finally { await other.close(); }
});
