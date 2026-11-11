import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { call, password } from './helpers';

test.use({ serviceWorkers: 'block' });

async function recoveryDraft(page: Page, key: string) {
  return page.evaluate(async key => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open('poker-banker');
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    try {
      return await new Promise<{ value: { codes: string[] } } | undefined>((resolve, reject) => {
        const reading = db.transaction('drafts').objectStore('drafts').get(key);
        reading.onsuccess = () => resolve(reading.result);
        reading.onerror = () => reject(reading.error);
      });
    } finally { db.close(); }
  }, key);
}

for (const failure of ['draft quota', 'restoration marker'] as const) {
  test(`signup displays and restores recovery codes after a failed ${failure} write`, async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Sign up', exact: true }).click();
    await page.getByLabel('Username', { exact: true }).fill(`codes-${randomUUID().slice(0, 12)}`);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.evaluate(failure => {
      if (failure === 'draft quota') {
        const original = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
          if (this.name === 'drafts') throw new DOMException('Storage quota exceeded', 'QuotaExceededError');
          return key === undefined ? original.call(this, value) : original.call(this, value, key);
        };
        window.addEventListener('codes-storage-recovered', () => { IDBObjectStore.prototype.put = original; }, { once: true });
      } else {
        const original = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key: string, value: string) {
          if (key === 'pb-pending-codes') throw new DOMException('Storage quota exceeded', 'QuotaExceededError');
          original.call(this, key, value);
        };
        window.addEventListener('codes-storage-recovered', () => { Storage.prototype.setItem = original; }, { once: true });
      }
    }, failure);
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
    await expect(page.getByTestId('recovery-codes')).toBeVisible();
    const codes = (await page.getByTestId('recovery-codes').textContent())!.match(/[a-f0-9]{8}(?:-[a-f0-9]{8}){3}/g)!;
    expect(codes).toHaveLength(10);
    const proceed = page.getByRole('button', { name: 'Continue to workspace', exact: true });
    await expect(proceed).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Retry saving draft', exact: true })).toBeVisible();
    const { banker } = await call<{ banker: { id: string } }>(page, '/auth/me');
    const key = `${banker.id}/account/recovery-codes/`;
    await page.evaluate(() => window.dispatchEvent(new Event('codes-storage-recovered')));
    await page.getByRole('button', { name: 'Retry saving draft', exact: true }).click();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('pb-pending-codes'))).toBe(key);
    await expect.poll(async () => (await recoveryDraft(page, key))?.value.codes).toEqual(codes);
    await page.reload();
    await expect(page.getByTestId('recovery-codes')).toBeVisible();
    expect((await page.getByTestId('recovery-codes').textContent())!.match(/[a-f0-9]{8}(?:-[a-f0-9]{8}){3}/g)).toEqual(codes);
    await expect(page.getByRole('button', { name: 'New session', exact: true })).toHaveCount(0);
    await expect(proceed).toBeDisabled();
    await page.getByLabel('I saved these codes', { exact: true }).check();
    await proceed.click();
    await expect(page.getByRole('button', { name: 'New session', exact: true })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('pb-pending-codes'))).toBeNull();
    expect(await recoveryDraft(page, key)).toBeUndefined();
  });
}

test('recovery-code restoration requires a successful owner draft read even when its marker is missing', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign up', exact: true }).click();
  await page.getByLabel('Username', { exact: true }).fill(`restore-${randomUUID().slice(0, 12)}`);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByTestId('recovery-codes')).toBeVisible();
  const codes = (await page.getByTestId('recovery-codes').textContent())!;
  const { banker } = await call<{ banker: { id: string } }>(page, '/auth/me');
  const key = `${banker.id}/account/recovery-codes/`;
  await expect.poll(async () => (await recoveryDraft(page, key))?.value.codes.join('')).toBe(codes);
  await page.evaluate(() => localStorage.removeItem('pb-pending-codes'));
  await page.addInitScript(() => {
    const original = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (key: IDBValidKey | IDBKeyRange) {
      if (this.name === 'drafts' && typeof key === 'string' && key.endsWith('/account/recovery-codes/')) throw new DOMException('Local storage read failed', 'UnknownError');
      return original.call(this, key);
    };
    window.addEventListener('recovery-read-restored', () => { IDBObjectStore.prototype.get = original; }, { once: true });
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Restore your recovery codes', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New session', exact: true })).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event('recovery-read-restored')));
  await page.getByRole('button', { name: 'Retry restoring recovery codes', exact: true }).click();
  await expect(page.getByTestId('recovery-codes')).toHaveText(codes);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('pb-pending-codes'))).toBe(key);
  await expect(page.getByRole('button', { name: 'Continue to workspace', exact: true })).toBeDisabled();
  await page.getByLabel('I saved these codes', { exact: true }).check();
  await page.getByRole('button', { name: 'Continue to workspace', exact: true }).click();
  await expect(page.getByRole('button', { name: 'New session', exact: true })).toBeVisible();
});
