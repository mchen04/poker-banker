import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { addPlayer, createAccount, current, newSession, openMoney } from './helpers';

test.use({ serviceWorkers: 'block' });

async function storedAmount(page: Page, key: string) {
  return page.evaluate(async key => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open('poker-banker');
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    try {
      return await new Promise<string | undefined>((resolve, reject) => {
        const reading = db.transaction('drafts').objectStore('drafts').get(key);
        reading.onsuccess = () => resolve(reading.result?.value?.amount);
        reading.onerror = () => reject(reading.error);
      });
    } finally { db.close(); }
  }, key);
}

test('a stale money submission refreshes the newer draft from another page before any entry is queued', async ({ page, context }) => {
  const account = await createAccount(page);
  const session = await newSession(page, 'Review newer shared draft');
  const player = await addPlayer(page, 'Shared draft player');
  const key = `${account.banker.id}/${session.session.id}/buy_in/${player.id}`;
  await openMoney(page, player.id);
  await page.getByLabel('Amount', { exact: true }).fill('10');
  await expect.poll(() => storedAmount(page, key)).toBe('10');
  const other = await context.newPage();
  try {
    await other.goto(`/?session=${session.session.id}`);
    await openMoney(other, player.id);
    await expect(other.getByLabel('Amount', { exact: true })).toHaveValue('10');
    await other.getByLabel('Amount', { exact: true }).fill('25');
    await expect.poll(() => storedAmount(other, key)).toBe('25');
    await page.getByRole('button', { name: 'Save entry', exact: true }).click();
    await expect(page.getByLabel('Amount', { exact: true })).toHaveValue('25');
    await expect(page.getByText(/edited in another tab/i).first()).toBeVisible();
    expect((await current(page)).entries).toHaveLength(0);
    expect(await storedAmount(other, key)).toBe('25');
    await page.getByRole('button', { name: 'Save entry', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByTestId('saved-confirmation')).toContainText('25.00');
    const saved = (await current(page)).entries.filter(entry => entry.kind === 'buy_in');
    expect(saved.map(entry => entry.amount_minor)).toEqual(['2500']);
  } finally { await other.close(); }
});

test('a failed edit recovered after another page saves reviews a fresh operation before saving', async ({ page, context }) => {
  const account = await createAccount(page);
  const session = await newSession(page, 'Recovered amount uses a new operation');
  const player = await addPlayer(page, 'Recovered draft player');
  const key = `${account.banker.id}/${session.session.id}/buy_in/${player.id}`;
  await openMoney(page, player.id);
  await page.getByLabel('Amount', { exact: true }).fill('10');
  await expect.poll(() => storedAmount(page, key)).toBe('10');
  const originalOperation = await page.evaluate(async key => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open('poker-banker');
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    try {
      return await new Promise<string>((resolve, reject) => {
        const reading = db.transaction('drafts').objectStore('drafts').get(key);
        reading.onsuccess = () => resolve(reading.result.value.op_id);
        reading.onerror = () => reject(reading.error);
      });
    } finally { db.close(); }
  }, key);
  const other = await context.newPage();
  try {
    await other.goto(`/?session=${session.session.id}`);
    await openMoney(other, player.id);
    await expect(other.getByLabel('Amount', { exact: true })).toHaveValue('10');
    await page.evaluate(() => {
      const original = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
        if (this.name === 'drafts') throw new DOMException('Storage quota exceeded', 'QuotaExceededError');
        return key === undefined ? original.call(this, value) : original.call(this, value, key);
      };
      window.addEventListener('recovered-operation-storage', () => { IDBObjectStore.prototype.put = original; }, { once: true });
    });
    await page.getByLabel('Amount', { exact: true }).fill('50');
    await expect(page.getByText(/not saved on this device/i).first()).toBeVisible();
    await other.getByRole('button', { name: 'Save entry', exact: true }).click();
    await expect(other.getByTestId('saved-confirmation')).toContainText('10.00');
    expect((await current(other)).entries.filter(entry => entry.kind === 'buy_in').map(entry => entry.amount_minor)).toEqual(['1000']);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Keep draft and close', exact: true }).click();
    await page.evaluate(() => window.dispatchEvent(new Event('recovered-operation-storage')));
    await openMoney(page, player.id);
    await expect(page.getByLabel('Amount', { exact: true })).toHaveValue('50');
    await expect(page.getByText(/review/i).first()).toBeVisible();
    expect((await current(page)).entries.filter(entry => entry.kind === 'buy_in').map(entry => entry.amount_minor)).toEqual(['1000']);
    const submitted: string[] = [];
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/sessions/${session.session.id}/entries`) submitted.push(request.postDataJSON().op_id as string);
    });
    await page.getByRole('button', { name: 'Save entry', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByTestId('saved-confirmation')).toContainText('50.00');
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).not.toBe(originalOperation);
    expect((await current(page)).entries.filter(entry => entry.kind === 'buy_in').map(entry => entry.amount_minor)).toEqual(['1000', '5000']);
    await expect(page.getByRole('button', { name: 'Retry saving draft', exact: true })).toHaveCount(0);
    await expect(page.getByText('Not saved yet', { exact: true })).toHaveCount(0);
  } finally { await other.close(); }
});
