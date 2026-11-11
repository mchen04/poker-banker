import { test, expect } from './fixtures';

test('a first worker install during the sign-up gesture does not move or reset account access', async ({ page }) => {
  await page.addInitScript(() => {
    const worker = Object.assign(new EventTarget(), { state: 'installing', postMessage() {} });
    const registration = Object.assign(new EventTarget(), { installing: worker as typeof worker | null, waiting: null as typeof worker | null, active: null as typeof worker | null, async update() {} });
    const container = Object.assign(new EventTarget(), { controller: null as typeof worker | null, async register() { return registration; } });
    Object.defineProperty(navigator, 'serviceWorker', { value: container });
    document.addEventListener('pointerdown', event => {
      if ((event.target as HTMLElement).textContent !== 'Sign up') return;
      registration.installing = null;
      registration.waiting = worker;
      worker.state = 'installed';
      worker.dispatchEvent(new Event('statechange'));
    }, { once: true, capture: true });
  });
  await page.goto('/');
  const signup = page.getByRole('button', { name: 'Sign up', exact: true });
  await expect(signup).toBeVisible();
  const before = (await signup.boundingBox())!;
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  await page.mouse.down();
  const during = await signup.evaluate(button => ({ y: button.getBoundingClientRect().y, banner: !!document.querySelector('.update-banner') }));
  await page.mouse.up();
  expect(during).toEqual({ y: before.y, banner: false });
  await expect(signup).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('heading', { name: 'Make room for game night', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create account', exact: true })).toBeVisible();
});
