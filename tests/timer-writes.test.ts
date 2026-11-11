import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import type { SessionState } from '../src/domain/session';
import { testDatabase } from './database';

let database: Awaited<ReturnType<typeof testDatabase>>;
let app: ReturnType<typeof createApp>;
let cookie = '';
const origin = 'https://timer-writes.test';
const earlier = '2026-11-10T18:00:00.000Z';
const cashOutTime = '2026-11-10T19:00:00.000Z';
const reentryTime = '2026-11-10T20:00:00.000Z';

async function request(path: string, body?: object, method = body === undefined ? 'GET' : 'POST') {
  return app.request(`${origin}/api${path}`, {
    method, headers: { origin, 'content-type': 'application/json', cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function ok<T>(response: Response): Promise<T> {
  const value = await response.json();
  expect(response.status, JSON.stringify(value)).toBe(200);
  return value as T;
}
async function write(state: SessionState, suffix: string, body: object) {
  return ok<SessionState>(await request(`/sessions/${state.session.id}${suffix}`, { op_id: randomUUID(), ...body }));
}
async function session() {
  const state = await ok<SessionState>(await request('/sessions', { op_id: randomUUID(), name: 'Timer writes', played_on: '2026-11-10', currency: 'USD' }));
  return write(state, '/players', { new_player_name: 'Justin' });
}
async function entry(state: SessionState, kind: string, occurred_at: string | null, extra: object = {}) {
  const chip = kind === 'buy_in' || kind === 'cash_out';
  return write(state, '/entries', {
    player_id: state.players[0]!.id, kind, amount_minor: chip ? '10000' : '100', occurred_at,
    ...(chip ? { paid_now: false } : kind === 'expense' ? { note: 'Meal' } : { method: 'cash' }), ...extra,
  });
}
async function assertUnchanged(before: SessionState, op_id: string) {
  const after = await ok<SessionState>(await request(`/sessions/${before.session.id}`));
  expect(after.session).toEqual(before.session);
  expect(after.revision).toBe(before.revision);
  expect(after.entries).toEqual(before.entries);
  expect(after.events).toEqual(before.events);
  expect((await database.pool.query('SELECT key FROM idempotency_keys WHERE key = $1', [op_id])).rows).toEqual([]);
}
async function rejectTiming(state: SessionState, suffix: string, body: object) {
  const op_id = randomUUID();
  const response = await request(`/sessions/${state.session.id}${suffix}`, { op_id, ...body });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: 'entries_outside_timing' } });
  await assertUnchanged(state, op_id);
}

beforeAll(async () => {
  database = await testDatabase();
  app = createApp(database.pool, { origin });
  const response = await request('/auth/signup', { username: `timer-${randomUUID().slice(0, 8)}`, password: 'secure-timer-writes-password' });
  await ok(response);
  cookie = response.headers.get('set-cookie')!.split(';')[0]!;
});
afterAll(async () => { await database?.stop(); });

it('rejects a re-entry auto-start after a live cash-out and rolls back timer, revision, ledger, history and idempotency', async () => {
  let state = await entry(await session(), 'buy_in', null);
  const original = state.entries[0]!;
  state = await entry(state, 'cash_out', cashOutTime);
  state = await write(state, `/entries/${original.id}/void`, {});
  expect(state.session.started_at).toBeNull();
  await rejectTiming(state, '/entries', {
    player_id: state.players[0]!.id, kind: 'buy_in', amount_minor: '10000',
    paid_now: true, method: 'cash', occurred_at: reentryTime,
  });
});

it('accepts a later buy-in without auto-starting when a live unknown-time buy-in remains', async () => {
  let state = await entry(await session(), 'buy_in', null);
  state = await entry(state, 'cash_out', cashOutTime);
  const before = state;
  state = await entry(state, 'buy_in', reentryTime);
  expect(state.session.started_at).toBeNull();
  expect(BigInt(state.revision)).toBe(BigInt(before.revision) + 1n);
  expect(state.entries).toHaveLength(before.entries.length + 1);
  expect(state.events).toEqual(before.events);
});

it('auto-starts at an exact cash-out boundary while ignoring voided chips and earlier settlements', async () => {
  let state = await entry(await session(), 'buy_in', null);
  state = await write(state, `/entries/${state.entries[0]!.id}/void`, {});
  state = await entry(state, 'cash_out', earlier);
  const oldCashOut = state.entries.find(item => item.kind === 'cash_out')!;
  state = await write(state, `/entries/${oldCashOut.id}/void`, {});
  for (const kind of ['payment_in', 'payment_out', 'expense']) state = await entry(state, kind, earlier);
  state = await entry(state, 'cash_out', null);
  state = await entry(state, 'cash_out', cashOutTime);
  const before = state;
  const op_id = randomUUID();
  const body = { op_id, player_id: state.players[0]!.id, kind: 'buy_in', amount_minor: '10000', paid_now: false, occurred_at: cashOutTime };
  state = await ok<SessionState>(await request(`/sessions/${state.session.id}/entries`, body));
  expect(state.session.started_at).toBe(cashOutTime);
  expect(BigInt(state.revision)).toBe(BigInt(before.revision) + 1n);
  expect(state.events[0]).toMatchObject({ kind: 'timer_started', detail: { new: { started_at: cashOutTime, ended_at: null } } });
  expect(await ok<SessionState>(await request(`/sessions/${state.session.id}/entries`, body))).toEqual(state);
});

it('rejects close before a future effective cash-out without changing any session records', async () => {
  const future = (await database.pool.query<{ time: string }>(`SELECT to_char((clock_timestamp() + interval '1 hour') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS time`)).rows[0]!.time;
  let state = await entry(await session(), 'buy_in', null);
  state = await entry(state, 'cash_out', future);
  await rejectTiming(state, '/close', { expected_revision: state.revision });
});

it('reports excluded chip entries before invalid timing when closing a future-started game', async () => {
  const future = (await database.pool.query<{ time: string }>(`SELECT to_char((clock_timestamp() + interval '1 hour') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS time`)).rows[0]!.time;
  let state = await entry(await session(), 'buy_in', future);
  state = await entry(state, 'cash_out', future);
  expect(state.session.started_at).toBe(future);
  await rejectTiming(state, '/close', { expected_revision: state.revision });
});

it('closes while ignoring future voided chips, settlements and expenses', async () => {
  const future = (await database.pool.query<{ time: string }>(`SELECT to_char((clock_timestamp() + interval '1 hour') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS time`)).rows[0]!.time;
  let state = await entry(await session(), 'buy_in', null);
  state = await entry(state, 'cash_out', future);
  state = await write(state, `/entries/${state.entries.find(item => item.kind === 'cash_out')!.id}/void`, {});
  for (const kind of ['payment_in', 'payment_out', 'expense']) state = await entry(state, kind, future);
  state = await entry(state, 'cash_out', null);
  const before = state;
  state = await write(state, '/close', { expected_revision: state.revision });
  expect(state.session.status).toBe('closed');
  expect(state.session.started_at).toBeNull();
  expect(Date.parse(state.session.ended_at!)).toBeLessThan(Date.parse(future));
  expect(state.entries).toEqual(before.entries);
  const endedAt = state.session.ended_at;
  state = await write(state, '/reopen', { reason: 'Settle later' });
  expect(state.session.ended_at).toBe(endedAt);
  state = await write(state, '/close', { expected_revision: state.revision });
  expect(state.session.ended_at).toBe(endedAt);
});

it('allows reopening a legacy session but checks its retained start before closing again', async () => {
  let state = await entry(await session(), 'buy_in', earlier);
  state = await entry(state, 'cash_out', cashOutTime);
  state = await write(state, '/close', { expected_revision: state.revision });
  await database.pool.query('UPDATE game_sessions SET started_at = $2 WHERE id = $1', [state.session.id, '2026-11-10T18:30:00.000Z']);
  state = await ok<SessionState>(await request(`/sessions/${state.session.id}`));
  state = await write(state, '/reopen', { reason: 'Correct legacy timing' });
  expect(state.session.started_at).toBe('2026-11-10T18:30:00.000Z');
  await rejectTiming(state, '/close', { expected_revision: state.revision });
});
