import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DraftRequest } from '../src/client/data';

type Row = { key?: string; op_id?: string; value?: unknown; [name: string]: unknown };
type RequestDouble = { result?: unknown; error?: DOMException; onsuccess?: () => void; onerror?: () => void };
function sharedStorage() {
  let rows = new Map(['drafts', 'outbox', 'snapshots'].map(name => [name, new Map<string, Row>()]));
  let active = false;
  let quota = false;
  let failedRead: 'readonly' | 'any' | undefined;
  let hold: { started: () => void; release?: () => void } | undefined;
  const waiting: (() => void)[] = [];
  const database = {
    transaction(_names: string | string[], mode?: string) {
      let local: typeof rows;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let finished = false;
      let ready = false;
      let paused = false;
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
            const perform = () => {
              if (!write && failedRead && (failedRead === 'any' || mode !== 'readwrite')) {
                failedRead = undefined;
                result.error = new DOMException('Storage read failed', 'UnknownError');
                result.onerror?.();
                return;
              }
              if (write && quota) {
                tx.error = new DOMException('Storage quota exceeded', 'QuotaExceededError');
                tx.abort();
                return;
              }
              result.result = structuredClone(operation(local.get(name)!));
              result.onsuccess?.();
            };
            actions.push(() => {
              if (write && hold) {
                const held = hold;
                hold = undefined;
                paused = true;
                held.release = () => { perform(); paused = false; pump(); };
                held.started();
              } else perform();
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
        if (!ready || finished || busy || paused) return;
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
    failNextRead: () => { failedRead = 'readonly'; },
    failNextGet: () => { failedRead = 'any'; },
    holdNextWrite: () => {
      let started!: () => void;
      const pending = new Promise<void>(resolve => { started = resolve; });
      const held = { started, release: undefined as (() => void) | undefined };
      hold = held;
      return { started: pending, release: () => held.release!() };
    },
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
  expect(a.draftSaveFailed(key)).toBe(false);
  expect(a.hasPendingLocalWrites()).toBe(false);
  await expect(a.flushDraftWrites()).resolves.toBeUndefined();
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
  expect(a.draftSaveFailed(key)).toBe(false);
  expect(a.hasPendingLocalWrites()).toBe(false);
  await expect(a.flushDraftWrites()).resolves.toBeUndefined();
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
  let cursor: import('../src/client/data').DraftCursor = {};
  if (observation === 'read') await a.readDraft(key, cursor);
  else cursor = (await a.listSubmittedDrafts(owner))[0]!.cursor;
  const b = await freshTab();
  await b.readDraft(key);
  await b.writeDraft(key, newer);
  const before = storage.state();
  const server = heldReply(false);
  server.release();
  await settle(a.replaySubmittedDraft(key, () => true, cursor));
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
  expect(a.draftSaveFailed(key)).toBe(false);
  expect(a.hasPendingLocalWrites()).toBe(false);
  await expect(a.flushDraftWrites()).resolves.toBeUndefined();
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

it.each(['write', 'discard', 'freeze', 'enqueue'] as const)('keeps a stale %s cursor independent from another form and background reads in the same tab module', async action => {
  const storage = sharedStorage();
  const tab = await freshTab();
  await tab.writeDraft(key, original);
  const stale: import('../src/client/data').DraftCursor = {};
  const fresh: import('../src/client/data').DraftCursor = {};
  await tab.readDraft(key, stale);
  await tab.readDraft(key, fresh);
  await tab.writeDraft(key, newer, fresh);
  await tab.readDraft(key);
  const before = storage.state();
  if (action === 'write') await settle(tab.writeDraft(key, edited, stale));
  if (action === 'discard') await settle(tab.deleteDraft(key, () => true, stale));
  if (action === 'freeze') await settle(tab.prepareDraftSubmission(key, original, request, () => true, stale));
  if (action === 'enqueue') await settle(tab.enqueue({ ...enqueueInput, draft_cursor: stale }));
  expect(storage.state()).toEqual(before);
  expect(storage.draft(key)).toEqual(newer);
});

it.each([['quota', 'write'], ['quota', 'enqueue'], ['conflict', 'write'], ['conflict', 'enqueue']] as const)('does not pair an unsaved %s value with another tab\'s newer permission to %s', async (failure, action) => {
  const storage = sharedStorage();
  const a = await freshTab();
  const cursor: import('../src/client/data').DraftCursor = {};
  await a.readDraft(key, cursor);
  await a.writeDraft(key, original, cursor);
  const b = await freshTab();
  await b.readDraft(key);
  if (failure === 'quota') {
    storage.quota(true);
    await expect(a.writeDraft(key, edited, cursor)).rejects.toMatchObject({ name: 'QuotaExceededError' });
    storage.quota(false);
  }
  await b.writeDraft(key, newer);
  if (failure === 'conflict') await settle(a.writeDraft(key, edited, cursor));
  const before = storage.state();
  const restored = await a.readDraft<typeof edited>(key, cursor);
  if (restored?.amount === edited.amount) {
    if (action === 'write') await settle(a.writeDraft(key, restored, cursor));
    else await settle(a.enqueue({ ...enqueueInput, body: { ...request.body, amount_minor: '5000' }, draft_cursor: cursor }));
    expect(storage.state()).toEqual(before);
    expect(await a.listOutbox(owner)).toEqual([]);
  } else expect(restored).toEqual(newer);
  expect(storage.draft(key)).toEqual(newer);
});

it('permits saving only after a stale writer adopts and reviews the actual current draft', async () => {
  const storage = sharedStorage();
  const a = await freshTab();
  const cursor: import('../src/client/data').DraftCursor = {};
  await a.readDraft(key, cursor);
  await a.writeDraft(key, original, cursor);
  const b = await freshTab();
  await b.readDraft(key);
  await b.writeDraft(key, newer);
  let problem: unknown;
  try { await a.writeDraft(key, edited, cursor); } catch (error) { problem = error; }
  expect(problem).toBeInstanceOf(a.DraftConflictError);
  const conflict = problem as InstanceType<typeof a.DraftConflictError>;
  expect(conflict.value).toEqual(newer);
  a.acceptDraftConflict(key, cursor, conflict);
  expect(await a.readDraft(key, cursor)).toEqual(newer);
  await a.writeDraft(key, edited, cursor);
  expect(storage.draft(key)).toEqual(edited);
  expect(a.hasPendingLocalWrites()).toBe(false);
});

it.each([false, true])('an enqueue reservation includes own earlier writes but excludes own later edits (laterEdit=%s)', async laterEdit => {
  const storage = sharedStorage();
  const a = await freshTab();
  const cursor: import('../src/client/data').DraftCursor = {};
  await a.readDraft(key, cursor);
  await a.writeDraft(key, original, cursor);
  const hold = storage.holdNextWrite();
  const prior = { ...original, amount: '11' };
  const savingPrior = a.writeDraft(key, prior, cursor);
  await hold.started;
  const queuing = a.enqueue({ ...enqueueInput, body: { ...request.body, amount_minor: '1100' }, draft_cursor: cursor, draft_value: prior });
  const result = settle(queuing);
  const savingLater = laterEdit ? a.writeDraft(key, newer, cursor) : Promise.resolve();
  hold.release();
  await savingPrior;
  await savingLater;
  await result;
  if (laterEdit) {
    expect(storage.draft(key)).toEqual(newer);
    expect(await a.listOutbox(owner)).toEqual([]);
  } else {
    expect(storage.draft(key)).toBeUndefined();
    expect((await a.listOutbox(owner)).map(item => item.body)).toEqual([{ ...request.body, amount_minor: '1100' }]);
  }
});

it('loads the current frozen record for a key-only recovery while preserving its later edit and original request', async () => {
  const storage = sharedStorage();
  const a = await freshTab();
  await a.writeDraft(key, original);
  const b = await freshTab();
  await b.prepareDraftSubmission(key, original, request);
  await a.writeDraft(key, newer);
  const server = heldReply(false);
  server.release();
  await b.replaySubmittedDraft(key);
  await a.flushDraftWrites();
  const retained = storage.draft(key) as typeof newer & { __submitted?: DraftRequest };
  expect(retained.amount).toBe('25');
  expect(retained.op_id).not.toBe(original.op_id);
  expect(retained.__submitted).toBeUndefined();
  expect(a.hasPendingLocalWrites()).toBe(false);
  expect(a.draftSaveFailed(key)).toBe(false);
  expect(server.fetch).toHaveBeenNthCalledWith(2, request.path, expect.objectContaining({ body: JSON.stringify(request.body) }));
});

it('retains the dirty value baseline when a restoring read fails before a later edit', async () => {
  const storage = sharedStorage();
  const a = await freshTab();
  const cursor: import('../src/client/data').DraftCursor = {};
  await a.readDraft(key, cursor);
  await a.writeDraft(key, original, cursor);
  storage.quota(true);
  await expect(a.writeDraft(key, edited, cursor)).rejects.toMatchObject({ name: 'QuotaExceededError' });
  storage.quota(false);
  const b = await freshTab();
  await b.writeDraft(key, newer);
  const restoring: import('../src/client/data').DraftCursor = {};
  storage.failNextRead();
  const restored = await a.readDraft<typeof edited>(key, restoring);
  expect(restored?.amount).toBe(edited.amount);
  expect(restored?.op_id).not.toBe(original.op_id);
  await expect(a.writeDraft(key, { ...restored, amount: '124' }, restoring)).rejects.toBeInstanceOf(a.DraftConflictError);
  expect(storage.draft(key)).toEqual(newer);
});

it('retains the first attempted write baseline after quota rejects its transaction', async () => {
  const storage = sharedStorage();
  const a = await freshTab();
  storage.quota(true);
  await expect(a.writeDraft(key, original)).rejects.toMatchObject({ name: 'QuotaExceededError' });
  storage.quota(false);
  const b = await freshTab();
  await b.writeDraft(key, newer);
  await settle(a.flushDraftWrites());
  expect(a.draftSaveFailed(key)).toBe(false);
  expect(a.hasPendingLocalWrites()).toBe(false);
  await expect(a.flushDraftWrites()).resolves.toBeUndefined();
  expect(storage.draft(key)).toEqual(newer);
});

it.each([false, true])('reviews an absent draft before retry without approving a later insert (inserted=%s)', async inserted => {
  const storage = sharedStorage();
  const a = await freshTab();
  await a.writeDraft(key, original);
  expect(a.hasRetainedDraft(key, original)).toBe(false);
  storage.quota(true);
  await expect(a.writeDraft(key, edited)).rejects.toMatchObject({ name: 'QuotaExceededError' });
  expect(a.hasRetainedDraft(key, { ...edited })).toBe(true);
  expect(a.hasRetainedDraft(`${key}-other`, edited)).toBe(false);
  expect(a.hasRetainedDraft(key, newer)).toBe(false);
  expect(a.hasRetainedDraft(key, { ...edited, op_id: 'different-operation' })).toBe(false);
  expect(storage.draft(key)).toEqual(original);
  expect(a.hasPendingLocalWrites()).toBe(true);
  storage.quota(false);
  const b = await freshTab();
  await b.readDraft(key);
  await b.deleteDraft(key);
  const cursor: import('../src/client/data').DraftCursor = {};
  const recovered = await a.readDraft<typeof edited>(key, cursor);
  expect(recovered?.amount).toBe('50');
  expect(recovered?.op_id).not.toBe(original.op_id);
  expect(storage.draft(key)).toEqual(recovered);
  expect(a.hasRetainedDraft(key, recovered)).toBe(false);
  if (inserted) {
    await expect(b.writeDraft(key, newer)).rejects.toBeInstanceOf(b.DraftConflictError);
    expect(storage.draft(key)).toEqual(recovered);
    await b.readDraft(key);
    await b.writeDraft(key, newer);
    const stale = await a.enqueue({ ...enqueueInput, draft_cursor: cursor, draft_value: recovered, body: { op_id: recovered!.op_id, amount_minor: '5000' } });
    expect(stale).toMatchObject({ draft_conflict: true, value: newer });
    expect(await a.listOutbox(owner)).toEqual([]);
    await settle(a.flushDraftWrites());
    expect(a.draftSaveFailed(key)).toBe(false);
    expect(a.hasPendingLocalWrites()).toBe(false);
    await expect(a.flushDraftWrites()).resolves.toBeUndefined();
    expect(storage.draft(key)).toEqual(newer);
  } else {
    await a.flushDraftWrites();
    expect(storage.draft(key)).toEqual(recovered);
    expect(a.hasPendingLocalWrites()).toBe(false);
  }
});

it.each([false, true])('does not approve another tab after the first draft observation fails (inserted=%s)', async inserted => {
  const storage = sharedStorage();
  const a = await freshTab();
  storage.failNextGet();
  await expect(a.writeDraft(key, original)).rejects.toMatchObject({ name: 'UnknownError' });
  const b = await freshTab();
  if (inserted) {
    await b.writeDraft(key, newer);
    await settle(a.flushDraftWrites());
    expect(a.draftSaveFailed(key)).toBe(false);
    expect(a.hasPendingLocalWrites()).toBe(false);
    await expect(a.flushDraftWrites()).resolves.toBeUndefined();
    expect(storage.draft(key)).toEqual(newer);
  } else {
    const recovered = await a.readDraft<typeof original>(key);
    expect(recovered?.amount).toBe('10');
    expect(recovered?.op_id).not.toBe(original.op_id);
    await a.flushDraftWrites();
    expect(storage.draft(key)).toEqual(recovered);
    expect(a.hasPendingLocalWrites()).toBe(false);
  }
});

it('does not let a first-write enqueue reservation stay unbound after another tab saves', async () => {
  const storage = sharedStorage();
  const a = await freshTab();
  const b = await freshTab();
  const saving = a.writeDraft(key, original);
  const queuing = settle(a.enqueue(enqueueInput));
  const concurrent = b.writeDraft(key, newer);
  await saving;
  await concurrent;
  await queuing;
  expect(storage.draft(key)).toEqual(newer);
  expect(await a.listOutbox(owner)).toEqual([]);
});

it.each(['discard', 'enqueue'] as const)('does not %s a saved draft without any observation of it', async operation => {
  const storage = sharedStorage();
  const a = await freshTab();
  const b = await freshTab();
  await b.writeDraft(key, newer);
  const before = storage.state();
  await settle(operation === 'discard' ? a.deleteDraft(key) : a.enqueue(enqueueInput));
  expect(storage.state()).toEqual(before);
  expect(storage.draft(key)).toEqual(newer);
  expect(await a.listOutbox(owner)).toEqual([]);
});

function draftForm(tab: Tab, formKey: string, initial: typeof original) {
  const source = ts.transpileModule(readFileSync('src/client/views/common.tsx', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  let position = 0;
  const slots: unknown[] = [];
  const effects: (() => unknown)[] = [];
  const cleanup: (() => void)[] = [];
  function registerEffect(effect: () => unknown, dependencies: unknown[]) {
    const index = position++;
    const previous = slots[index] as unknown[] | undefined;
    if (!previous || dependencies.some((value, item) => value !== previous[item])) { slots[index] = dependencies; effects.push(effect); }
  }
  const hooks = {
    createContext: () => null, useContext: () => null,
    useRef(value: unknown) { const index = position++; return slots[index] ??= { current: value }; },
    useState(value: unknown) {
      const index = position++;
      if (!(index in slots)) slots[index] = typeof value === 'function' ? value() : value;
      return [slots[index], (next: unknown) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }];
    },
    useEffect: registerEffect,
    useLayoutEffect: registerEffect,
  };
  const exports: Record<string, unknown> = {};
  runInNewContext(source, {
    exports, require: (name: string) => name === 'react' ? hooks : name === '../data' ? tab : {},
    window, crypto, structuredClone, Event, CustomEvent, Error,
  });
  const useDraft = exports.useDraft as typeof import('../src/client/views/common').useDraft;
  return {
    render() {
      position = 0;
      const form = useDraft(formKey, initial);
      while (effects.length) {
        const result = effects.shift()!();
        if (typeof result === 'function') cleanup.push(result as () => void);
      }
      return form;
    },
    close() { for (const stop of cleanup) stop(); },
  };
}

it.each([false, true])('adopts the retained edit and clears a three-tab rejected value after frozen recovery (rejected=%s)', async rejected => {
  const bus = new EventTarget();
  vi.stubGlobal('window', { setTimeout, clearTimeout, dispatchEvent: bus.dispatchEvent.bind(bus), addEventListener: bus.addEventListener.bind(bus), removeEventListener: bus.removeEventListener.bind(bus) });
  const storage = sharedStorage();
  const editing = await freshTab();
  const freezing = await freshTab();
  const retaining = await freshTab();
  const harness = draftForm(editing, key, original);
  let form = harness.render();
  try {
    await vi.waitFor(() => { form = harness.render(); expect(form.ready).toBe(true); });
    form.update(original);
    await vi.waitFor(() => expect(storage.draft(key)).toEqual(original));
    await editing.flushDraftWrites();
    await editing.readDraft(key);
    form = harness.render();
    await freezing.readDraft(key);
    const retainingCursor: import('../src/client/data').DraftCursor = {};
    await retaining.readDraft(key, retainingCursor);
    await freezing.prepareDraftSubmission(key, original, request);
    await retaining.writeDraft(key, newer, retainingCursor);
    form.update(edited);
    await vi.waitFor(() => { form = harness.render(); expect(form.submitted).toBe(true); expect(form.error).toContain('edited in another tab'); });
    const server = heldReply(rejected);
    server.release();
    if (rejected) await expect(form.reconcile()).rejects.toMatchObject({ code: 'already_seated' });
    else await form.reconcile();
    await vi.waitFor(() => {
      form = harness.render();
      expect(form.value.amount).toBe('25');
      expect(form.submitted).toBe(false);
      expect(form.error).toBe('');
    });
    expect((storage.draft(key) as typeof newer).amount).toBe('25');
    expect(editing.draftSaveFailed(key)).toBe(false);
    expect(editing.hasPendingLocalWrites()).toBe(false);
    await expect(editing.flushDraftWrites()).resolves.toBeUndefined();
    await expect(editing.flushDraftWrites()).resolves.toBeUndefined();
    expect(server.fetch).toHaveBeenNthCalledWith(2, request.path, expect.objectContaining({ body: JSON.stringify(request.body) }));
  } finally { harness.close(); }
});

it.each([false, true])('does not turn a fingerprint conflict into a pending storage failure (frozen=%s)', async frozen => {
  const storage = sharedStorage();
  const editing = await freshTab();
  await editing.writeDraft(key, original);
  const other = await freshTab();
  await other.readDraft(key);
  if (frozen) await other.prepareDraftSubmission(key, original, request);
  await other.writeDraft(key, newer);
  await expect(editing.writeDraft(key, edited)).rejects.toBeInstanceOf(editing.DraftConflictError);
  expect(editing.draftSaveFailed(key)).toBe(false);
  expect(editing.hasPendingLocalWrites()).toBe(false);
  await expect(editing.flushDraftWrites()).resolves.toBeUndefined();
  expect(storage.state().get('outbox')!.size).toBe(0);
  const value = storage.draft(key) as typeof original;
  if (frozen) expect(value.amount).toBe('10');
  else expect(value.amount).toBe('25');
});

it('does not attach an older fingerprint conflict to a newer edit with a current observation', async () => {
  const storage = sharedStorage();
  const editing = await freshTab();
  const stale: import('../src/client/data').DraftCursor = {};
  await editing.readDraft(key, stale);
  await editing.writeDraft(key, original, stale);
  const other = await freshTab();
  await other.readDraft(key);
  await other.prepareDraftSubmission(key, original, request);
  await other.writeDraft(key, newer);
  const current: import('../src/client/data').DraftCursor = {};
  await editing.readDraft(key, current);
  const rejected = editing.writeDraft(key, edited, stale);
  const failure = expect(rejected).rejects.toBeInstanceOf(editing.DraftConflictError);
  const latest = { ...original, amount: '60' };
  const saved = editing.writeDraft(key, latest, current);
  await failure;
  await expect(saved).resolves.toBeUndefined();
  expect(storage.state().get('drafts')!.get(key)!.next_value).toEqual(latest);
  expect((storage.draft(key) as typeof original).amount).toBe('10');
  expect(editing.draftSaveFailed(key)).toBe(false);
  expect(editing.hasPendingLocalWrites()).toBe(false);
  await expect(editing.flushDraftWrites()).resolves.toBeUndefined();
});

it.each([false, true])('releases a quota-failed value when discarding it encounters a newer saved draft (reopened=%s)', async reopened => {
  const storage = sharedStorage();
  const editing = await freshTab();
  let cursor: import('../src/client/data').DraftCursor = {};
  await editing.readDraft(key, cursor);
  await editing.writeDraft(key, original, cursor);
  storage.quota(true);
  await expect(editing.writeDraft(key, edited, cursor)).rejects.toMatchObject({ name: 'QuotaExceededError' });
  storage.quota(false);
  if (reopened) {
    cursor = {};
    expect(await editing.readDraft(key, cursor)).toEqual(edited);
  }
  const other = await freshTab();
  await other.writeDraft(key, newer);
  let conflict: unknown;
  try { await editing.deleteDraft(key, () => true, cursor); } catch (problem) { conflict = problem; }
  expect(conflict).toBeInstanceOf(editing.DraftConflictError);
  editing.acceptDraftConflict(key, cursor, conflict as InstanceType<typeof editing.DraftConflictError>);
  expect(await editing.readDraft(key, cursor)).toEqual(newer);
  expect(editing.draftSaveFailed(key)).toBe(false);
  expect(editing.hasPendingLocalWrites()).toBe(false);
  await expect(editing.flushDraftWrites()).resolves.toBeUndefined();
  expect(storage.draft(key)).toEqual(newer);
});

it('releases a quota-failed value when a frozen replay claim encounters a newer retained edit', async () => {
  const storage = sharedStorage();
  const editing = await freshTab();
  const cursor: import('../src/client/data').DraftCursor = {};
  await editing.readDraft(key, cursor);
  await editing.writeDraft(key, original, cursor);
  storage.quota(true);
  await expect(editing.writeDraft(key, edited, cursor)).rejects.toMatchObject({ name: 'QuotaExceededError' });
  storage.quota(false);
  const other = await freshTab();
  await other.prepareDraftSubmission(key, original, request);
  await other.writeDraft(key, newer);
  const server = heldReply(false);
  server.release();
  let conflict: unknown;
  try { await editing.replaySubmittedDraft(key, () => true, cursor); } catch (problem) { conflict = problem; }
  expect(conflict).toBeInstanceOf(editing.DraftConflictError);
  expect(server.fetch).not.toHaveBeenCalled();
  editing.acceptDraftConflict(key, cursor, conflict as InstanceType<typeof editing.DraftConflictError>);
  expect(editing.draftSaveFailed(key)).toBe(false);
  expect(editing.hasPendingLocalWrites()).toBe(false);
  await editing.replaySubmittedDraft(key, () => true, cursor);
  expect((await editing.readDraft<typeof newer>(key))?.amount).toBe('25');
  await expect(editing.flushDraftWrites()).resolves.toBeUndefined();
});

it.each([false, true])('releases a quota-failed value when replay settlement encounters a newer retained edit (rejected=%s)', async rejected => {
  const storage = sharedStorage();
  const editing = await freshTab();
  const cursor: import('../src/client/data').DraftCursor = {};
  await editing.readDraft(key, cursor);
  await editing.writeDraft(key, original, cursor);
  const other = await freshTab();
  await other.prepareDraftSubmission(key, original, request);
  storage.quota(true);
  await expect(editing.writeDraft(key, edited, cursor)).rejects.toMatchObject({ name: 'QuotaExceededError' });
  storage.quota(false);
  const server = heldReply(rejected);
  const pending = editing.replaySubmittedDraft(key, () => true, cursor);
  const failure = expect(pending).rejects.toBeInstanceOf(editing.DraftConflictError);
  await server.sent;
  await other.writeDraft(key, newer);
  server.release();
  await failure;
  expect(editing.draftSaveFailed(key)).toBe(false);
  expect(editing.hasPendingLocalWrites()).toBe(false);
  await expect(editing.flushDraftWrites()).resolves.toBeUndefined();
  const row = storage.state().get('drafts')!.get(key)!;
  expect(row.next_value).toEqual(newer);
  expect((row.value as typeof original).amount).toBe('10');
});

it('does not discard a newer genuine failed intent while rejecting an older discard', async () => {
  const storage = sharedStorage();
  const editing = await freshTab();
  const stale: import('../src/client/data').DraftCursor = {};
  await editing.readDraft(key, stale);
  await editing.writeDraft(key, original, stale);
  storage.quota(true);
  await expect(editing.writeDraft(key, edited, stale)).rejects.toMatchObject({ name: 'QuotaExceededError' });
  storage.quota(false);
  const other = await freshTab();
  await other.writeDraft(key, newer);
  const current: import('../src/client/data').DraftCursor = {};
  await other.readDraft(key, current);
  const discarding = editing.deleteDraft(key, () => true, stale);
  const discardFailure = expect(discarding).rejects.toBeInstanceOf(editing.DraftConflictError);
  storage.quota(true);
  const latest = { ...original, amount: '60' };
  const saving = editing.writeDraft(key, latest, current);
  const saveFailure = expect(saving).rejects.toMatchObject({ name: 'QuotaExceededError' });
  await discardFailure;
  await saveFailure;
  expect(editing.draftSaveFailed(key)).toBe(true);
  expect(editing.hasPendingLocalWrites()).toBe(true);
  expect(await editing.readDraft(key)).toEqual(latest);
  expect(storage.draft(key)).toEqual(newer);
  storage.quota(false);
  await editing.flushDraftWrites();
  expect(storage.draft(key)).toEqual(latest);
  expect(editing.hasPendingLocalWrites()).toBe(false);
});

it('shows the conflict notice when a stale first submission adopts a newer frozen form', async () => {
  const bus = new EventTarget();
  vi.stubGlobal('window', { setTimeout, clearTimeout, dispatchEvent: bus.dispatchEvent.bind(bus), addEventListener: bus.addEventListener.bind(bus), removeEventListener: bus.removeEventListener.bind(bus) });
  const storage = sharedStorage();
  const editing = await freshTab();
  const harness = draftForm(editing, key, original);
  let form = harness.render();
  try {
    await vi.waitFor(() => { form = harness.render(); expect(form.ready).toBe(true); });
    form.update(original);
    await vi.waitFor(() => expect(storage.draft(key)).toEqual(original));
    await editing.flushDraftWrites();
    await editing.readDraft(key);
    form = harness.render();
    const other = await freshTab();
    await other.writeDraft(key, newer);
    const newerRequest = { ...request, body: { ...request.body, amount_minor: '2500' } };
    await other.prepareDraftSubmission(key, newer, newerRequest);
    const before = storage.state();
    await expect(form.submit(request.path, request.body)).rejects.toThrow('edited in another tab');
    form = harness.render();
    expect(form.value.amount).toBe('25');
    expect(form.submitted).toBe(true);
    expect(form.error).toContain('edited in another tab');
    expect(editing.hasPendingLocalWrites()).toBe(false);
    expect(editing.draftSaveFailed(key)).toBe(false);
    expect(storage.state()).toEqual(before);
  } finally { harness.close(); }
});

it('saves a recovered quota write beside an unchanged frozen request instead of reporting a storage failure', async () => {
  const storage = sharedStorage();
  const editing = await freshTab();
  await editing.writeDraft(key, original);
  storage.quota(true);
  await expect(editing.writeDraft(key, edited)).rejects.toMatchObject({ name: 'QuotaExceededError' });
  expect(editing.draftSaveFailed(key)).toBe(true);
  storage.quota(false);
  const other = await freshTab();
  await other.prepareDraftSubmission(key, original, request);
  await expect(editing.flushDraftWrites()).resolves.toBeUndefined();
  const row = storage.state().get('drafts')!.get(key)!;
  expect(row.value).toEqual({ ...original, __submitted: request });
  expect(row.next_value).toEqual(edited);
  expect(editing.draftSaveFailed(key)).toBe(false);
  expect(editing.hasPendingLocalWrites()).toBe(false);
  await expect(editing.flushDraftWrites()).resolves.toBeUndefined();
});

it.each([false, true])('releases a rejected quota value when an observed frozen row has already settled elsewhere (retained=%s)', async retained => {
  const storage = sharedStorage();
  const editing = await freshTab();
  const cursor: import('../src/client/data').DraftCursor = {};
  await editing.readDraft(key, cursor);
  await editing.writeDraft(key, original, cursor);
  storage.quota(true);
  await expect(editing.writeDraft(key, edited, cursor)).rejects.toMatchObject({ name: 'QuotaExceededError' });
  storage.quota(false);
  const other = await freshTab();
  await other.prepareDraftSubmission(key, original, request);
  expect(await editing.readDraft(key, cursor)).toEqual({ ...original, __submitted: request });
  if (retained) await other.writeDraft(key, newer);
  const server = heldReply(false);
  server.release();
  await other.replaySubmittedDraft(key);
  await expect(editing.replaySubmittedDraft(key, () => true, cursor)).rejects.toBeInstanceOf(editing.DraftConflictError);
  expect(editing.draftSaveFailed(key)).toBe(false);
  expect(editing.hasPendingLocalWrites()).toBe(false);
  const recovered = await editing.readDraft<typeof newer>(key);
  if (retained) expect(recovered?.amount).toBe('25');
  else expect(recovered).toBeUndefined();
  await expect(editing.flushDraftWrites()).resolves.toBeUndefined();
  expect(server.fetch).toHaveBeenCalledTimes(2);
  const row = storage.state().get('drafts')!.get(key);
  if (retained) expect((row?.value as typeof newer).amount).toBe('25');
  else expect(row).toBeUndefined();
});

it('keeps newer typing visible when a pending discard finishes and asks the banker to review it', async () => {
  const bus = new EventTarget();
  vi.stubGlobal('window', { setTimeout, clearTimeout, dispatchEvent: bus.dispatchEvent.bind(bus), addEventListener: bus.addEventListener.bind(bus), removeEventListener: bus.removeEventListener.bind(bus) });
  const storage = sharedStorage();
  const editing = await freshTab();
  const harness = draftForm(editing, key, original);
  let form = harness.render();
  try {
    await vi.waitFor(() => { form = harness.render(); expect(form.ready).toBe(true); });
    form.update(original);
    await vi.waitFor(() => expect(storage.draft(key)).toEqual(original));
    await editing.flushDraftWrites();
    await editing.readDraft(key);
    form = harness.render();
    const held = storage.holdNextWrite();
    const clearing = form.clear().then(() => ({ cleared: true as const }), error => ({ cleared: false as const, error }));
    await held.started;
    form.update(edited);
    form = harness.render();
    expect(form.value.amount).toBe('50');
    held.release();
    const outcome = await clearing;
    await editing.flushDraftWrites();
    await editing.readDraft(key);
    form = harness.render();
    expect(form.value.amount).toBe('50');
    expect(storage.draft(key)).toEqual(edited);
    expect(outcome.cleared).toBe(false);
    if (!outcome.cleared) expect(outcome.error).toBeInstanceOf(Error);
    if (!outcome.cleared) expect(outcome.error.message).toMatch(/review/i);
    expect(editing.draftSaveFailed(key)).toBe(false);
    expect(editing.hasPendingLocalWrites()).toBe(false);
    await expect(editing.flushDraftWrites()).resolves.toBeUndefined();
  } finally { harness.close(); }
});

it.each([false, true])('does not silently adopt another tab after a completed save reads back later data (newerTyping=%s)', async newerTyping => {
  const bus = new EventTarget();
  vi.stubGlobal('window', { setTimeout, clearTimeout, dispatchEvent: bus.dispatchEvent.bind(bus), addEventListener: bus.addEventListener.bind(bus), removeEventListener: bus.removeEventListener.bind(bus) });
  const storage = sharedStorage();
  const editing = await freshTab();
  const other = await freshTab();
  let pauseNextRead = false;
  let arrived!: () => void;
  let release!: () => void;
  let completed!: () => void;
  const started = new Promise<void>(resolve => { arrived = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const finished = new Promise<void>(resolve => { completed = resolve; });
  const viewData: Tab = { ...editing, async readDraft<T>(draftKey: string, cursor?: import('../src/client/data').DraftCursor) {
    const paused = pauseNextRead;
    if (paused) { pauseNextRead = false; arrived(); await held; }
    const value = await editing.readDraft<T>(draftKey, cursor);
    if (paused) completed();
    return value;
  } };
  const harness = draftForm(viewData, key, original);
  let form = harness.render();
  try {
    await vi.waitFor(() => { form = harness.render(); expect(form.ready).toBe(true); });
    form.update(original);
    await vi.waitFor(() => expect(storage.draft(key)).toEqual(original));
    await editing.flushDraftWrites();
    await editing.readDraft(key);
    form = harness.render();
    pauseNextRead = true;
    form.update({ ...original, amount: '11' });
    await started;
    if (newerTyping) {
      form = harness.render();
      form.update({ ...original, amount: '60' });
      await vi.waitFor(() => expect((storage.draft(key) as typeof original).amount).toBe('60'));
      await editing.readDraft(key);
      form = harness.render();
    }
    const cursor: import('../src/client/data').DraftCursor = {};
    await other.readDraft(key, cursor);
    await other.writeDraft(key, newer, cursor);
    release();
    await finished;
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    form = harness.render();
    if (newerTyping) expect(form.value.amount).toBe('60');
    else {
      expect(form.value.amount).toBe('25');
      expect(form.error).toContain('edited in another tab');
    }
    expect(storage.draft(key)).toEqual(newer);
    expect(editing.draftSaveFailed(key)).toBe(false);
    expect(editing.hasPendingLocalWrites()).toBe(false);
  } finally { release(); harness.close(); }
});

it.each([false, true])('shows a closed form rejection after reopening without approving a stale fingerprint (advanced=%s)', async advanced => {
  const bus = new EventTarget();
  vi.stubGlobal('window', { setTimeout, clearTimeout, dispatchEvent: bus.dispatchEvent.bind(bus), addEventListener: bus.addEventListener.bind(bus), removeEventListener: bus.removeEventListener.bind(bus) });
  const storage = sharedStorage();
  const editing = await freshTab();
  const other = await freshTab();
  const harness = draftForm(editing, key, original);
  let form = harness.render();
  await vi.waitFor(() => { form = harness.render(); expect(form.ready).toBe(true); });
  form.update(original);
  await vi.waitFor(() => expect(storage.draft(key)).toEqual(original));
  await editing.flushDraftWrites();
  await editing.readDraft(key);
  form = harness.render();
  const cursor: import('../src/client/data').DraftCursor = {};
  await other.readDraft(key, cursor);
  await other.writeDraft(key, newer, cursor);
  form.update(edited);
  harness.close();
  await editing.flushDraftWrites();
  if (advanced) await other.writeDraft(key, { ...newer, amount: '30' }, cursor);
  const reopened = draftForm(editing, key, original);
  let current = reopened.render();
  try {
    await vi.waitFor(() => {
      current = reopened.render();
      expect(current.ready).toBe(true);
      expect(current.value.amount).toBe(advanced ? '30' : '25');
      expect(current.error).toContain('edited in another tab');
    });
    expect(editing.draftConflictNotice(key)).toBeUndefined();
    expect(editing.hasPendingLocalWrites()).toBe(false);
    expect(editing.draftSaveFailed(key)).toBe(false);
    await expect(editing.flushDraftWrites()).resolves.toBeUndefined();
    await expect(editing.flushDraftWrites()).resolves.toBeUndefined();
    const reviewed = { ...current.value, amount: advanced ? '31' : '26' };
    current.update(reviewed);
    await vi.waitFor(() => expect(storage.draft(key)).toEqual(reviewed));
    await editing.flushDraftWrites();
    await editing.readDraft(key);
    current = reopened.render();
    expect(current.value.amount).toBe(reviewed.amount);
    expect(current.error).toBe('');
    expect(editing.hasPendingLocalWrites()).toBe(false);
    expect(editing.draftSaveFailed(key)).toBe(false);
  } finally { reopened.close(); }
});

it('keeps a newer conflict visible when an old warning is dismissed and scopes notices to their banker', async () => {
  sharedStorage();
  const editing = await freshTab();
  const other = await freshTab();
  const cursor: import('../src/client/data').DraftCursor = {};
  await editing.readDraft(key, cursor);
  await editing.writeDraft(key, original, cursor);
  await other.writeDraft(key, newer);
  const first = await editing.writeDraft(key, edited, cursor).then(() => undefined, problem => problem);
  expect(first).toBeInstanceOf(editing.DraftConflictError);
  expect(editing.draftConflictNotice(key)).toBe(first);
  await editing.readDraft(key, cursor);
  await other.writeDraft(key, { ...newer, amount: '30' });
  const second = await editing.writeDraft(key, { ...edited, amount: '60' }, cursor).then(() => undefined, problem => problem);
  expect(second).toBeInstanceOf(editing.DraftConflictError);
  editing.dismissDraftConflict(first);
  expect(editing.draftConflictNotice(key)).toBe(second);
  expect(editing.draftConflictNotices(owner)).toEqual([second]);
  expect(editing.draftConflictNotices('another-banker')).toEqual([]);
  expect(editing.hasPendingLocalWrites()).toBe(false);
  expect(editing.draftSaveFailed(key)).toBe(false);
  editing.dismissDraftConflict(second);
  expect(editing.draftConflictNotice(key)).toBeUndefined();
  expect(editing.draftConflictNotices(owner)).toEqual([]);
});

function operationServer() {
  const applied = new Map<string, { body: string; state: object }>();
  let writes = 0;
  let drop = false;
  const fetch = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/me') return Response.json({ banker: { id: owner, username: owner } }, { headers: { 'X-PB-Banker-ID': owner } });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const op = String(body.op_id);
    const previous = applied.get(op);
    if (previous && previous.body !== JSON.stringify(body)) return Response.json({ error: { code: 'idempotency_mismatch', message: 'This operation already has different content' } }, { status: 409, headers: { 'X-PB-Banker-ID': owner } });
    const state = previous?.state ?? { session: { id: 'session' }, revision: String(++writes), server_now: '2026-11-11T00:00:00Z' };
    if (!previous) applied.set(op, { body: JSON.stringify(body), state });
    if (drop) { drop = false; throw new TypeError('Response lost after commit'); }
    return Response.json(state, { headers: { 'X-PB-Banker-ID': owner } });
  });
  vi.stubGlobal('fetch', fetch);
  return { fetch, applied, writes: () => writes, loseNextReply: () => { drop = true; } };
}
function outboxEvents() {
  const bus = new EventTarget();
  vi.stubGlobal('window', { setTimeout, clearTimeout, setInterval, clearInterval, dispatchEvent: bus.dispatchEvent.bind(bus), addEventListener: bus.addEventListener.bind(bus), removeEventListener: bus.removeEventListener.bind(bus) });
  vi.stubGlobal('navigator', { onLine: true });
}
async function drainApplied(tab: Tab) {
  const stop = tab.syncOutbox(owner, () => {}, () => {});
  try { await vi.waitFor(async () => expect(await tab.listOutbox(owner)).toEqual([])); }
  finally { stop(); }
}

it.each([false, true])('recovers a quota-retained value with a fresh operation before review after another tab saved its former operation (lostReply=%s)', async lostReply => {
  outboxEvents();
  const storage = sharedStorage();
  const server = operationServer();
  const editing = await freshTab();
  await editing.writeDraft(key, original);
  await editing.readDraft(key);
  storage.quota(true);
  await expect(editing.writeDraft(key, edited)).rejects.toMatchObject({ name: 'QuotaExceededError' });
  storage.quota(false);
  const other = await freshTab();
  const otherCursor: import('../src/client/data').DraftCursor = {};
  await other.readDraft(key, otherCursor);
  await other.enqueue({ ...enqueueInput, draft_cursor: otherCursor, draft_value: original });
  if (lostReply) {
    server.loseNextReply();
    const stop = other.syncOutbox(owner, () => {}, () => {});
    try { await vi.waitFor(async () => expect((await other.listOutbox(owner))[0]).toMatchObject({ status: 'uncertain', delivery: 'uncertain', body: request.body })); }
    finally { stop(); }
  } else await drainApplied(other);
  const originalItems = await other.listOutbox(owner);
  const cursor: import('../src/client/data').DraftCursor = {};
  const recovered = await editing.readDraft<typeof edited>(key, cursor);
  expect(recovered?.amount).toBe('50');
  expect(recovered?.op_id).not.toBe(original.op_id);
  expect(editing.draftConflictNotice(key)?.message).toMatch(/review/i);
  expect(await editing.listOutbox(owner)).toEqual(originalItems);
  await editing.flushDraftWrites();
  expect(editing.hasPendingLocalWrites()).toBe(false);
  expect(editing.draftSaveFailed(key)).toBe(false);
  const saved = await editing.readDraft<typeof edited>(key, cursor);
  expect(saved).toEqual(recovered);
  if (lostReply) {
    expect((await other.listOutbox(owner))[0]).toMatchObject({ status: 'uncertain', delivery: 'uncertain', body: request.body });
    await expect(other.discardItem(original.op_id)).rejects.toThrow(/may already exist/i);
    await other.retryItem(original.op_id);
    await drainApplied(other);
    expect(server.writes()).toBe(1);
  }
  await editing.enqueue({ ...enqueueInput, body: { op_id: saved!.op_id, amount_minor: '5000' }, draft_cursor: cursor, draft_value: saved });
  await drainApplied(editing);
  expect(server.writes()).toBe(2);
  expect(server.applied.get(original.op_id)?.body).toBe(JSON.stringify(request.body));
  expect(await editing.listOutbox(owner)).toEqual([]);
  expect(storage.draft(key)).toBeUndefined();
});

it('returns a frozen idempotency conflict to review without declaring the original operation not applied', async () => {
  outboxEvents();
  const storage = sharedStorage();
  const server = operationServer();
  await fetch(request.path, { method: request.method, body: JSON.stringify(request.body) });
  const editing = await freshTab();
  const cursor: import('../src/client/data').DraftCursor = {};
  await editing.readDraft(key, cursor);
  await editing.writeDraft(key, edited, cursor);
  const differentRequest = { ...request, body: { ...request.body, amount_minor: '5000' } };
  await editing.prepareDraftSubmission(key, edited, differentRequest, () => true, cursor);
  let failure: unknown;
  try { await editing.replaySubmittedDraft(key, () => true, cursor); } catch (problem) { failure = problem; }
  expect(failure).toMatchObject({ code: 'idempotency_mismatch', status: 409 });
  expect(editing.isProvenNotApplied(failure)).toBe(false);
  const recovered = storage.draft(key) as typeof edited & { __submitted?: DraftRequest };
  expect(recovered.amount).toBe('50');
  expect(recovered.op_id).not.toBe(original.op_id);
  expect(recovered.__submitted).toBeUndefined();
  expect(editing.draftConflictNotice(key)?.message).toMatch(/review/i);
  expect(await editing.listSubmittedDrafts(owner)).toEqual([]);
  expect(editing.hasPendingLocalWrites()).toBe(false);
  expect(editing.draftSaveFailed(key)).toBe(false);
  await expect(editing.flushDraftWrites()).resolves.toBeUndefined();
  expect(server.writes()).toBe(1);
  expect(server.applied.get(original.op_id)?.body).toBe(JSON.stringify(request.body));
});

it('keeps an earlier uncertain request while refusing a different body with its claimed operation before delivery', async () => {
  outboxEvents();
  const storage = sharedStorage();
  const server = operationServer();
  const first = await freshTab();
  await first.writeDraft(key, original);
  await first.enqueue(enqueueInput);
  server.loseNextReply();
  const stop = first.syncOutbox(owner, () => {}, () => {});
  try { await vi.waitFor(async () => expect((await first.listOutbox(owner))[0]).toMatchObject({ status: 'uncertain', delivery: 'uncertain' })); }
  finally { stop(); }
  const originalItem = (await first.listOutbox(owner))[0];
  const editing = await freshTab();
  const cursor: import('../src/client/data').DraftCursor = {};
  await editing.readDraft(key, cursor);
  await editing.writeDraft(key, edited, cursor);
  let conflict: unknown;
  try { conflict = await editing.enqueue({ ...enqueueInput, body: { ...request.body, amount_minor: '5000' }, draft_cursor: cursor, draft_value: edited }); }
  catch (problem) { conflict = problem; }
  expect(conflict).toMatchObject({ draft_conflict: true, value: { amount: '50' } });
  expect((conflict as { value: typeof edited }).value.op_id).not.toBe(original.op_id);
  expect((storage.draft(key) as typeof edited).amount).toBe('50');
  expect(await editing.listOutbox(owner)).toEqual([originalItem]);
  expect(server.writes()).toBe(1);
  expect(editing.hasPendingLocalWrites()).toBe(false);
  expect(editing.draftSaveFailed(key)).toBe(false);
  await expect(first.discardItem(original.op_id)).rejects.toThrow(/may already exist/i);
});

it.each([undefined, 'different-banker'])('does not release a frozen operation when its mismatch response has an unverified owner (%s)', async responseOwner => {
  outboxEvents();
  const storage = sharedStorage();
  const editing = await freshTab();
  await editing.writeDraft(key, original);
  await editing.prepareDraftSubmission(key, original, request);
  const before = storage.state();
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === '/api/auth/me') return Response.json({ banker: { id: owner, username: owner } }, { headers: { 'X-PB-Banker-ID': owner } });
    return Response.json({ error: { code: 'idempotency_mismatch', message: 'This operation already has different content' } }, { status: 409, headers: responseOwner ? { 'X-PB-Banker-ID': responseOwner } : {} });
  }));
  await expect(editing.replaySubmittedDraft(key)).rejects.toBeInstanceOf(Error);
  expect(storage.state().get('outbox')).toEqual(before.get('outbox'));
  expect(storage.state().get('snapshots')).toEqual(before.get('snapshots'));
  expect(storage.draft(key)).toEqual(before.get('drafts')!.get(key)!.value);
  expect((storage.draft(key) as { __submitted?: DraftRequest }).__submitted).toEqual(request);
  expect(editing.draftConflictNotice(key)).toBeUndefined();
});

it('replays an unchanged frozen request with its original operation and records only one server write', async () => {
  outboxEvents();
  const storage = sharedStorage();
  const server = operationServer();
  await fetch(request.path, { method: request.method, body: JSON.stringify(request.body) });
  const editing = await freshTab();
  await editing.writeDraft(key, original);
  await editing.prepareDraftSubmission(key, original, request);
  await editing.replaySubmittedDraft(key);
  expect(server.writes()).toBe(1);
  expect(server.applied.get(original.op_id)?.body).toBe(JSON.stringify(request.body));
  expect(storage.draft(key)).toBeUndefined();
  expect(await editing.listSubmittedDrafts(owner)).toEqual([]);
  expect(editing.hasPendingLocalWrites()).toBe(false);
});

it('restores a sourced outbox mismatch as editable fresh work without a stuck rejected entry', async () => {
  outboxEvents();
  const storage = sharedStorage();
  const server = operationServer();
  await fetch(request.path, { method: request.method, body: JSON.stringify(request.body) });
  const editing = await freshTab();
  const cursor: import('../src/client/data').DraftCursor = {};
  await editing.readDraft(key, cursor);
  await editing.writeDraft(key, edited, cursor);
  await editing.enqueue({ ...enqueueInput, body: { ...request.body, amount_minor: '5000' }, draft_cursor: cursor, draft_value: edited });
  await drainApplied(editing);
  const recovered = await editing.readDraft<typeof edited>(key, {});
  expect(recovered?.amount).toBe('50');
  expect(recovered?.op_id).not.toBe(original.op_id);
  expect((recovered as { __submitted?: DraftRequest }).__submitted).toBeUndefined();
  expect(editing.draftConflictNotice(key)?.message).toMatch(/review/i);
  expect(await editing.listOutbox(owner)).toEqual([]);
  expect(editing.hasPendingLocalWrites()).toBe(false);
  expect(editing.draftSaveFailed(key)).toBe(false);
  await expect(editing.flushDraftWrites()).resolves.toBeUndefined();
  expect(server.writes()).toBe(1);
  expect(server.applied.get(original.op_id)?.body).toBe(JSON.stringify(request.body));
  expect((storage.draft(key) as typeof edited).amount).toBe('50');
});

it('retains a legacy outbox mismatch for explicit review without sending a new operation automatically', async () => {
  outboxEvents();
  const storage = sharedStorage();
  const server = operationServer();
  await fetch(request.path, { method: request.method, body: JSON.stringify(request.body) });
  const editing = await freshTab();
  await editing.enqueue({ banker_id: owner, session_id: 'session', path: request.path, body: { ...request.body, amount_minor: '5000' }, label: 'Buy-in' });
  await drainApplied(editing);
  const records = [...storage.state().get('drafts')!.values()];
  const editable = records.map(record => record.value as { op_id?: string; amount_minor?: string; __submitted?: DraftRequest }).find(value => value.amount_minor === '5000');
  expect(editable).toBeDefined();
  expect(editable?.op_id).not.toBe(original.op_id);
  expect(editable?.__submitted).toBeUndefined();
  expect(editing.draftConflictNotices(owner).some(problem => /review/i.test(problem.message))).toBe(true);
  expect(await editing.listOutbox(owner)).toEqual([]);
  expect(editing.hasPendingLocalWrites()).toBe(false);
  expect(editing.draftSaveFailed()).toBe(false);
  expect(server.writes()).toBe(1);
  expect(server.fetch).toHaveBeenCalledTimes(2);
});

it.each(['uncertain', 'confirmed'] as const)('refuses to freeze a different body with an earlier %s operation before delivery', async earlier => {
  outboxEvents();
  const storage = sharedStorage();
  const server = operationServer();
  const first = await freshTab();
  await first.writeDraft(key, original);
  await first.enqueue(enqueueInput);
  if (earlier === 'uncertain') {
    server.loseNextReply();
    const stop = first.syncOutbox(owner, () => {}, () => {});
    try { await vi.waitFor(async () => expect((await first.listOutbox(owner))[0]).toMatchObject({ status: 'uncertain', delivery: 'uncertain' })); }
    finally { stop(); }
  } else await drainApplied(first);
  const originalItems = await first.listOutbox(owner);
  const editing = await freshTab();
  const cursor: import('../src/client/data').DraftCursor = {};
  await editing.readDraft(key, cursor);
  await editing.writeDraft(key, edited, cursor);
  const changedRequest = { ...request, body: { ...request.body, amount_minor: '5000' } };
  let conflict: unknown;
  try { conflict = await editing.prepareDraftSubmission(key, edited, changedRequest, () => true, cursor); }
  catch (problem) { conflict = problem; }
  const visible = (conflict as { value?: typeof edited }).value;
  expect(visible?.amount).toBe('50');
  expect(visible?.op_id).not.toBe(original.op_id);
  expect((storage.draft(key) as { __submitted?: DraftRequest }).__submitted).toBeUndefined();
  expect((storage.draft(key) as typeof edited).amount).toBe('50');
  expect(await editing.listOutbox(owner)).toEqual(originalItems);
  expect(editing.hasPendingLocalWrites()).toBe(false);
  expect(editing.draftSaveFailed(key)).toBe(false);
  expect(server.writes()).toBe(1);
  expect(server.applied.get(original.op_id)?.body).toBe(JSON.stringify(request.body));
});

it('does not release a submitted mismatch after the replay owner scope is invalidated', async () => {
  outboxEvents();
  const storage = sharedStorage();
  const editing = await freshTab();
  await editing.writeDraft(key, original);
  await editing.prepareDraftSubmission(key, original, request);
  let arrived!: () => void;
  let release!: () => void;
  const sent = new Promise<void>(resolve => { arrived = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === '/api/auth/me') return Response.json({ banker: { id: owner, username: owner } }, { headers: { 'X-PB-Banker-ID': owner } });
    arrived(); await held;
    return Response.json({ error: { code: 'idempotency_mismatch', message: 'This operation already has different content' } }, { status: 409, headers: { 'X-PB-Banker-ID': owner } });
  }));
  let current = true;
  const pending = editing.replaySubmittedDraft(key, () => current);
  const rejected = expect(pending).rejects.toBeInstanceOf(Error);
  await sent;
  current = false;
  release();
  await rejected;
  expect(storage.draft(key)).toEqual({ ...original, __submitted: request });
  expect(await editing.listSubmittedDrafts(owner)).toHaveLength(1);
  expect(editing.draftConflictNotice(key)).toBeUndefined();
});

