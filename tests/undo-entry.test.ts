import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { SessionState } from '../src/domain/session';
import { createApp } from '../src/server/app';
import { testDatabase } from './database';

let database: Awaited<ReturnType<typeof testDatabase>>;
let app: ReturnType<typeof createApp>;
type Account = { id: string; cookie: string };
let owner: Account;
let other: Account;
const origin = 'https://undo.test';
const errors: unknown[] = [];

function request(path: string, body?: unknown, account = owner) {
  return app.request(`${origin}/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { origin, 'content-type': 'application/json', cookie: account?.cookie ?? '' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function ok<T>(response: Response): Promise<T> {
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  return body as T;
}
async function signup(): Promise<Account> {
  const response = await request('/auth/signup', { username: `undo-${randomUUID().slice(0, 12)}`, password: randomUUID() });
  const body = await ok<{ banker: { id: string } }>(response);
  return { id: body.banker.id, cookie: response.headers.get('set-cookie')!.split(';')[0]! };
}
async function setup() {
  let state = await ok<SessionState>(await request('/sessions', { op_id: randomUUID(), name: 'Undo test', currency: 'USD', played_on: '2026-11-10' }));
  state = await ok<SessionState>(await request(`/sessions/${state.session.id}/players`, { op_id: randomUUID(), new_player_name: 'Justin' }));
  return state;
}
async function entry(state: SessionState, kind: string, amount_minor = '10000', extra: object = {}) {
  return ok<SessionState>(await request(`/sessions/${state.session.id}/entries`, { op_id: randomUUID(), player_id: state.players[0]!.id, kind, amount_minor, ...extra }));
}
function latest(state: SessionState, kind?: string) {
  return state.entries.find(row => row.revision === state.revision && (!kind || row.kind === kind))!;
}
function undo(state: SessionState, entryId = latest(state).id, body = { op_id: randomUUID(), expected_revision: state.revision }, account = owner) {
  return request(`/sessions/${state.session.id}/entries/${entryId}/undo`, body, account);
}
async function ledger(state: SessionState) {
  return (await database.pool.query(`SELECT s.revision::text, (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM ledger_entries e WHERE e.session_id = s.id) AS entries
    FROM game_sessions s WHERE s.id = $1`, [state.session.id])).rows[0];
}
async function rejected(response: Response, status: number, code: string) {
  expect(response.status, await response.clone().text()).toBe(status);
  expect(await response.json()).toMatchObject({ error: { code } });
}

beforeAll(async () => {
  database = await testDatabase();
  app = createApp(database.pool, { origin, onError: error => errors.push(error) });
  owner = await signup();
  other = await signup();
});
afterAll(async () => { await database?.stop(); expect(errors).toEqual([]); });

it.each(['buy_in', 'cash_out'])('atomically appends voids for a paid %s and its automatic payment', async kind => {
  const state = await entry(await setup(), kind, '10000', { paid_now: true, method: 'venmo', note: 'Saved note', occurred_at: '2026-11-10T20:00:00Z' });
  const originals = state.entries;
  const result = await ok<SessionState>(await undo(state, latest(state, kind).id));
  expect(BigInt(result.revision)).toBe(BigInt(state.revision) + 1n);
  expect(result.entries).toHaveLength(4);
  for (const original of originals) {
    expect(result.entries.find(row => row.id === original.id)).toEqual(original);
    expect(result.entries.find(row => row.voids_entry_id === original.id)).toMatchObject({
      player_id: original.player_id, kind: original.kind, amount_minor: original.amount_minor,
      method: original.method, occurred_at: original.occurred_at, note: original.note, revision: result.revision,
    });
  }
  expect(result.players[0]).toMatchObject({ state: 'seated', bought_in_minor: '0', cashed_out_minor: '0', payment_in_minor: '0', payment_out_minor: '0', balance_minor: '0' });
  expect(result.events).toEqual(state.events);
  expect(result.session.started_at).toBe(state.session.started_at);
});

it.each([
  ['payment_in', '100', { method: 'cash' }],
  ['payment_out', '100', { method: 'zelle' }],
  ['expense', '100', {}],
  ['cash_out', '0', { paid_now: true }],
  ['cash_out', '100', { paid_now: false }],
  ['buy_in', '100', { paid_now: false }],
] as const)('undoes a standalone %s of %s without generating a payment', async (kind, amount, extra) => {
  const state = await entry(await setup(), kind, amount, extra);
  const result = await ok<SessionState>(await undo(state));
  expect(result.entries).toHaveLength(2);
  expect(result.entries.filter(row => row.voids_entry_id)).toHaveLength(1);
  expect(result.players[0]).toMatchObject({ state: 'seated', balance_minor: '0', expense_minor: '0' });
});

it('rejects stale and replaced receipts without changing the ledger or revision', async () => {
  const saved = await entry(await setup(), 'buy_in', '100', { paid_now: true, method: 'cash' });
  const original = latest(saved, 'buy_in');
  const corrected = await ok<SessionState>(await request(`/sessions/${saved.session.id}/entries/${original.id}/void`, { op_id: randomUUID(), replacement_amount_minor: '200' }));
  const before = await ledger(corrected);
  await rejected(await undo(saved, original.id), 409, 'revision_mismatch');
  await rejected(await undo(corrected, original.id), 409, 'already_voided');
  const voidEntry = corrected.entries.find(row => row.voids_entry_id === original.id)!;
  await rejected(await undo(corrected, voidEntry.id), 409, 'already_voided');
  const replacement = corrected.entries.find(row => row.revision === corrected.revision && row.voids_entry_id === null)!;
  await rejected(await undo(corrected, replacement.id), 409, 'undo_unavailable');
  expect(await ledger(corrected)).toEqual(before);
});

it('rejects an older command even when sent with the current revision', async () => {
  const saved = await entry(await setup(), 'expense', '100');
  const state = await entry(saved, 'expense', '100');
  const before = await ledger(state);
  await rejected(await undo(state, latest(saved).id), 409, 'revision_mismatch');
  expect(await ledger(state)).toEqual(before);
});

it('scopes Undo to the banker and session', async () => {
  const state = await entry(await setup(), 'expense', '100');
  const before = await ledger(state);
  await rejected(await undo(state, latest(state).id, undefined, other), 404, 'not_found');
  await rejected(await undo(state, randomUUID()), 404, 'not_found');
  expect(await ledger(state)).toEqual(before);
});

it('serializes competing Undo operations so the paid pair is reversed once', async () => {
  const state = await entry(await setup(), 'buy_in', '100', { paid_now: true, method: 'cash' });
  const responses = await Promise.all([undo(state, latest(state, 'buy_in').id), undo(state, latest(state, 'buy_in').id)]);
  expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
  const result = await ok<SessionState>(await request(`/sessions/${state.session.id}`));
  expect(result.entries).toHaveLength(4);
  expect(BigInt(result.revision)).toBe(BigInt(state.revision) + 1n);
  expect(result.entries.filter(row => row.voids_entry_id).map(row => row.revision)).toEqual([result.revision, result.revision]);
});

it('replays the exact stored response after later writes and rejects a changed operation body', async () => {
  const state = await entry(await setup(), 'buy_in', '100', { paid_now: true, method: 'cash' });
  const original = latest(state, 'buy_in');
  const body = { op_id: randomUUID(), expected_revision: state.revision };
  const responses = await Promise.all([undo(state, original.id, body), undo(state, original.id, body)]);
  const result = await ok<SessionState>(responses[0]!);
  expect(await ok(responses[1]!)).toEqual(result);
  const advanced = await entry(result, 'expense', '50');
  const before = await ledger(advanced);
  expect(await ok(await undo(state, original.id, body))).toEqual(result);
  await rejected(await undo(state, original.id, { ...body, expected_revision: advanced.revision }), 409, 'idempotency_mismatch');
  expect(await ledger(advanced)).toEqual(before);
});

it('rejects an unexpected same-revision group without voiding any entry', async () => {
  const state = await entry(await setup(), 'buy_in', '100', { paid_now: true, method: 'cash' });
  await database.pool.query(`INSERT INTO ledger_entries(id,banker_id,session_id,player_id,kind,amount_minor,method,revision)
    VALUES($1,$2,$3,$4,'payment_in',100,'cash',$5)`, [randomUUID(), owner.id, state.session.id, state.players[0]!.id, state.revision]);
  const before = await ledger(state);
  await rejected(await undo(state, latest(state, 'buy_in').id), 409, 'undo_unavailable');
  expect(await ledger(state)).toEqual(before);
});
