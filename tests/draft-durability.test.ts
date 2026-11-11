import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DraftRequest } from '../src/client/data';

type Row = { key: string; [field: string]: unknown };
type RequestDouble = { result?: unknown; onsuccess?: () => void };
type TransactionDouble = {
  error?: DOMException;
  oncomplete?: () => void;
  onabort?: () => void;
  objectStore: () => {
    get: (key: string) => RequestDouble;
    getAll: () => RequestDouble;
    put: (row: Row) => RequestDouble;
    delete: (key: string) => RequestDouble;
  };
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function draftStorage() {
  let rows = new Map<string, Row>();
  let active: (() => void) | undefined;
  const waiting: (() => void)[] = [];
  let quota = false;
  let hold: { started: ReturnType<typeof deferred>; abort?: () => void } | undefined;
  const db = {
    transaction(_name: string, mode?: string) {
      let local: Map<string, Row>;
      let busy = false;
      let finished = false;
      let paused = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const operations: (() => void)[] = [];
      const release = () => {
        finished = true;
        if (timer) clearTimeout(timer);
        active = undefined;
        waiting.shift()?.();
      };
      const abort = () => {
        tx.error = new DOMException('Storage quota exceeded', 'QuotaExceededError');
        tx.onabort?.();
        release();
      };
      const pump = () => {
        if (finished || busy || paused || active !== start) return;
        const operation = operations.shift();
        if (operation) {
          busy = true;
          queueMicrotask(() => {
            operation();
            busy = false;
            pump();
          });
        } else {
          timer = setTimeout(() => {
            if (mode === 'readwrite') rows = local;
            tx.oncomplete?.();
            release();
          }, 0);
        }
      };
      const request = (action: () => unknown, writing = false) => {
        const result: RequestDouble = {};
        if (timer) clearTimeout(timer);
        operations.push(() => {
          if (writing && hold) {
            const held = hold;
            hold = undefined;
            held.abort = abort;
            held.started.resolve();
            paused = true;
            return;
          }
          if (writing && quota) { abort(); return; }
          result.result = structuredClone(action());
          result.onsuccess?.();
        });
        pump();
        return result;
      };
      const tx: TransactionDouble = { objectStore: () => ({
        get: key => request(() => local.get(key)),
        getAll: () => request(() => [...local.values()]),
        put: row => request(() => { local.set(row.key, structuredClone(row)); return row.key; }, true),
        delete: key => request(() => local.delete(key), true),
      }) };
      const start = () => {
        active = start;
        local = structuredClone(rows);
        pump();
      };
      if (active) waiting.push(start);
      else start();
      return tx;
    },
  };
  vi.stubGlobal('indexedDB', { open: () => {
    const opening: RequestDouble = {};
    queueMicrotask(() => { opening.result = db; opening.onsuccess?.(); });
    return opening;
  } });
  return {
    quota: (full: boolean) => { quota = full; },
    waitingTransactions: () => waiting.length,
    holdNextWrite: () => {
      const held = { started: deferred(), abort: undefined as (() => void) | undefined };
      hold = held;
      return { started: held.started.promise, abort: () => held.abort!() };
    },
  };
}

const owner = 'banker';
const key = 'banker/session/buy_in/player';
const original = { op_id: 'original-operation', amount: '10' };
const request = (op: string, amount: string): DraftRequest => ({
  path: '/api/sessions/session/entries', method: 'POST', body: { op_id: op, amount_minor: amount },
});
const freshData = async () => { vi.resetModules(); return import('../src/client/data'); };
function serverReply(rejected = false) {
  const bodies: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit) => {
    if (path === '/api/auth/me') return new Response(JSON.stringify({ banker: { id: owner, username: owner } }), { headers: { 'X-PB-Banker-ID': owner } });
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify(rejected ? { error: { code: 'session_closed', message: 'Session closed' } } : { ok: true }), {
      status: rejected ? 409 : 200, headers: { 'X-PB-Banker-ID': owner },
    });
  }));
  return bodies;
}
beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('window', { setTimeout, clearTimeout, dispatchEvent() {} });
});
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it('retires a recovered draft write before freezing and never resurrects its confirmed amount', async () => {
  const storage = draftStorage();
  const data = await freshData();
  await data.writeDraft(key, original);
  const edited = { ...original, amount: '123' };
  storage.quota(true);
  await expect(data.writeDraft(key, edited)).rejects.toMatchObject({ name: 'QuotaExceededError' });
  await expect(data.flushDraftWrites()).rejects.toThrow('Not saved on this device');
  expect(await data.readDraft(key)).toEqual(edited);

  storage.quota(false);
  const submitted = request(edited.op_id, '12300');
  expect(await data.prepareDraftSubmission(key, edited, submitted)).toMatchObject({ first: true, previouslyConfirmed: false });
  expect(await data.readDraft(key)).toEqual({ ...edited, __submitted: submitted });
  await expect(data.flushDraftWrites()).resolves.toBeUndefined();
  expect(data.hasPendingLocalWrites()).toBe(false);
  const bodies = serverReply();
  await data.replaySubmittedDraft(key);
  expect(bodies).toEqual([submitted.body]);
  expect(await data.readDraft(key)).toBeUndefined();
  await data.flushDraftWrites();
  expect(await data.readDraft(key)).toBeUndefined();
  expect(await data.listSubmittedDrafts(owner)).toEqual([]);
  expect(await (await freshData()).readDraft(key)).toBeUndefined();
});

