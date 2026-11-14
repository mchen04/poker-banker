import { afterEach, expect, it, vi } from 'vitest';
import { deriveSession, type SessionSettings } from '../src/domain/session';

type Opening = { result?: unknown; onsuccess?: () => void; onerror?: () => void; onblocked?: () => void; onupgradeneeded?: (event: { oldVersion: number }) => void };
type Row = Record<string, unknown>;
const settings = (id: string): SessionSettings => ({
  id, name: 'Game', played_on: '2026-11-10', currency: 'USD', status: 'open', location: null, game: null,
  big_blind_minor: null, started_at: null, ended_at: null, closed_balanced: null, closed_at: null,
  share_token: null, deleted_at: null, created_at: '', updated_at: '',
});
function request<T>(value: T) {
  const result: { result?: T; onsuccess?: () => void; onerror?: () => void } = {};
  queueMicrotask(() => { result.result = value; result.onsuccess?.(); });
  return result;
}
function fakeStorage(seed: { snapshots?: Row[]; outbox?: Row[]; drafts?: Row[] } = {}) {
  const stores = new Map<string, Map<string, Row>>([
    ['snapshots', new Map((seed.snapshots ?? []).map(row => [String(row.key), structuredClone(row)]))],
    ['outbox', new Map((seed.outbox ?? []).map(row => [String(row.op_id), structuredClone(row)]))],
    ['drafts', new Map((seed.drafts ?? []).map(row => [String(row.key), structuredClone(row)]))],
  ]);
  const db = {
    transaction() {
      const tx: { oncomplete?: () => void; onabort?: () => void; onerror?: () => void; error?: unknown; objectStore: (name: string) => unknown } = {
        objectStore(name: string) {
          const store = stores.get(name)!;
          return {
            get: (key: string) => request(store.get(key)),
            getAll: () => request([...store.values()]),
            put: (row: Row) => { store.set(String(row.key ?? row.op_id), structuredClone(row)); return request(undefined); },
            delete: (key: string) => { store.delete(key); return request(undefined); },
          };
        },
      };
      queueMicrotask(() => tx.oncomplete?.());
      return tx;
    },
  };
  vi.stubGlobal('indexedDB', { open() {
    const opening: Opening = {};
    queueMicrotask(() => { opening.result = db; opening.onsuccess?.(); });
    return opening;
  } });
  return stores;
}
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it('skips only the malformed snapshot record', async () => {
  const complete = deriveSession(settings('bad-players'), '1', [], [], [], '2026-11-10T00:30:00.000Z');
  fakeStorage({ snapshots: [
    { key: 'banker/a', banker_id: 'banker', state: deriveSession(settings('a'), '2', [], [], [], '2026-11-10T01:00:00.000Z') },
    { key: 'banker/bad-state', banker_id: 'banker', state: null },
    { key: 'banker/bad-session', banker_id: 'banker', state: { revision: '1', session: null } },
    { key: 'banker/bad-revision', banker_id: 'banker', state: { revision: 4, session: { id: 'bad' } } },
    { key: 'banker/bad-players', banker_id: 'banker', state: { ...complete, players: null } },
    { key: 'banker/b', banker_id: 'banker', state: deriveSession(settings('b'), '3', [], [], [], '2026-11-10T02:00:00.000Z') },
  ] });
  const { listSnapshots } = await import('../src/client/data');
  expect((await listSnapshots('banker')).map(state => state.session.id)).toEqual(['a', 'b']);
});

it('overwrites a malformed stored snapshot with the fresh server copy', async () => {
  const fresh = deriveSession(settings('session'), '2', [], [], [], '2026-11-10T01:00:00.000Z');
  const stores = fakeStorage({ snapshots: [{ key: 'banker/session', banker_id: 'banker', state: { ...fresh, revision: 'not-a-number' } }] });
  const { storeSnapshot, readSnapshot } = await import('../src/client/data');
  await storeSnapshot('banker', fresh);
  expect(await readSnapshot('banker', 'session')).toEqual(fresh);
  expect(stores.get('snapshots')!.get('banker/session')!.state).toEqual(fresh);
});

