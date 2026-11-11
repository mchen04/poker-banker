import { observeServerTime } from './clock';
import type { SessionState } from '../domain/session';

export type Banker = { id: string; username: string };
export class ApiError extends Error {
  constructor(message: string, public status: number, public code: string) { super(message); }
}
export function isProvenNotApplied(problem: unknown): boolean {
  return problem instanceof ApiError && problem.status >= 400 && problem.status < 500
    && ![401, 403, 408, 415, 429].includes(problem.status)
    && typeof problem.code === 'string' && problem.code.trim().length > 0
    && !['request_failed', 'idempotency_mismatch'].includes(problem.code);
}
export type OutboxItem = {
  op_id: string;
  banker_id: string;
  session_id: string;
  path: string;
  method: 'POST' | 'PATCH';
  body: Record<string, unknown>;
  label: string;
  order: number;
  status: 'pending' | 'sending' | 'uncertain' | 'rejected';
  delivery?: 'not_sent' | 'uncertain' | 'not_applied';
  error?: string;
  attempts: number;
  next_attempt_at: number;
  lease_until?: number;
};
export type DraftRequest = { path: string; method: string; body: Record<string, unknown> };
export type SubmittedDraft = { key: string; form: string; request: DraftRequest };
type DraftValue = Record<string, unknown> & { __submitted?: DraftRequest };
type DraftRecord = { key: string; value: unknown; banker_id: string; updated_at: number; kind?: 'acknowledged_operation' };
const acknowledgedKey = (key: string, request: DraftRequest) => `${key.split('/')[0]}/_operations/confirmed/${String(request.body.op_id)}`;
type SnapshotRecord = { key: string; banker_id: string; state: SessionState };
let database: Promise<IDBDatabase> | undefined;
const draftWrites = new Map<string, Promise<void>>();
const enqueueWrites = new Set<Promise<OutboxItem>>();
let channel: BroadcastChannel | undefined;
const generations = new Map<string, number>();
const generation = (banker: string) => generations.get(banker) ?? 0;