it.each(['path', 'method'] as const)('requires a fresh operation before freezing a request whose %s changed after the original was confirmed', async component => {
  outboxEvents();
  const storage = sharedStorage();
  const server = operationServer();
  const first = await freshTab();
  await first.writeDraft(key, original);
  await first.enqueue(enqueueInput);
  await drainApplied(first);
  const editing = await freshTab();
  const cursor: import('../src/client/data').DraftCursor = {};
  await editing.readDraft(key, cursor);
  await editing.writeDraft(key, original, cursor);
  const changedRequest = { ...request, ...(component === 'path' ? { path: '/api/sessions/different-session/entries' } : { method: 'PATCH' }) };
  let conflict: unknown;
  try { conflict = await editing.prepareDraftSubmission(key, original, changedRequest, () => true, cursor); }
  catch (problem) { conflict = problem; }
  const recovered = (conflict as { value?: typeof original }).value;
  expect(recovered?.amount).toBe('10');
  expect(recovered?.op_id).not.toBe(original.op_id);
  expect((storage.draft(key) as { __submitted?: DraftRequest }).__submitted).toBeUndefined();
  expect((storage.draft(key) as typeof original).amount).toBe('10');
  expect(await editing.listOutbox(owner)).toEqual([]);
  expect(server.writes()).toBe(1);
  expect(server.fetch).toHaveBeenCalledTimes(1);
  expect(server.applied.get(original.op_id)?.body).toBe(JSON.stringify(request.body));
});

