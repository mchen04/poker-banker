import type { Request } from '@playwright/test';
import { test, expect } from './fixtures';
import { addPlayer, call, closeSession, createAccount, current, menu, money, newSession, signOut } from './helpers';
import type { SessionState } from '../src/domain/session';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

test.use({ serviceWorkers: 'block' });

test('a lost create response reconciles the submitted draft before a fresh session operation', async ({ page }) => {
  await createAccount(page);
  const bodies: { op_id: string; name: string }[] = [];
  let drop = true;
  await page.route('**/api/sessions', async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    bodies.push(route.request().postDataJSON());
    if (!drop) { await route.continue(); return; }
    drop = false;
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    await route.abort('failed');
  });
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  await page.getByLabel('Session name', { exact: true }).fill('First committed game');
  await page.getByRole('button', { name: 'Create session', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Check saved result', exact: true })).toBeEnabled();
  await expect(page.getByLabel('Session name', { exact: true })).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Check saved result', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Check saved result', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'First committed game', exact: true })).toBeVisible();
  await newSession(page, 'Second distinct game');
  expect(bodies).toHaveLength(3);
  expect(bodies[0]).toEqual(bodies[1]);
  expect(bodies[2]!.op_id).not.toBe(bodies[0]!.op_id);
  const response = await page.request.get('/api/sessions');
  const history = await response.json() as { sessions: { name: string }[] };
  expect(history.sessions.map(session => session.name).sort()).toEqual(['First committed game', 'Second distinct game']);
});

