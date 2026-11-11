import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import type { SessionState } from '../src/domain/session';
import { testDatabase } from './database';

let database: Awaited<ReturnType<typeof testDatabase>>;
let app: ReturnType<typeof createApp>;
const origin = 'https://unknown-start.test';
let cookie = '';
beforeAll(async () => {
  database = await testDatabase();
  app = createApp(database.pool, { origin });
  const response = await app.request(`${origin}/api/auth/signup`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ username: `start-${randomUUID().slice(0, 8)}`, password: 'secure-unknown-start-password' }) });
  expect(response.status).toBe(200);
  cookie = response.headers.get('set-cookie')!.split(';')[0]!;
});
afterAll(async () => { await database.stop(); });
async function request(path: string, body?: unknown, method = body ? 'POST' : 'GET'): Promise<SessionState> {
  const response = await app.request(`${origin}/api${path}`, { method, headers: { origin, 'content-type': 'application/json', cookie }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const value = await response.json();
  expect(response.status, JSON.stringify(value)).toBe(200);
  return value as SessionState;
}
async function session() {
  const created = await request('/sessions', { op_id: randomUUID(), name: 'Unknown start', played_on: '2026-11-10', currency: 'USD' });
  return request(`/sessions/${created.session.id}/players`, { op_id: randomUUID(), new_player_name: 'Justin' });
}
async function buyIn(state: SessionState, occurred_at: string | null) {
  return request(`/sessions/${state.session.id}/entries`, { op_id: randomUUID(), player_id: state.players[0]!.id, kind: 'buy_in', amount_minor: '10000', paid_now: false, occurred_at });
}
it('leaves an unknown first start unset through reload and later known rebuys', async () => {
  let state = await buyIn(await session(), null);
  const id = state.session.id;
  expect(state.timing).toEqual({ started_at: null, ended_at: null, elapsed_ms: null });
  expect(state.events.some(event => event.kind === 'timer_started')).toBe(false);
  state = await request(`/sessions/${id}`);
  expect(state.session.started_at).toBeNull();
  state = await buyIn(state, '2026-11-10T20:00:00Z');
  expect(state.session.started_at).toBeNull();
  expect(state.players[0]!.duration_ms).toBeNull();
  expect(state.events.some(event => event.kind === 'timer_started')).toBe(false);
});
it('allows correcting an unknown buy-in to its real earlier time before setting table timing', async () => {
  let state = await buyIn(await session(), null);
  const original = state.entries[0]!;
  state = await request(`/sessions/${state.session.id}/entries/${original.id}/void`, { op_id: randomUUID(), replacement_occurred_at: '2026-11-10T18:00:00Z' });
  expect(state.session.started_at).toBeNull();
  expect(state.entries.find(entry => entry.kind === 'buy_in' && entry.id !== original.id && entry.voids_entry_id === null)?.occurred_at).toBe('2026-11-10T18:00:00.000Z');
  state = await request(`/sessions/${state.session.id}/timing`, { op_id: randomUUID(), started_at: '2026-11-10T18:00:00Z', ended_at: null }, 'PATCH');
  expect(state.session.started_at).toBe('2026-11-10T18:00:00.000Z');
  expect(state.events[0]).toMatchObject({ kind: 'timing_corrected', detail: { old: { started_at: null, ended_at: null }, new: { started_at: '2026-11-10T18:00:00.000Z', ended_at: null } } });
});
it('starts at a known first buy-in time and ignores voided buy-ins when finding that first buy-in', async () => {
  let state = await buyIn(await session(), null);
  state = await request(`/sessions/${state.session.id}/entries/${state.entries[0]!.id}/void`, { op_id: randomUUID() });
  state = await buyIn(state, '2026-11-10T18:00:00Z');
  expect(state.session.started_at).toBe('2026-11-10T18:00:00.000Z');
  expect(state.events[0]).toMatchObject({ kind: 'timer_started', detail: { old: { started_at: null, ended_at: null }, new: { started_at: '2026-11-10T18:00:00.000Z', ended_at: null } } });
  const later = await buyIn(state, '2026-11-10T19:00:00Z');
  expect(later.session.started_at).toBe(state.session.started_at);
  expect(later.events.filter(event => event.kind === 'timer_started')).toHaveLength(1);
  expect((await request(`/sessions/${state.session.id}`)).session.started_at).toBe('2026-11-10T18:00:00.000Z');
});
it.each(['buy_in', 'cash_out'] as const)('rejects starting after a saved %s without changing timing, revision, history or idempotency', async kind => {
  let state = await session();
  if (kind === 'buy_in') state = await buyIn(state, null);
  state = await request(`/sessions/${state.session.id}/entries`, { op_id: randomUUID(), player_id: state.players[0]!.id, kind, amount_minor: '10000', paid_now: false, occurred_at: '2026-11-10T19:00:00Z' });
  expect(state.session.started_at).toBeNull();
  const op_id = randomUUID();
  const response = await app.request(`${origin}/api/sessions/${state.session.id}/start`, { method: 'POST', headers: { origin, 'content-type': 'application/json', cookie }, body: JSON.stringify({ op_id }) });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: 'entries_outside_timing', message: 'Timing must include the effective entries' } });
  const after = await request(`/sessions/${state.session.id}`);
  expect(after.timing).toEqual(state.timing);
  expect(after.revision).toBe(state.revision);
  expect(after.events).toEqual(state.events);
  expect(after.entries).toEqual(state.entries);
  expect((await database.pool.query('SELECT key FROM idempotency_keys WHERE key=$1', [op_id])).rows).toEqual([]);
});
it('starts before future chip entries while ignoring voided chips, payments and expenses before now', async () => {
  let state = await session();
  const path = `/sessions/${state.session.id}`;
  const player_id = state.players[0]!.id;
  state = await request(`${path}/entries`, { op_id: randomUUID(), player_id, kind: 'cash_out', amount_minor: '10000', paid_now: false, occurred_at: '2026-11-10T19:00:00Z' });
  state = await request(`${path}/entries/${state.entries[0]!.id}/void`, { op_id: randomUUID() });
  for (const kind of ['payment_in', 'payment_out', 'expense']) state = await request(`${path}/entries`, { op_id: randomUUID(), player_id, kind, amount_minor: '100', ...(kind === 'expense' ? { note: 'Meal' } : { method: 'cash' }), occurred_at: '2026-11-10T19:00:00Z' });
  const future = (await database.pool.query<{ time: string }>(`SELECT to_char((clock_timestamp() + interval '1 hour') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS time`)).rows[0]!.time;
  state = await request(`${path}/entries`, { op_id: randomUUID(), player_id, kind: 'cash_out', amount_minor: '10000', paid_now: false, occurred_at: future });
  const before = state;
  const op_id = randomUUID();
  state = await request(`${path}/start`, { op_id });
  expect(state.session.started_at).not.toBeNull();
  expect(Date.parse(state.session.started_at!)).toBeLessThanOrEqual(Date.parse(future));
  expect(state.session.ended_at).toBeNull();
  expect(BigInt(state.revision)).toBe(BigInt(before.revision) + 1n);
  expect(state.entries).toEqual(before.entries);
  expect(state.events[0]).toMatchObject({ kind: 'timer_started', detail: { old: { started_at: null, ended_at: null }, new: { started_at: state.session.started_at, ended_at: null } } });
  expect(await request(`${path}/start`, { op_id })).toEqual(state);
  state = await request(`${path}/entries`, { op_id: randomUUID(), player_id, kind: 'cash_out', amount_minor: '0', paid_now: false, occurred_at: state.session.started_at });
  expect(state.entries.find(entry => entry.kind === 'cash_out' && entry.amount_minor === '0' && entry.revision === state.revision)?.occurred_at).toBe(state.session.started_at);
});
