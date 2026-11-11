import type { Page, Request } from '@playwright/test';
import { test, expect } from './fixtures';
import { addPlayer, call, createAccount, keepMoneyDraft, menu, newSession, openMoney, password } from './helpers';
import type { SessionState } from '../src/domain/session';

test.use({ serviceWorkers: 'block' });

async function records(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('poker-banker');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const read = (name: string) => new Promise<Record<string, unknown>[]>((resolve, reject) => {
      const request = db.transaction(name).objectStore(name).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const [drafts, outbox, snapshots] = await Promise.all(['drafts', 'outbox', 'snapshots'].map(read));
    db.close();
    return { drafts: drafts!, outbox: outbox!, snapshots: snapshots! };
  });
}

async function seedRetainedWork(page: Page, owners: string[]) {
  return page.evaluate(async owners => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('poker-banker');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = db.transaction(['drafts', 'outbox'], 'readwrite');
    const ids = owners.map(banker_id => {
      const op_id = crypto.randomUUID();
      tx.objectStore('drafts').put({ key: `${banker_id}/retained/settings/`, banker_id, updated_at: 1, value: { op_id, name: `Private draft ${banker_id}` } });
      tx.objectStore('outbox').put({ op_id, banker_id, session_id: crypto.randomUUID(), path: '/api/sessions/retained/entries', method: 'POST', body: { op_id }, label: 'Retained private entry', order: 1, status: 'rejected', delivery: 'not_applied', attempts: 1, next_attempt_at: Number.MAX_SAFE_INTEGER });
      return op_id;
    });
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
    db.close();
    return ids;
  }, owners);
}

async function holdCurrentPoll(page: Page, id: string) {
  let ready!: () => void;
  let release!: () => void;
  let settled!: () => void;
  let actualRequest: Request | undefined;
  let canceled = false;
  const failed = (request: Request) => { if (request === actualRequest) canceled = true; };
  page.on('requestfailed', failed);
  const held = new Promise<void>(resolve => { ready = resolve; });
  const resumed = new Promise<void>(resolve => { release = resolve; });
  const completed = new Promise<void>(resolve => { settled = resolve; });
  const pattern = `**/api/sessions/${id}*`;
  await page.route(pattern, async route => {
    if (route.request().method() !== 'GET' || actualRequest) { await route.continue(); return; }
    actualRequest = route.request();
    const response = await route.fetch();
    ready();
    await resumed;
    try { if (!actualRequest.failure()) await route.fulfill({ response }); } finally { settled(); }
  });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await held;
  let closing: Promise<void> | undefined;
  return (requireCanceled = false) => closing ??= (async () => {
    try {
      if (requireCanceled) {
        await expect.poll(() => canceled).toBe(true);
        expect(actualRequest!.failure()).not.toBeNull();
      }
    } finally {
      release();
      await completed;
      await page.unroute(pattern);
      page.off('requestfailed', failed);
    }
  })();
}

