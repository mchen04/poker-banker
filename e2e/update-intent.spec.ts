import { test, expect } from './fixtures';
import { typeInput } from './input';
import { addPlayer, createAccount, current, newSession, openMoney, storedDraft, workerReady } from './helpers';
import { buildRelease } from './global-setup';

test('a manual update keeps progressing when its first activation message leaves the worker waiting', async ({ page }, info) => {
  const releaseA = `intent-A-${info.project.name}`;
  const releaseB = `intent-B-${info.project.name}`;
  buildRelease(releaseA);
  const account = await createAccount(page);
  const session = await newSession(page, 'Pending manual update');
  const player = await addPlayer(page, 'Justin');
  await workerReady(page);
  await openMoney(page, player.id);
  await typeInput(page.getByTestId('money-amount'), '123');
  const key = `${account.banker.id}/${session.session.id}/buy_in/${player.id}`;
  await expect.poll(async () => (await storedDraft<{ amount: string }>(page, key))?.amount).toBe('123');
  buildRelease(releaseB);
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration('/');
    if (!registration) throw new Error('The local service worker is missing');
    await registration.update();
    const original = ServiceWorker.prototype.postMessage;
    ServiceWorker.prototype.postMessage = function (message: unknown, options?: StructuredSerializeOptions | Transferable[]) {
      if ((message as { type?: string })?.type === 'ACTIVATE') {
        const attempts = Number(sessionStorage.getItem('test-activation-attempts') ?? '0') + 1;
        sessionStorage.setItem('test-activation-attempts', String(attempts));
        if (attempts === 1) return;
      }
      Reflect.apply(original, this, arguments);
    };
  });
  await expect(page.getByTestId('update-reload')).toBeVisible();
  await Promise.all([page.waitForEvent('domcontentloaded'), page.getByTestId('update-reload').click()]);
  await expect(page.locator('meta[name="pb-release"]')).toHaveAttribute('content', releaseB);
  expect(await page.evaluate(() => Number(sessionStorage.getItem('test-activation-attempts')))).toBeGreaterThanOrEqual(2);
  await expect.poll(() => page.evaluate(async () => {
    const worker = navigator.serviceWorker.controller;
    if (!worker) return null;
    return new Promise<string>(resolve => {
      const channel = new MessageChannel();
      channel.port1.onmessage = event => { channel.port1.close(); resolve(event.data.version); };
      worker.postMessage({ type: 'GET_VERSION' }, [channel.port2]);
    });
  })).toBe(releaseB);
  await openMoney(page, player.id);
  await expect(page.getByTestId('money-amount')).toHaveValue('123');
  expect((await current(page)).entries).toEqual([]);
  expect((await page.request.get('/api/auth/me')).status()).toBe(200);
});