async function putLegacyDraft(value: unknown, recordKey = key, kind?: string) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const opening = indexedDB.open('poker-banker', 2);
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error);
  });
  const transaction = db.transaction('drafts', 'readwrite');
  const done = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () => reject(transaction.error);
  });
  transaction.objectStore('drafts').put({ key: recordKey, banker_id: owner, value, ...(kind ? { kind } : {}), updated_at: Date.now() });
  await done;
}

it('recovers a legacy editable value after a cold account reload without reusing its applied operation', async () => {
  outboxEvents();
  const storage = sharedStorage();
  const server = operationServer();
  const first = await freshTab();
  await first.writeDraft(key, original);
  await first.enqueue(enqueueInput);
  await drainApplied(first);
  await putLegacyDraft(edited);
  const cold = await freshTab();
  const cursor: import('../src/client/data').DraftCursor = {};
  const restored = await cold.readDraft<typeof edited>(key, cursor);
  expect(restored?.amount).toBe('50');
  expect(restored?.op_id).not.toBe(original.op_id);
  expect(cold.draftConflictNotice(key)?.message).toMatch(/review/i);
  await cold.flushDraftWrites();
  expect((storage.draft(key) as typeof edited).amount).toBe('50');
  expect((storage.draft(key) as typeof edited).op_id).not.toBe(original.op_id);
  expect(await cold.listOutbox(owner)).toEqual([]);
  expect(server.writes()).toBe(1);
  expect(server.applied.get(original.op_id)?.body).toBe(JSON.stringify(request.body));
  const reviewed = await cold.readDraft<typeof edited>(key, cursor);
  await cold.enqueue({ ...enqueueInput, body: { op_id: reviewed!.op_id, amount_minor: '5000' }, draft_cursor: cursor, draft_value: reviewed });
  await drainApplied(cold);
  expect(server.writes()).toBe(2);
  expect(cold.hasPendingLocalWrites()).toBe(false);
});

