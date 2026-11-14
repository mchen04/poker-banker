import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import type { SessionState } from '../src/domain/session';
import { testDatabase } from './database';

type Account = { id: string; cookie: string };
let database: Awaited<ReturnType<typeof testDatabase>>;
let app: ReturnType<typeof createApp>;
const origin = 'https://poker.test';
beforeAll(async () => {
  database = await testDatabase();
  app = createApp(database.pool, { origin });
});
afterAll(async () => { await database?.stop(); });
function request(account: Account | null, path: string, method = 'GET', body?: unknown) {
  return app.request(`${origin}/api${path}`, {
    method, headers: { origin, 'content-type': 'application/json', ...(account ? { cookie: account.cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function ok<T>(response: Response): Promise<T> {
  const value: unknown = await response.json();
  expect(response.status, JSON.stringify(value)).toBe(200);
  return value as T;
}
async function rejects(response: Response, status: number, code?: string) {
  const body = await response.json() as { error: { code: string } };
  expect(response.status, JSON.stringify(body)).toBe(status);
  if (code) expect(body.error.code).toBe(code);
}
async function account(): Promise<Account> {
  const response = await request(null, '/auth/signup', 'POST', { username: `deletions-${randomUUID().slice(0, 12)}`, password: randomUUID() });
  const result = await ok<{ banker: { id: string } }>(response);
  return { id: result.banker.id, cookie: response.headers.get('set-cookie')!.split(';')[0]! };
}
async function createSession(owner: Account, details: Record<string, unknown> = {}) {
  return ok<SessionState>(await request(owner, '/sessions', 'POST', { op_id: randomUUID(), name: 'Deletions', played_on: '2026-11-10', currency: 'USD', ...details }));
}
async function write(owner: Account, state: SessionState, suffix: string, body: Record<string, unknown>, method = 'POST') {
  return ok<SessionState>(await request(owner, `/sessions/${state.session.id}${suffix}`, method, { op_id: randomUUID(), ...body }));
}
async function seat(owner: Account, state: SessionState, name = 'Justin') {
  return write(owner, state, '/players', { new_player_name: name });
}
async function close(owner: Account, state: SessionState) {
  return write(owner, state, '/close', { expected_revision: state.revision, accept_discrepancy_minor: state.totals.discrepancy_minor });
}

it('restores a voided entry with the same fields and exact balances', async () => {
  const owner = await account();
  let state = await seat(owner, await createSession(owner));
  state = await write(owner, state, '/entries', { player_id: state.players[0]!.id, kind: 'buy_in', amount_minor: '10000', paid_now: false, note: 'First', occurred_at: '2026-11-10T19:00:00.000Z' });
  const original = state.entries[0]!;
  state = await write(owner, state, `/entries/${original.id}/void`, {});
  expect(state.players[0]!.balance_minor).toBe('0');
  expect(state.totals.total_in_minor).toBe('0');
  const op = randomUUID();
  const restored = await ok<SessionState>(await request(owner, `/sessions/${state.session.id}/entries/${original.id}/restore`, 'POST', { op_id: op }));
  expect(restored.players[0]!.balance_minor).toBe('10000');
  expect(restored.totals.total_in_minor).toBe('10000');
  const copy = restored.entries.find(row => row.restores_entry_id === original.id)!;
  expect(copy).toMatchObject({
    player_id: original.player_id, kind: original.kind, amount_minor: original.amount_minor,
    note: original.note, method: original.method, occurred_at: original.occurred_at, voids_entry_id: null, removal_id: null,
  });
  const replay = await ok<SessionState>(await request(owner, `/sessions/${state.session.id}/entries/${original.id}/restore`, 'POST', { op_id: op }));
  expect(replay.revision).toBe(restored.revision);
  await rejects(await request(owner, `/sessions/${state.session.id}/entries/${original.id}/restore`, 'POST', { op_id: randomUUID() }), 409, 'already_restored');
  await rejects(await request(owner, `/sessions/${state.session.id}/entries/${copy.id}/restore`, 'POST', { op_id: randomUUID() }), 409, 'not_voided');
});

it('rejects restores of replaced, live and closed-session entries and scopes them to the banker', async () => {
  const owner = await account(), other = await account();
  let state = await seat(owner, await createSession(owner));
  state = await write(owner, state, '/entries', { player_id: state.players[0]!.id, kind: 'buy_in', amount_minor: '10000', paid_now: false });
  const live = state.entries[0]!;
  await rejects(await request(owner, `/sessions/${state.session.id}/entries/${live.id}/restore`, 'POST', { op_id: randomUUID() }), 409, 'not_voided');
  state = await write(owner, state, `/entries/${live.id}/void`, { replacement_amount_minor: '9000' });
  await rejects(await request(owner, `/sessions/${state.session.id}/entries/${live.id}/restore`, 'POST', { op_id: randomUUID() }), 409, 'replaced_entry');
  await rejects(await request(other, `/sessions/${state.session.id}/entries/${live.id}/restore`, 'POST', { op_id: randomUUID() }), 404);
  let closed = await seat(owner, await createSession(owner));
  closed = await write(owner, closed, '/entries', { player_id: closed.players[0]!.id, kind: 'buy_in', amount_minor: '10000', paid_now: false });
  const closedEntry = closed.entries[0]!;
  closed = await write(owner, closed, `/entries/${closedEntry.id}/void`, {});
  closed = await close(owner, closed);
  await rejects(await request(owner, `/sessions/${closed.session.id}/entries/${closedEntry.id}/restore`, 'POST', { op_id: randomUUID() }), 409, 'session_closed');
});

it('removes a player with every effective entry and restores exactly those entries', async () => {
  const owner = await account(), other = await account();
  let state = await seat(owner, await createSession(owner), 'A');
  const a = state.players[0]!.id;
  state = await seat(owner, state, 'B');
  const b = state.players.find(player => player.id !== a)!.id;
  state = await write(owner, state, '/entries', { player_id: a, kind: 'buy_in', amount_minor: '10000', paid_now: true, method: 'cash' });
  state = await write(owner, state, '/entries', { player_id: a, kind: 'expense', amount_minor: '500' });
  state = await write(owner, state, '/entries', { player_id: b, kind: 'buy_in', amount_minor: '5000', paid_now: false });
  expect(state.players.find(player => player.id === a)).toMatchObject({ bought_in_minor: '10000', payment_in_minor: '10000', expense_minor: '500', balance_minor: '0' });
  const before = state.entries.length;
  const op = randomUUID();
  const removed = await ok<SessionState>(await request(owner, `/sessions/${state.session.id}/players/${a}/remove`, 'POST', { op_id: op }));
  expect(removed.players.map(player => player.id)).toEqual([b]);
  expect(removed.removed_players).toEqual([expect.objectContaining({ id: a, display_name: 'A' })]);
  expect(removed.entries.filter(entry => entry.removal_id).map(entry => entry.kind).sort()).toEqual(['buy_in', 'expense', 'payment_in']);
  expect(removed.entries).toHaveLength(before + 3);
  expect(removed.totals).toMatchObject({ total_in_minor: '5000', owed_to_banker_minor: '5000' });
  const replay = await ok<SessionState>(await request(owner, `/sessions/${state.session.id}/players/${a}/remove`, 'POST', { op_id: op }));
  expect(replay.revision).toBe(removed.revision);
  await rejects(await request(owner, `/sessions/${state.session.id}/players/${a}/remove`, 'POST', { op_id: randomUUID() }), 409, 'not_seated');
  await rejects(await request(owner, `/sessions/${state.session.id}/entries`, 'POST', { op_id: randomUUID(), player_id: a, kind: 'buy_in', amount_minor: '100', paid_now: false }), 409, 'player_removed');
  await rejects(await request(other, `/sessions/${state.session.id}/players/${a}/remove`, 'POST', { op_id: randomUUID() }), 404);
  const shared = await write(owner, removed, '/share', { action: 'enable' });
  const viewer = await ok<SessionState>(await request(null, `/view/${shared.session.share_token}`));
  expect(viewer.players.map(player => player.id)).toEqual([b]);
  expect(viewer.removed_players).toEqual([{ id: a, display_name: 'A' }]);
  expect(Object.keys(viewer.removed_players[0]!).sort()).toEqual(['display_name', 'id']);
  expect(viewer.session).not.toHaveProperty('share_token');
  expect(JSON.stringify(viewer)).not.toContain('removed_at');
  expect(viewer.entries.some(entry => entry.player_id === a && entry.removal_id)).toBe(true);
  const restored = await ok<SessionState>(await request(owner, `/sessions/${state.session.id}/players/${a}/restore`, 'POST', { op_id: randomUUID() }));
  expect(restored.players.map(player => player.id).sort()).toEqual([a, b].sort());
  expect(restored.removed_players).toEqual([]);
  expect(restored.players.find(player => player.id === a)).toMatchObject({ bought_in_minor: '10000', payment_in_minor: '10000', expense_minor: '500', balance_minor: '0' });
  expect(restored.entries.filter(entry => entry.restores_entry_id).map(entry => entry.kind).sort()).toEqual(['buy_in', 'expense', 'payment_in']);
  expect(restored.totals.total_in_minor).toBe('15000');
  await rejects(await request(owner, `/sessions/${state.session.id}/players/${a}/restore`, 'POST', { op_id: randomUUID() }), 409, 'already_seated');
  await rejects(await request(other, `/sessions/${state.session.id}/players/${a}/restore`, 'POST', { op_id: randomUUID() }), 404);
});

it('rejects player removal and restore in a closed session', async () => {
  const owner = await account();
  let state = await seat(owner, await createSession(owner));
  const playerId = state.players[0]!.id;
  state = await close(owner, state);
  await rejects(await request(owner, `/sessions/${state.session.id}/players/${playerId}/remove`, 'POST', { op_id: randomUUID() }), 409, 'session_closed');
  await rejects(await request(owner, `/sessions/${state.session.id}/players/${playerId}/restore`, 'POST', { op_id: randomUUID() }), 409, 'session_closed');
});

it('soft-deletes a session from every read path and restores its data with sharing disabled', async () => {
  const owner = await account(), other = await account();
  let state = await seat(owner, await createSession(owner, { location: 'Home', game: 'NLH' }));
  const playerId = state.players[0]!.id;
  state = await write(owner, state, '/entries', { player_id: playerId, kind: 'buy_in', amount_minor: '10000', paid_now: false });
  state = await write(owner, state, '/share', { action: 'enable' });
  const token = state.session.share_token!;
  const deleted = await ok<SessionState>(await request(owner, `/sessions/${state.session.id}/delete`, 'POST', { op_id: randomUUID() }));
  expect(deleted.session.deleted_at).not.toBeNull();
  expect(deleted.players).toHaveLength(1);
  expect(deleted.entries).toHaveLength(state.entries.length);
  expect((await ok<{ sessions: { id: string }[] }>(await request(owner, '/sessions'))).sessions.map(row => row.id)).not.toContain(state.session.id);
  await rejects(await request(owner, `/sessions/${state.session.id}`), 404);
  await rejects(await request(null, `/view/${token}`), 404);
  expect((await ok<{ locations: string[]; games: string[] }>(await request(owner, '/suggestions'))).locations).not.toContain('Home');
  expect((await ok<{ sessions: { session: { id: string } }[] }>(await request(owner, `/players/${playerId}`))).sessions.map(row => row.session.id)).not.toContain(state.session.id);
  expect((await ok<{ players: { id: string }[] }>(await request(owner, '/players'))).players.map(row => row.id)).toContain(playerId);
  expect((await ok<{ sessions: { id: string; deleted_at: string }[] }>(await request(owner, '/sessions/deleted'))).sessions.find(row => row.id === state.session.id))
    .toMatchObject({ id: state.session.id, deleted_at: expect.any(String) });
  await rejects(await request(other, `/sessions/${state.session.id}/delete`, 'POST', { op_id: randomUUID() }), 404);
  const restored = await ok<SessionState>(await request(owner, `/sessions/${state.session.id}/restore`, 'POST', { op_id: randomUUID() }));
  expect(restored.session.deleted_at).toBeNull();
  expect(restored.session.share_token).toBeNull();
  expect(restored.players).toHaveLength(1);
  expect(restored.entries).toHaveLength(state.entries.length);
  expect(restored.players[0]!.bought_in_minor).toBe('10000');
  await rejects(await request(null, `/view/${token}`), 404);
  expect((await ok<{ sessions: { id: string }[] }>(await request(owner, '/sessions'))).sessions.map(row => row.id)).toContain(state.session.id);
  await rejects(await request(owner, `/sessions/${state.session.id}/restore`, 'POST', { op_id: randomUUID() }), 409, 'session_active');
  await rejects(await request(other, `/sessions/${state.session.id}/restore`, 'POST', { op_id: randomUUID() }), 404);
  await ok(await request(owner, `/sessions/${state.session.id}/delete`, 'POST', { op_id: randomUUID() }));
  await rejects(await request(owner, `/sessions/${state.session.id}/delete`, 'POST', { op_id: randomUUID() }), 409, 'already_deleted');
});

it('deletes a roster player only when not seated and restores them', async () => {
  const owner = await account(), other = await account();
  const created = await ok<{ player: { id: string } }>(await request(owner, '/players', 'POST', { op_id: randomUUID(), display_name: 'Roster' }));
  const playerId = created.player.id;
  let state = await createSession(owner);
  state = await write(owner, state, '/players', { player_id: playerId });
  await rejects(await request(owner, `/players/${playerId}/delete`, 'POST', { op_id: randomUUID() }), 409, 'player_seated');
  state = await write(owner, state, `/players/${playerId}/remove`, {});
  const op = randomUUID();
  const deleted = await ok<{ player: { id: string; deleted_at: string | null } }>(await request(owner, `/players/${playerId}/delete`, 'POST', { op_id: op }));
  expect(deleted.player).toMatchObject({ id: playerId });
  expect(deleted.player.deleted_at).not.toBeNull();
  expect((await ok<{ players: { id: string }[] }>(await request(owner, '/players?q=ros'))).players).toEqual([]);
  await rejects(await request(owner, `/players/${playerId}`), 404);
  await rejects(await request(owner, `/players/${playerId}/report`), 404);
  await rejects(await request(owner, `/sessions/${state.session.id}/players`, 'POST', { op_id: randomUUID(), player_id: playerId }), 404);
  expect(await ok(await request(owner, `/players/${playerId}/delete`, 'POST', { op_id: op }))).toEqual(deleted);
  await rejects(await request(other, `/players/${playerId}/delete`, 'POST', { op_id: randomUUID() }), 404);
  expect((await ok<{ players: { id: string; display_name: string }[] }>(await request(owner, '/players/deleted'))).players).toMatchObject([{ id: playerId, display_name: 'Roster' }]);
  expect((await ok<{ players: unknown[] }>(await request(other, '/players/deleted'))).players).toEqual([]);
  const restored = await ok<{ player: { id: string; deleted_at: string | null } }>(await request(owner, `/players/${playerId}/restore`, 'POST', { op_id: randomUUID() }));
  expect(restored.player.deleted_at).toBeNull();
  expect((await ok<{ players: { id: string }[] }>(await request(owner, '/players?q=ros'))).players.map(row => row.id)).toEqual([playerId]);
  expect((await ok<{ players: unknown[] }>(await request(owner, '/players/deleted'))).players).toEqual([]);
  await rejects(await request(owner, `/players/${playerId}/restore`, 'POST', { op_id: randomUUID() }), 409, 'player_active');
  await rejects(await request(other, `/players/${playerId}/restore`, 'POST', { op_id: randomUUID() }), 404);
});

it('restores a buy-in into its original position so a later cash-out stays last', async () => {
  const owner = await account();
  let state = await seat(owner, await createSession(owner));
  const playerId = state.players[0]!.id;
  state = await write(owner, state, '/entries', { player_id: playerId, kind: 'buy_in', amount_minor: '10000', paid_now: false });
  const first = state.entries.find(entry => entry.kind === 'buy_in')!;
  state = await write(owner, state, '/entries', { player_id: playerId, kind: 'buy_in', amount_minor: '5000', paid_now: false });
  state = await write(owner, state, `/entries/${first.id}/void`, {});
  state = await write(owner, state, '/entries', { player_id: playerId, kind: 'cash_out', amount_minor: '20000', paid_now: false });
  expect(state.players[0]).toMatchObject({ state: 'cashed_out', result_minor: '15000' });
  state = await ok<SessionState>(await request(owner, `/sessions/${state.session.id}/entries/${first.id}/restore`, 'POST', { op_id: randomUUID() }));
  expect(state.players[0]).toMatchObject({ state: 'cashed_out', result_minor: '5000', bought_in_minor: '15000', cashed_out_minor: '20000' });
  expect(state.totals).toMatchObject({ total_in_minor: '15000', total_out_minor: '20000', discrepancy_minor: '5000' });
  const copy = state.entries.find(entry => entry.restores_entry_id === first.id)!;
  state = await write(owner, state, `/entries/${copy.id}/void`, {});
  state = await ok<SessionState>(await request(owner, `/sessions/${state.session.id}/entries/${copy.id}/restore`, 'POST', { op_id: randomUUID() }));
  expect(state.players[0]).toMatchObject({ state: 'cashed_out', result_minor: '5000' });
  state = await close(owner, state);
  expect(state.session.status).toBe('closed');
  const roster = await ok<{ players: { id: string; cumulative: { currency: string; result_minor: string }[] }[] }>(await request(owner, '/players'));
  expect(roster.players.find(player => player.id === playerId)!.cumulative).toEqual([{ currency: 'USD', result_minor: '5000' }]);
});

it('restores a removed player with a buy-in and cash-out', async () => {
  const owner = await account();
  let state = await seat(owner, await createSession(owner));
  const playerId = state.players[0]!.id;
  state = await write(owner, state, '/entries', { player_id: playerId, kind: 'buy_in', amount_minor: '10000', paid_now: false });
  state = await write(owner, state, '/entries', { player_id: playerId, kind: 'cash_out', amount_minor: '15000', paid_now: false });
  state = await write(owner, state, `/players/${playerId}/remove`, {});
  expect(state.players).toEqual([]);
  state = await write(owner, state, `/players/${playerId}/restore`, {});
  expect(state.players[0]).toMatchObject({ id: playerId, bought_in_minor: '10000', cashed_out_minor: '15000', balance_minor: '-5000' });
  expect(state.entries.filter(entry => entry.restores_entry_id).map(entry => entry.kind).sort()).toEqual(['buy_in', 'cash_out']);
});

it('restoring a session brings back a deleted roster player and their debt', async () => {
  const owner = await account();
  let state = await seat(owner, await createSession(owner));
  const playerId = state.players[0]!.id;
  state = await write(owner, state, '/entries', { player_id: playerId, kind: 'buy_in', amount_minor: '10000', paid_now: false });
  state = await write(owner, state, '/entries', { player_id: playerId, kind: 'cash_out', amount_minor: '15000', paid_now: false });
  state = await close(owner, state);
  await ok(await request(owner, `/sessions/${state.session.id}/delete`, 'POST', { op_id: randomUUID() }));
  const deleted = await ok<{ player: { deleted_at: string | null } }>(await request(owner, `/players/${playerId}/delete`, 'POST', { op_id: randomUUID() }));
  expect(deleted.player.deleted_at).not.toBeNull();
  expect((await ok<{ players: { id: string }[] }>(await request(owner, '/players'))).players.map(row => row.id)).not.toContain(playerId);
  await rejects(await request(owner, `/players/${playerId}/report`), 404);
  const restored = await ok<SessionState>(await request(owner, `/sessions/${state.session.id}/restore`, 'POST', { op_id: randomUUID() }));
  expect(restored.session.deleted_at).toBeNull();
  expect(restored.players[0]).toMatchObject({ id: playerId, bought_in_minor: '10000', cashed_out_minor: '15000' });
  const roster = await ok<{ players: { id: string; outstanding: { currency: string; owed_to_banker_minor: string; owed_by_banker_minor: string }[] }[] }>(await request(owner, '/players'));
  expect(roster.players.find(row => row.id === playerId)).toMatchObject({
    outstanding: [{ currency: 'USD', owed_to_banker_minor: '0', owed_by_banker_minor: '5000' }],
  });
  const report = await ok<{ groups: { metrics: { profit_loss_minor: { value: { numerator: string; denominator: string } | null } } }[] }>(await request(owner, `/players/${playerId}/report`));
  expect(report.groups[0]!.metrics.profit_loss_minor.value).toEqual({ numerator: '5000', denominator: '1' });
  expect((await ok<{ players: { id: string }[] }>(await request(owner, '/players/deleted'))).players).toEqual([]);
});

it('restoring a removed player brings back a deleted roster player and their debt', async () => {
  const owner = await account();
  let state = await seat(owner, await createSession(owner));
  const playerId = state.players[0]!.id;
  state = await write(owner, state, '/entries', { player_id: playerId, kind: 'buy_in', amount_minor: '10000', paid_now: false });
  state = await write(owner, state, `/players/${playerId}/remove`, {});
  const deleted = await ok<{ player: { deleted_at: string | null } }>(await request(owner, `/players/${playerId}/delete`, 'POST', { op_id: randomUUID() }));
  expect(deleted.player.deleted_at).not.toBeNull();
  expect((await ok<{ players: { id: string }[] }>(await request(owner, '/players'))).players.map(row => row.id)).not.toContain(playerId);
  await rejects(await request(owner, `/players/${playerId}/report`), 404);
  const restored = await ok<SessionState>(await request(owner, `/sessions/${state.session.id}/players/${playerId}/restore`, 'POST', { op_id: randomUUID() }));
  expect(restored.players[0]).toMatchObject({ id: playerId, bought_in_minor: '10000', balance_minor: '10000' });
  const roster = await ok<{ players: { id: string; outstanding: { currency: string; owed_to_banker_minor: string }[] }[] }>(await request(owner, '/players'));
  expect(roster.players.find(row => row.id === playerId)).toMatchObject({ outstanding: [{ currency: 'USD', owed_to_banker_minor: '10000' }] });
  expect((await ok<{ player: { deleted_at: string | null } }>(await request(owner, `/players/${playerId}`))).player.deleted_at).toBeNull();
  expect((await request(owner, `/players/${playerId}/report`)).status).toBe(200);
});

it('pages every deleted session to the end and restores the oldest', async () => {
  const owner = await account();
  const ids: string[] = [];
  for (let index = 0; index < 32; index++) {
    const state = await createSession(owner, { name: `Deleted session ${index}` });
    await ok(await request(owner, `/sessions/${state.session.id}/delete`, 'POST', { op_id: randomUUID() }));
    ids.push(state.session.id);
  }
  const first = await ok<{ sessions: { id: string }[]; next: string | null }>(await request(owner, '/sessions/deleted'));
  expect(first.sessions).toHaveLength(30);
  expect(first.next).not.toBeNull();
  const second = await ok<{ sessions: { id: string }[]; next: string | null }>(await request(owner, `/sessions/deleted?before=${encodeURIComponent(first.next!)}`));
  expect(second.sessions).toHaveLength(2);
  expect(second.next).toBeNull();
  expect(new Set([...first.sessions, ...second.sessions].map(row => row.id)).size).toBe(32);
  expect(second.sessions.map(row => row.id)).toContain(ids[0]);
  const restored = await ok<SessionState>(await request(owner, `/sessions/${ids[0]}/restore`, 'POST', { op_id: randomUUID() }));
  expect(restored.session.id).toBe(ids[0]);
  const remaining = await ok<{ sessions: { id: string }[]; next: string | null }>(await request(owner, '/sessions/deleted'));
  expect(remaining.sessions.map(row => row.id)).not.toContain(ids[0]);
  expect(remaining.next).not.toBeNull();
});

it('pages every deleted player to the end and restores the oldest', async () => {
  const owner = await account();
  const ids: string[] = [];
  for (let index = 0; index < 32; index++) {
    const created = await ok<{ player: { id: string } }>(await request(owner, '/players', 'POST', { op_id: randomUUID(), display_name: `Deleted player ${index}` }));
    await ok(await request(owner, `/players/${created.player.id}/delete`, 'POST', { op_id: randomUUID() }));
    ids.push(created.player.id);
  }
  const first = await ok<{ players: { id: string }[]; next: string | null }>(await request(owner, '/players/deleted'));
  expect(first.players).toHaveLength(30);
  expect(first.next).not.toBeNull();
  const second = await ok<{ players: { id: string }[]; next: string | null }>(await request(owner, `/players/deleted?before=${encodeURIComponent(first.next!)}`));
  expect(second.players).toHaveLength(2);
  expect(second.next).toBeNull();
  expect(new Set([...first.players, ...second.players].map(row => row.id)).size).toBe(32);
  expect(second.players.map(row => row.id)).toContain(ids[0]);
  const restored = await ok<{ player: { id: string; deleted_at: string | null } }>(await request(owner, `/players/${ids[0]}/restore`, 'POST', { op_id: randomUUID() }));
  expect(restored.player).toMatchObject({ id: ids[0], deleted_at: null });
  const remaining = await ok<{ players: { id: string }[]; next: string | null }>(await request(owner, '/players/deleted'));
  expect(remaining.players.map(row => row.id)).not.toContain(ids[0]);
  expect(remaining.next).not.toBeNull();
});

describe('ledger integrity for restores', () => {
  it('rejects a direct insert that restores a live entry or double-restores a voided one', async () => {
    const owner = await account();
    let state = await seat(owner, await createSession(owner));
    state = await write(owner, state, '/entries', { player_id: state.players[0]!.id, kind: 'buy_in', amount_minor: '1000', paid_now: false });
    const original = state.entries[0]!;
    const insert = (id: string, restores: string | null) => database.pool.query(
      `INSERT INTO ledger_entries(id,banker_id,session_id,player_id,kind,amount_minor,revision,restores_entry_id)
       VALUES ($1,$2,$3,$4,'buy_in',1000,99,$5)`, [id, owner.id, state.session.id, state.players[0]!.id, restores]);
    await expect(insert(randomUUID(), original.id)).rejects.toMatchObject({ code: '23514' });
    await write(owner, state, `/entries/${original.id}/void`, {});
    await insert(randomUUID(), original.id);
    await expect(insert(randomUUID(), original.id)).rejects.toMatchObject({ code: '23505' });
  });
});

it('never leaves a player seated in a live session and deleted at the same time', async () => {
  const owner = await account();
  const state = await createSession(owner);
  const sessionId = state.session.id;
  const created = await ok<{ player: { id: string } }>(await request(owner, '/players', 'POST', { op_id: randomUUID(), display_name: 'Race' }));
  const playerId = created.player.id;
  const reset = async () => {
    await request(owner, `/sessions/${sessionId}/players/${playerId}/remove`, 'POST', { op_id: randomUUID() });
    await request(owner, `/players/${playerId}/delete`, 'POST', { op_id: randomUUID() });
    await request(owner, `/players/${playerId}/restore`, 'POST', { op_id: randomUUID() });
  };
  for (let round = 0; round < 20; round++) {
    await reset();
    const [deleted, seated] = await Promise.all([
      request(owner, `/players/${playerId}/delete`, 'POST', { op_id: randomUUID() }),
      request(owner, `/sessions/${sessionId}/players`, 'POST', { op_id: randomUUID(), player_id: playerId }),
    ]);
    expect([200, 404, 409]).toContain(deleted.status);
    expect([200, 404, 409]).toContain(seated.status);
    expect(deleted.status === 200 || seated.status === 200).toBe(true);
    const row = await database.pool.query<{ deleted_at: string | null; seated: boolean }>(
      `SELECT p.deleted_at::text, EXISTS (SELECT 1 FROM session_players sp JOIN game_sessions s ON s.id = sp.session_id AND s.banker_id = sp.banker_id
        WHERE sp.player_id = p.id AND sp.banker_id = p.banker_id AND sp.removed_at IS NULL AND s.deleted_at IS NULL) AS seated
       FROM players p WHERE p.id = $1 AND p.banker_id = $2`, [playerId, owner.id]);
    expect(row.rows[0]!.seated && row.rows[0]!.deleted_at !== null).toBe(false);
  }
});