it('acknowledges an outbox item over a malformed stored snapshot', async () => {
  const fresh = deriveSession(settings('session'), '2', [], [], [], '2026-11-10T01:00:00.000Z');
  const op = 'op-1';
  const item = { op_id: op, banker_id: 'banker', session_id: 'session', path: '/api/sessions/session/entries', method: 'POST', body: { op_id: op }, label: 'Buy-in', order: 0, status: 'pending', attempts: 0, next_attempt_at: 0 };
  const stores = fakeStorage({ snapshots: [{ key: 'banker/session', banker_id: 'banker', state: { session: null } }], outbox: [item] });
  const bus = new EventTarget();
  vi.stubGlobal('window', { setTimeout, clearTimeout, setInterval, clearInterval, addEventListener: bus.addEventListener.bind(bus), removeEventListener: bus.removeEventListener.bind(bus), dispatchEvent: bus.dispatchEvent.bind(bus) });
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(fresh, { headers: { 'X-PB-Banker-ID': 'banker' } })));
  const { syncOutbox, listOutbox, readSnapshot } = await import('../src/client/data');
  let saved: unknown;
  const stop = syncOutbox('banker', state => { saved = state; }, () => {});
  try { await vi.waitFor(async () => expect(await listOutbox('banker')).toEqual([])); }
  finally { stop(); }
  expect(saved).toEqual(fresh);
  expect(await readSnapshot('banker', 'session')).toEqual(fresh);
  expect(stores.get('outbox')!.size).toBe(0);
});

it('treats a malformed stored snapshot as absent when read', async () => {
  fakeStorage({ snapshots: [{ key: 'banker/session', banker_id: 'banker', state: { revision: '1', session: null } }] });
  const { readSnapshot } = await import('../src/client/data');
  expect(await readSnapshot('banker', 'session')).toBeUndefined();
});

it('recovers a changed retry when the stored snapshot is malformed', async () => {
  const op = 'op-1';
  fakeStorage({
    snapshots: [{ key: 'banker/bad', banker_id: 'banker', state: { revision: '1', session: null } }],
    drafts: [{ key: `banker/_operations/requests/${op}`, banker_id: 'banker', kind: 'operation_request', value: { request: { path: '/api/sessions/bad/entries', method: 'POST', body: { op_id: op, player_id: 'p', kind: 'buy_in', amount_minor: '1000' } } }, updated_at: 0 }],
  });
  vi.stubGlobal('window', { dispatchEvent: () => {} });
  const { enqueue } = await import('../src/client/data');
  const result = await enqueue({ banker_id: 'banker', session_id: 'bad', path: '/api/sessions/bad/entries', body: { op_id: op, player_id: 'p', kind: 'buy_in', amount_minor: '2000' }, label: 'Buy-in' });
  expect('draft_conflict' in result).toBe(true);
});

it('keeps syncing after a conflicting retry over a malformed snapshot', async () => {
  const bad = { op_id: 'op-bad', banker_id: 'banker', session_id: 'bad', path: '/api/sessions/bad/entries', method: 'POST', body: { op_id: 'op-bad', player_id: 'p', kind: 'buy_in', amount_minor: '1000', paid_now: false }, label: 'Buy-in', order: 0, status: 'pending', attempts: 0, next_attempt_at: 0 };
  const good = { ...bad, op_id: 'op-good', session_id: 'good', path: '/api/sessions/good/entries', body: { ...bad.body, op_id: 'op-good', amount_minor: '2000' }, order: 1 };
  const freshGood = deriveSession(settings('good'), '2', [], [], [], '2026-11-10T01:00:00.000Z');
  fakeStorage({ snapshots: [{ key: 'banker/bad', banker_id: 'banker', state: { revision: '1', session: null } }], outbox: [bad, good] });
  const bus = new EventTarget();
  vi.stubGlobal('window', { setTimeout, clearTimeout, setInterval, clearInterval, addEventListener: bus.addEventListener.bind(bus), removeEventListener: bus.removeEventListener.bind(bus), dispatchEvent: bus.dispatchEvent.bind(bus) });
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('fetch', vi.fn(async (_path: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { op_id: string };
    return body.op_id === 'op-bad'
      ? Response.json({ error: { code: 'idempotency_mismatch', message: 'Changed' } }, { status: 409, headers: { 'X-PB-Banker-ID': 'banker' } })
      : Response.json(freshGood, { headers: { 'X-PB-Banker-ID': 'banker' } });
  }));
  const { syncOutbox, listOutbox, listRecoveredDrafts, readSnapshot } = await import('../src/client/data');
  const stop = syncOutbox('banker', () => {}, () => {});
  try { await vi.waitFor(async () => expect(await listOutbox('banker')).toEqual([])); }
  finally { stop(); }
  const recovered = await listRecoveredDrafts('banker');
  expect(recovered).toHaveLength(1);
  expect(recovered[0]!.currency).toBeUndefined();
  expect(await readSnapshot('banker', 'good')).toEqual(freshGood);
  expect(await readSnapshot('banker', 'bad')).toBeUndefined();
});