it('keeps healthy unclaimed draft observations stable across tabs without changing their fingerprints', async () => {
  const storage = sharedStorage();
  const first = await freshTab();
  await first.writeDraft(key, original);
  const before = storage.state();
  const one: import('../src/client/data').DraftCursor = {};
  expect(await first.readDraft(key, one)).toEqual(original);
  const fingerprint = one.version;
  expect(await first.readDraft(key, one)).toEqual(original);
  expect(one.version).toBe(fingerprint);
  const other = await freshTab();
  const two: import('../src/client/data').DraftCursor = {};
  expect(await other.readDraft(key, two)).toEqual(original);
  expect(two.version).toBe(fingerprint);
  expect(storage.state()).toEqual(before);
  expect(first.draftConflictNotice(key)).toBeUndefined();
  expect(other.draftConflictNotice(key)).toBeUndefined();
  expect(first.hasPendingLocalWrites()).toBe(false);
  expect(other.hasPendingLocalWrites()).toBe(false);
});

it('does not revive an applied operation when the first dirty observation and the restoring read both fail', async () => {
  outboxEvents();
  const storage = sharedStorage();
  const server = operationServer();
  const first = await freshTab();
  await first.writeDraft(key, original);
  await first.enqueue(enqueueInput);
  await drainApplied(first);
  const editing = await freshTab();
  storage.failNextGet();
  await expect(editing.writeDraft(key, edited)).rejects.toMatchObject({ name: 'UnknownError' });
  storage.failNextRead();
  const cursor: import('../src/client/data').DraftCursor = {};
  const recovered = await editing.readDraft<typeof edited>(key, cursor);
  expect(recovered?.amount).toBe('50');
  expect(recovered?.op_id).not.toBe(original.op_id);
  expect(await editing.listOutbox(owner)).toEqual([]);
  await editing.flushDraftWrites();
  const current = await editing.readDraft<typeof edited>(key, cursor);
  expect(current?.amount).toBe('50');
  expect(current?.op_id).not.toBe(original.op_id);
  expect(editing.draftSaveFailed(key)).toBe(false);
  expect(editing.hasPendingLocalWrites()).toBe(false);
  expect(server.writes()).toBe(1);
});

