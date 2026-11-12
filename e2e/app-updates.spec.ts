import { verifyUpdateJourney } from '../scripts/verify-update-journey';
import { createAccount, addPlayer, current, newSession, openMoney, storedDraft, workerReady, password } from './helpers';
import { test, expect } from './fixtures';
import { buildRelease } from './global-setup';
import { typeInput } from './input';
import { randomUUID } from 'node:crypto';
import { verifyUpdateReviewCases } from '../scripts/verify-update-review';

test.describe("Automatic adoption", () => {
  test('automatic release adoption preserves previous clients, drafts, offline writes and live old tabs', async ({ page, browser, baseURL }, info) => {
    test.setTimeout(900000);
    if (!baseURL) throw new Error('The owned local TLS server is required');
    await createAccount(page);
    if (process.env.PB_UPDATE_REVIEW_MODE || process.env.PB_UPDATE_REVIEW_CASES) {
      const result = await verifyUpdateReviewCases({ page, browser, baseURL, evidence: info.outputPath('update-review'), tag: info.project.name });
      expect(result?.errors).toEqual([]);
      expect(result?.rows).toHaveLength(process.env.PB_UPDATE_REVIEW_CASES?.split(',').length ?? 7);
      return;
    }
    const result = await verifyUpdateJourney({ page, browser, baseURL, evidence: info.outputPath('automatic-updates'), tag: info.project.name });
    expect(result?.table).toHaveLength(5);
    expect(result?.compatibility.previousSource).toMatch(/^dc2082b/);
    expect(result?.review?.rows).toHaveLength(7);
    expect(result?.review?.errors).toEqual([]);
  });
});

test.describe("Manual activation intent", () => {
  test('a manual update keeps progressing when its first activation message leaves the worker waiting', async ({ page }, info) => {
    const releaseA = `intent-A-${info.project.name}`;
    const releaseB = `intent-B-${info.project.name}`;
    await buildRelease(releaseA);
    const account = await createAccount(page);
    const session = await newSession(page, 'Pending manual update');
    const player = await addPlayer(page, 'Justin');
    await workerReady(page);
    await openMoney(page, player.id);
    await typeInput(page.getByTestId('money-amount'), '123');
    const key = `${account.banker.id}/${session.session.id}/buy_in/${player.id}`;
    await expect.poll(async () => (await storedDraft<{ amount: string }>(page, key))?.amount).toBe('123');
    await buildRelease(releaseB);
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration('/');
      if (!registration) throw new Error('The local service worker is missing');
      await registration.update();
      const original = ServiceWorker.prototype.postMessage;
      ServiceWorker.prototype.postMessage = function (message: unknown) {
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
});

test.describe("Pending signup", () => {
  test('an update waits for the signup reply and restores its unacknowledged recovery codes', async ({ page }, testInfo) => {
    const releaseA = `signup-A-${testInfo.project.name}`;
    const releaseB = `signup-B-${testInfo.project.name}`;
    await buildRelease(releaseA);
    await page.goto('/');
    await workerReady(page);
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    await buildRelease(releaseB);
    await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration('/'))!.update(); });
    await expect.poll(() => page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration('/'))?.waiting)).toBe(true);
    await page.getByRole('button', { name: 'Sign up', exact: true }).click();
    await typeInput(page.getByLabel('Username', { exact: true }), `update-${randomUUID().slice(0, 12)}`);
    await typeInput(page.getByLabel('Password', { exact: true }), password);
    await page.evaluate(() => {
      const original = window.fetch.bind(window);
      const held = new Promise<void>(resolve => window.addEventListener('release-signup-reply', () => resolve(), { once: true }));
      window.fetch = async (...args: Parameters<typeof fetch>) => {
        const response = await original(...args);
        const input = args[0];
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
        if (url.pathname === '/api/auth/signup') {
          if (response.status !== 200) throw new Error('Signup failed before the reply could be held');
          await response.clone().json();
          document.documentElement.setAttribute('data-signup-reply-held', 'true');
          await held;
        }
        return response;
      };
    });
    try {
      await page.getByRole('button', { name: 'Create account', exact: true }).click();
      await expect(page.locator('html')).toHaveAttribute('data-signup-reply-held', 'true');
      await expect(page.getByTestId('update-reload')).toBeDisabled();
      await page.evaluate(() => window.dispatchEvent(new Event('release-signup-reply')));
      await expect(page.getByTestId('recovery-codes')).toBeVisible();
      const codes = await page.getByTestId('recovery-codes').textContent();
      await expect(page.getByTestId('update-reload')).toBeEnabled();
      await Promise.all([page.waitForEvent('domcontentloaded'), page.getByTestId('update-reload').click()]);
      await expect(page.locator('meta[name="pb-release"]')).toHaveAttribute('content', releaseB);
      await expect(page.getByTestId('recovery-codes')).toHaveText(codes!);
      await expect(page.getByRole('button', { name: 'Continue to table', exact: true })).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Table', exact: true })).toHaveCount(0);
    } finally { await page.evaluate(() => window.dispatchEvent(new Event('release-signup-reply'))).catch(() => {}); }
  });
});
