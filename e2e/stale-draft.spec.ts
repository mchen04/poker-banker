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