async function mismatchWithNewerDraft() {
  outboxEvents();
  const storage = sharedStorage();
  const server = operationServer();
  await fetch(request.path, { method: request.method, body: JSON.stringify(request.body) });
  const send = globalThis.fetch;
  let arrived!: () => void;
  let release!: () => void;
  const sent = new Promise<void>(resolve => { arrived = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path !== '/api/auth/me') { arrived(); await held; }
    return send(path, init);
  }));
  const editing = await freshTab();
  await editing.writeDraft(key, edited);
  await editing.enqueue({ ...enqueueInput, body: { ...request.body, amount_minor: '5000' }, draft_value: edited });
  const stop = editing.syncOutbox(owner, () => {}, () => {});
  try {
    await sent;
    const other = await freshTab();
    await other.readDraft(key);
    await other.writeDraft(key, newer);
    release();
    await vi.waitFor(async () => expect(await editing.listOutbox(owner)).toEqual([]));
    return { editing, other, storage, server };
  } finally { release(); stop(); }
}

it.each([false, true])('keeps both a newer saved draft and a mismatched recovered edit until an explicit choice (useRecovered=%s)', async useRecovered => {
  const { editing, storage, server } = await mismatchWithNewerDraft();
  expect(storage.draft(key)).toEqual(newer);
  const recoveries = await editing.listRecoveredDrafts(owner);
  expect(recoveries).toHaveLength(1);
  expect(recoveries[0]).toMatchObject({ source_key: key, value: { amount: '50' }, source_value: newer });
  expect((recoveries[0]!.value as typeof edited).op_id).not.toBe(original.op_id);
  expect(await editing.listRecoveredDrafts('different-banker')).toEqual([]);
  expect(await editing.hasUnsent(owner)).toBe(true);
  await expect(editing.clearBankerData(owner)).rejects.toThrow(/discard/i);
  await editing.resolveRecoveredDraft(recoveries[0]!, useRecovered);
  expect((storage.draft(key) as typeof edited).amount).toBe(useRecovered ? '50' : '25');
  if (useRecovered) expect((storage.draft(key) as typeof edited).op_id).not.toBe(original.op_id);
  else expect(storage.draft(key)).toEqual(newer);
  if (useRecovered) expect(await editing.listRecoveredDrafts(owner)).toEqual([expect.objectContaining({ key, value: expect.objectContaining({ amount: '50', __recovery_request: expect.objectContaining({ path: request.path }) }), request_error: expect.stringMatching(/currency/i) })]);
  else expect(await editing.listRecoveredDrafts(owner)).toEqual([]);
  expect(await editing.listOutbox(owner)).toEqual([]);
  expect(server.writes()).toBe(1);
  expect(editing.hasPendingLocalWrites()).toBe(false);
});

