import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DraftRequest } from '../src/client/data';

type Row = { key?: string; op_id?: string; value?: unknown; [name: string]: unknown };
type RequestDouble = { result?: unknown; onsuccess?: () => void };
function sharedStorage() {
  let rows = new Map(['drafts', 'outbox', 'snapshots'].map(name => [name, new Map<string, Row>()]));
  let active = false;
  let quota = false;
  const waiting: (() => void)[] = [];
  const database = {
    transaction(_names: string | string[], mode?: string) {
      let local: typeof rows;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let finished = false;
      let ready = false;
      const actions: (() => void)[] = [];
      const release = () => {
        finished = true;
        if (timer) clearTimeout(timer);
        active = false;
        waiting.shift()?.();
      };
      const tx = {
        error: undefined as DOMException | undefined,
        oncomplete: undefined as (() => void) | undefined,
        onabort: undefined as (() => void) | undefined,
        abort() {
          if (finished) return;
          tx.error ??= new DOMException('Transaction aborted', 'AbortError');
          tx.onabort?.();
          release();
        },
        objectStore(name: string) {
          const request = (operation: (store: Map<string, Row>) => unknown, write = false) => {
            const result: RequestDouble = {};
            if (timer) clearTimeout(timer);
            actions.push(() => {
              if (write && quota) {
                tx.error = new DOMException('Storage quota exceeded', 'QuotaExceededError');
                tx.abort();
                return;
              }
              result.result = structuredClone(operation(local.get(name)!));
              result.onsuccess?.();
            });
            pump();
            return result;
          };
          return {
            get: (key: string) => request(store => store.get(key)),
            getAll: () => request(store => [...store.values()]),
            put: (row: Row) => request(store => { const key = String(row.key ?? row.op_id); store.set(key, structuredClone(row)); return key; }, true),
            add: (row: Row) => request(store => { const key = String(row.key ?? row.op_id); if (store.has(key)) throw new Error('Duplicate key'); store.set(key, structuredClone(row)); return key; }, true),
            delete: (key: string) => request(store => store.delete(key), true),
          };
        },
      };
      let busy = false;
      function pump() {
        if (!ready || finished || busy) return;
        const action = actions.shift();
        if (action) {
          busy = true;
          queueMicrotask(() => { action(); busy = false; pump(); });
        } else {
          timer = setTimeout(() => {
            if (mode === 'readwrite') rows = local;
            tx.oncomplete?.();
            release();
          }, 0);
        }
      }
      const start = () => { active = true; ready = true; local = structuredClone(rows); pump(); };
      if (active) waiting.push(start);
      else start();
      return tx;
    },
  };
  vi.stubGlobal('indexedDB', { open() {
    const opening: RequestDouble = {};
    queueMicrotask(() => { opening.result = database; opening.onsuccess?.(); });
    return opening;
  } });
  return {
    state: () => structuredClone(rows),
    draft: (key: string) => structuredClone(rows.get('drafts')!.get(key)?.value),
    quota: (full: boolean) => { quota = full; },
  };
}
const owner = 'banker';
const key = 'banker/session/buy_in/player';
const original = { op_id: 'original-operation', amount: '10' };
const newer = { ...original, amount: '25' };
const edited = { ...original, amount: '50' };
const request: DraftRequest = { path: '/api/sessions/session/entries', method: 'POST', body: { op_id: original.op_id, amount_minor: '1000' } };
const freshTab = async () => { vi.resetModules(); return import('../src/client/data'); };
type Tab = Awaited<ReturnType<typeof freshTab>>;
const enqueueInput = { banker_id: owner, session_id: 'session', path: request.path, body: request.body, label: 'Buy-in', draft_key: key };
const actions = {
  write: (tab: Tab) => tab.writeDraft(key, edited),
  discard: (tab: Tab) => tab.deleteDraft(key),
  freeze: (tab: Tab) => tab.prepareDraftSubmission(key, original, request),
  enqueue: (tab: Tab) => tab.enqueue(enqueueInput),
};
const settle = (operation: Promise<unknown>) => operation.catch(() => undefined);
function heldReply(rejected: boolean) {
  let release!: () => void;
  let arrived!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const sent = new Promise<void>(resolve => { arrived = resolve; });
  const fetch = vi.fn(async (path: string) => {
    if (path === '/api/auth/me') return new Response(JSON.stringify({ banker: { id: owner, username: owner } }), { headers: { 'X-PB-Banker-ID': owner } });
    arrived();
    await held;
    return new Response(JSON.stringify(rejected ? { error: { code: 'already_seated', message: 'Already seated' } } : { ok: true }), { status: rejected ? 409 : 200, headers: { 'X-PB-Banker-ID': owner } });
  });
  vi.stubGlobal('fetch', fetch);
  return { sent, release, fetch };
}
beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('window', { setTimeout, clearTimeout, dispatchEvent() {} });
});
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it.each(Object.entries(actions))('does not let a stale %s replace another tab\'s committed edit', async (_name, action) => {
  const storage = sharedStorage();
  const a = await freshTab();
  await a.writeDraft(key, original);
  await a.readDraft(key);
  const b = await freshTab();
  await b.readDraft(key);
  await b.writeDraft(key, newer);
  const before = storage.state();
  await settle(action(a));
  expect(storage.state()).toEqual(before);
  expect(storage.draft(key)).toEqual(newer);
  expect(await b.listOutbox(owner)).toEqual([]);
});

