import { test, expect } from './fixtures';
import { addPlayer, call, createAccount, current, newSession, openMoney } from './helpers';

test.use({ serviceWorkers: 'block' });

for (const failure of ['connection', 413] as const) {
  test(`a ${failure} failure after commit remains uncertain and replays the original operation once`, async ({ page }) => {
    await createAccount(page);
    const session = await newSession(page, 'Lost acknowledgement');
    const player = await addPlayer(page, 'Justin');
    const bodies: string[] = [];
    let committed!: () => void;
    const firstCommit = new Promise<void>(resolve => { committed = resolve; });
    await page.route(`**/api/sessions/${session.session.id}/entries`, async route => {
      bodies.push(route.request().postData()!);
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      if (failure === 'connection') await route.abort('failed');
      else await route.fulfill({ status: failure, contentType: 'application/json', body: JSON.stringify({ error: { code: 'invalid_request', message: 'Untrusted platform rejection' } }) });
      committed();
    });
    await openMoney(page, player.id);
    await page.getByLabel('Amount', { exact: true }).fill('100');
    await page.getByRole('button', { name: 'Save entry', exact: true }).click();
    await firstCommit;
    await expect(page.getByRole('button', { name: 'Check saved entry', exact: true })).toBeVisible();
    expect((await current(page)).entries.filter(entry => entry.kind === 'buy_in')).toHaveLength(1);
    page.once('dialog', dialog => { expect(dialog.message()).toContain('may already exist on the server'); void dialog.dismiss(); });
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Check saved entry', exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Check saved entry', exact: true })).toBeVisible();
    await page.unroute(`**/api/sessions/${session.session.id}/entries`);
    await page.route(`**/api/sessions/${session.session.id}/entries`, async route => { bodies.push(route.request().postData()!); await route.continue(); });
    await page.getByRole('button', { name: 'Check saved entry', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Check saved entry', exact: true })).toHaveCount(0);
    expect(bodies.length).toBeGreaterThan(1);
    expect(new Set(bodies).size).toBe(1);
    expect((await current(page)).entries.filter(entry => entry.kind === 'buy_in')).toHaveLength(1);
  });
}

test('a migrated version-one attempted operation cannot be silently discarded', async ({ page }) => {
  const account = await createAccount(page);
  const session = await newSession(page, 'Migrated acknowledgement');
  const player = await addPlayer(page, 'Justin');
  const op = crypto.randomUUID();
  const body = { op_id: op, player_id: player.id, kind: 'buy_in', amount_minor: '10000', paid_now: false };
  const path = `/api/sessions/${session.session.id}/entries`;
  await call(page, path.slice(4), 'POST', body);
  await page.goto('/manifest.webmanifest');
  await page.evaluate(async ({ banker, session, op, path, body }) => {
    await new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase('poker-banker'); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); });
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('poker-banker', 1);
      request.onupgradeneeded = () => { request.result.createObjectStore('drafts', { keyPath: 'key' }); request.result.createObjectStore('outbox', { keyPath: 'op_id' }); request.result.createObjectStore('snapshots', { keyPath: 'key' }); };
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction('outbox', 'readwrite');
    transaction.objectStore('outbox').put({ op_id: op, banker_id: banker, session_id: session, path, method: 'POST', body, label: 'Migrated buy-in', order: 1, status: 'pending', attempts: 1, next_attempt_at: 0 });
    await new Promise<void>((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); });
    database.close();
  }, { banker: account.banker.id, session: session.session.id, op, path, body });
  await page.addInitScript(() => Object.defineProperty(navigator, 'onLine', { get: () => false }));
  await page.goto(`/?session=${session.session.id}`);
  await expect(page.getByRole('button', { name: 'Check saved entry', exact: true })).toBeVisible();
  page.once('dialog', dialog => { expect(dialog.message()).toContain('may already exist'); void dialog.dismiss(); });
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(page.getByTestId(`pending-${op}`)).toBeVisible();
});
