import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import type { SessionState } from '../src/domain/session';
import { testDatabase } from './database';
let database: Awaited<ReturnType<typeof testDatabase>>;
let app: ReturnType<typeof createApp>;
let cookie = '';
const origin = 'https://zero.test';
async function request(path: string, body?: unknown) {
  return app.request(`${origin}/api${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { origin, 'content-type': 'application/json', cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function ok<T>(response: Response): Promise<T> { const body = await response.json(); expect(response.status, JSON.stringify(body)).toBe(200); return body as T; }
async function setup() {
  let state = await ok<SessionState>(await request('/sessions', { op_id: randomUUID(), name: 'Lost stack', currency: 'USD', played_on: '2026-11-10' }));
  state = await ok<SessionState>(await request(`/sessions/${state.session.id}/players`, { op_id: randomUUID(), new_player_name: 'Justin' }));
  return state;
}
async function entry(state: SessionState, kind: string, amount_minor: string, extra: object = {}) {
  return request(`/sessions/${state.session.id}/entries`, { op_id: randomUUID(), player_id: state.players[0]!.id, kind, amount_minor, ...extra });
}
beforeAll(async () => { database = await testDatabase(); app = createApp(database.pool, { origin }); const response = await request('/auth/signup', { username: `zero-${randomUUID().slice(0, 12)}`, password: 'a-secure-zero-password' }); await ok(response); cookie = response.headers.get('set-cookie')!.split(';')[0]!; });
afterAll(async () => { await database?.stop(); });
it('records a complete loss with zero cash-out, never creates zero payment and closes honestly', async () => {
  let state = await setup();
  state = await ok(await entry(state, 'buy_in', '10000', { paid_now: true, method: 'cash' }));
  state = await ok(await entry(state, 'cash_out', '0', { paid_now: true, method: 'cash' }));
  expect(state.players[0]).toMatchObject({ state: 'cashed_out', result_minor: '-10000', payment_out_minor: '0' });
  expect(state.entries.filter(row => row.kind === 'payment_out')).toHaveLength(0);
  expect(state.entries.filter(row => row.kind === 'cash_out')).toHaveLength(1);
  state = await ok(await request(`/sessions/${state.session.id}/close`, { op_id: randomUUID(), expected_revision: state.revision, accept_discrepancy_minor: '-10000' }));
  expect(state.session.status).toBe('closed');
});
it('corrects cash-outs to and from zero while other kinds remain strictly positive', async () => {
  let state = await setup();
  state = await ok(await entry(state, 'buy_in', '10000', { paid_now: false }));
  state = await ok(await entry(state, 'cash_out', '100', { paid_now: false }));
  let cashout = state.entries.find(row => row.kind === 'cash_out')!;
  state = await ok(await request(`/sessions/${state.session.id}/entries/${cashout.id}/void`, { op_id: randomUUID(), replacement_amount_minor: '0' }));
  cashout = state.entries.find(row => row.kind === 'cash_out' && !row.voids_entry_id && row.amount_minor === '0')!;
  expect(state.players[0]).toMatchObject({ state: 'cashed_out', result_minor: '-10000' });
  state = await ok(await request(`/sessions/${state.session.id}/entries/${cashout.id}/void`, { op_id: randomUUID(), replacement_amount_minor: '200' }));
  expect(state.players[0]).toMatchObject({ state: 'cashed_out', result_minor: '-9800' });
  for (const kind of ['buy_in', 'payment_in', 'payment_out', 'expense']) {
    const extra = kind.startsWith('payment') ? { method: 'cash' } : kind === 'buy_in' ? { paid_now: false } : {};
    expect((await entry(state, kind, '0', extra)).status).toBe(400);
  }
  for (const kind of ['payment_in', 'payment_out', 'expense']) state = await ok(await entry(state, kind, '50', kind.startsWith('payment') ? { method: 'cash' } : {}));
  for (const kind of ['buy_in', 'payment_in', 'payment_out', 'expense']) {
    const original = state.entries.find(row => row.kind === kind && !row.voids_entry_id)!;
    expect((await request(`/sessions/${state.session.id}/entries/${original.id}/void`, { op_id: randomUUID(), replacement_amount_minor: '0' })).status).toBe(400);
  }
});
it('enforces the same kind-specific zero rule directly in Postgres', async () => {
  const state = await setup();
  const owner = (await database.pool.query('SELECT banker_id FROM game_sessions WHERE id=$1', [state.session.id])).rows[0]!.banker_id;
  const insert = (kind: string, amount: number) => database.pool.query('INSERT INTO ledger_entries(id,banker_id,session_id,player_id,kind,amount_minor,method,revision) VALUES($1,$2,$3,$4,$5,$6,$7,1)', [randomUUID(), owner, state.session.id, state.players[0]!.id, kind, amount, kind.startsWith('payment') ? 'cash' : null]);
  await expect(insert('cash_out', 0)).resolves.toBeDefined();
  for (const kind of ['buy_in', 'payment_in', 'payment_out', 'expense']) await expect(insert(kind, 0)).rejects.toMatchObject({ code: '23514' });
  await expect(insert('cash_out', -1)).rejects.toMatchObject({ code: '23514' });
});