it('rechecks both saved and recovered versions before applying or discarding a recovered edit', async () => {
  const { editing, other, storage, server } = await mismatchWithNewerDraft();
  const recovery = (await editing.listRecoveredDrafts(owner))[0]!;
  await other.writeDraft(key, { ...newer, amount: '30' });
  const before = storage.state();
  await expect(editing.resolveRecoveredDraft(recovery, true)).rejects.toBeInstanceOf(editing.DraftConflictError);
  expect(storage.state()).toEqual(before);
  await expect(editing.resolveRecoveredDraft(recovery, false)).rejects.toBeInstanceOf(editing.DraftConflictError);
  expect(storage.state()).toEqual(before);
  expect((await editing.listRecoveredDrafts(owner))[0]).toMatchObject({ source_value: { amount: '30' }, value: { amount: '50' } });
  const reviewed = (await editing.listRecoveredDrafts(owner))[0]!;
  await editing.resolveRecoveredDraft(reviewed, false);
  expect((storage.draft(key) as typeof newer).amount).toBe('30');
  expect(await editing.listRecoveredDrafts(owner)).toEqual([]);
  expect(server.writes()).toBe(1);
});

it('keeps a chained legacy mismatch editable and reachable instead of leaving an internal operation draft stuck', async () => {
  outboxEvents();
  const storage = sharedStorage();
  const server = operationServer();
  const originalRequest = { ...request, body: { ...request.body, player_id: 'player', kind: 'buy_in', paid_now: false, occurred_at: null } };
  await fetch(request.path, { method: request.method, body: JSON.stringify({ ...originalRequest.body, amount_minor: '2000' }) });
  const editing = await freshTab();
  await editing.writeDraft(key, edited);
  await editing.prepareDraftSubmission(key, edited, { ...originalRequest, body: { ...originalRequest.body, amount_minor: '5000' } });
  await putLegacyDraft({ request: originalRequest }, `${owner}/_operations/requests/${original.op_id}`, 'operation_request');
  await expect(editing.replaySubmittedDraft(key)).rejects.toMatchObject({ code: 'idempotency_mismatch' });
  const earlier = await editing.listSubmittedDrafts(owner);
  expect(earlier).toHaveLength(1);
  expect(earlier[0]!.request).toEqual(originalRequest);
  expect((storage.draft(key) as typeof edited).amount).toBe('50');
  await expect(editing.replaySubmittedDraft(earlier[0]!.key, () => true, earlier[0]!.cursor)).rejects.toMatchObject({ code: 'idempotency_mismatch' });
  expect(await editing.listSubmittedDrafts(owner)).toEqual([]);
  expect((storage.draft(key) as typeof edited).amount).toBe('50');
  const recovered = await editing.listRecoveredDrafts(owner);
  expect(recovered).toHaveLength(1);
  expect(recovered[0]).toMatchObject({ source_key: key, value: { amount_minor: '1000' } });
  expect((recovered[0]!.value as typeof edited).op_id).not.toBe(original.op_id);
  expect(storage.draft(earlier[0]!.key)).toBeUndefined();
  expect(editing.hasPendingLocalWrites()).toBe(false);
  expect(editing.draftSaveFailed()).toBe(false);
  expect(server.writes()).toBe(1);
});

