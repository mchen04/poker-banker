import { test, expect } from './fixtures';
import { addPlayer, createAccount, current, newSession, openMoney } from './helpers';

test('offline entries retain their two-hour submission interval when replayed together', async ({ page, context }) => {
  await page.clock.install({ time: new Date() });
  await createAccount(page); await newSession(page, 'Offline occurrence');
  const player = await addPlayer(page, 'Justin');
  await expect.poll(async () => page.evaluate(async () => {
    const response = await fetch(`/api/sessions/${new URL(location.href).searchParams.get('session')}`, { cache: 'no-store' });
    return response.ok;
  })).toBe(true);
  await context.setOffline(true);
  await openMoney(page, player.id); await page.getByLabel('Amount', { exact: true }).fill('100');
  await page.getByRole('button', { name: 'Save entry', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.clock.fastForward(7200000);
  await openMoney(page, player.id, 'Cash out'); await page.getByLabel('Amount', { exact: true }).fill('150');
  await page.getByRole('button', { name: 'Save entry', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const times = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('poker-banker'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    return new Promise<(string | null)[]>((resolve, reject) => { const request = db.transaction('outbox').objectStore('outbox').getAll(); request.onsuccess = () => { const rows = request.result.sort((a, b) => a.order - b.order); db.close(); resolve(rows.map(row => row.body.occurred_at)); }; request.onerror = () => reject(request.error); });
  });
  expect(times).toHaveLength(2); expect(typeof times[0]).toBe('string'); expect(typeof times[1]).toBe('string');
  const elapsed = Date.parse(times[1]!) - Date.parse(times[0]!);
  expect(elapsed).toBeGreaterThanOrEqual(7200000); expect(elapsed).toBeLessThan(7202000);
  await context.setOffline(false); await page.clock.resume();
  await expect.poll(async () => (await current(page)).players[0]!.duration_ms).toBe(String(elapsed));
  const saved = await current(page);
  expect(saved.entries.filter(entry => entry.kind === 'buy_in')).toHaveLength(1);
  expect(saved.entries.filter(entry => entry.kind === 'cash_out')).toHaveLength(1);
  expect(saved.players[0]).toMatchObject({ state: 'cashed_out', result_minor: '5000', duration_ms: String(elapsed) });
});