function changed() {
  window.dispatchEvent(new Event('pb-data'));
  channel?.postMessage('changed');
}
function req<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Storage request failed'));
  });
}
function complete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error('Storage transaction failed'));
  });
}
function storage(): Promise<IDBDatabase> {
  database ??= new Promise((resolve, reject) => {
    const opening = indexedDB.open('poker-banker', 2);
    opening.onerror = () => { database = undefined; reject(opening.error ?? new Error('Could not open local storage')); };
    opening.onblocked = () => window.dispatchEvent(new CustomEvent('pb-storage-blocked'));
    opening.onupgradeneeded = event => {
      const db = opening.result;
      const transaction = opening.transaction!;
      if (event.oldVersion < 1) {
        db.createObjectStore('drafts', { keyPath: 'key' });
        db.createObjectStore('outbox', { keyPath: 'op_id' });
        db.createObjectStore('snapshots', { keyPath: 'key' });
      }
      if (event.oldVersion < 2) {
        for (const name of ['drafts', 'outbox', 'snapshots']) {
          const store = transaction.objectStore(name);
          if (!store.indexNames.contains('banker_id')) store.createIndex('banker_id', 'banker_id');
          const cursor = store.openCursor();
          let order = 0;
          cursor.onsuccess = () => {
            const current = cursor.result;
            if (!current) return;
            const value = current.value as Record<string, unknown>;
            const key = String(value.key ?? current.key);
            const migrated = { ...value, banker_id: value.banker_id ?? key.split('/')[0] };
            if (name === 'drafts') current.update({ ...migrated, updated_at: value.updated_at ?? 0 });
            else if (name === 'outbox') current.update({ order: ++order, attempts: 0, next_attempt_at: 0, status: 'pending', ...migrated });
            else current.update(migrated);
            current.continue();
          };
        }
      }
    };
    opening.onsuccess = () => {
      const db = opening.result;
      db.onversionchange = () => { db.close(); database = undefined; };
      resolve(db);
    };
  });
  return database;
}
async function all<T>(name: string): Promise<T[]> {
  const db = await storage();
  const transaction = db.transaction(name, 'readonly');
  return req(transaction.objectStore(name).getAll()) as Promise<T[]>;
}
async function http<T>(path: string, method: string, body: unknown, consume: (response: Response) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(path, {
      method, credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const result = await consume(response);
    if (method === 'GET' && result !== null && typeof result === 'object' && 'server_now' in result && typeof result.server_now === 'string') observeServerTime(result.server_now);
    return result;
  } finally { window.clearTimeout(timeout); }
}
async function parse<T>(response: Response): Promise<T> {
  const body: unknown = await response.json();
  if (!response.ok) {
    const error = body as { error?: { message?: string; code?: string } };
    throw new ApiError(error.error?.message ?? 'Request failed', response.status, error.error?.code ?? 'request_failed');
  }
  return body as T;
}
export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  return http(path, method, body, parse<T>);
}
export async function pollSession(path: string, revision?: string): Promise<SessionState | undefined> {
  return http(revision ? `${path}?since=${encodeURIComponent(revision)}` : path, 'GET', undefined, async response => response.status === 304 ? undefined : parse<SessionState>(response));
}
export const draftKey = (bankerId: string, sessionId: string, form: string, playerId = '') => `${bankerId}/${sessionId}/${form}/${playerId}`;
export async function readDraft<T>(key: string): Promise<T | undefined> {
  await draftWrites.get(key);
  const db = await storage();
  const record = await req(db.transaction('drafts').objectStore('drafts').get(key)) as DraftRecord | undefined;
  return record?.value as T | undefined;
}
function draftWrite(key: string, action: () => Promise<void>): Promise<void> {
  const previous = draftWrites.get(key) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(action);
  draftWrites.set(key, pending);
  void pending.finally(() => { if (draftWrites.get(key) === pending) draftWrites.delete(key); }).catch(() => {});
  return pending;
}
export function writeDraft(key: string, value: unknown): Promise<void> {
  const banker = key.split('/')[0]!;
  const epoch = generation(banker);
  return draftWrite(key, async () => {
    if (generation(banker) !== epoch) return;
    const db = await storage();
    const transaction = db.transaction('drafts', 'readwrite');
    const done = complete(transaction);
    const store = transaction.objectStore('drafts');
    const existing = await req(store.get(key)) as DraftRecord | undefined;
    if (!(existing?.value as DraftValue | undefined)?.__submitted) store.put({ key, banker_id: banker, value, updated_at: Date.now() } satisfies DraftRecord);
    await done; changed();
  });
}
export function deleteDraft(key: string): Promise<void> {
  return draftWrite(key, async () => {
    const db = await storage();
    const transaction = db.transaction('drafts', 'readwrite');
    const done = complete(transaction);
    const store = transaction.objectStore('drafts');
    const existing = await req(store.get(key)) as DraftRecord | undefined;
    if ((existing?.value as DraftValue | undefined)?.__submitted) { await done; throw new Error('Check the saved result before discarding this submitted form'); }
    store.delete(key); await done; changed();
  });
}
export async function prepareDraftSubmission<T extends object>(key: string, value: T, request: DraftRequest) {
  const banker = key.split('/')[0]!;
  const epoch = generation(banker);
  await draftWrites.get(key);
  const db = await storage();
  if (generation(banker) !== epoch) throw new Error('Account changed. Sign in to check this form.');
  const transaction = db.transaction('drafts', 'readwrite');
  const done = complete(transaction);
  const store = transaction.objectStore('drafts');
  const existing = await req(store.get(key)) as DraftRecord | undefined;
  const previous = (existing?.value as DraftValue | undefined)?.__submitted;
  const acknowledged = await req(store.get(acknowledgedKey(key, request))) as DraftRecord | undefined;
  const priorRequest = (acknowledged?.value as { request: DraftRequest } | undefined)?.request;
  if (!previous && priorRequest && JSON.stringify(priorRequest) !== JSON.stringify(request)) {
    const fresh = { ...value, op_id: crypto.randomUUID() };
    store.put({ key, banker_id: banker, value: fresh, updated_at: Date.now() } satisfies DraftRecord);
    await done; changed();
    return { request, first: false, value: fresh, previouslyConfirmed: true };
  }
  const selected = previous ?? priorRequest ?? structuredClone(request);
  const next = previous ? existing!.value as T & { __submitted: DraftRequest } : { ...value, __submitted: selected };
  if (!previous) store.put({ key, banker_id: banker, value: next, updated_at: Date.now() } satisfies DraftRecord);
  await done; changed();
  return { request: selected, first: !previous && !priorRequest, value: next, previouslyConfirmed: false };
}
async function finishDraftSubmission(key: string, request: DraftRequest, replacement?: object, acknowledge = false, expectedGeneration?: number) {
  const db = await storage();
  if (expectedGeneration !== undefined && generation(key.split('/')[0]!) !== expectedGeneration) throw new Error('Account changed. Sign in to check this form.');
  const transaction = db.transaction('drafts', 'readwrite');
  const done = complete(transaction);
  const store = transaction.objectStore('drafts');
  const existing = await req(store.get(key)) as DraftRecord | undefined;
  const previous = (existing?.value as DraftValue | undefined)?.__submitted;
  const matched = existing?.banker_id === key.split('/')[0] && !!previous && JSON.stringify(previous) === JSON.stringify(request);
  if (matched) {
    if (acknowledge) store.put({ key: acknowledgedKey(key, request), banker_id: key.split('/')[0]!, kind: 'acknowledged_operation', value: { request }, updated_at: Date.now() } satisfies DraftRecord);
    if (replacement) store.put({ ...existing, value: replacement, updated_at: Date.now() });
    else store.delete(key);
  }
  await done; changed();
  return matched;
}
export async function listSubmittedDrafts(banker: string): Promise<SubmittedDraft[]> {
  return (await all<DraftRecord>('drafts')).filter(record => record.banker_id === banker).flatMap(record => {
    const request = (record.value as DraftValue | null)?.__submitted;
    return request ? [{ key: record.key, form: record.key.split('/')[2] ?? 'form', request }] : [];
  });
}
export async function replaySubmittedDraft<T>(key: string): Promise<T> {
  const epoch = generation(key.split('/')[0]!);
  const value = await readDraft<DraftValue>(key);
  const request = value?.__submitted;
  if (!request || !request.path.startsWith('/api/') || !['POST', 'PATCH'].includes(request.method)) throw new Error('There is no submitted form to check');
  const identity = await api<{ banker: Banker }>('/api/auth/me');
  if (identity.banker.id !== key.split('/')[0]) throw new Error('Account changed. Sign in to check this form.');
  let result: T;
  try { result = await api<T>(request.path, request.method, request.body); }
  catch (problem) {
    if (isProvenNotApplied(problem)) {
      const editable = { ...value, op_id: crypto.randomUUID() };
      delete editable.__submitted;
      if (!await finishDraftSubmission(key, request, editable, false, epoch)) throw new Error('This submitted form was cleared in another tab. Check your signed-in account.');
    }
    throw problem;
  }
  if (!await finishDraftSubmission(key, request, undefined, true, epoch)) throw new Error('This submitted form was cleared in another tab. Check your signed-in account.');
  return result;
}
async function flushOnlyDrafts(): Promise<void> {
  while (draftWrites.size) await Promise.all([...draftWrites.values()]);
}
export async function flushDraftWrites(): Promise<void> {
  while (draftWrites.size || enqueueWrites.size) await Promise.all([...draftWrites.values(), ...enqueueWrites]);
}
export async function hasAnyOutbox(): Promise<boolean> {
  await flushDraftWrites();
  return (await all<OutboxItem>('outbox')).length > 0;
}
const snapshotKey = (banker: string, session: string) => `${banker}/${session}`;
export async function readSnapshot(banker: string, session: string): Promise<SessionState | undefined> {
  const db = await storage();
  const record = await req(db.transaction('snapshots').objectStore('snapshots').get(snapshotKey(banker, session))) as SnapshotRecord | undefined;
  return record?.state;
}
export function newerSnapshot(existing: SessionState | undefined, incoming: SessionState): SessionState {
  if (!existing) return incoming;
  const oldRevision = BigInt(existing.revision), newRevision = BigInt(incoming.revision);
  return oldRevision > newRevision || (oldRevision === newRevision && Date.parse(existing.server_now) > Date.parse(incoming.server_now)) ? existing : incoming;
}
export async function storeSnapshot(banker: string, state: SessionState): Promise<void> {
  const db = await storage();
  const transaction = db.transaction('snapshots', 'readwrite');
  const done = complete(transaction);
  const store = transaction.objectStore('snapshots');
  const key = snapshotKey(banker, state.session.id);
  const existing = await req(store.get(key)) as SnapshotRecord | undefined;
  store.put({ key, banker_id: banker, state: newerSnapshot(existing?.state, state) } satisfies SnapshotRecord);
  await done;
}
export async function listSnapshots(banker: string): Promise<SessionState[]> {
  return (await all<SnapshotRecord>('snapshots')).filter(record => record.banker_id === banker).map(record => record.state);
}
export async function listOutbox(banker: string): Promise<OutboxItem[]> {
  return (await all<OutboxItem>('outbox')).filter(item => item.banker_id === banker).sort((a, b) => a.order - b.order);
}
type EnqueueInput = {
  banker_id: string; session_id: string; path: string; method?: 'POST' | 'PATCH'; body: Record<string, unknown>; label: string; draft_key?: string;
};
export function enqueue(input: EnqueueInput): Promise<OutboxItem> {
  const pending = enqueueRecord(input);
  enqueueWrites.add(pending);
  void pending.finally(() => enqueueWrites.delete(pending)).catch(() => {});
  return pending;
}
async function enqueueRecord(input: EnqueueInput): Promise<OutboxItem> {
  const epoch = generation(input.banker_id);
  await flushOnlyDrafts();
  const op = input.body.op_id;
  if (typeof op !== 'string') throw new Error('An entry needs its operation ID');
  const db = await storage();
  if (epoch !== generation(input.banker_id)) throw new Error('Sign in again before saving this draft');
  const transaction = db.transaction(['outbox', 'drafts'], 'readwrite');
  const done = complete(transaction);
  const store = transaction.objectStore('outbox');
  const records = await req(store.getAll()) as OutboxItem[];
  const existing = records.find(item => item.op_id === op);
  if (existing) {
    if (existing.banker_id !== input.banker_id || existing.path !== input.path || existing.method !== (input.method ?? 'POST') || JSON.stringify(existing.body) !== JSON.stringify(input.body)) {
      transaction.abort();
      await done.catch(() => {});
      throw new Error('This draft operation already has different content');
    }
    await done;
    return existing;
  }
  const item: OutboxItem = {
    op_id: op, banker_id: input.banker_id, session_id: input.session_id, path: input.path, method: input.method ?? 'POST',
    body: input.body, label: input.label, order: records.reduce((maximum, item) => Math.max(maximum, item.order), 0) + 1,
    attempts: 0, next_attempt_at: 0, status: 'pending', delivery: 'not_sent',
  };
  store.add(item);
  if (input.draft_key) transaction.objectStore('drafts').delete(input.draft_key);
  await done;
  changed();
  return item;
}
async function updateItem(op: string, update: (item: OutboxItem) => OutboxItem): Promise<void> {
  const db = await storage();
  const transaction = db.transaction('outbox', 'readwrite');
  const done = complete(transaction);
  const store = transaction.objectStore('outbox');
  const item = await req(store.get(op)) as OutboxItem | undefined;
  if (item) store.put(update(item));
  await done;
  changed();
}
export function outboxUncertain(item: OutboxItem): boolean {
  return item.delivery === 'uncertain' || (item.delivery === undefined && (item.attempts > 0 || item.status === 'sending' || item.status === 'uncertain'));
}
export async function retryItem(op: string): Promise<void> {
  await updateItem(op, item => ({ ...item, status: outboxUncertain(item) ? 'uncertain' : 'pending', error: undefined, next_attempt_at: 0, lease_until: 0 }));
}
export async function discardItem(op: string, acceptMayExist = false): Promise<void> {
  const db = await storage();
  const transaction = db.transaction('outbox', 'readwrite');
  const done = complete(transaction);
  const store = transaction.objectStore('outbox');
  const item = await req(store.get(op)) as OutboxItem | undefined;
  if (item?.status === 'sending' && (item.lease_until ?? 0) > Date.now()) {
    await done;
    throw new Error('Wait for this entry to finish saving before discarding');
  }
  if (item && outboxUncertain(item) && !acceptMayExist) {
    await done;
    throw new Error('This entry may already exist on the server. Check its saved result before discarding, or explicitly accept that it may exist.');
  }
  store.delete(op);
  await done;
  changed();
}
export async function hasUnsent(banker: string): Promise<boolean> {
  await flushDraftWrites();
  return (await listOutbox(banker)).length > 0 || (await all<DraftRecord>('drafts')).some(record => record.banker_id === banker && record.kind !== 'acknowledged_operation');
}
export async function clearBankerData(banker: string): Promise<void> {
  generations.set(banker, generation(banker) + 1);
  await flushDraftWrites();
  const db = await storage();
  const transaction = db.transaction(['drafts', 'outbox', 'snapshots'], 'readwrite');
  const done = complete(transaction);
  for (const name of ['drafts', 'outbox', 'snapshots']) {
    const cursor = transaction.objectStore(name).index('banker_id').openCursor(IDBKeyRange.only(banker));
    cursor.onsuccess = () => {
      const current = cursor.result;
      if (current) { current.delete(); current.continue(); }
    };
  }
  await done;
  changed();
}
async function claim(banker: string): Promise<OutboxItem | undefined> {
  const db = await storage();
  const transaction = db.transaction('outbox', 'readwrite');
  const done = complete(transaction);
  const store = transaction.objectStore('outbox');
  const items = (await req(store.getAll()) as OutboxItem[]).filter(item => item.banker_id === banker).sort((a, b) => a.order - b.order);
  const heads = new Map<string, OutboxItem>();
  for (const item of items) if (!heads.has(item.session_id)) heads.set(item.session_id, item);
  const now = Date.now();
  const item = [...heads.values()].find(item => item.status !== 'rejected' && item.next_attempt_at <= now && (item.lease_until ?? 0) <= now);
  if (item) {
    item.status = 'sending';
    item.delivery = 'uncertain';
    item.attempts++;
    item.lease_until = now + 30000;
    store.put(item);
  }
  await done;
  return item;
}
async function acknowledge(banker: string, item: OutboxItem, state: SessionState) {
  const db = await storage();
  const transaction = db.transaction(['snapshots', 'outbox'], 'readwrite');
  const done = complete(transaction);
  const queued = await req(transaction.objectStore('outbox').get(item.op_id)) as OutboxItem | undefined;
  if (!queued || queued.banker_id !== banker) { await done; return undefined; }
  const store = transaction.objectStore('snapshots');
  const key = snapshotKey(banker, state.session.id);
  const existing = await req(store.get(key)) as SnapshotRecord | undefined;
  const latest = newerSnapshot(existing?.state, state);
  store.put({ key, banker_id: banker, state: latest } satisfies SnapshotRecord);
  transaction.objectStore('outbox').delete(item.op_id);
  await done;
  changed();
  return latest;
}
export function syncOutbox(banker: string, onSaved: (state: SessionState, item: OutboxItem) => void, onChange: () => void): () => void {
  const epoch = generation(banker);
  let stopped = false;
  let running = false;
  if (!channel && 'BroadcastChannel' in window) {
    channel = new BroadcastChannel('poker-banker');
    channel.onmessage = () => window.dispatchEvent(new Event('pb-data'));
  }
  const drain = async () => {
    if (running || stopped || !navigator.onLine) return;
    running = true;
    try {
      while (!stopped && navigator.onLine) {
        const item = await claim(banker);
        if (!item) break;
        if (!stopped) onChange();
        let state: SessionState;
        try {
          state = await api<SessionState>(item.path, item.method, item.body);
        } catch (error) {
          const rejected = error instanceof ApiError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status);
          const notApplied = isProvenNotApplied(error);
          await updateItem(item.op_id, current => ({
            ...current, status: rejected ? 'rejected' : 'uncertain', delivery: notApplied ? 'not_applied' : 'uncertain',
            next_attempt_at: Date.now() + Math.min(30000, 1000 * 2 ** Math.min(current.attempts, 5)),
            lease_until: 0, error: error instanceof Error ? error.message : 'Waiting for a connection',
          }));
          if (!stopped) onChange();
          continue;
        }
        if (generation(banker) !== epoch) break;
        const latest = await acknowledge(banker, item, state);
        if (!stopped && latest) { onSaved(latest, item); onChange(); }
      }
    } finally { running = false; }
  };
  const signal = () => { if (!stopped) { onChange(); void drain().catch(onStorageError); } };
  const online = () => {
    void listOutbox(banker).then(items => Promise.all(items.filter(item => item.status === 'pending' || item.status === 'uncertain').map(item => updateItem(item.op_id, current => ({ ...current, next_attempt_at: 0 }))))).then(signal).catch(onStorageError);
  };
  const interval = window.setInterval(signal, 500);
  window.addEventListener('online', online);
  window.addEventListener('pb-data', signal);
  signal();
  return () => { stopped = true; window.clearInterval(interval); window.removeEventListener('online', online); window.removeEventListener('pb-data', signal); };
}
function onStorageError(error: unknown) {
  window.dispatchEvent(new CustomEvent('pb-storage-error', { detail: error instanceof Error ? error.message : 'Local storage failed' }));
}
export async function requestPersistence(): Promise<void> {
  try { await navigator.storage?.persist?.(); } catch {}
}