it.each([null, '2026-11-10T10:15:16.123Z'])('keeps the original submitted time when recovering a mismatched entry (%s)', async occurredAt => {
  outboxEvents();
  const storage = sharedStorage();
  const server = operationServer();
  await fetch(request.path, { method: request.method, body: JSON.stringify(request.body) });
  const editing = await freshTab();
  await editing.writeDraft(key, edited);
  await editing.enqueue({ ...enqueueInput, body: { ...request.body, amount_minor: '5000', occurred_at: occurredAt }, draft_value: edited });
  await drainApplied(editing);
  expect(storage.draft(key)).toMatchObject({ amount: '50', __recovered_occurred_at: occurredAt });
  expect((storage.draft(key) as typeof edited).op_id).not.toBe(original.op_id);
  expect(server.writes()).toBe(1);
});

it('treats a reordered request body as the same operation instead of inventing a conflicting save', async () => {
  outboxEvents();
  sharedStorage();
  const server = operationServer();
  const editing = await freshTab();
  const first = await editing.enqueue({ ...enqueueInput, draft_key: undefined });
  const replay = await editing.enqueue({ ...enqueueInput, draft_key: undefined, body: { amount_minor: '1000', op_id: original.op_id } });
  expect(replay).toEqual(first);
  await drainApplied(editing);
  expect(server.writes()).toBe(1);
  expect(server.fetch).toHaveBeenCalledTimes(1);
});

