import { observeServerTime } from './clock';
import type { SessionState } from '../domain/session';

export type Banker = { id: string; username: string };
export class ApiError extends Error {
  constructor(message: string, public status: number, public code: string) { super(message); }
}
export class AccountChangedError extends ApiError {
  constructor(public bankerId: string) { super('Account changed. Reload account state to continue.', 409, 'account_changed'); }
}
export class UnverifiedResponseError extends Error {
  constructor(public responseStatus: number) {
    super('Response could not be verified. Reconnect and check the saved result.');
    this.name = 'UnverifiedResponseError';
  }
}
export function isProvenNotApplied(problem: unknown): boolean {
  return problem instanceof ApiError && problem.status >= 400 && problem.status < 500
    && ![401, 403, 408, 415, 429].includes(problem.status)
    && typeof problem.code === 'string' && problem.code.trim().length > 0
    && !['request_failed', 'idempotency_mismatch', 'account_changed'].includes(problem.code);
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
export type DraftCursor = { version?: string | null };
export type DraftConflict = { draft_conflict: true; key: string; value: unknown; version: string | null; message: string };
export class DraftConflictError extends Error {
  readonly draft_conflict = true;
  constructor(public key: string, public value: unknown, public version: string | null) {
    super('This draft was edited in another tab. Review the latest draft and submit again.');
    this.name = 'DraftConflictError';
  }
}
export type SubmittedDraft = { key: string; form: string; request: DraftRequest; cursor: DraftCursor };
type DraftValue = Record<string, unknown> & { __submitted?: DraftRequest };
type DraftRecord = { key: string; value: unknown; next_value?: unknown; banker_id: string; updated_at: number; kind?: 'acknowledged_operation'; replay_id?: string };
const acknowledgedKey = (key: string, request: DraftRequest) => `${key.split('/')[0]}/_operations/confirmed/${String(request.body.op_id)}`;
type SnapshotRecord = { key: string; banker_id: string; state: SessionState };
let database: Promise<IDBDatabase> | undefined;
const draftWrites = new Map<string, Promise<void>>();
const enqueueWrites = new Set<Promise<OutboxItem | DraftConflict>>();
type DraftIntent = { value: unknown; revision: number; cursor: DraftCursor; expectedVersion?: string | null; error?: unknown };
type DraftConflictNotice = { key: string; value: unknown; error: DraftConflictError; cursor: DraftCursor };
const draftConflicts = new WeakMap<DraftCursor, DraftConflictNotice>();
const draftConflictNotifications = new Map<string, DraftConflictNotice>();
const observedDraftIntents = new WeakMap<DraftCursor, { key: string; intent: DraftIntent }>();
const unknownDraftVersion = 'unknown';
const draftCursors = new Map<string, DraftCursor>();
const queuedDraftIntents = new Set<DraftIntent>();
type DraftReservation = { cursor: DraftCursor; version?: string | null; value?: unknown; throughRevision: number };
const draftReservations = new Set<DraftReservation>();
const draftIntents = new Map<string, DraftIntent>();
let draftRevision = 0;
const activeClears = new Map<string, IDBTransaction>();
let channel: BroadcastChannel | undefined;
const generations = new Map<string, number>();
const blockedOwners = new Set<string>();
const ownerRequests = new Map<string, Set<AbortController>>();
const generation = (banker: string) => generations.get(banker) ?? 0;
const syncRuns = new Map<string, symbol>();
const draftReplays = new Map<string, symbol>();
export function invalidateBankerWork(banker: string): void {
  generations.set(banker, generation(banker) + 1);
  for (const controller of ownerRequests.get(banker) ?? []) controller.abort();
}
export function resumeBankerWork(banker: string): void {
  if (blockedOwners.has(banker)) invalidateBankerWork(banker);
  blockedOwners.delete(banker);
}
export function blockBankerWork(banker: string): void {
  if (!blockedOwners.has(banker)) {
    blockedOwners.add(banker);
    invalidateBankerWork(banker);
    window.dispatchEvent(Object.assign(new Event('pb-account-changed'), { detail: { bankerId: banker } }));
  }
}
function accountChanged(banker: string): never { blockBankerWork(banker); throw new AccountChangedError(banker); }

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
async function http<T>(path: string, method: string, body: unknown, consume: (response: Response) => Promise<T>, banker?: string, isCurrent = () => true, unchangedPoll = false): Promise<T> {
  const ensureCurrent = () => { if (!isCurrent()) throw new AccountChangedError(banker!); };
  ensureCurrent();
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15000);
  if (banker) {
    let requests = ownerRequests.get(banker);
    if (!requests) { requests = new Set(); ownerRequests.set(banker, requests); }
    requests.add(controller);
  }
  try {
    const response = await fetch(path, {
      method, credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(banker ? { 'X-PB-Expected-Banker-ID': banker } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    ensureCurrent();
    const owner = response.headers.get('X-PB-Banker-ID');
    if (banker && owner && owner !== banker) {
      controller.abort();
      accountChanged(banker);
    }
    if (banker) {
      const unchanged = response.status === 304 && unchangedPoll && method === 'GET' && body === undefined;
      if (!owner && response.status === 401) {
        controller.abort();
        throw new ApiError('Sign in to continue', 401, 'unauthorized');
      }
      if ((!owner && !unchanged) || (response.status === 304 && !unchanged) || [204, 205].includes(response.status) || method === 'HEAD') {
        controller.abort();
        throw new UnverifiedResponseError(response.status);
      }
    }
    let result: T;
    try { result = await consume(response); }
    catch (problem) {
      ensureCurrent();
      if (banker && problem instanceof ApiError && problem.status === 409 && problem.code === 'account_changed') accountChanged(banker);
      throw problem;
    }
    ensureCurrent();
    if (method === 'GET' && result !== null && typeof result === 'object' && 'server_now' in result && typeof result.server_now === 'string') observeServerTime(result.server_now);
    return result;
  } finally {
    window.clearTimeout(timeout);
    if (banker) {
      const requests = ownerRequests.get(banker);
      requests?.delete(controller);
      if (!requests?.size) ownerRequests.delete(banker);
    }
  }
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
  if (!publicRequest(path, method)) throw new Error('This request requires an account-bound client');
  return http(path, method, body, parse<T>);
}
function publicRequest(path: string, method: string): boolean {
  return (method === 'POST' && ['/api/auth/signup', '/api/auth/login', '/api/auth/recover'].includes(path))
    || (method === 'GET' && /^\/api\/view\/[^/?]+(?:\?.*)?$/.test(path));
}
export function discoverAccount(): Promise<{ banker: Banker }> {
  return http('/api/auth/me', 'GET', undefined, parse<{ banker: Banker }>);
}
export type BankerClient = {
  bankerId: string;
  isCurrent: () => boolean;
  api: <T>(path: string, method?: string, body?: unknown) => Promise<T>;
  pollSession: (path: string, revision?: string) => Promise<SessionState | undefined>;
};
export function bankerClient(banker: string, current = () => true): BankerClient {
  if (typeof banker !== 'string' || !banker || banker.trim() !== banker) throw new Error('An account-bound client requires a banker');
  const epoch = generation(banker);
  const isCurrent = () => !blockedOwners.has(banker) && generation(banker) === epoch && current();
  return Object.freeze({
    bankerId: banker, isCurrent,
    api: <T>(path: string, method = 'GET', body?: unknown) => publicRequest(path, method) ? api<T>(path, method, body) : http(path, method, body, parse<T>, banker, isCurrent),
    pollSession: (path: string, revision?: string) => publicRequest(path, 'GET') ? pollSession(path, revision) : http(pollPath(path, revision), 'GET', undefined, consumePoll, banker, isCurrent, !!revision && !/[?#]/.test(path)),
  });
}
function ownerApi<T>(banker: string, request: DraftRequest, isCurrent: () => boolean): Promise<T> {
  return bankerClient(banker, isCurrent).api<T>(request.path, request.method, request.body);
}
const pollPath = (path: string, revision?: string) => revision ? `${path}?since=${encodeURIComponent(revision)}` : path;
const consumePoll = (response: Response) => response.status === 304 ? Promise.resolve(undefined) : parse<SessionState>(response);
export async function pollSession(path: string, revision?: string): Promise<SessionState | undefined> {
  if (!publicRequest(path, 'GET')) throw new Error('This request requires an account-bound client');
  return http(pollPath(path, revision), 'GET', undefined, consumePoll);
}
export const draftKey = (bankerId: string, sessionId: string, form: string, playerId = '') => `${bankerId}/${sessionId}/${form}/${playerId}`;
function draftVersion(record: DraftRecord | undefined): string | null {
  if (!record) return null;
  const value = record.value;
  const editable = value && typeof value === 'object' && !Array.isArray(value) ? { ...value } as DraftValue : value;
  if (editable && typeof editable === 'object' && !Array.isArray(editable)) delete (editable as DraftValue).__submitted;
  return JSON.stringify([editable, record.next_value]);
}
function cursorFor(key: string, cursor?: DraftCursor): DraftCursor {
  if (cursor) return cursor;
  let existing = draftCursors.get(key);
  if (!existing) { existing = {}; draftCursors.set(key, existing); }
  return existing;
}
function observedDraftIntent(key: string, cursor: DraftCursor): DraftIntent | undefined {
  const intent = draftIntents.get(key);
  const observed = observedDraftIntents.get(cursor);
  return intent && (intent.cursor === cursor || (observed?.key === key && observed.intent === intent)) ? intent : undefined;
}
function rejectDraftIntent(key: string, cursor: DraftCursor, intent: DraftIntent | undefined, problem: unknown): void {
  if (!(problem instanceof DraftConflictError) || !intent || draftIntents.get(key) !== intent) return;
  draftIntents.delete(key);
  const notice = { key, value: intent.value, error: problem, cursor };
  draftConflicts.set(cursor, notice);
  draftConflictNotifications.set(key, notice);
  changed();
}
function assertDraftVersion(key: string, record: DraftRecord | undefined, expected: string | null | undefined): void {
  const actual = draftVersion(record);
  if (expected === undefined ? record !== undefined : expected !== actual) throw new DraftConflictError(key, record?.value, actual);
}
function reserveDraft(cursor: DraftCursor, value?: unknown): DraftReservation {
  const reservation = { cursor, version: cursor.version, value, throughRevision: draftRevision };
  draftReservations.add(reservation);
  return reservation;
}
function advanceDraftCursor(cursor: DraftCursor, previous: string | null | undefined, next: string | null, revision?: number): void {
  if (cursor.version === previous) cursor.version = next;
  for (const reservation of draftReservations) {
    if (revision !== undefined && revision <= reservation.throughRevision && reservation.cursor === cursor && reservation.version === previous && (previous === undefined || reservation.value === undefined || draftVersion({ value: reservation.value } as DraftRecord) === next)) reservation.version = next;
  }
  for (const intent of new Set([...queuedDraftIntents, ...draftIntents.values()])) {
    if (intent.cursor === cursor && intent.expectedVersion === previous) intent.expectedVersion = next;
  }
}
export function acceptDraftConflict(key: string, cursor: DraftCursor, conflict: Pick<DraftConflict, 'value' | 'version'>): void {
  cursor.version = conflict.version;
  const notice = draftConflicts.get(cursor);
  if (notice?.key === key && notice.error === conflict) draftConflicts.delete(cursor);
  if (conflict instanceof DraftConflictError) forgetDraftConflict(conflict);
  changed();
}
function forgetDraftConflict(problem: DraftConflictError): boolean {
  const notice = draftConflictNotifications.get(problem.key);
  if (notice?.error !== problem) return false;
  draftConflictNotifications.delete(problem.key);
  if (draftConflicts.get(notice.cursor) === notice) draftConflicts.delete(notice.cursor);
  return true;
}
export function draftConflictNotice(key: string): DraftConflictError | undefined {
  return draftConflictNotifications.get(key)?.error;
}
export function draftConflictNotices(banker?: string): DraftConflictError[] {
  return [...draftConflictNotifications.values()].filter(notice => !banker || notice.key.split('/')[0] === banker).map(notice => notice.error);
}
export function dismissDraftConflict(problem: DraftConflictError): void {
  if (forgetDraftConflict(problem)) changed();
}
export async function readDraft<T>(key: string, cursor?: DraftCursor): Promise<T | undefined> {
  await draftWrites.get(key)?.catch(() => {});
  try {
    const db = await storage();
    const record = await req(db.transaction('drafts').objectStore('drafts').get(key)) as DraftRecord | undefined;
    const intent = draftIntents.get(key);
    if (!record && intent?.error !== undefined) {
      const previous = intent.expectedVersion;
      intent.expectedVersion = null;
      if (intent.cursor.version === previous) intent.cursor.version = null;
    }
    const observation = cursorFor(key, cursor);
    if ((record?.value as DraftValue | undefined)?.__submitted) { observedDraftIntents.delete(observation); observation.version = draftVersion(record); return record!.value as T; }
    if (intent) observedDraftIntents.set(observation, { key, intent });
    else observedDraftIntents.delete(observation);
    observation.version = intent ? intent.expectedVersion : draftVersion(record);
    return (intent ? intent.value : record?.value) as T | undefined;
  } catch (problem) {
    const intent = draftIntents.get(key);
    if (intent) {
      const observation = cursorFor(key, cursor);
      observedDraftIntents.set(observation, { key, intent });
      observation.version = intent.expectedVersion;
      return intent.value as T;
    }
    throw problem;
  }
}
function draftWrite(key: string, action: () => Promise<void>): Promise<void> {
  const previous = draftWrites.get(key) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(action);
  draftWrites.set(key, pending);
  void pending.finally(() => { if (draftWrites.get(key) === pending) draftWrites.delete(key); }).catch(() => {});
  return pending;
}
export function writeDraft(key: string, value: unknown, observation?: DraftCursor): Promise<void> {
  const cursor = cursorFor(key, observation);
  draftConflicts.delete(cursor);
  observedDraftIntents.delete(cursor);
  const intent: DraftIntent = { value: structuredClone(value), revision: ++draftRevision, cursor, expectedVersion: cursor.version, error: draftIntents.get(key)?.error };
  draftIntents.set(key, intent);
  return saveDraftIntent(key, intent);
}
function saveDraftIntent(key: string, intent: DraftIntent): Promise<void> {
  const banker = key.split('/')[0]!;
  activeClears.get(banker)?.abort();
  queuedDraftIntents.add(intent);
  const pending = draftWrite(key, async () => {
    let completion: Promise<void> | undefined;
    try {
      const db = await storage();
      const transaction = db.transaction('drafts', 'readwrite');
      const done = complete(transaction);
      completion = done;
      const store = transaction.objectStore('drafts');
      const existing = await req(store.get(key)) as DraftRecord | undefined;
      if (intent.expectedVersion === undefined || (intent.expectedVersion === unknownDraftVersion && !existing)) {
        const observed = draftVersion(existing);
        advanceDraftCursor(intent.cursor, intent.expectedVersion, observed, intent.revision);
        intent.expectedVersion = observed;
      }
      try { assertDraftVersion(key, existing, intent.expectedVersion); } catch (problem) { await done; throw problem; }
      let next: DraftRecord;
      if ((existing?.value as DraftValue | undefined)?.__submitted) next = { ...existing!, next_value: intent.value, updated_at: Date.now() };
      else {
        const stored = existing?.value as DraftValue | undefined;
        const incoming = intent.value as DraftValue | undefined;
        const value = stored?.op_id && incoming?.op_id && stored.op_id !== incoming.op_id ? { ...incoming, op_id: stored.op_id } : intent.value;
        next = { key, banker_id: banker, value, updated_at: Date.now() };
      }
      store.put(next);
      await done;
      advanceDraftCursor(intent.cursor, intent.expectedVersion, draftVersion(next), intent.revision);
      if (draftIntents.get(key) === intent) draftIntents.delete(key);
      changed();
    } catch (problem) {
      await completion?.catch(() => {});
      if (intent.expectedVersion === undefined) {
        advanceDraftCursor(intent.cursor, undefined, unknownDraftVersion, intent.revision);
        intent.expectedVersion = unknownDraftVersion;
      }
      const latest = draftIntents.get(key);
      if (problem instanceof DraftConflictError) {
        rejectDraftIntent(key, intent.cursor, intent, problem);
      } else {
        intent.error = problem;
        if (latest) latest.error ??= problem;
      }
      changed();
      throw problem;
    }
  });
  void pending.finally(() => queuedDraftIntents.delete(intent)).catch(() => {});
  return pending;
}
export function hasPendingLocalWrites(): boolean { return draftIntents.size > 0 || draftWrites.size > 0 || enqueueWrites.size > 0; }
export function draftSaveFailed(key?: string): boolean {
  return key ? draftIntents.get(key)?.error !== undefined : [...draftIntents.values()].some(intent => intent.error !== undefined);
}
export function draftConflict(key: string, cursor: DraftCursor, value?: unknown): DraftConflictError | undefined {
  const notice = draftConflicts.get(cursor);
  return notice?.key === key && (value === undefined || JSON.stringify(notice.value) === JSON.stringify(value)) ? notice.error : undefined;
}
export function deleteDraft(key: string, isCurrent = () => true, observation?: DraftCursor): Promise<void> {
  const cursor = cursorFor(key, observation);
  const reservation = reserveDraft(cursor, draftIntents.get(key)?.value);
  const banker = key.split('/')[0]!;
  const epoch = generation(banker);
  const intent = observedDraftIntent(key, cursor);
  const pending = draftWrite(key, async () => {
    const expected = reservation.version;
    const db = await storage();
    if (generation(banker) !== epoch || !isCurrent()) return;
    const transaction = db.transaction('drafts', 'readwrite');
    const done = complete(transaction);
    const store = transaction.objectStore('drafts');
    const existing = await req(store.get(key)) as DraftRecord | undefined;
    if (generation(banker) !== epoch || !isCurrent()) { await done; return; }
    try { assertDraftVersion(key, existing, expected); } catch (problem) { await done; if (isCurrent()) rejectDraftIntent(key, cursor, intent, problem); throw problem; }
    if ((existing?.value as DraftValue | undefined)?.__submitted) { await done; throw new Error('Check the saved result before discarding this submitted form'); }
    store.delete(key); await done;
    advanceDraftCursor(cursor, expected, null);
    if (draftIntents.get(key) === intent) draftIntents.delete(key);
    changed();
  });
  void pending.finally(() => draftReservations.delete(reservation)).catch(() => {});
  return pending;
}
export async function prepareDraftSubmission<T extends object>(key: string, value: T, request: DraftRequest, isCurrent = () => true, observation?: DraftCursor) {
  const cursor = cursorFor(key, observation);
  const reservation = reserveDraft(cursor, value);
  try {
  const banker = key.split('/')[0]!;
  const epoch = generation(banker);
  await draftWrites.get(key);
  const intent = draftIntents.get(key);
  if (intent) await saveDraftIntent(key, intent);
  const expected = reservation.version;
  const db = await storage();
  const current = () => generation(banker) === epoch && isCurrent();
  if (!current()) throw new Error('Account changed. Sign in to check this form.');
  const transaction = db.transaction('drafts', 'readwrite');
  const done = complete(transaction);
  const store = transaction.objectStore('drafts');
  const existing = await req(store.get(key)) as DraftRecord | undefined;
  const previous = (existing?.value as DraftValue | undefined)?.__submitted;
  const acknowledged = await req(store.get(acknowledgedKey(key, request))) as DraftRecord | undefined;
  if (!current()) { await done; throw new Error('Account changed. Sign in to check this form.'); }
  const priorRequest = (acknowledged?.value as { request: DraftRequest } | undefined)?.request;
  const stored = existing?.value as DraftValue | undefined;
  if ((expected !== undefined && expected !== draftVersion(existing)) || (stored && !previous && JSON.stringify(stored) !== JSON.stringify(value))) {
    await done;
    cursor.version = draftVersion(existing);
    return { request, first: false, value: (stored ?? { ...value, op_id: crypto.randomUUID() }) as T, previouslyConfirmed: true };
  }
  if (!previous && stored?.op_id && stored.op_id !== request.body.op_id) {
    const fresh = stored as T;
    await done;
    cursor.version = draftVersion(existing);
    return { request, first: false, value: fresh, previouslyConfirmed: true };
  }
  if (!previous && priorRequest && JSON.stringify(priorRequest) !== JSON.stringify(request)) {
    const fresh = { ...value, op_id: crypto.randomUUID() };
    const nextRecord = { key, banker_id: banker, value: fresh, updated_at: Date.now() } satisfies DraftRecord;
    store.put(nextRecord);
    await done;
    advanceDraftCursor(cursor, expected, draftVersion(nextRecord));
    changed();
    return { request, first: false, value: fresh, previouslyConfirmed: true };
  }
  const selected = previous ?? priorRequest ?? structuredClone(request);
  const next = previous ? existing!.value as T & { __submitted: DraftRequest } : { ...value, __submitted: selected };
  const nextRecord = previous ? existing : { key, banker_id: banker, value: next, updated_at: Date.now() };
  if (!previous) store.put(nextRecord!);
  await done;
  advanceDraftCursor(cursor, expected, draftVersion(nextRecord));
  changed();
  return { request: selected, first: !previous && !priorRequest, value: next, previouslyConfirmed: false };
  } finally { draftReservations.delete(reservation); }
}
async function claimDraftReplay(key: string, replayId: string, isCurrent: () => boolean, cursor: DraftCursor, intent: DraftIntent | undefined): Promise<{ value: DraftValue; version: string | null } | undefined> {
  const expected = cursor.version;
  await draftWrites.get(key);
  const db = await storage();
  if (!isCurrent()) return;
  const transaction = db.transaction('drafts', 'readwrite');
  const done = complete(transaction);
  const store = transaction.objectStore('drafts');
  const existing = await req(store.get(key)) as DraftRecord | undefined;
  const value = existing?.value as DraftValue | undefined;
  if (!isCurrent() || (existing && existing.banker_id !== key.split('/')[0])) { await done; return; }
  try { assertDraftVersion(key, existing, expected); } catch (problem) { await done; if (isCurrent()) rejectDraftIntent(key, cursor, intent, problem); throw problem; }
  if (!value?.__submitted) { await done; return; }
  store.put({ ...existing, replay_id: replayId });
  await done;
  const version = draftVersion(existing);
  advanceDraftCursor(cursor, expected, version);
  return { value, version };
}
async function finishDraftSubmission(key: string, request: DraftRequest, replayId: string, isCurrent: () => boolean, cursor: DraftCursor, expected: string | null, capturedIntent: DraftIntent | undefined, replacement?: object, acknowledge = false) {
  const db = await storage();
  if (!isCurrent()) throw new Error('Account changed. Sign in to check this form.');
  const transaction = db.transaction('drafts', 'readwrite');
  const done = complete(transaction);
  const store = transaction.objectStore('drafts');
  const existing = await req(store.get(key)) as DraftRecord | undefined;
  const previous = (existing?.value as DraftValue | undefined)?.__submitted;
  const matched = isCurrent() && existing?.banker_id === key.split('/')[0] && existing?.replay_id === replayId && !!previous && JSON.stringify(previous) === JSON.stringify(request);
  if (matched) {
    try { assertDraftVersion(key, existing, expected); } catch (problem) { await done; if (isCurrent()) rejectDraftIntent(key, cursor, capturedIntent, problem); throw problem; }
  }
  const editable = existing?.next_value !== undefined ? { ...(existing.next_value as DraftValue), op_id: crypto.randomUUID() } : replacement;
  let nextRecord: DraftRecord | undefined;
  if (matched) {
    if (acknowledge) store.put({ key: acknowledgedKey(key, request), banker_id: key.split('/')[0]!, kind: 'acknowledged_operation', value: { request }, updated_at: Date.now() } satisfies DraftRecord);
    if (editable) { nextRecord = { key, banker_id: key.split('/')[0]!, value: editable, updated_at: Date.now() }; store.put(nextRecord); }
    else store.delete(key);
  }
  await done;
  if (matched) advanceDraftCursor(cursor, expected, draftVersion(nextRecord));
  const intent = draftIntents.get(key);
  const retained = intent?.value as DraftValue | undefined;
  if (matched && isCurrent() && intent && retained && !retained.__submitted && retained.op_id === request.body.op_id && (replacement || acknowledge)) {
    draftIntents.set(key, { ...intent, value: { ...retained, op_id: editable ? (editable as DraftValue).op_id : crypto.randomUUID() }, revision: ++draftRevision });
  }
  changed();
  return matched;
}
export async function listSubmittedDrafts(banker: string): Promise<SubmittedDraft[]> {
  return (await all<DraftRecord>('drafts')).filter(record => record.banker_id === banker).flatMap(record => {
    const request = (record.value as DraftValue | null)?.__submitted;
    if (!request) return [];
    const version = draftVersion(record);
    cursorFor(record.key).version = version;
    return [{ key: record.key, form: record.key.split('/')[2] ?? 'form', request, cursor: { version } }];
  });
}
export async function replaySubmittedDraft<T>(key: string, isCurrent = () => true, observation?: DraftCursor): Promise<T> {
  const cursor = cursorFor(key, observation);
  const capturedIntent = observedDraftIntent(key, cursor);
  const banker = key.split('/')[0]!;
  const epoch = generation(banker);
  const replay = Symbol();
  const replayId = crypto.randomUUID();
  draftReplays.set(key, replay);
  const current = () => generation(banker) === epoch && draftReplays.get(key) === replay && isCurrent();
  const ensureCurrent = () => { if (!current()) throw new Error('Account changed or this form is no longer open. Check your saved work.'); };
  try {
    ensureCurrent();
    if (!observation) { await readDraft(key, cursor); ensureCurrent(); }
    const claimed = await claimDraftReplay(key, replayId, current, cursor, capturedIntent);
    ensureCurrent();
    const value = claimed?.value;
    const request = value?.__submitted;
    if (!request || !request.path.startsWith('/api/') || !['POST', 'PATCH'].includes(request.method)) throw new Error('There is no submitted form to check');
    const identity = await bankerClient(banker, current).api<{ banker: Banker }>('/api/auth/me');
    ensureCurrent();
    if (identity.banker.id !== banker) accountChanged(banker);
    let result: T;
    try { result = await ownerApi<T>(banker, request, current); }
    catch (problem) {
      ensureCurrent();
      if (isProvenNotApplied(problem)) {
        const editable = { ...value, op_id: crypto.randomUUID() };
        delete editable.__submitted;
        if (!await finishDraftSubmission(key, request, replayId, current, cursor, claimed!.version, capturedIntent, editable)) throw new Error('This submitted form was cleared or checked in another tab. Check your signed-in account.');
      }
      throw problem;
    }
    ensureCurrent();
    if (!await finishDraftSubmission(key, request, replayId, current, cursor, claimed!.version, capturedIntent, undefined, true)) throw new Error('This submitted form was cleared or checked in another tab. Check your signed-in account.');
    ensureCurrent();
    return result;
  } finally { if (draftReplays.get(key) === replay) draftReplays.delete(key); }
}
async function flushOnlyDrafts(): Promise<void> {
  while (draftWrites.size) await Promise.allSettled([...draftWrites.values()]);
  await Promise.allSettled([...draftIntents].map(([key, intent]) => saveDraftIntent(key, intent)));
  if (draftIntents.size) throw new Error('Not saved on this device. Retry saving draft before continuing.');
}
export async function flushDraftWrites(): Promise<void> {
  await flushOnlyDrafts();
  while (draftWrites.size || enqueueWrites.size) await Promise.allSettled([...draftWrites.values(), ...enqueueWrites]);
  if (draftIntents.size) throw new Error('Not saved on this device. Retry saving draft before continuing.');
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
  const epoch = generation(banker);
  const db = await storage();
  if (blockedOwners.has(banker) || generation(banker) !== epoch) return;
  const transaction = db.transaction('snapshots', 'readwrite');
  const done = complete(transaction);
  const store = transaction.objectStore('snapshots');
  const key = snapshotKey(banker, state.session.id);
  const existing = await req(store.get(key)) as SnapshotRecord | undefined;
  if (blockedOwners.has(banker) || generation(banker) !== epoch) { await done; return; }
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
  banker_id: string; session_id: string; path: string; method?: 'POST' | 'PATCH'; body: Record<string, unknown>; label: string; draft_key?: string; draft_cursor?: DraftCursor; draft_value?: unknown;
};
export function enqueue(input: EnqueueInput): Promise<OutboxItem | DraftConflict> {
  activeClears.get(input.banker_id)?.abort();
  const pending = enqueueRecord(input);
  enqueueWrites.add(pending);
  void pending.finally(() => enqueueWrites.delete(pending)).catch(() => {});
  return pending;
}
async function enqueueRecord(input: EnqueueInput): Promise<OutboxItem | DraftConflict> {
  const cursor = input.draft_key ? cursorFor(input.draft_key, input.draft_cursor) : undefined;
  const reservation = cursor ? reserveDraft(cursor, input.draft_value) : undefined;
  try {
  const epoch = generation(input.banker_id);
  await flushOnlyDrafts();
  const expected = reservation?.version;
  const op = input.body.op_id;
  if (typeof op !== 'string') throw new Error('An entry needs its operation ID');
  const db = await storage();
  if (epoch !== generation(input.banker_id)) throw new Error('Sign in again before saving this draft');
  const transaction = db.transaction(['outbox', 'drafts'], 'readwrite');
  const done = complete(transaction);
  const store = transaction.objectStore('outbox');
  if (input.draft_key) {
    const draft = await req(transaction.objectStore('drafts').get(input.draft_key)) as DraftRecord | undefined;
    if ((draft !== undefined && expected === undefined) || (expected !== undefined && draftVersion(draft) !== expected) || (input.draft_value !== undefined && draft && JSON.stringify(draft.value) !== JSON.stringify(input.draft_value))) {
      await done;
      const problem = new DraftConflictError(input.draft_key, draft?.value, draftVersion(draft));
      return { draft_conflict: true, key: problem.key, value: problem.value, version: problem.version, message: problem.message };
    }
    if ((draft?.value as DraftValue | undefined)?.__submitted) { await done; throw new Error('Check the saved result before submitting this form again'); }
  }
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
  if (cursor) advanceDraftCursor(cursor, expected, null);
  changed();
  return item;
  } finally { if (reservation) draftReservations.delete(reservation); }
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
  return (await readBankerWork(banker)).hasUnsent;
}
export type BankerWork = { bankerId: string; fingerprint: string; hasUnsent: boolean };
function workSnapshot(banker: string, drafts: DraftRecord[], outbox: OutboxItem[]): BankerWork {
  const ownedDrafts = drafts.filter(record => record.banker_id === banker && record.kind !== 'acknowledged_operation').sort((a, b) => a.key.localeCompare(b.key));
  const ownedOutbox = outbox.filter(item => item.banker_id === banker).sort((a, b) => a.op_id.localeCompare(b.op_id));
  const dirty = [...draftIntents].filter(([key]) => key.split('/')[0] === banker).map(([key, intent]) => ({ key, revision: intent.revision, value: intent.value })).sort((a, b) => a.key.localeCompare(b.key));
  return { bankerId: banker, fingerprint: JSON.stringify([ownedDrafts, ownedOutbox, dirty]), hasUnsent: ownedDrafts.length > 0 || ownedOutbox.length > 0 || dirty.length > 0 };
}
function requireConsent(work: BankerWork, consent?: BankerWork): void {
  if (consent ? consent.bankerId !== work.bankerId || consent.fingerprint !== work.fingerprint : work.hasUnsent) throw new Error('Local work changed. Review and explicitly discard the current unsent entries and drafts before signing out.');
}
export async function readBankerWork(banker: string): Promise<BankerWork> {
  while (draftWrites.size || enqueueWrites.size) await Promise.allSettled([...draftWrites.values(), ...enqueueWrites]);
  const db = await storage();
  const transaction = db.transaction(['drafts', 'outbox'], 'readonly');
  const [drafts, outbox] = await Promise.all([req(transaction.objectStore('drafts').getAll()) as Promise<DraftRecord[]>, req(transaction.objectStore('outbox').getAll()) as Promise<OutboxItem[]>]);
  return workSnapshot(banker, drafts, outbox);
}
export async function verifyBankerWork(banker: string, consent?: BankerWork): Promise<void> {
  requireConsent(await readBankerWork(banker), consent);
}
export async function clearBankerData(banker: string, consent?: BankerWork): Promise<void> {
  while (draftWrites.size || enqueueWrites.size) await Promise.allSettled([...draftWrites.values(), ...enqueueWrites]);
  const db = await storage();
  const transaction = db.transaction(['drafts', 'outbox', 'snapshots'], 'readwrite');
  const done = complete(transaction);
  activeClears.set(banker, transaction);
  try {
    const [drafts, outbox, snapshots] = await Promise.all([
      req(transaction.objectStore('drafts').getAll()) as Promise<DraftRecord[]>,
      req(transaction.objectStore('outbox').getAll()) as Promise<OutboxItem[]>,
      req(transaction.objectStore('snapshots').getAll()) as Promise<SnapshotRecord[]>,
    ]);
    requireConsent(workSnapshot(banker, drafts, outbox), consent);
    const accepted = [...draftIntents].filter(([key]) => key.split('/')[0] === banker);
    for (const record of drafts) if (record.banker_id === banker) transaction.objectStore('drafts').delete(record.key);
    for (const item of outbox) if (item.banker_id === banker) transaction.objectStore('outbox').delete(item.op_id);
    for (const record of snapshots) if (record.banker_id === banker) transaction.objectStore('snapshots').delete(record.key);
    await done;
    for (const [key, intent] of accepted) if (draftIntents.get(key) === intent) draftIntents.delete(key);
    invalidateBankerWork(banker);
    changed();
  } catch (problem) {
    try { transaction.abort(); } catch {}
    await done.catch(() => {});
    throw problem;
  } finally {
    if (activeClears.get(banker) === transaction) activeClears.delete(banker);
  }
}
async function claim(banker: string, isCurrent: () => boolean): Promise<OutboxItem | undefined> {
  const db = await storage();
  if (!isCurrent()) return;
  const transaction = db.transaction('outbox', 'readwrite');
  const done = complete(transaction);
  const store = transaction.objectStore('outbox');
  const items = (await req(store.getAll()) as OutboxItem[]).filter(item => item.banker_id === banker).sort((a, b) => a.order - b.order);
  if (!isCurrent()) { await done; return; }
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
function sameClaim(current: OutboxItem | undefined, item: OutboxItem): current is OutboxItem {
  return !!current && current.banker_id === item.banker_id && current.status === 'sending' && current.attempts === item.attempts && current.lease_until === item.lease_until;
}
async function settleClaim(item: OutboxItem, isCurrent: () => boolean, error?: unknown): Promise<void> {
  const db = await storage();
  const transaction = db.transaction('outbox', 'readwrite');
  const done = complete(transaction);
  const store = transaction.objectStore('outbox');
  const current = await req(store.get(item.op_id)) as OutboxItem | undefined;
  if (sameClaim(current, item)) {
    const valid = isCurrent();
    const rejected = valid && error instanceof ApiError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status);
    store.put({
      ...current, status: rejected ? 'rejected' : 'uncertain', delivery: valid && isProvenNotApplied(error) ? 'not_applied' : 'uncertain',
      next_attempt_at: valid ? Date.now() + Math.min(30000, 1000 * 2 ** Math.min(current.attempts, 5)) : 0,
      lease_until: 0, error: valid && error instanceof Error ? error.message : 'Save not confirmed. Check your saved entry.',
    } satisfies OutboxItem);
  }
  await done;
  changed();
}
async function acknowledge(banker: string, item: OutboxItem, state: SessionState, isCurrent: () => boolean) {
  const db = await storage();
  if (!isCurrent()) return;
  const transaction = db.transaction(['snapshots', 'outbox'], 'readwrite');
  const done = complete(transaction);
  const queued = await req(transaction.objectStore('outbox').get(item.op_id)) as OutboxItem | undefined;
  if (!isCurrent() || !sameClaim(queued, item)) { await done; return undefined; }
  const store = transaction.objectStore('snapshots');
  const key = snapshotKey(banker, state.session.id);
  const existing = await req(store.get(key)) as SnapshotRecord | undefined;
  if (!isCurrent()) { await done; return undefined; }
  const latest = newerSnapshot(existing?.state, state);
  store.put({ key, banker_id: banker, state: latest } satisfies SnapshotRecord);
  transaction.objectStore('outbox').delete(item.op_id);
  await done;
  changed();
  return latest;
}
export function syncOutbox(banker: string, onSaved: (state: SessionState, item: OutboxItem) => void, onChange: () => void): () => void {
  const epoch = generation(banker);
  const run = Symbol();
  syncRuns.set(banker, run);
  let stopped = false;
  let running = false;
  const isCurrent = () => !stopped && generation(banker) === epoch && syncRuns.get(banker) === run;
  if (!channel && 'BroadcastChannel' in window) {
    channel = new BroadcastChannel('poker-banker');
    channel.onmessage = () => window.dispatchEvent(new Event('pb-data'));
  }
  const drain = async () => {
    if (running || !isCurrent() || !navigator.onLine) return;
    running = true;
    try {
      while (isCurrent() && navigator.onLine) {
        const item = await claim(banker, isCurrent);
        if (!item) break;
        if (!isCurrent()) { await settleClaim(item, isCurrent); break; }
        onChange();
        if (!isCurrent()) { await settleClaim(item, isCurrent); break; }
        let state: SessionState;
        try {
          state = await ownerApi<SessionState>(banker, item, isCurrent);
        } catch (error) {
          await settleClaim(item, isCurrent, error);
          if (!isCurrent()) break;
          onChange();
          continue;
        }
        if (!isCurrent()) { await settleClaim(item, isCurrent); break; }
        const latest = await acknowledge(banker, item, state, isCurrent);
        if (!isCurrent()) { await settleClaim(item, isCurrent); break; }
        if (latest) { onSaved(latest, item); if (isCurrent()) onChange(); }
      }
    } finally { running = false; }
  };
  const signal = () => { if (isCurrent()) { onChange(); if (isCurrent()) void drain().catch(onStorageError); } };
  const online = () => {
    if (!isCurrent()) return;
    void listOutbox(banker).then(items => isCurrent() ? Promise.all(items.filter(item => item.status === 'pending' || item.status === 'uncertain').map(item => updateItem(item.op_id, current => isCurrent() && current.status !== 'sending' ? { ...current, next_attempt_at: 0 } : current))) : undefined).then(signal).catch(onStorageError);
  };
  const interval = window.setInterval(signal, 500);
  window.addEventListener('online', online);
  window.addEventListener('pb-data', signal);
  signal();
  return () => { stopped = true; if (syncRuns.get(banker) === run) syncRuns.delete(banker); window.clearInterval(interval); window.removeEventListener('online', online); window.removeEventListener('pb-data', signal); };
}
function onStorageError(error: unknown) {
  window.dispatchEvent(new CustomEvent('pb-storage-error', { detail: error instanceof Error ? error.message : 'Local storage failed' }));
}
export async function requestPersistence(): Promise<void> {
  try { await navigator.storage?.persist?.(); } catch {}
}