for (const recovery of ['sheet', 'workspace'] as const) {
  test(`a dropped validation rejection returns the ${recovery} draft to editing with a fresh operation`, async ({ page }) => {
    await createAccount(page);
    const bodies: { op_id: string; name: string; location: string }[] = [];
    let drop = true;
    await page.route('**/api/sessions', async route => {
      if (route.request().method() !== 'POST') { await route.continue(); return; }
      bodies.push(route.request().postDataJSON());
      if (!drop) { await route.continue(); return; }
      drop = false;
      expect((await route.fetch()).status()).toBe(400);
      await route.abort('failed');
    });
    await page.getByRole('button', { name: 'New session', exact: true }).click();
    await page.getByLabel('Session name', { exact: true }).fill('   ');
    await page.getByLabel('Location', { exact: true }).fill('Retained typed location');
    await page.getByRole('button', { name: 'Create session', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Check saved result', exact: true })).toBeEnabled();
    await page.reload();
    if (recovery === 'sheet') {
      await page.getByRole('button', { name: 'New session', exact: true }).click();
      await page.getByRole('button', { name: 'Check saved result', exact: true }).click();
    } else {
      await page.getByRole('button', { name: 'Check saved form: New session', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Unconfirmed forms', exact: true })).toHaveCount(0);
      await page.getByRole('button', { name: 'New session', exact: true }).click();
    }
    await expect(page.getByLabel('Session name', { exact: true })).toHaveValue('   ');
    await expect(page.getByLabel('Location', { exact: true })).toHaveValue('Retained typed location');
    await expect(page.getByLabel('Session name', { exact: true })).toBeEnabled();
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
    await page.getByLabel('Session name', { exact: true }).fill('Corrected rejected game');
    await page.getByRole('button', { name: 'Create session', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Corrected rejected game', exact: true })).toBeVisible();
    expect(bodies).toHaveLength(3);
    expect(bodies[2]!.op_id).not.toBe(bodies[0]!.op_id);
    expect((await call<{ sessions: { name: string }[] }>(page, '/sessions')).sessions.map(session => session.name)).toEqual(['Corrected rejected game']);
  });
}

test('a dropped timer-bound rejection restores an editable correction without applying the void', async ({ page }) => {
  await createAccount(page);
  let state = await newSession(page, 'Recover rejected correction');
  const player = await addPlayer(page, 'Justin');
  state = await call<SessionState>(page, `/sessions/${state.session.id}/timing`, 'PATCH', { op_id: crypto.randomUUID(), started_at: '2026-11-10T00:00:00Z', ended_at: '2026-11-10T06:00:00Z' });
  state = await call<SessionState>(page, `/sessions/${state.session.id}/entries`, 'POST', { op_id: crypto.randomUUID(), player_id: player.id, kind: 'buy_in', amount_minor: '10000', paid_now: false, occurred_at: '2026-11-10T02:00:00Z' });
  const original = state.entries[0]!;
  await page.reload();
  const bodies: { op_id: string; replacement_occurred_at: string }[] = [];
  let drop = true;
  await page.route(`**/api/sessions/${state.session.id}/entries/${original.id}/void`, async route => {
    bodies.push(route.request().postDataJSON());
    if (!drop) { await route.continue(); return; }
    drop = false;
    const response = await route.fetch();
    expect(response.status()).toBe(400);
    expect((await response.json()).error.code).toBe('outside_timer_bounds');
    await route.abort('failed');
  });
  await page.getByTestId(`entry-${original.id}`).getByRole('button', { name: 'Correct', exact: false }).click();
  await page.getByLabel('Entry time', { exact: true }).fill('2026-11-09T23:00:00');
  await page.getByRole('button', { name: 'Save correction', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Check saved result', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Check saved result', exact: true }).click();
  await expect(page.getByLabel('Entry time', { exact: true })).toHaveValue(/^2026-11-09T23:00(?::00)?$/);
  expect((await current(page)).entries).toHaveLength(1);
  await page.getByLabel('Entry time', { exact: true }).fill('2026-11-10T03:00:00');
  await page.getByRole('button', { name: 'Save correction', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const after = await current(page);
  expect(after.entries).toHaveLength(3);
  expect(after.entries.find(entry => entry.voids_entry_id === original.id)).toBeDefined();
  expect(after.entries.find(entry => !entry.voids_entry_id && entry.id !== original.id)!.occurred_at).toBe('2026-11-10T03:00:00.000Z');
  expect(bodies).toHaveLength(3);
  expect(bodies[0]).toEqual(bodies[1]);
  expect(bodies[2]!.op_id).not.toBe(bodies[0]!.op_id);
});

test('a committed reopen stays recoverable after reload changes the available lifecycle controls', async ({ page }) => {
  await createAccount(page);
  await newSession(page, 'Recover lifecycle');
  const player = await addPlayer(page, 'Justin');
  await money(page, player.id, '100');
  await money(page, player.id, '100', { kind: 'Cash out', paid: true });
  await closeSession(page);
  const state = await current(page);
  const bodies: string[] = [];
  let drop = true;
  await page.route(`**/api/sessions/${state.session.id}/reopen`, async route => {
    bodies.push(route.request().postData()!);
    if (!drop) { await route.continue(); return; }
    drop = false;
    expect((await route.fetch()).status()).toBe(200);
    await route.abort('failed');
  });
  await menu(page, 'Reopen session');
  await page.getByLabel('Reason', { exact: true }).fill('Review the saved payout');
  await page.getByRole('button', { name: 'Reopen session', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Check saved result', exact: true })).toBeEnabled();
  await page.reload();
  await page.getByRole('button', { name: 'Check saved form: Reopen session', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Unconfirmed forms', exact: true })).toHaveCount(0);
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toBe(bodies[1]);
  expect((await current(page)).events.filter(event => event.kind === 'reopened')).toHaveLength(1);
});

test('a committed correction stays recoverable after its original entry becomes voided', async ({ page }) => {
  await createAccount(page);
  await newSession(page, 'Recover correction');
  const player = await addPlayer(page, 'Justin');
  const state = await money(page, player.id, '100');
  const original = state.entries.find(entry => entry.kind === 'buy_in')!;
  const bodies: string[] = [];
  let drop = true;
  await page.route(`**/api/sessions/${state.session.id}/entries/${original.id}/void`, async route => {
    bodies.push(route.request().postData()!);
    if (!drop) { await route.continue(); return; }
    drop = false;
    expect((await route.fetch()).status()).toBe(200);
    await route.abort('failed');
  });
  await page.getByTestId(`entry-${original.id}`).getByRole('button', { name: 'Correct', exact: false }).click();
  await page.getByLabel('Replacement amount', { exact: true }).fill('200');
  await page.getByRole('button', { name: 'Save correction', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Check saved result', exact: true })).toBeEnabled();
  await page.reload();
  await page.getByRole('button', { name: 'Check saved form: Entry correction', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Unconfirmed forms', exact: true })).toHaveCount(0);
  expect(bodies).toHaveLength(2); expect(bodies[0]).toBe(bodies[1]);
  const after = await current(page);
  expect(after.players[0]!.bought_in_minor).toBe('20000');
  expect(after.entries).toHaveLength(4);
});

test('concurrent preparations preserve the first submitted payload and retain later edits for a fresh operation', async ({ page }) => {
  const account = await createAccount(page);
  const source = await readFile('src/client/data.ts', 'utf8');
  const compile = (value: string) => ts.transpileModule(value, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const compiled = compile(source);
  for (const match of source.matchAll(/from ['"](\.\/[^'"]+)['"]/g)) {
    const modulePath = match[1]!.slice(2);
    const dependency = await readFile(`src/client/${modulePath}.ts`, 'utf8');
    await page.route(`**/${modulePath}`, route => route.fulfill({ contentType: 'text/javascript', body: compile(dependency) }));
  }
  await page.route('**/draft-probe.js', route => route.fulfill({ contentType: 'text/javascript', body: compiled }));
  const result = await page.evaluate(async banker => {
    const modulePath = '/draft-probe.js';
    const data = await import(modulePath) as typeof import('../src/client/data');
    const key = `${banker}/new/new-session/`;
    const op_id = crypto.randomUUID();
    const first = { path: '/api/sessions', method: 'POST', body: { op_id, name: 'First snapshot', played_on: '2026-11-10', currency: 'USD' } };
    const second = { ...first, body: { ...first.body, name: 'Conflicting snapshot' } };
    await data.writeDraft(key, { op_id, name: 'Typed draft' });
    const submitted = await Promise.all([data.prepareDraftSubmission(key, { op_id, name: 'First snapshot' }, first), data.prepareDraftSubmission(key, { op_id, name: 'Conflicting snapshot' }, second)]);
    await data.writeDraft(key, { op_id, name: 'Changed after submission' });
    const retained = await data.readDraft<{ __submitted: typeof first }>(key);
    await data.replaySubmittedDraft(key);
    const recovered = await data.readDraft<{ name: string; op_id: string }>(key);
    const stale = await data.prepareDraftSubmission(key, { op_id, name: 'Next reviewed intent' }, { ...first, body: { ...first.body, name: 'Next reviewed intent' } });
    const fresh = await data.readDraft<{ op_id: string; name: string }>(key);
    await data.prepareDraftSubmission(key, fresh!, { ...first, body: { ...first.body, op_id: fresh!.op_id, name: fresh!.name } });
    await data.replaySubmittedDraft(key);
    return { submitted, retained, recovered, stale, fresh, unsent: await data.hasUnsent(banker), originalOp: op_id };
  }, account.banker.id);
  expect(result.submitted.map(item => item.first).sort()).toEqual([false, true]);
  expect(result.submitted[0]!.request).toEqual(result.submitted[1]!.request);
  expect(result.retained!.__submitted).toEqual(result.submitted[0]!.request);
  expect(result.recovered?.name).toBe('Changed after submission');
  expect(result.recovered?.op_id).not.toBe(result.originalOp);
  expect(result.stale.previouslyConfirmed).toBe(true);
  expect(result.fresh!.name).toBe('Next reviewed intent');
  expect(result.fresh!.op_id).not.toBe(result.originalOp);
  expect(result.unsent).toBe(false);
  const history = await call<{ sessions: { name: string }[] }>(page, '/sessions');
  expect(history.sessions.map(session => session.name).sort()).toEqual(['First snapshot', 'Next reviewed intent']);
});

test('a late form acknowledgement after another tab signs out cannot restore private local records', async ({ page, context }) => {
  await createAccount(page);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let committed!: () => void;
  const committedRequest = new Promise<void>(resolve => { committed = resolve; });
  let settled!: () => void;
  const completed = new Promise<void>(resolve => { settled = resolve; });
  let heldRequest: Request | undefined;
  await page.route('**/api/sessions', async route => {
    if (route.request().method() !== 'POST' || heldRequest) { await route.continue(); return; }
    heldRequest = route.request();
    try {
      const response = await route.fetch();
      expect(response.status()).toBe(200); committed();
      await held;
      if (!heldRequest.failure()) await route.fulfill({ response });
    } finally { settled(); }
  });
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  await page.getByLabel('Session name', { exact: true }).fill('Held server acknowledgement');
  await page.getByRole('button', { name: 'Create session', exact: true }).click();
  await committedRequest;
  const other = await context.newPage();
  try {
    await other.goto('/');
    await expect(other.getByRole('button', { name: 'Players', exact: true })).toBeVisible();
    const saved = await call<{ sessions: { name: string }[] }>(other, '/sessions');
    expect(saved.sessions.filter(session => session.name === 'Held server acknowledgement')).toHaveLength(1);
    const canceled = page.waitForEvent('requestfailed', { predicate: request => request === heldRequest });
    await signOut(other);
    expect((await canceled).failure()).not.toBeNull();
    release();
    await completed;
    await expect(page.getByLabel('Username', { exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const opening = indexedDB.open('poker-banker'); opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error); });
      const values: number[] = [];
      for (const name of ['drafts', 'outbox', 'snapshots']) values.push(await new Promise<number>((resolve, reject) => { const reading = db.transaction(name).objectStore(name).count(); reading.onsuccess = () => resolve(reading.result); reading.onerror = () => reject(reading.error); }));
      db.close(); return values;
    })).toEqual([0, 0, 0]);
    await expect(page.getByTestId('saved-confirmation')).toHaveCount(0);
  } finally { release(); await completed; await other.close(); }
});

test('a dropped timing-validation rejection restores editing before a fresh timing operation', async ({ page }) => {
  await createAccount(page);
  let state = await newSession(page, 'Recover rejected timing');
  const player = await addPlayer(page, 'Justin');
  state = await call<SessionState>(page, `/sessions/${state.session.id}/timing`, 'PATCH', { op_id: crypto.randomUUID(), started_at: '2026-11-10T18:00:00Z', ended_at: '2026-11-10T22:00:00Z' });
  state = await call<SessionState>(page, `/sessions/${state.session.id}/entries`, 'POST', { op_id: crypto.randomUUID(), player_id: player.id, kind: 'buy_in', amount_minor: '10000', paid_now: false, occurred_at: '2026-11-10T20:00:00Z' });
  await page.reload();
  const bodies: { op_id: string; started_at: string; ended_at: string | null }[] = [];
  let drop = true;
  await page.route(`**/api/sessions/${state.session.id}/timing`, async route => {
    if (route.request().method() !== 'PATCH') { await route.continue(); return; }
    bodies.push(route.request().postDataJSON());
    if (!drop) { await route.continue(); return; }
    drop = false;
    const response = await route.fetch();
    expect(response.status()).toBe(409);
    expect((await response.json()).error.code).toBe('entries_outside_timing');
    await route.abort('failed');
  });
  await menu(page, 'Correct times');
  await page.getByLabel('Started at', { exact: true }).fill('2026-11-10T21:00:00');
  await page.getByRole('button', { name: 'Save timing', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Check saved result', exact: true })).toBeEnabled();
  await page.reload();
  await menu(page, 'Correct times');
  await page.getByRole('button', { name: 'Check saved result', exact: true }).click();
  await expect(page.getByLabel('Started at', { exact: true })).toHaveValue(/^2026-11-10T21:00(?::00)?$/);
  await expect(page.getByLabel('Ended at', { exact: true })).toHaveValue(/^2026-11-10T22:00(?::00)?$/);
  expect((await current(page)).session.started_at).toBe('2026-11-10T18:00:00.000Z');
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toEqual(bodies[1]);
  await page.getByLabel('Started at', { exact: true }).fill('2026-11-10T19:00:00');
  await page.getByRole('button', { name: 'Save timing', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const saved = await current(page);
  expect(saved.session.started_at).toBe('2026-11-10T19:00:00.000Z');
  expect(saved.session.ended_at).toBe('2026-11-10T22:00:00.000Z');
  expect(saved.events.filter(event => event.kind === 'timing_corrected')).toHaveLength(2);
  expect(bodies).toHaveLength(3);
  expect(bodies[2]!.op_id).not.toBe(bodies[0]!.op_id);
});

test('a rejected timer start leaves no pending operation and correct times remains available', async ({ page }) => {
  await createAccount(page);
  let state = await newSession(page, 'Reject late timer start');
  const player = await addPlayer(page, 'Justin');
  state = await call<SessionState>(page, `/sessions/${state.session.id}/entries`, 'POST', { op_id: crypto.randomUUID(), player_id: player.id, kind: 'cash_out', amount_minor: '10000', paid_now: false, occurred_at: '2026-11-10T19:00:00Z' });
  await page.reload();
  const bodies: { op_id: string }[] = [];
  await page.route(`**/api/sessions/${state.session.id}/start`, async route => {
    bodies.push(route.request().postDataJSON());
    await route.continue();
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    const rejected = page.waitForResponse(response => new URL(response.url()).pathname === `/api/sessions/${state.session.id}/start` && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Start timer', exact: true }).click();
    expect((await rejected).status()).toBe(409);
    await expect(page.getByTestId('save-status')).toHaveText('Timing must include the effective entries');
    await expect(page.getByRole('button', { name: 'Start timer', exact: true })).toBeEnabled();
  }
  expect(bodies).toHaveLength(2);
  expect(bodies[0]!.op_id).not.toBe(bodies[1]!.op_id);
  expect((await current(page)).session.started_at).toBeNull();
  await expect(page.getByRole('region', { name: 'Unconfirmed forms', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Unsent entries', exact: true })).toHaveCount(0);
  const pending = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const opening = indexedDB.open('poker-banker'); opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error); });
    const outbox = await new Promise<number>((resolve, reject) => { const reading = db.transaction('outbox').objectStore('outbox').count(); reading.onsuccess = () => resolve(reading.result); reading.onerror = () => reject(reading.error); });
    const drafts = await new Promise<{ value?: { __submitted?: unknown } }[]>((resolve, reject) => { const reading = db.transaction('drafts').objectStore('drafts').getAll(); reading.onsuccess = () => resolve(reading.result); reading.onerror = () => reject(reading.error); });
    db.close(); return { outbox, submitted: drafts.filter(draft => draft.value?.__submitted).length };
  });
  expect(pending).toEqual({ outbox: 0, submitted: 0 });
  await menu(page, 'Correct times');
  await page.getByLabel('Started at', { exact: true }).fill('2026-11-10T18:00:00');
  await page.getByRole('button', { name: 'Save timing', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const saved = await current(page);
  expect(saved.session.started_at).toBe('2026-11-10T18:00:00.000Z');
  expect(saved.events.filter(event => event.kind === 'timer_started')).toHaveLength(0);
  expect(saved.events.filter(event => event.kind === 'timing_corrected')).toHaveLength(1);
});
