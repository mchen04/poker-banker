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
  expect(restored).toEqual(edited);
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
  storage.quota(true);
  await expect(a.writeDraft(key, edited)).rejects.toMatchObject({ name: 'QuotaExceededError' });
  storage.quota(false);
  const b = await freshTab();
  await b.readDraft(key);
  await b.deleteDraft(key);
  const cursor: import('../src/client/data').DraftCursor = {};
  expect(await a.readDraft(key, cursor)).toEqual(edited);
  if (inserted) {
    await b.writeDraft(key, newer);
    await settle(a.flushDraftWrites());
    expect(a.draftSaveFailed(key)).toBe(false);
    expect(a.hasPendingLocalWrites()).toBe(false);
    await expect(a.flushDraftWrites()).resolves.toBeUndefined();
    expect(storage.draft(key)).toEqual(newer);
  } else {
    await a.flushDraftWrites();
    expect(storage.draft(key)).toEqual(edited);
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
    await a.readDraft(key);
    await a.flushDraftWrites();
    expect(storage.draft(key)).toEqual(original);
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
  const hooks = {
    createContext: () => null, useContext: () => null,
    useRef(value: unknown) { const index = position++; return slots[index] ??= { current: value }; },
    useState(value: unknown) {
      const index = position++;
      if (!(index in slots)) slots[index] = typeof value === 'function' ? value() : value;
      return [slots[index], (next: unknown) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }];
    },
    useEffect(effect: () => unknown, dependencies: unknown[]) {
      const index = position++;
      const previous = slots[index] as unknown[] | undefined;
      if (!previous || dependencies.some((value, item) => value !== previous[item])) { slots[index] = dependencies; effects.push(effect); }
    },
    useLayoutEffect() {},
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
