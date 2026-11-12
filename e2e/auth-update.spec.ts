import { typeInput } from './input';
import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures';
import { password, workerReady } from './helpers';
import { buildRelease } from './global-setup';

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
    await expect(page.getByRole('button', { name: 'Continue to workspace', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Workspace', exact: true })).toHaveCount(0);
  } finally { await page.evaluate(() => window.dispatchEvent(new Event('release-signup-reply'))).catch(() => {}); }
});
