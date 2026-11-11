import { test, expect } from './fixtures';
import { addPlayer, createAccount, newSession } from './helpers';
import { typeInput } from './input';
import type { Page } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

async function storedAmount(page: Page, key: string) {
  return page.evaluate(async key => {
    const db = await new Promise<IDBDatabase>(resolve => { const opening = indexedDB.open('poker-banker'); opening.onsuccess = () => resolve(opening.result); });
    try { return await new Promise<string | undefined>(resolve => { const reading = db.transaction('drafts').objectStore('drafts').get(key); reading.onsuccess = () => resolve(reading.result?.value?.amount); }); }
    finally { db.close(); }
  }, key);
}

test('recovered typing persists across reload and another tab cannot silently replace it', async ({ page, context }) => {
  const { banker } = await createAccount(page);
  const session = await newSession(page, 'Durable recovered payment');
  const player = await addPlayer(page, 'Recovered payment player');
  const path = `/api/sessions/${session.session.id}/entries`;
  await page.route(`**${path}`, route => route.fulfill({ status: 409, contentType: 'application/json', headers: { 'X-PB-Banker-ID': banker.id }, body: JSON.stringify({ error: { code: 'idempotency_mismatch', message: 'Review the original saved entry' } }) }));
  await page.evaluate(async ({ banker, session, player, path }) => {
    const db = await new Promise<IDBDatabase>(resolve => { const opening = indexedDB.open('poker-banker'); opening.onsuccess = () => resolve(opening.result); });
    const op = crypto.randomUUID(); const transaction = db.transaction('outbox', 'readwrite');
    transaction.objectStore('outbox').put({ banker_id: banker, session_id: session, op_id: op, path, method: 'POST', body: { op_id: op, player_id: player, kind: 'payment_out', amount_minor: '5000', method: 'cash', occurred_at: null }, label: 'Recovered payment', order: 1, status: 'pending', delivery: 'not_sent', attempts: 0, next_attempt_at: 0 });
    await new Promise<void>((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error); }); db.close(); window.dispatchEvent(new Event('pb-data'));
  }, { banker: banker.id, session: session.session.id, player: player.id, path });
  const key = `${banker.id}/${session.session.id}/payment_out/${player.id}`;
  const region = page.getByRole('region', { name: 'Needs review', exact: true });
  await region.getByText('Review recovered edit', { exact: true }).click();
  const other = await context.newPage();
  try {
    await other.goto(`/?session=${session.session.id}`);
    const otherRegion = other.getByRole('region', { name: 'Needs review', exact: true });
    await otherRegion.getByText('Review recovered edit', { exact: true }).click();
    await expect(otherRegion.getByLabel('Amount', { exact: true })).toHaveValue('50.00');
    await typeInput(region.getByLabel('Amount', { exact: true }), '75.00');
    await expect.poll(() => storedAmount(page, key)).toBe('75.00');
    await typeInput(otherRegion.getByLabel('Amount', { exact: true }), '25.00', { expectedValue: '75.00' });
    await expect(otherRegion.getByLabel('Amount', { exact: true })).toHaveValue('75.00');
    await expect(other.getByText(/edited in another tab/i).first()).toBeVisible();
    await expect(otherRegion.getByLabel('Amount', { exact: true })).toBeDisabled();
    await expect(otherRegion.getByRole('button', { name: 'Resubmit recovered draft', exact: true })).toBeDisabled();
    await expect(region.getByLabel('Amount', { exact: true })).toHaveValue('75.00');
    expect(await storedAmount(page, key)).toBe('75.00');
    await page.reload();
    await page.getByRole('region', { name: 'Needs review', exact: true }).getByText('Review recovered edit', { exact: true }).click();
    await expect(page.getByRole('region', { name: 'Needs review', exact: true }).getByLabel('Amount', { exact: true })).toHaveValue('75.00');
    await otherRegion.getByRole('button', { name: 'Review saved draft', exact: true }).click();
    await typeInput(otherRegion.getByLabel('Amount', { exact: true }), '80.00');
    await expect.poll(() => storedAmount(other, key)).toBe('80.00');
    await other.reload();
    await other.getByRole('region', { name: 'Needs review', exact: true }).getByText('Review recovered edit', { exact: true }).click();
    await expect(other.getByRole('region', { name: 'Needs review', exact: true }).getByLabel('Amount', { exact: true })).toHaveValue('80.00');
  } finally { await other.close(); }
});
