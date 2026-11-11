import { typeInput } from './input';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { addPlayer, call, createAccount, current, newSession, openMoney } from './helpers';

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
  await typeInput(page.getByLabel('Amount', { exact: true }), '10');
  await expect.poll(() => storedAmount(page, key)).toBe('10');
  const other = await context.newPage();
  try {
    await other.goto(`/?session=${session.session.id}`);
    await openMoney(other, player.id);
    await expect(other.getByLabel('Amount', { exact: true })).toHaveValue('10');
    await typeInput(other.getByLabel('Amount', { exact: true }), '25');
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
  await typeInput(page.getByLabel('Amount', { exact: true }), '10');
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
    await typeInput(page.getByLabel('Amount', { exact: true }), '50');
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
    expect((await current(page)).entries.filter(entry => entry.kind === 'buy_in').map(entry => entry.amount_minor).sort()).toEqual(['1000', '5000']);
    await expect(page.getByRole('button', { name: 'Retry saving draft', exact: true })).toHaveCount(0);
    await expect(page.getByText('Not saved yet', { exact: true })).toHaveCount(0);
  } finally { await other.close(); }
});

test('a mismatched entry and a newer saved draft both remain reviewable and preserve the submitted time', async ({ page, context }) => {
  const account = await createAccount(page);
  const session = await newSession(page, 'Review both recovered amounts');
  const player = await addPlayer(page, 'Two retained versions');
  const key = `${account.banker.id}/${session.session.id}/buy_in/${player.id}`;
  await openMoney(page, player.id);
  await typeInput(page.getByLabel('Amount', { exact: true }), '50');
  await page.getByLabel('Paid now', { exact: true }).uncheck();
  await expect.poll(() => storedAmount(page, key)).toBe('50');
  const operation = await page.evaluate(async key => {
    const opening = indexedDB.open('poker-banker');
    const db = await new Promise<IDBDatabase>((resolve, reject) => { opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error); });
    try {
      return await new Promise<string>((resolve, reject) => { const read = db.transaction('drafts').objectStore('drafts').get(key); read.onsuccess = () => resolve(read.result.value.op_id); read.onerror = () => reject(read.error); });
    } finally { db.close(); }
  }, key);
  await call(page, `/sessions/${session.session.id}/entries`, 'POST', { op_id: operation, player_id: player.id, kind: 'buy_in', amount_minor: '1000', paid_now: false, occurred_at: null });
  let arrived!: () => void;
  let release!: () => void;
  const sent = new Promise<void>(resolve => { arrived = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let submittedTime: unknown;
  await page.route(`**/api/sessions/${session.session.id}/entries`, async route => {
    if (route.request().method() !== 'POST' || route.request().postDataJSON().op_id !== operation) { await route.continue(); return; }
    submittedTime = route.request().postDataJSON().occurred_at;
    const response = await route.fetch();
    expect(response.status()).toBe(409);
    arrived(); await held;
    await route.fulfill({ response });
  });
  const other = await context.newPage();
  try {
    await page.getByRole('button', { name: 'Save entry', exact: true }).click();
    await sent;
    await other.goto(`/?session=${session.session.id}`);
    await openMoney(other, player.id);
    await typeInput(other.getByLabel('Amount', { exact: true }), '25');
    await expect.poll(() => storedAmount(other, key)).toBe('25');
    release();
    const recovery = page.getByTestId('recovered-draft');
    await recovery.getByText('Review recovered edit', { exact: true }).click();
    await expect(recovery.locator('dl').nth(0)).toContainText('25');
    await expect(recovery.locator('dl').nth(1)).toContainText('50');
    expect(await storedAmount(other, key)).toBe('25');
    expect((await current(page)).entries.filter(entry => entry.kind === 'buy_in').map(entry => entry.amount_minor)).toEqual(['1000']);
    await recovery.getByRole('button', { name: 'Use recovered edit', exact: true }).click();
    await expect(recovery).toHaveCount(0);
    await openMoney(page, player.id);
    await expect(page.getByLabel('Amount', { exact: true })).toHaveValue('50');
    const saved = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === `/api/sessions/${session.session.id}/entries` && request.postDataJSON().op_id !== operation);
    await page.getByRole('button', { name: 'Save entry', exact: true }).click();
    const body = (await saved).postDataJSON();
    expect(body.occurred_at).toBe(submittedTime);
    expect(body.op_id).not.toBe(operation);
    await expect(page.getByTestId('saved-confirmation')).toContainText('50.00');
    expect((await current(page)).entries.filter(entry => entry.kind === 'buy_in').map(entry => entry.amount_minor).sort()).toEqual(['1000', '5000']);
    await expect(page.getByText('Not saved yet', { exact: true })).toHaveCount(0);
  } finally { release(); await other.close(); }
});
