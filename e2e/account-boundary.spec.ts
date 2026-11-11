import type { Page, Request } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { test, expect } from './fixtures';
import { addPlayer, call, createAccount, current, newSession, password } from './helpers';
import type { OutboxItem } from '../src/client/data';
import type { SessionState } from '../src/domain/session';

test.use({ serviceWorkers: 'block' });

type ProbeWindow = Window & { boundary: { data: typeof import('../src/client/data'); secondary?: typeof import('../src/client/data'); first?: Promise<string>; second?: Promise<string>; stop?: () => void; saved: number; changes: number } };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function records(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('poker-banker');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const read = <T>(name: string) => new Promise<T[]>((resolve, reject) => {
      const request = db.transaction(name).objectStore(name).getAll();
      request.onsuccess = () => resolve(request.result as T[]);
      request.onerror = () => reject(request.error);
    });
    const drafts = await read<{ key: string; value: { op_id: string; search?: string; __submitted?: unknown }; kind?: string }>('drafts');
    const outbox = await read<OutboxItem>('outbox');
    const snapshots = await read<{ key: string; state: SessionState }>('snapshots');
    db.close();
    return { drafts, outbox, snapshots };
  });
}

async function accounts(page: Page) {
  const a = await createAccount(page);
  const aCookies = await page.context().cookies();
  const origin = new URL(page.url()).origin;
  const response = await page.request.post('/api/auth/signup', { headers: { origin }, data: { username: `boundary-${crypto.randomUUID().slice(0, 12)}`, password } });
  expect(response.status()).toBe(200);
  const b = await response.json() as { banker: { id: string; username: string } };
  const bCookies = await page.context().cookies();
  await page.context().addCookies(aCookies);
  return { a, b, aCookies, bCookies };
}