it.each(Object.entries(actions))('permits %s after the same tab reviews the current stored draft', async (name, action) => {
  const storage = sharedStorage();
  const tab = await freshTab();
  await tab.writeDraft(key, original);
  await tab.readDraft(key);
  await action(tab);
  if (name === 'write') expect(storage.draft(key)).toEqual(edited);
  if (name === 'discard') expect(storage.draft(key)).toBeUndefined();
  if (name === 'freeze') expect(storage.draft(key)).toMatchObject({ ...original, __submitted: request });
  if (name === 'enqueue') {
    expect(storage.draft(key)).toBeUndefined();
    expect((await tab.listOutbox(owner)).map(item => item.body)).toEqual([request.body]);
  }
});

it('does not let a quota retry overwrite another tab\'s newer committed edit', async () => {
  const storage = sharedStorage();
  const a = await freshTab();
  await a.writeDraft(key, original);
  storage.quota(true);
  await expect(a.writeDraft(key, edited)).rejects.toMatchObject({ name: 'QuotaExceededError' });
  storage.quota(false);
  const b = await freshTab();
  await b.readDraft(key);
  await b.writeDraft(key, newer);
  const before = storage.state();
  await settle(a.flushDraftWrites());
  expect(storage.state()).toEqual(before);
  expect(storage.draft(key)).toEqual(newer);
});

it('does not replace a newer next edit when writing to a frozen form from a stale tab', async () => {
  const storage = sharedStorage();
  const a = await freshTab();
  await a.writeDraft(key, original);
  await a.prepareDraftSubmission(key, original, request);
  const b = await freshTab();
  await b.readDraft(key);
  await b.writeDraft(key, newer);
  const before = storage.state();
  await settle(a.writeDraft(key, edited));
  expect(storage.state()).toEqual(before);
});

it.each(['read', 'list'] as const)('requires review of a newer frozen record before replay claimed from a stale %s', async observation => {
  const storage = sharedStorage();
  const a = await freshTab();
  await a.writeDraft(key, original);
  await a.prepareDraftSubmission(key, original, request);
  if (observation === 'read') await a.readDraft(key);
  else await a.listSubmittedDrafts(owner);
  const b = await freshTab();
  await b.readDraft(key);
  await b.writeDraft(key, newer);
  const before = storage.state();
  const server = heldReply(false);
  server.release();
  await settle(a.replaySubmittedDraft(key));
  expect(storage.state()).toEqual(before);
  expect(server.fetch).not.toHaveBeenCalled();
});

it.each([false, true])('does not settle over a draft changed after the replay was sent (rejected=%s)', async rejected => {
  const storage = sharedStorage();
  const a = await freshTab();
  await a.writeDraft(key, original);
  await a.prepareDraftSubmission(key, original, request);
  const server = heldReply(rejected);
  const pending = settle(a.replaySubmittedDraft(key));
  await server.sent;
  const b = await freshTab();
  await b.readDraft(key);
  await b.writeDraft(key, newer);
  const before = storage.state();
  server.release();
  await pending;
  expect(storage.state()).toEqual(before);
});

it('does not let idempotent enqueue replay delete a newer draft for the same form', async () => {
  const storage = sharedStorage();
  const a = await freshTab();
  await a.writeDraft(key, original);
  await a.enqueue(enqueueInput);
  const b = await freshTab();
  await b.readDraft(key);
  await b.writeDraft(key, newer);
  const before = storage.state();
  await settle(a.enqueue(enqueueInput));
  expect(storage.state()).toEqual(before);
  expect(storage.draft(key)).toEqual(newer);
});

it('does not clear a newer draft with consent collected before the other tab saved', async () => {
  const storage = sharedStorage();
  const a = await freshTab();
  await a.writeDraft(key, original);
  const consent = await a.readBankerWork(owner);
  const b = await freshTab();
  await b.readDraft(key);
  await b.writeDraft(key, newer);
  const before = storage.state();
  await expect(a.clearBankerData(owner, consent)).rejects.toThrow('Local work changed');
  expect(storage.state()).toEqual(before);
});
