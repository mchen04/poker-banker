import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures';
import { password, workerReady } from './helpers';
import { buildRelease } from './global-setup';

test('an update waits for the signup reply and restores its unacknowledged recovery codes', async ({ page }, testInfo) => {
  const releaseA = `signup-A-${testInfo.project.name}`;
  const releaseB = `signup-B-${testInfo.project.name}`;
  buildRelease(releaseA);
  await page.goto('/');
  await workerReady(page);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  buildRelease(releaseB);
  await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration('/'))!.update(); });
  await expect.poll(() => page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration('/'))?.waiting)).toBe(true);
  await page.getByRole('button', { name: 'Sign up', exact: true }).click();
  await page.getByLabel('Username', { exact: true }).fill(`update-${randomUUID().slice(0, 12)}`);
  await page.getByLabel('Password', { exact: true }).fill(password);
  let release!: () => void;
  let committed!: () => void;
  let settled!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const saved = new Promise<void>(resolve => { committed = resolve; });
  const completed = new Promise<void>(resolve => { settled = resolve; });
  await page.route('**/api/auth/signup', async route => {
    try {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      committed();
      await held;
      await route.fulfill({ response });
    } finally { settled(); }
  });
  try {
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
    await saved;
    await expect(page.getByTestId('update-reload')).toBeDisabled();
    release();
    await completed;
    await expect(page.getByTestId('recovery-codes')).toBeVisible();
    const codes = await page.getByTestId('recovery-codes').textContent();
    await expect(page.getByTestId('update-reload')).toBeEnabled();
    await Promise.all([page.waitForEvent('domcontentloaded'), page.getByTestId('update-reload').click()]);
    await expect(page.locator('meta[name="pb-release"]')).toHaveAttribute('content', releaseB);
    await expect(page.getByTestId('recovery-codes')).toHaveText(codes!);
    await expect(page.getByRole('button', { name: 'Continue to workspace', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'New session', exact: true })).toHaveCount(0);
  } finally { release(); await completed; }
});
