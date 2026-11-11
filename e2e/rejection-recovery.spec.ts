import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { addPlayer, call, createAccount, current, newSession, openMoney } from './helpers';
import type { OutboxItem } from '../src/client/data';
import type { SessionState } from '../src/domain/session';

test.use({ serviceWorkers: 'block' });

async function localRecords(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open('poker-banker');
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    const read = <T>(name: string) => new Promise<T[]>((resolve, reject) => {
      const request = db.transaction(name).objectStore(name).getAll();
      request.onsuccess = () => resolve(request.result as T[]);
      request.onerror = () => reject(request.error);
    });
    const drafts = await read<{ key: string; value: { op_id: string; search?: string; __submitted?: unknown } }>('drafts');
    const outbox = await read<OutboxItem>('outbox');
    db.close();
    return { drafts, outbox };
  });
}

for (const recovery of ['same sheet', 'workspace'] as const) {
  test(`a confirmed already-seated replay releases the ${recovery} draft and submits a fresh player selection`, async ({ page }) => {
    await createAccount(page);
    await newSession(page, 'Existing player directory');
    const justin = await addPlayer(page, 'Justin');
    const alex = await addPlayer(page, 'Alex');
    const session = await newSession(page, 'Concurrent seating');
    const path = `/api/sessions/${session.session.id}/players`;
    const bodies: { op_id: string; player_id: string }[] = [];
    let disconnected = true;
    await page.route(`**${path}`, async route => {
      bodies.push(route.request().postDataJSON());
      if (disconnected) await route.abort('failed');
      else await route.continue();
    });
    await page.getByRole('button', { name: 'Add player', exact: true }).click();
    await page.getByLabel('Search players', { exact: true }).fill('Justin');
    await page.getByRole('dialog').getByRole('button', { name: 'Justin', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Check saved result', exact: true })).toBeEnabled();
    const submitted = (await localRecords(page)).drafts.find(draft => draft.key.includes('/add-player/'))!;
    expect(submitted.value.__submitted).toBeDefined();
    expect(submitted.value.search).toBe('Justin');
    await call(page, path.slice(4), 'POST', { op_id: crypto.randomUUID(), player_id: justin.id });
    disconnected = false;
    if (recovery === 'workspace') {
      await page.reload();
      await page.getByRole('button', { name: 'Check saved form: Add player', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Unconfirmed forms', exact: true })).toHaveCount(0);
      await page.getByRole('button', { name: 'Add player', exact: true }).click();
    } else {
      await page.getByRole('button', { name: 'Check saved result', exact: true }).click();
    }
    await expect(page.getByLabel('Search players', { exact: true })).toHaveValue('Justin');
    await expect(page.getByLabel('Search players', { exact: true })).toBeEnabled();
    await expect(page.getByRole('region', { name: 'Unconfirmed forms', exact: true })).toHaveCount(0);
    const editable = (await localRecords(page)).drafts.find(draft => draft.key === submitted.key)!;
    expect(editable.value.__submitted).toBeUndefined();
    expect(editable.value.op_id).not.toBe(submitted.value.op_id);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
    await page.getByLabel('Search players', { exact: true }).fill('Alex');
    await page.getByRole('dialog').getByRole('button', { name: 'Alex', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(bodies).toHaveLength(3);
    expect(bodies[2]!.op_id).not.toBe(bodies[0]!.op_id);
    expect(bodies[2]!.player_id).toBe(alex.id);
    expect((await current(page)).players.map(player => player.id).sort()).toEqual([justin.id, alex.id].sort());
    expect((await localRecords(page)).drafts.some(draft => draft.value.__submitted)).toBe(false);
  });
}

test('a previously uncertain outbox replay confirmed as rejected becomes safely discardable', async ({ page }) => {
  await createAccount(page);
  const session = await newSession(page, 'Rejected outbox replay');
  const player = await addPlayer(page, 'Justin');
  const path = `/api/sessions/${session.session.id}/entries`;
  const bodies: string[] = [];
  let disconnected = true;
  await page.route(`**${path}`, async route => {
    bodies.push(route.request().postData()!);
    if (disconnected) await route.abort('failed');
    else await route.continue();
  });
  await openMoney(page, player.id);
  await page.getByLabel('Amount', { exact: true }).fill('100');
  await page.getByRole('button', { name: 'Save entry', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Check saved entry', exact: true })).toBeEnabled();
  const queued = (await localRecords(page)).outbox[0]!;
  expect(queued.delivery).toBe('uncertain');
  const beforeClose = await current(page);
  await call<SessionState>(page, `/sessions/${session.session.id}/close`, 'POST', { op_id: crypto.randomUUID(), expected_revision: beforeClose.revision, accept_discrepancy_minor: '0' });
  disconnected = false;
  await page.getByRole('button', { name: 'Check saved entry', exact: true }).click();
  await expect(page.getByTestId(`pending-${queued.op_id}`)).toContainText('Reopen this session before writing');
  const rejected = (await localRecords(page)).outbox[0]!;
  expect(rejected.status).toBe('rejected');
  expect(rejected.delivery).toBe('not_applied');
  expect(rejected.attempts).toBeGreaterThan(1);
  expect(new Set(bodies).size).toBe(1);
  expect((await current(page)).entries).toHaveLength(0);
  let confirmation = false;
  page.on('dialog', async dialog => { confirmation = true; await dialog.dismiss(); });
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Unsent entries', exact: true })).toHaveCount(0);
  expect(confirmation).toBe(false);
  expect((await localRecords(page)).outbox).toHaveLength(0);
});

test('a 503 delivered after commit keeps the form frozen until an identical replay confirms one saved session', async ({ page }) => {
  await createAccount(page);
  const bodies: string[] = [];
  let unavailable = true;
  await page.route('**/api/sessions', async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    bodies.push(route.request().postData()!);
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    if (unavailable) await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'unavailable', message: 'Service temporarily unavailable' } }) });
    else await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  await page.getByLabel('Session name', { exact: true }).fill('Committed during delivery failure');
  await page.getByLabel('Location', { exact: true }).fill('Preserved uncertain location');
  await page.getByRole('button', { name: 'Create session', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Check saved result', exact: true })).toBeEnabled();
  const submitted = (await localRecords(page)).drafts.find(draft => draft.value.__submitted)!;
  expect(submitted.value.__submitted).toBeDefined();
  await page.getByRole('button', { name: 'Check saved result', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Service temporarily unavailable');
  await expect(page.getByRole('button', { name: 'Check saved result', exact: true })).toBeEnabled();
  await expect(page.getByLabel('Session name', { exact: true })).toHaveCount(0);
  const retained = (await localRecords(page)).drafts.find(draft => draft.key === submitted.key)!;
  expect(retained.value).toEqual(submitted.value);
  await expect(page.getByRole('region', { name: 'Unconfirmed forms', exact: true })).toBeVisible();
  expect(bodies).toHaveLength(2);
  expect(new Set(bodies).size).toBe(1);
  expect((await call<{ sessions: { name: string }[] }>(page, '/sessions')).sessions.map(session => session.name)).toEqual(['Committed during delivery failure']);
  unavailable = false;
  await page.getByRole('button', { name: 'Check saved result', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Committed during delivery failure', exact: true })).toBeVisible();
  expect(bodies).toHaveLength(3);
  expect(new Set(bodies).size).toBe(1);
  await expect(page.getByRole('region', { name: 'Unconfirmed forms', exact: true })).toHaveCount(0);
  expect((await localRecords(page)).drafts.some(draft => draft.value.__submitted)).toBe(false);
  expect((await call<{ sessions: { name: string }[] }>(page, '/sessions')).sessions).toHaveLength(1);
});