it.each([false, true])('does not resolve a recovered choice over a newer quota-retained edit (useRecovered=%s)', async useRecovered => {
  const { editing, storage, server } = await mismatchWithNewerDraft();
  const choice = (await editing.listRecoveredDrafts(owner))[0]!;
  const cursor: import('../src/client/data').DraftCursor = {};
  await editing.readDraft(key, cursor);
  storage.quota(true);
  await expect(editing.writeDraft(key, { ...newer, amount: '75' }, cursor)).rejects.toMatchObject({ name: 'QuotaExceededError' });
  const before = storage.state();
  await expect(editing.resolveRecoveredDraft(choice, useRecovered)).rejects.toBeInstanceOf(Error);
  expect(storage.state()).toEqual(before);
  expect(editing.draftSaveFailed(key)).toBe(true);
  expect((await editing.readDraft<typeof newer>(key, cursor))?.amount).toBe('75');
  storage.quota(false);
  await expect(editing.resolveRecoveredDraft(choice, useRecovered)).rejects.toBeInstanceOf(editing.DraftConflictError);
  expect((storage.draft(key) as typeof newer).amount).toBe('75');
  expect(editing.hasPendingLocalWrites()).toBe(false);
  expect(editing.draftSaveFailed(key)).toBe(false);
  const reviewed = (await editing.listRecoveredDrafts(owner))[0]!;
  expect(reviewed).toMatchObject({ source_value: { amount: '75' }, value: { amount: '50' } });
  await editing.resolveRecoveredDraft(reviewed, false);
  expect((storage.draft(key) as typeof newer).amount).toBe('75');
  expect(await editing.listRecoveredDrafts(owner)).toEqual([]);
  expect(server.writes()).toBe(1);
});

it('adopts a newer saved value when recovery normalization loses its fingerprint race without reporting a storage failure', async () => {
  outboxEvents();
  const storage = sharedStorage();
  operationServer();
  const first = await freshTab();
  await first.writeDraft(key, original);
  await first.enqueue(enqueueInput);
  await drainApplied(first);
  await putLegacyDraft(edited);
  const other = await freshTab();
  const editing = await freshTab();
  const db = await new Promise<IDBDatabase>(resolve => { const open = indexedDB.open('poker-banker', 2); open.onsuccess = () => resolve(open.result); });
  const transaction = db.transaction.bind(db);
  let changed: Promise<void> | undefined;
  let armed = true;
  vi.spyOn(db, 'transaction').mockImplementation(((names: string | string[], mode?: IDBTransactionMode) => {
    const tx = transaction(names, mode);
    const objectStore = tx.objectStore.bind(tx);
    vi.spyOn(tx, 'objectStore').mockImplementation(name => {
      const store = objectStore(name);
      const get = store.get.bind(store);
      vi.spyOn(store, 'get').mockImplementation(query => {
        const result = get(query);
        if (armed && mode !== 'readwrite' && query === `${owner}/_operations/requests/${original.op_id}`) {
          let success: ((event: Event) => unknown) | null = null;
          Object.defineProperty(result, 'onsuccess', { get: () => (event: Event) => { if (armed) { armed = false; changed = other.writeDraft(key, { ...newer, amount: '75' }); } return success?.(event); }, set: callback => { success = callback; }, configurable: true });
        }
        return result;
      });
      return store;
    });
    return tx;
  }) as IDBDatabase['transaction']);
  const restored = await editing.readDraft<typeof edited>(key, {});
  await changed;
  expect(restored?.amount).toBe('75');
  expect(restored?.op_id).not.toBe(original.op_id);
  expect((storage.draft(key) as typeof edited).amount).toBe('75');
  expect(editing.draftConflictNotice(key)?.message).toMatch(/review/i);
  expect(editing.draftSaveFailed()).toBe(false);
  expect(editing.hasPendingLocalWrites()).toBe(false);
});

it('does not freeze a stale render request against a newer visible edit in the same mounted form', async () => {
  outboxEvents();
  const storage = sharedStorage();
  const editing = await freshTab();
  await editing.writeDraft(key, original);
  const harness = draftForm(editing, key, original);
  const send = vi.fn();
  vi.stubGlobal('fetch', send);
  try {
    await vi.waitFor(() => expect(harness.render().ready).toBe(true));
    const oldRender = harness.render();
    oldRender.update(newer);
    await editing.flushDraftWrites();
    expect((storage.draft(key) as typeof newer).amount).toBe('25');
    await expect(oldRender.submit(request.path, request.body, request.method)).rejects.toThrow(/review/i);
    expect((storage.draft(key) as typeof newer).amount).toBe('25');
    expect((storage.draft(key) as { __submitted?: DraftRequest }).__submitted).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  } finally { harness.close(); }
});