async function probe(page: Page) {
  const source = await readFile('src/client/data.ts', 'utf8');
  const compile = (value: string) => ts.transpileModule(value, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  for (const match of source.matchAll(/from ['"](\.\/[^'"]+)['"]/g)) {
    const name = match[1]!.slice(2);
    const dependency = await readFile(`src/client/${name}.ts`, 'utf8');
    await page.route(`**/${name}`, route => route.fulfill({ contentType: 'text/javascript', body: compile(dependency) }));
  }
  await page.route('**/account-probe.js', route => route.fulfill({ contentType: 'text/javascript', body: compile(source) }));
  await page.route('**/account-probe-second.js', route => route.fulfill({ contentType: 'text/javascript', body: compile(source) }));
  await page.route('**/account-probe.html', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Account boundary probe</title>' }));
  await page.goto('/account-probe.html');
  await page.evaluate(async () => {
    const modulePath = '/account-probe.js';
    (window as unknown as ProbeWindow).boundary = { data: await import(modulePath) as typeof import('../src/client/data'), saved: 0, changes: 0 };
  });
}

async function start(page: Page, banker: string) {
  await page.evaluate(id => {
    const p = (window as unknown as ProbeWindow).boundary;
    p.stop = p.data.syncOutbox(id, () => { p.saved++; }, () => { p.changes++; });
  }, banker);
}

async function stop(page: Page) {
  await page.evaluate(() => (window as unknown as ProbeWindow).boundary.stop?.());
}

test('a stopped retry under another cookie cannot turn a committed uncertain entry into a safe discard', async ({ page }) => {
  const { a, aCookies, bCookies } = await accounts(page);
  const session = await newSession(page, 'Cross-account lost reply');
  const player = await addPlayer(page, 'Justin');
  await probe(page);
  const path = `/api/sessions/${session.session.id}/entries`;
  const bodies: string[] = [];
  let attempt = 0;
  const held = deferred();
  const release = deferred();
  await page.route(`**${path}`, async route => {
    bodies.push(route.request().postData()!);
    attempt++;
    const headers = { ...route.request().headers() };
    if (attempt === 2) delete headers['x-pb-expected-banker-id'];
    const response = await route.fetch({ headers });
    if (attempt === 1) {
      expect(response.status()).toBe(200);
      await route.abort('failed');
    } else if (attempt === 2) {
      expect(response.status()).toBe(404);
      held.resolve();
      await release.promise;
      await route.fulfill({ response });
    } else await route.fulfill({ response });
  });
  const op = await page.evaluate(async ({ banker, session, player, path }) => {
    const op_id = crypto.randomUUID();
    await (window as unknown as ProbeWindow).boundary.data.enqueue({ banker_id: banker, session_id: session, path, label: 'Buy-in', body: { op_id, player_id: player, kind: 'buy_in', amount_minor: '10000', paid_now: false, occurred_at: null } });
    return op_id;
  }, { banker: a.banker.id, session: session.session.id, player: player.id, path });
  await start(page, a.banker.id);
  await expect.poll(async () => (await records(page)).outbox[0]?.status).toBe('uncertain');
  await stop(page);
  expect((await current(page, session.session.id)).entries).toHaveLength(1);
  await page.context().addCookies(bCookies);
  await page.evaluate(id => (window as unknown as ProbeWindow).boundary.data.retryItem(id), op);
  await start(page, a.banker.id);
  await held.promise;
  await stop(page);
  const delivered = page.waitForResponse(response => new URL(response.url()).pathname === path);
  release.resolve();
  await delivered;
  await expect.poll(async () => (await records(page)).outbox[0]?.status === 'sending').toBe(false);
  const retained = (await records(page)).outbox[0]!;
  expect(retained.delivery).toBe('uncertain');
  expect(await page.evaluate(async id => {
    try { await (window as unknown as ProbeWindow).boundary.data.discardItem(id); return false; } catch { return true; }
  }, op)).toBe(true);
  await page.context().addCookies(aCookies);
  await page.evaluate(id => (window as unknown as ProbeWindow).boundary.data.retryItem(id), op);
  await start(page, a.banker.id);
  await expect.poll(async () => (await records(page)).outbox.length).toBe(0);
  await stop(page);
  const confirmed = await current(page, session.session.id);
  expect(confirmed.entries).toHaveLength(1);
  expect(confirmed.entries[0]!.amount_minor).toBe('10000');
  expect(bodies).toHaveLength(3);
  expect(new Set(bodies).size).toBe(1);
});

for (const recovery of ['same mounted sheet', 'workspace'] as const) {
  test(`an identity-check cookie race preserves the ${recovery} submitted draft until its owner replays it`, async ({ page }) => {
    const { a, b, aCookies, bCookies } = await accounts(page);
    const session = await newSession(page, 'Draft cookie race');
    const path = `/api/sessions/${session.session.id}/players`;
    const bodies: string[] = [];
    let attempt = 0;
    await page.route(`**${path}`, async route => {
      bodies.push(route.request().postData()!);
      attempt++;
      const headers = { ...route.request().headers() };
      if (attempt === 2) {
        delete headers['x-pb-expected-banker-id'];
        headers.cookie = bCookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
      }
      const response = await route.fetch({ headers });
      if (attempt === 1) {
        expect(response.status()).toBe(200);
        await route.abort('failed');
      } else {
        expect(response.status()).toBe(attempt === 2 ? 404 : 200);
        if (attempt === 2) expect(response.headers()['x-pb-banker-id']).toBe(b.banker.id);
        await route.fulfill({ response });
      }
    });
    await page.getByRole('button', { name: 'Add player', exact: true }).click();
    await page.getByLabel('Search players', { exact: true }).fill('Justin');
    await page.getByRole('button', { name: "Add 'Justin' as new", exact: true }).click();
    await expect(page.getByRole('button', { name: 'Check saved result', exact: true })).toBeEnabled();
    const submitted = (await records(page)).drafts.find(draft => draft.value.__submitted)!;
    expect(submitted.key.startsWith(`${a.banker.id}/`)).toBe(true);
    if (recovery === 'workspace') await page.reload();
    let switchCookie = true;
    await page.route('**/api/auth/me', async route => {
      const response = await route.fetch();
      expect((await response.json()).banker.id).toBe(a.banker.id);
      if (switchCookie) {
        switchCookie = false;
        await page.context().addCookies(bCookies);
      }
      await route.fulfill({ response });
    });
    const check = recovery === 'workspace' ? page.getByRole('button', { name: 'Check saved form: Add player', exact: true }) : page.getByRole('button', { name: 'Check saved result', exact: true });
    const rejected = page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST');
    await check.click();
    expect((await rejected).status()).toBe(404);
    await expect(page.getByRole('heading', { name: 'Account changed', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reload account state', exact: true })).toBeEnabled();
    expect((await records(page)).drafts.find(draft => draft.key === submitted.key)!.value).toEqual(submitted.value);
    if (recovery === 'same mounted sheet') await expect(page.getByLabel('Search players', { exact: true })).toHaveCount(0);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
    await page.context().addCookies(aCookies);
    await page.getByRole('button', { name: 'Reload account state', exact: true }).click();
    await page.getByRole('button', { name: 'Check saved form: Add player', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Unconfirmed forms', exact: true })).toHaveCount(0);
    expect((await records(page)).drafts.some(draft => draft.key === submitted.key)).toBe(false);
    const confirmed = await current(page, session.session.id);
    expect(confirmed.players.map(player => player.display_name)).toEqual(['Justin']);
    expect(bodies).toHaveLength(3);
    expect(new Set(bodies).size).toBe(1);
  });
}

test('stopped syncs ignore late same-owner successes and rejections until a current replay settles them', async ({ page }) => {
  const account = await createAccount(page);
  const session = await newSession(page, 'Stopped same-owner replies');
  const player = await addPlayer(page, 'Justin');
  await probe(page);
  const path = `/api/sessions/${session.session.id}/entries`;
  for (const outcome of ['success', 'rejection'] as const) {
    const before = await records(page);
    const savedBefore = await page.evaluate(() => (window as unknown as ProbeWindow).boundary.saved);
    const held = deferred();
    const release = deferred();
    let hold = true;
    await page.route(`**${path}`, async route => {
      const response = await route.fetch();
      expect(response.status()).toBe(outcome === 'success' ? 200 : 404);
      expect(response.headers()['x-pb-banker-id']).toBe(account.banker.id);
      if (hold) {
        hold = false;
        held.resolve();
        await release.promise;
      }
      await route.fulfill({ response });
    });
    const op = await page.evaluate(async ({ banker, session, player, path }) => {
      const op_id = crypto.randomUUID();
      await (window as unknown as ProbeWindow).boundary.data.enqueue({ banker_id: banker, session_id: session, path, label: 'Buy-in', body: { op_id, player_id: player, kind: 'buy_in', amount_minor: '10000', paid_now: false, occurred_at: null } });
      return op_id;
    }, { banker: account.banker.id, session: session.session.id, player: outcome === 'success' ? player.id : crypto.randomUUID(), path });
    await start(page, account.banker.id);
    await held.promise;
    await stop(page);
    const delivered = page.waitForResponse(response => new URL(response.url()).pathname === path);
    release.resolve();
    await delivered;
    await expect.poll(async () => (await records(page)).outbox[0]?.status === 'sending').toBe(false);
    const retained = await records(page);
    expect(retained.outbox).toHaveLength(1);
    expect(retained.outbox[0]!.delivery).toBe('uncertain');
    expect(retained.snapshots).toEqual(before.snapshots);
    expect(await page.evaluate(() => (window as unknown as ProbeWindow).boundary.saved)).toBe(savedBefore);
    expect(await page.evaluate(async id => {
      try { await (window as unknown as ProbeWindow).boundary.data.discardItem(id); return false; } catch { return true; }
    }, op)).toBe(true);
    await page.evaluate(id => (window as unknown as ProbeWindow).boundary.data.retryItem(id), op);
    await start(page, account.banker.id);
    if (outcome === 'success') {
      await expect.poll(async () => (await records(page)).outbox.length).toBe(0);
      expect((await current(page, session.session.id)).entries).toHaveLength(1);
    } else {
      await expect.poll(async () => (await records(page)).outbox[0]?.delivery).toBe('not_applied');
      await page.evaluate(id => (window as unknown as ProbeWindow).boundary.data.discardItem(id), op);
      expect((await records(page)).outbox).toHaveLength(0);
    }
    await stop(page);
    await page.unroute(`**${path}`);
  }
});

test('a cross-tab account transition invalidates a held same-owner draft rejection before the owner returns', async ({ page, context }) => {
  const { a, b } = await accounts(page);
  await newSession(page, 'Player directory');
  const player = await addPlayer(page, 'Justin');
  const session = await newSession(page, 'Cross-tab draft generation');
  const path = `/api/sessions/${session.session.id}/players`;
  const held = deferred();
  const release = deferred();
  const completed = deferred();
  let heldRequest: Request | undefined;
  let attempt = 0;
  await page.route(`**${path}`, async route => {
    attempt++;
    if (attempt === 1) { await route.abort('failed'); return; }
    const response = await route.fetch();
    expect(response.status()).toBe(409);
    expect(response.headers()['x-pb-banker-id']).toBe(a.banker.id);
    if (attempt === 2) {
      heldRequest = route.request();
      held.resolve();
      await release.promise;
      if (heldRequest.failure()) { completed.resolve(); return; }
    }
    await route.fulfill({ response });
    if (attempt === 2) completed.resolve();
  });
  await page.getByRole('button', { name: 'Add player', exact: true }).click();
  await page.getByLabel('Search players', { exact: true }).fill('Justin');
  await page.getByRole('dialog').getByRole('button', { name: 'Justin', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Check saved result', exact: true })).toBeEnabled();
  const submitted = (await records(page)).drafts.find(draft => draft.value.__submitted)!;
  await call(page, path.slice(4), 'POST', { op_id: crypto.randomUUID(), player_id: player.id });
  await page.getByRole('button', { name: 'Check saved result', exact: true }).click();
  await held.promise;
  const other = await context.newPage();
  await other.route('**/account-transition.html', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Account transition</title>' }));
  await other.goto('/account-transition.html');
  const canceled = page.waitForEvent('requestfailed', { predicate: request => request === heldRequest });
  await other.evaluate(banker => localStorage.setItem('pb-banker', JSON.stringify(banker)), b.banker);
  await expect(page.getByRole('heading', { name: 'Account changed', exact: true })).toBeVisible();
  expect((await canceled).failure()).not.toBeNull();
  await other.evaluate(banker => localStorage.setItem('pb-banker', JSON.stringify(banker)), a.banker);
  release.resolve();
  await completed.promise;
  expect((await records(page)).drafts.find(draft => draft.key === submitted.key)!.value).toEqual(submitted.value);
  expect((await records(page)).drafts.filter(draft => draft.kind === 'acknowledged_operation' && draft.key.endsWith(submitted.value.op_id))).toHaveLength(0);
  await page.reload();
  await page.getByRole('button', { name: 'Check saved form: Add player', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Unconfirmed forms', exact: true })).toHaveCount(0);
  const editable = (await records(page)).drafts.find(draft => draft.key === submitted.key)!;
  expect(editable.value.__submitted).toBeUndefined();
  expect(editable.value.op_id).not.toBe(submitted.value.op_id);
  expect((await current(page, session.session.id)).players.map(item => item.id)).toEqual([player.id]);
});

test('a newer draft replay in another module instance supersedes an older held rejection', async ({ page }) => {
  const account = await createAccount(page);
  const session = await newSession(page, 'Concurrent draft replay owners');
  const player = await addPlayer(page, 'Justin');
  await probe(page);
  const path = `/api/sessions/${session.session.id}/players`;
  const key = `${account.banker.id}/${session.session.id}/add-player/`;
  const original = await page.evaluate(async ({ key, path, player }) => {
    const p = (window as unknown as ProbeWindow).boundary;
    const modulePath = '/account-probe-second.js';
    p.secondary = await import(modulePath) as typeof import('../src/client/data');
    const value = { op_id: crypto.randomUUID(), search: 'Justin' };
    await p.data.prepareDraftSubmission(key, value, { path, method: 'POST', body: { op_id: value.op_id, player_id: player } });
    return value;
  }, { key, path, player: player.id });
  const held = [deferred(), deferred()];
  const release = [deferred(), deferred()];
  const bodies: string[] = [];
  await page.route(`**${path}`, async route => {
    const index = bodies.length;
    bodies.push(route.request().postData()!);
    const response = await route.fetch();
    expect(response.status()).toBe(409);
    expect((await response.json()).error.code).toBe('already_seated');
    expect(response.headers()['x-pb-banker-id']).toBe(account.banker.id);
    held[index]!.resolve();
    await release[index]!.promise;
    await route.fulfill({ response });
  });
  await page.evaluate(key => {
    const p = (window as unknown as ProbeWindow).boundary;
    p.first = p.data.replaySubmittedDraft(key).then(() => 'saved', problem => String(problem));
  }, key);
  await held[0]!.promise;
  await page.evaluate(key => {
    const p = (window as unknown as ProbeWindow).boundary;
    p.second = p.secondary!.replaySubmittedDraft(key).then(() => 'saved', problem => String(problem));
  }, key);
  await held[1]!.promise;
  release[0]!.resolve();
  await page.evaluate(() => (window as unknown as ProbeWindow).boundary.first);
  const frozen = (await records(page)).drafts.find(draft => draft.key === key)!;
  expect(frozen.value.__submitted).toBeDefined();
  expect(frozen.value.op_id).toBe(original.op_id);
  expect(frozen.value.search).toBe('Justin');
  release[1]!.resolve();
  await page.evaluate(() => (window as unknown as ProbeWindow).boundary.second);
  const editable = (await records(page)).drafts.find(draft => draft.key === key)!;
  expect(editable.value.__submitted).toBeUndefined();
  expect(editable.value.op_id).not.toBe(original.op_id);
  expect(editable.value.search).toBe('Justin');
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toBe(bodies[1]);
  expect((await current(page, session.session.id)).players.map(item => item.id)).toEqual([player.id]);
});