it.each([false, true])('retains the latest edit behind a frozen cross-tab request until matched settlement (rejected=%s)', async rejected => {
  const storage = draftStorage();
  const data = await freshData();
  await data.writeDraft(key, original);
  const held = storage.holdNextWrite();
  const first = data.writeDraft(key, { ...original, amount: '123' });
  const firstFailure = expect(first).rejects.toMatchObject({ name: 'QuotaExceededError' });
  await held.started;
  const latest = { ...original, amount: '456' };
  const second = data.writeDraft(key, latest);
  const secondFailure = expect(second).rejects.toThrow('Not saved on this device');
  const otherTab = await freshData();
  const submitted = request(original.op_id, '1000');
  const freezing = otherTab.prepareDraftSubmission(key, original, submitted);
  await vi.waitFor(() => expect(storage.waitingTransactions()).toBe(1));
  held.abort();
  await firstFailure;
  await freezing;
  await secondFailure;

  expect(await data.readDraft(key)).toEqual({ ...original, __submitted: submitted });
  expect(await data.listSubmittedDrafts(owner)).toEqual([{ key, form: 'buy_in', request: submitted }]);
  expect(data.draftSaveFailed(key)).toBe(true);
  await expect(data.flushDraftWrites()).rejects.toThrow('Not saved on this device');
  const bodies = serverReply(rejected);
  if (rejected) await expect(data.replaySubmittedDraft(key)).rejects.toMatchObject({ code: 'session_closed' });
  else await data.replaySubmittedDraft(key);
  expect(bodies).toEqual([submitted.body]);
  const retained = await data.readDraft<typeof latest & { __submitted?: DraftRequest }>(key);
  expect(retained).toMatchObject({ amount: '456' });
  expect(retained?.__submitted).toBeUndefined();
  expect(retained?.op_id).not.toBe(original.op_id);
  expect(await data.listSubmittedDrafts(owner)).toEqual([]);
  expect(data.hasPendingLocalWrites()).toBe(true);
  await data.flushDraftWrites();
  expect(data.draftSaveFailed(key)).toBe(false);
  expect(data.hasPendingLocalWrites()).toBe(false);
  expect(await (await freshData()).readDraft(key)).toEqual(retained);
  expect(await data.prepareDraftSubmission(key, retained!, request(retained!.op_id, '45600'))).toMatchObject({ first: true, previouslyConfirmed: false });
});