for (const action of ['roster', 'share', 'logout'] as const) {
  test(`a displayed account rejects a cookie-only account switch before ${action}`, async ({ page, context }) => {
    const a = await createAccount(page);
    const sessionA = await newSession(page, `A private ${action}`);
    const playerA = await addPlayer(page, `A player ${action}`);
    await openMoney(page, playerA.id);
    await page.getByLabel('Amount', { exact: true }).fill('37.25');
    await keepMoneyDraft(page);
    const resumePoll = await holdCurrentPoll(page, sessionA.session.id);
    const blank = await context.newPage();
    try {
      const aCookies = await context.cookies();
      const origin = new URL(page.url()).origin;
      await blank.route('**/cookie-login.html', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Cookie login</title>' }));
      await blank.goto(`${origin}/cookie-login.html`);
      const username = `request-${crypto.randomUUID().slice(0, 12)}`;
      const signup = await blank.request.post(`${origin}/api/auth/signup`, { headers: { origin }, data: { username, password } });
      expect(signup.status()).toBe(200);
      const b = await signup.json() as { banker: { id: string; username: string } };
      const sessionB = await call<SessionState>(page, '/sessions', 'POST', { op_id: crypto.randomUUID(), name: `B secret ${action}`, played_on: '2026-11-10', currency: 'USD' });
      const sharedB = await call<SessionState>(page, `/sessions/${sessionB.session.id}/share`, 'POST', { op_id: crypto.randomUUID(), action: 'enable' });
      const alternateB = await call<SessionState>(page, '/sessions', 'POST', { op_id: crypto.randomUUID(), name: `B newer ${action}`, played_on: '2026-11-11', currency: 'USD' });
      expect(alternateB.session.played_on > sessionB.session.played_on).toBe(true);
      await context.addCookies(aCookies);
      await page.evaluate(({ owner, id }) => localStorage.setItem(`pb-session-${owner}`, id), { owner: b.banker.id, id: sessionB.session.id });
      const retainedIds = await seedRetainedWork(page, [a.banker.id, b.banker.id]);
      if (action === 'share') await menu(page, 'Share');
      if (action === 'logout') {
        await page.getByRole('button', { name: 'Players', exact: true }).click();
        await expect(page.getByRole('region', { name: 'Account', exact: true })).toContainText(a.username);
        await page.getByRole('button', { name: 'Sign out', exact: true }).click();
        await page.getByLabel('Discard unsent entries and drafts', { exact: true }).check();
        await expect(page.getByRole('button', { name: 'Confirm sign out', exact: true })).toBeEnabled();
      } else await expect(page.getByRole('heading', { name: `A private ${action}`, exact: true })).toBeVisible();
      const before = await records(page);
      const loggedIn = await blank.request.post(`${origin}/api/auth/login`, { headers: { origin }, data: { username, password } });
      expect(loggedIn.status()).toBe(200);
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem('pb-banker')!).id)).toBe(a.banker.id);
      const target = action === 'roster' ? '/api/players' : action === 'share' ? `/api/sessions/${sessionA.session.id}/share` : '/api/auth/logout';
      const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === target);
      if (action === 'roster') await page.getByRole('button', { name: 'Players', exact: true }).click();
      else if (action === 'share') await page.getByRole('button', { name: 'Enable sharing', exact: true }).click();
      else await page.getByRole('button', { name: 'Confirm sign out', exact: true }).click();
      const response = await responsePromise;
      expect(response.request().headers()['x-pb-expected-banker-id']).toBe(a.banker.id);
      expect(response.status()).toBe(409);
      expect(response.headers()['x-pb-banker-id']).toBe(b.banker.id);
      await expect(page.getByRole('heading', { name: 'Account changed', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Reload account state', exact: true })).toBeVisible();
      const after = await records(page);
      expect(after.drafts).toEqual(before.drafts);
      expect(after.outbox).toEqual(before.outbox);
      expect(after.snapshots.some(row => row.banker_id === a.banker.id && (row.state as SessionState).session.id === sessionB.session.id)).toBe(false);
      expect(await page.evaluate(owner => localStorage.getItem(`pb-session-${owner}`), b.banker.id)).toBe(sessionB.session.id);
      expect((await call<{ banker: { id: string } }>(blank, '/auth/me')).banker.id).toBe(b.banker.id);
      expect((await call<SessionState>(blank, `/sessions/${sessionB.session.id}`)).session.share_token).toBe(sharedB.session.share_token);
      await resumePoll(true);
      const discoveryPromise = page.waitForRequest(request => new URL(request.url()).pathname === '/api/auth/me');
      await page.getByRole('button', { name: 'Reload account state', exact: true }).click();
      const discovery = await discoveryPromise;
      expect(discovery.headers()['x-pb-expected-banker-id']).toBeUndefined();
      await expect(page.getByRole('heading', { name: `B secret ${action}`, exact: true })).toBeVisible();
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem('pb-banker')!).id)).toBe(b.banker.id);
      expect(await page.evaluate(owner => localStorage.getItem(`pb-session-${owner}`), b.banker.id)).toBe(sessionB.session.id);
      expect((await records(page)).outbox.map(row => row.op_id)).toEqual(expect.arrayContaining(retainedIds));
      const reloaded = await records(page);
      expect(reloaded.drafts).toEqual(before.drafts);
      expect(reloaded.snapshots.some(row => row.banker_id === a.banker.id && (row.state as SessionState).session.id === sessionB.session.id)).toBe(false);
      expect((await call<{ banker: { id: string } }>(blank, '/auth/me')).banker.id).toBe(b.banker.id);
      const ownA = await blank.request.get(`${origin}/api/sessions/${sessionA.session.id}`, { headers: { cookie: aCookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ') } });
      expect(ownA.status()).toBe(200);
      expect((await ownA.json() as SessionState).session.name).toBe(`A private ${action}`);
    } finally { try { await resumePoll(); } finally { await blank.close(); } }
  });
}
