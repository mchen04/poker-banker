import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import type { SessionState } from '../src/domain/session';
import { testDatabase } from './database';
let database: Awaited<ReturnType<typeof testDatabase>>;
let app: ReturnType<typeof createApp>;
let cookie = '', banker = '';
const origin = 'https://late.test';
const start = '2026-11-10T18:00:00.000Z', end = '2026-11-10T20:00:00.000Z', nextDay = '2026-11-11T18:00:00.000Z';
async function request(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  return app.request(`${origin}/api${path}`, { method, headers: { origin, 'content-type': 'application/json', cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function ok<T>(response: Response): Promise<T> { const body = await response.json(); expect(response.status, JSON.stringify(body)).toBe(200); return body as T; }
async function write(state: SessionState, suffix: string, body: object, method = 'POST') { return ok<SessionState>(await request(`/sessions/${state.session.id}${suffix}`, { op_id: randomUUID(), ...body }, method)); }
async function entry(state: SessionState, kind: string, amount_minor: string, occurred_at: string, extra: object = {}) {
  return write(state, '/entries', { player_id: state.players[0]!.id, kind, amount_minor, occurred_at, ...extra });
}
async function setup() {
  let state = await ok<SessionState>(await request('/sessions', { op_id: randomUUID(), name: 'Late settlement', currency: 'USD', played_on: '2026-11-10' }));
  state = await write(state, '/players', { new_player_name: 'Justin' });
  state = await write(state, '/timing', { started_at: start, ended_at: end }, 'PATCH');
  state = await entry(state, 'buy_in', '10000', start, { paid_now: true, method: 'cash' });
  state = await entry(state, 'cash_out', '10000', end, { paid_now: false });
  return write(state, '/close', { expected_revision: state.revision });
}
beforeAll(async () => { database = await testDatabase(); app = createApp(database.pool, { origin }); const response = await request('/auth/signup', { username: `late-${randomUUID().slice(0, 12)}`, password: 'a-secure-late-password' }); const account = await ok<{ banker: { id: string } }>(response); banker = account.banker.id; cookie = response.headers.get('set-cookie')!.split(';')[0]!; });
afterAll(async () => { await database?.stop(); });
it('records next-day payments and expenses after reopen, preserves game end and counts reclosure once', async () => {
  let state = await setup();
  expect((await request(`/sessions/${state.session.id}/entries`, { op_id: randomUUID(), player_id: state.players[0]!.id, kind: 'payment_out', amount_minor: '10000', method: 'zelle', occurred_at: nextDay })).status).toBe(409);
  state = await write(state, '/reopen', { reason: 'Settle the bank next day' });
  state = await entry(state, 'payment_out', '10000', nextDay, { method: 'zelle' });
  state = await entry(state, 'payment_in', '2500', nextDay, { method: 'venmo' });
  state = await entry(state, 'expense', '500', nextDay, { note: 'Meal settled later' });
  expect(state.entries.filter(row => row.occurred_at === nextDay)).toHaveLength(3);
  state = await write(state, '/close', { expected_revision: state.revision });
  expect(state.session.ended_at).toBe(end);
  const history = await ok<{ cumulative: unknown[]; sessions: { session: { id: string } }[] }>(await request(`/players/${state.players[0]!.id}`));
  expect(history.cumulative).toEqual([{ currency: 'USD', result_minor: '0' }]);
  expect(history.sessions.filter(item => item.session.id === state.session.id)).toHaveLength(1);
});
it('corrects a settlement occurrence after game end while chip corrections still enforce bounds', async () => {
  let state = await setup(); state = await write(state, '/reopen', { reason: 'Correct settlement time' });
  const payment = state.entries.find(row => row.kind === 'payment_in')!;
  state = await write(state, `/entries/${payment.id}/void`, { replacement_occurred_at: nextDay, replacement_method: 'zelle' });
  expect(state.entries.some(row => row.kind === 'payment_in' && row.occurred_at === nextDay && row.method === 'zelle' && !row.voids_entry_id)).toBe(true);
  const chip = state.entries.find(row => row.kind === 'cash_out')!;
  const response = await request(`/sessions/${state.session.id}/entries/${chip.id}/void`, { op_id: randomUUID(), replacement_occurred_at: nextDay });
  expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ error: { code: 'outside_timer_bounds' } });
  expect((await request(`/sessions/${state.session.id}/entries`, { op_id: randomUUID(), player_id: state.players[0]!.id, kind: 'buy_in', amount_minor: '100', paid_now: false, occurred_at: nextDay })).status).toBe(400);
});
it('validates corrected game times against chip rows only', async () => {
  let state = await setup(); state = await write(state, '/reopen', { reason: 'Update game times' });
  await database.pool.query('INSERT INTO ledger_entries(id,banker_id,session_id,player_id,kind,amount_minor,method,occurred_at,revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [randomUUID(), banker, state.session.id, state.players[0]!.id, 'payment_out', '10000', 'cash', nextDay, state.revision]);
  state = await write(state, '/timing', { started_at: start, ended_at: end }, 'PATCH');
  const response = await request(`/sessions/${state.session.id}/timing`, { op_id: randomUUID(), started_at: start, ended_at: '2026-11-10T19:00:00.000Z' }, 'PATCH');
  expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: { code: 'entries_outside_timing' } });
});
