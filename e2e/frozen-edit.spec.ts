import { typeInput } from './input';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { createAccount, current, newSession } from './helpers';

test.use({ serviceWorkers: 'block' });

async function storedPlayerDraft(page: Page, key: string) {
  return page.evaluate(async key => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open('poker-banker');
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    try {
      return await new Promise<{ value: { op_id: string; search: string; __submitted?: unknown } } | undefined>((resolve, reject) => {
        const reading = db.transaction('drafts').objectStore('drafts').get(key);
        reading.onsuccess = () => resolve(reading.result);
        reading.onerror = () => reject(reading.error);
      });
    } finally { db.close(); }
  }, key);
}

test('an open tab retains its later player draft while another tab confirms the frozen request', async ({ page, context }) => {
  const account = await createAccount(page);
  const session = await newSession(page, 'Cross-tab player draft');
  const key = `${account.banker.id}/${session.session.id}/add-player/`;
  await page.getByRole('button', { name: 'Add player', exact: true }).click();
  await typeInput(page.getByLabel('Search players', { exact: true }), 'Justin');
  await expect.poll(async () => (await storedPlayerDraft(page, key))?.value.search).toBe('Justin');
  const other = await context.newPage();
  let release!: () => void;
  let requested!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const submitted = new Promise<void>(resolve => { requested = resolve; });
  const bodies: { op_id: string; new_player_name: string }[] = [];
  await context.route(`**/api/sessions/${session.session.id}/players`, async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    bodies.push(route.request().postDataJSON());
    if (bodies.length === 1) { requested(); await held; }
    const response = await route.fetch();
    await route.fulfill({ response });
  });
  try {
    await other.goto(`/?session=${session.session.id}`);
    await other.getByRole('button', { name: 'Add player', exact: true }).click();
    await expect(other.getByLabel('Search players', { exact: true })).toHaveValue('Justin');
    await page.getByRole('button', { name: "Add 'Justin' as new", exact: true }).click();
    await submitted;
    await typeInput(other.getByLabel('Search players', { exact: true }), 'Alex');
    await expect(other.getByText(/submitted.*another tab|submitted elsewhere/i).first()).toBeVisible();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.new_player_name).toBe('Justin');
    release();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByText(/edited in another tab/i).first()).toBeVisible();
    const check = page.getByRole('button', { name: 'Check saved result', exact: true });
    await expect(check).toBeEnabled();
    expect((await current(page)).players.map(player => player.display_name)).toEqual(['Justin']);
    await check.click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
    await expect.poll(async () => (await storedPlayerDraft(other, key))?.value.search).toBe('Alex');
    const retained = (await storedPlayerDraft(other, key))!.value;
    expect(retained.op_id).not.toBe(bodies[0]!.op_id);
    expect(retained.__submitted).toBeUndefined();
    await other.reload();
    await other.getByRole('button', { name: 'Add player', exact: true }).click();
    await expect(other.getByLabel('Search players', { exact: true })).toHaveValue('Alex');
    await other.getByRole('button', { name: "Add 'Alex' as new", exact: true }).click();
    await expect(other.getByRole('dialog')).toHaveCount(0);
    expect(bodies).toHaveLength(3);
    expect(bodies[0]!.new_player_name).toBe('Justin');
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]!.new_player_name).toBe('Alex');
    expect(bodies[2]!.op_id).not.toBe(bodies[0]!.op_id);
    expect((await current(other)).players.map(player => player.display_name).sort()).toEqual(['Alex', 'Justin']);
  } finally { release(); await other.close(); }
});
