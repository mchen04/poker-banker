import { typeInput } from './input';
import { test, expect, screen } from './fixtures';
import { addPlayer, createAccount, current, newSession, openMoney, workerReady } from './helpers';
import { buildRelease } from './global-setup';
import type { Page } from '@playwright/test';

async function version(page: Page) {
  return page.evaluate(async () => {
    const worker = navigator.serviceWorker.controller;
    if (!worker) return null;
    return new Promise<string>((resolve, reject) => {
      const channel = new MessageChannel();
      const timeout = setTimeout(() => reject(new Error('Worker did not answer version')), 5000);
      channel.port1.onmessage = event => { clearTimeout(timeout); resolve(event.data.version); };
      worker.postMessage({ type: 'GET_VERSION' }, [channel.port2]);
    });
  });
}

test('waiting release update after hidden and visible preserves auth, drafts and open session', async ({ page }, testInfo) => {
  test.setTimeout(120000);
  const releaseA = `e2e-A-${testInfo.project.name}`;
  const releaseB = `e2e-B-${testInfo.project.name}`;
  await buildRelease(releaseA);
  const user = await createAccount(page);
  const state = await newSession(page, 'Survives update');
  const player = await addPlayer(page, 'Justin');
  await workerReady(page);
  await expect.poll(() => version(page)).toBe(releaseA);
  await openMoney(page, player.id);
  await typeInput(page.getByTestId('money-amount'), '37.');
  await page.getByRole('group', { name: 'Payment method', exact: true }).getByRole('button', { name: 'Venmo', exact: true }).click();
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await buildRelease(releaseB);
  await page.evaluate(async () => { const registration = await navigator.serviceWorker.getRegistration('/'); if (!registration) throw new Error('Local service worker registration disappeared'); await registration.update(); });
  await expect.poll(() => page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration('/'))?.waiting)).toBe(true);
  expect(await version(page)).toBe(releaseA);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.getByText('Update ready', { exact: true })).toBeVisible();
  await screen(page, testInfo, 'update-ready');
  await Promise.all([page.waitForEvent('domcontentloaded'), page.getByTestId('update-reload').click()]);
  await expect.poll(() => version(page)).toBe(releaseB);
  await expect(page.locator('meta[name="pb-release"]')).toHaveAttribute('content', releaseB);
  await expect(page.getByRole('heading', { name: 'Survives update', exact: true })).toBeVisible();
  await openMoney(page, player.id);
  await expect(page.getByTestId('money-amount')).toHaveValue('37.');
  await expect(page.getByRole('group', { name: 'Payment method', exact: true }).getByRole('button', { name: 'Venmo', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect((await current(page)).session.id).toBe(state.session.id);
  expect((await page.request.get('/api/auth/me')).status()).toBe(200);
  const me = await (await page.request.get('/api/auth/me')).json() as { banker: { id: string } };
  expect(me.banker.id).toBe(user.banker.id);
  await screen(page, testInfo, 'updated-draft');
});
