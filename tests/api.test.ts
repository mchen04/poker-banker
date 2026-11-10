import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessionState } from '../src/domain/session';
import { createApp } from '../src/server/app';
import { testDatabase } from './database';
import { migrate } from '../scripts/migrate';

let database: Awaited<ReturnType<typeof testDatabase>>;
let app: ReturnType<typeof createApp>;
const origin = 'https://poker.test';
const secret = 'a-secure-home-game-password';
const errors: unknown[] = [];
type Account = { banker: { id: string; username: string }; recovery_codes: string[]; cookie: string; ip: string };
type History = { player: { id: string; display_name: string }; cumulative: { currency: string; result_minor: string }[]; outstanding: { currency: string; owed_to_banker_minor: string; owed_by_banker_minor: string }[]; sessions: unknown[] };

beforeAll(async () => {
  database = await testDatabase();
  app = createApp(database.pool, { origin, clientIp: c => c.req.header('x-test-ip') ?? 'test-ip', onError: error => errors.push(error) });
});
afterAll(async () => { await database?.stop(); expect(errors).toEqual([]); });

function request(path: string, method = 'GET', body?: unknown, account?: Pick<Account, 'cookie' | 'ip'>, extraHeaders: Record<string, string> = {}) {
  return app.request(`${origin}/api${path}`, {
    method,
    headers: { origin, 'content-type': 'application/json', ...(account ? { cookie: account.cookie, 'x-test-ip': account.ip } : {}), ...extraHeaders },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function ok<T>(response: Response): Promise<T> {
  const value: unknown = await response.json();
  expect(response.status, JSON.stringify(value)).toBe(200);
  return value as T;
}
async function error(response: Response, status: number, code?: string) {
  expect(response.status, await response.clone().text()).toBe(status);
  const value = await response.json() as { error: { code: string; message: string } };
  expect(typeof value.error.message).toBe('string');
  if (code) expect(value.error.code).toBe(code);
}
async function signup(): Promise<Account> {
  const username = `banker-${randomUUID().slice(0, 16)}`;
  const ip = randomUUID();
  const response = await request('/auth/signup', 'POST', { username, password: secret }, { cookie: '', ip });
  const body = await ok<Omit<Account, 'cookie' | 'ip'>>(response);
  return { ...body, cookie: response.headers.get('set-cookie')!.split(';')[0]!, ip };
}
async function game(account: Account, currency = 'USD') {
  return ok<SessionState>(await request('/sessions', 'POST', { op_id: randomUUID(), name: 'Friday game', played_on: '2026-11-10', currency }, account));
}
async function seat(account: Account, session: SessionState, player?: string) {
  return ok<SessionState>(await request(`/sessions/${session.session.id}/players`, 'POST', { op_id: randomUUID(), ...(player ? { player_id: player } : { new_player_name: 'Justin' }) }, account));
}
async function entry(account: Account, session: SessionState, kind = 'buy_in', amount = '10000', paid_now?: boolean) {
  return ok<SessionState>(await request(`/sessions/${session.session.id}/entries`, 'POST', {
    op_id: randomUUID(), player_id: session.players[0]!.id, kind, amount_minor: amount,
    ...(paid_now === undefined ? {} : { paid_now }),
  }, account));
}
async function close(account: Account, session: SessionState, accept?: string) {
  return ok<SessionState>(await request(`/sessions/${session.session.id}/close`, 'POST', {
    op_id: randomUUID(), expected_revision: session.revision, ...(accept === undefined ? {} : { accept_discrepancy_minor: accept }),
  }, account));
}
async function history(account: Account, player: string) { return ok<History>(await request(`/players/${player}`, 'GET', undefined, account)); }

describe('accounts and recovery', () => {
  it('signs up, hashes passwords, issues hardened cookies and slides expiry', async () => {
    const account = await signup();
    expect(account.recovery_codes).toHaveLength(10);
    expect(new Set(account.recovery_codes).size).toBe(10);
    const stored = await database.pool.query('SELECT password_hash FROM bankers WHERE id = $1', [account.banker.id]);
    expect(stored.rows[0].password_hash).toMatch(/^\$argon2id\$/);
    const codes = await database.pool.query('SELECT code_hash FROM recovery_codes WHERE banker_id = $1', [account.banker.id]);
    expect(codes.rows[0].code_hash).toBeInstanceOf(Buffer);
    expect(codes.rows[0].code_hash.toString('hex')).not.toContain(account.recovery_codes[0]);
    await database.pool.query("UPDATE auth_sessions SET expires_at = now() + interval '1 day' WHERE banker_id = $1", [account.banker.id]);
    const me = await request('/auth/me', 'GET', undefined, account);
    expect(await ok(me)).toEqual({ banker: account.banker });
    const cookie = me.headers.get('set-cookie')!;
    for (const attr of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=15552000']) expect(cookie).toContain(attr);
    const expiry = await database.pool.query('SELECT expires_at > now() + interval \'179 days\' AS sliding FROM auth_sessions WHERE banker_id = $1', [account.banker.id]);
    expect(expiry.rows[0].sliding).toBe(true);
  });
  it('normalizes usernames and rejects weak credentials and duplicates', async () => {
    const account = await signup();
    const login = await request('/auth/login', 'POST', { username: account.banker.username.toUpperCase(), password: secret }, { cookie: '', ip: randomUUID() });
    expect(await ok(login)).toEqual({ banker: account.banker });
    await error(await request('/auth/signup', 'POST', { username: account.banker.username, password: secret }), 409, 'username_unavailable');
    for (const password of ['short', '1234567890', 'password123']) await error(await request('/auth/signup', 'POST', { username: 'weak-password', password }), 400);
  });
  it('rejects wrong passwords and locks a username after five failures even across IPs', async () => {
    const account = await signup();
    for (let i = 1; i <= 5; i++) await error(await request('/auth/login', 'POST', { username: account.banker.username, password: 'wrong' }, { cookie: '', ip: randomUUID() }), i === 5 ? 429 : 401);
    await error(await request('/auth/login', 'POST', { username: account.banker.username, password: secret }, { cookie: '', ip: randomUUID() }), 429, 'auth_locked');
    const locked = await database.pool.query('SELECT failures, locked_until > now() AS locked FROM login_throttle WHERE key = $1', [`username:${account.banker.username}`]);
    expect(locked.rows[0]).toEqual({ failures: 5, locked: true });
    await database.pool.query("UPDATE login_throttle SET locked_until = now() - interval '1 second', window_started_at = now() - interval '16 minutes' WHERE key = $1", [`username:${account.banker.username}`]);
    for (let i = 0; i < 5; i++) await request('/auth/login', 'POST', { username: account.banker.username, password: 'wrong' }, { cookie: '', ip: randomUUID() });
    const doubled = await database.pool.query("SELECT failures, locked_until > now() + interval '29 minutes' AS doubled FROM login_throttle WHERE key = $1", [`username:${account.banker.username}`]);
    expect(doubled.rows[0]).toEqual({ failures: 10, doubled: true });
  });
  it('locks an IP across unknown usernames and uses the same credential error', async () => {
    const ip = randomUUID();
    for (let i = 0; i < 5; i++) await error(await request('/auth/login', 'POST', { username: `unknown-${randomUUID().slice(0, 8)}`, password: 'wrong' }, { cookie: '', ip }), i === 4 ? 429 : 401, i === 4 ? 'auth_locked' : 'invalid_credentials');
    const account = await signup();
    await error(await request('/auth/login', 'POST', { username: account.banker.username, password: secret }, { cookie: '', ip }), 429);
  });
  it('recovers once, revokes every old session, and permits only the new password', async () => {
    const account = await signup();
    const login = await request('/auth/login', 'POST', { username: account.banker.username, password: secret }, account);
    await ok(login);
    const second = { ...account, cookie: login.headers.get('set-cookie')!.split(';')[0]! };
    const recovered = await request('/auth/recover', 'POST', { username: account.banker.username, recovery_code: account.recovery_codes[0], new_password: 'new-secure-home-password' }, account);
    expect(await ok(recovered)).toEqual({ banker: account.banker });
    for (const session of [account, second]) await error(await request('/auth/me', 'GET', undefined, session), 401);
    expect((await database.pool.query('SELECT id FROM auth_sessions WHERE banker_id = $1', [account.banker.id])).rowCount).toBe(0);
    await error(await request('/auth/recover', 'POST', { username: account.banker.username, recovery_code: account.recovery_codes[0], new_password: secret }, account), 401);
    await error(await request('/auth/login', 'POST', { username: account.banker.username, password: secret }, account), 401);
    await ok(await request('/auth/login', 'POST', { username: account.banker.username, password: 'new-secure-home-password' }, account));
  });
  it('consumes one recovery code only once under concurrent recovery', async () => {
    const account = await signup();
    const payload = { username: account.banker.username, recovery_code: account.recovery_codes[0], new_password: 'concurrent-new-password' };
    const responses = await Promise.all([request('/auth/recover', 'POST', payload, account), request('/auth/recover', 'POST', payload, account)]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 401]);
    const used = await database.pool.query('SELECT id FROM recovery_codes WHERE banker_id = $1 AND used_at IS NOT NULL', [account.banker.id]);
    expect(used.rows).toHaveLength(1);
  });
  it('requires the current password for code regeneration and password change', async () => {
    const account = await signup();
    await error(await request('/auth/recovery-codes', 'POST', { password: 'wrong' }, account), 401);
    const regenerated = await ok<{ recovery_codes: string[] }>(await request('/auth/recovery-codes', 'POST', { password: secret }, account));
    expect(regenerated.recovery_codes).toHaveLength(10);
    await error(await request('/auth/recover', 'POST', { username: account.banker.username, recovery_code: account.recovery_codes[0], new_password: 'a-new-secure-password' }, account), 401);
    await error(await request('/auth/password', 'POST', { current_password: 'wrong', new_password: 'a-new-secure-password' }, account), 401);
    await ok(await request('/auth/password', 'POST', { current_password: secret, new_password: 'a-new-secure-password' }, account));
    await error(await request('/auth/login', 'POST', { username: account.banker.username, password: secret }, account), 401);
    await ok(await request('/auth/login', 'POST', { username: account.banker.username, password: 'a-new-secure-password' }, account));
    await ok(await request('/auth/logout', 'POST', {}, account));
    await error(await request('/auth/me', 'GET', undefined, account), 401);
  });
  it('supports simultaneous successful logins without deleting throttle rows under waiters', async () => {
    const account = await signup();
    const responses = await Promise.all(Array.from({ length: 10 }, () => request('/auth/login', 'POST', { username: account.banker.username, password: secret }, account)));
    for (const response of responses) expect(await ok(response)).toEqual({ banker: account.banker });
    const states = await database.pool.query('SELECT failures FROM login_throttle WHERE key = $1', [`username:${account.banker.username}`]);
    expect(states.rows[0].failures).toBe(0);
  });
  it('rejects expired and malformed session tokens', async () => {
    const account = await signup();
    await database.pool.query("UPDATE auth_sessions SET expires_at = now() - interval '1 second' WHERE banker_id = $1", [account.banker.id]);
    await error(await request('/auth/me', 'GET', undefined, account), 401);
    await error(await request('/auth/me', 'GET', undefined, { ...account, cookie: 'pb_session=bad' }), 401);
  });
});

describe('HTTP boundaries and banking journeys', () => {
  it('checks Origin and JSON for every mutation and returns the error shape', async () => {
    const account = await signup();
    await error(await request('/sessions', 'POST', {}, account, { origin: 'https://evil.test' }), 403, 'invalid_origin');
    await error(await request('/sessions', 'POST', {}, account, { 'content-type': 'text/plain' }), 415, 'json_required');
    const absent = await app.request(`${origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    await error(absent, 403);
    await error(await app.request(`${origin}/api/sessions`, { method: 'POST', headers: { origin, 'content-type': 'application/json', cookie: account.cookie }, body: '{' }), 400, 'invalid_request');
    await error(await request('/sessions', 'POST', { op_id: randomUUID(), name: 'Game', played_on: '2026-02-30', currency: 'USD' }, account), 400);
    await error(await request('/sessions', 'POST', { op_id: randomUUID(), name: 'Game', played_on: '2026-11-10', currency: 'ZZZ' }, account), 400);
    await error(await request('/sessions', 'GET'), 401);
  });
  it('creates, renames, searches, seats reusable players and polls by revision', async () => {
    const account = await signup();
    let session = await game(account);
    const roster = await ok<{ player: { id: string } }>(await request('/players', 'POST', { op_id: randomUUID(), display_name: 'Justin Tan' }, account));
    session = await seat(account, session, roster.player.id);
    await error(await request(`/sessions/${session.session.id}/players`, 'POST', { op_id: randomUUID(), player_id: roster.player.id }, account), 409, 'already_seated');
    expect((await request(`/sessions/${session.session.id}?since=${session.revision}`, 'GET', undefined, account)).status).toBe(304);
    session = await ok<SessionState>(await request(`/sessions/${session.session.id}`, 'PATCH', { op_id: randomUUID(), name: 'Saturday', played_on: '2026-11-11' }, account));
    expect(session.session.name).toBe('Saturday');
    const priorRevision = session.revision;
    await ok(await request(`/players/${roster.player.id}`, 'PATCH', { op_id: randomUUID(), display_name: 'Justin T' }, account));
    const polled = await ok<SessionState>(await request(`/sessions/${session.session.id}?since=${priorRevision}`, 'GET', undefined, account));
    expect(polled.players[0]!.display_name).toBe('Justin T');
    expect(BigInt(polled.revision)).toBe(BigInt(priorRevision) + 1n);
    const found = await ok<{ players: { id: string }[] }>(await request('/players?q=JUSTIN', 'GET', undefined, account));
    expect(found.players.map(player => player.id)).toEqual([roster.player.id]);
    const sessions = await ok<{ sessions: { id: string }[] }>(await request('/sessions?q=Saturday', 'GET', undefined, account));
    expect(sessions.sessions.map(item => item.id)).toEqual([session.session.id]);
    expect((await history(account, roster.player.id)).sessions).toHaveLength(1);
  });
  it('records default paid buy-ins, unpaid cash-outs and partial settlements', async () => {
    const account = await signup();
    let session = await seat(account, await game(account));
    session = await entry(account, session);
    expect(session.entries).toHaveLength(2);
    expect(session.players[0]).toMatchObject({ state: 'playing', bought_in_minor: '10000', payment_in_minor: '10000', balance_minor: '0' });
    expect(session.players[0]).not.toHaveProperty('result_minor');
    session = await entry(account, session, 'cash_out', '12000');
    expect(session.players[0]).toMatchObject({ state: 'cashed_out', result_minor: '2000', balance_minor: '-12000' });
    session = await entry(account, session, 'payment_out', '3000');
    expect(session.totals.owed_by_banker_minor).toBe('9000');
    session = await entry(account, session, 'buy_in', '5000', false);
    expect(session.players[0]).toMatchObject({ state: 'playing', balance_minor: '-4000' });
    expect(session.players[0]).not.toHaveProperty('result_minor');
    expect(session.totals.on_table_minor).toBe('3000');
    const playerHistory = await history(account, session.players[0]!.id);
    expect(playerHistory.cumulative).toEqual([]);
    expect(playerHistory.outstanding).toEqual([{ currency: 'USD', owed_to_banker_minor: '0', owed_by_banker_minor: '4000' }]);
  });
  it('voids and corrects in one transaction without deleting audit rows', async () => {
    const account = await signup();
    let session = await entry(account, await seat(account, await game(account)), 'buy_in', '10000', false);
    const original = session.entries[0]!;
    session = await ok<SessionState>(await request(`/sessions/${session.session.id}/entries/${original.id}/void`, 'POST', { op_id: randomUUID(), replacement_amount_minor: '20000' }, account));
    expect(session.entries).toHaveLength(3);
    expect(session.entries.find(item => item.voids_entry_id === original.id)).toMatchObject({ kind: 'buy_in', amount_minor: '10000' });
    expect(session.players[0]!.bought_in_minor).toBe('20000');
    expect(session.entries.filter(item => item.revision === session.revision)).toHaveLength(2);
    const voided = session.entries.find(item => item.voids_entry_id === original.id)!;
    await error(await request(`/sessions/${session.session.id}/entries/${voided.id}/void`, 'POST', { op_id: randomUUID() }, account), 409);
    await expect(database.pool.query('UPDATE ledger_entries SET amount_minor = 1 WHERE id = $1', [original.id])).rejects.toMatchObject({ code: '23514' });
    await expect(database.pool.query('DELETE FROM ledger_entries WHERE id = $1', [original.id])).rejects.toMatchObject({ code: '23514' });
  });
  it('validates amounts, operation IDs, kinds, membership and queries', async () => {
    const account = await signup();
    const session = await seat(account, await game(account));
    const base = { op_id: randomUUID(), player_id: session.players[0]!.id, kind: 'buy_in', amount_minor: '100' };
    for (const amount_minor of ['0', '-1', '1.005', '100x', '9223372036854775808', 1.5, 100]) await error(await request(`/sessions/${session.session.id}/entries`, 'POST', { ...base, amount_minor }, account), 400);
    await error(await request(`/sessions/${session.session.id}/entries`, 'POST', { ...base, kind: 'bogus' }, account), 400);
    await error(await request(`/sessions/${session.session.id}/entries`, 'POST', { ...base, op_id: 'bad' }, account), 400);
    await error(await request(`/sessions/${session.session.id}/entries`, 'POST', { ...base, player_id: randomUUID() }, account), 404);
    await error(await request(`/sessions/${session.session.id}?since=wat`, 'GET', undefined, account), 400);
    await error(await request('/sessions?before=garbage', 'GET', undefined, account), 400);
    expect((await ok<SessionState>(await request(`/sessions/${session.session.id}`, 'GET', undefined, account))).revision).toBe(session.revision);
  });
  it('paginates equal-date sessions with a stable cursor and no gaps', async () => {
    const account = await signup();
    const ids = new Set<string>();
    for (let i = 0; i < 33; i++) ids.add((await game(account)).session.id);
    const page = await ok<{ sessions: { id: string }[]; next: string }>(await request('/sessions', 'GET', undefined, account));
    expect(page.sessions).toHaveLength(30);
    const next = await ok<{ sessions: { id: string }[]; next: null }>(await request(`/sessions?before=${encodeURIComponent(page.next)}`, 'GET', undefined, account));
    expect(next.sessions).toHaveLength(3);
    expect(next.next).toBeNull();
    expect(new Set([...page.sessions, ...next.sessions].map(item => item.id))).toEqual(ids);
  });
});

describe('account boundaries and private viewers', () => {
  it('returns 404 for every cross-account resource and rejects foreign player attachment', async () => {
    const a = await signup(), b = await signup();
    const session = await entry(a, await seat(a, await game(a)));
    const own = await game(b);
    const player = session.players[0]!.id;
    const paths: [string, string, unknown][] = [
      [`/sessions/${session.session.id}`, 'GET', undefined],
      [`/sessions/${session.session.id}`, 'PATCH', { op_id: randomUUID(), name: 'Steal' }],
      [`/players/${player}`, 'GET', undefined],
      [`/players/${player}`, 'PATCH', { op_id: randomUUID(), display_name: 'Steal' }],
      [`/sessions/${session.session.id}/entries`, 'POST', { op_id: randomUUID(), player_id: player, kind: 'buy_in', amount_minor: '10' }],
      [`/sessions/${session.session.id}/entries/${session.entries[0]!.id}/void`, 'POST', { op_id: randomUUID() }],
      [`/sessions/${session.session.id}/share`, 'POST', { op_id: randomUUID(), action: 'enable' }],
      [`/sessions/${session.session.id}/players`, 'POST', { op_id: randomUUID(), new_player_name: 'Intruder' }],
      [`/sessions/${own.session.id}/players`, 'POST', { op_id: randomUUID(), player_id: player }],
      [`/sessions/${own.session.id}/entries/${session.entries[0]!.id}/void`, 'POST', { op_id: randomUUID() }],
      [`/sessions/${session.session.id}/close`, 'POST', { op_id: randomUUID(), expected_revision: session.revision }],
      [`/sessions/${session.session.id}/reopen`, 'POST', { op_id: randomUUID(), reason: 'Steal' }],
    ];
    for (const [path, method, payload] of paths) await error(await request(path, method, payload, b), 404, 'not_found');
    expect((await ok<{ players: unknown[] }>(await request('/players', 'GET', undefined, b))).players).toEqual([]);
    expect((await ok<{ sessions: { id: string }[] }>(await request('/sessions', 'GET', undefined, b))).sessions.map(item => item.id)).toEqual([own.session.id]);
    expect((await ok<SessionState>(await request(`/sessions/${session.session.id}`, 'GET', undefined, a))).revision).toBe(session.revision);
  });
  it('exposes one session without account data and rotates and disables tokens', async () => {
    const account = await signup();
    let session = await seat(account, await game(account));
    const other = await seat(account, await game(account));
    session = await ok<SessionState>(await request(`/sessions/${session.session.id}/share`, 'POST', { op_id: randomUUID(), action: 'enable' }, account));
    const token = session.session.share_token!;
    expect(token).toHaveLength(22);
    const viewerResponse = await request(`/view/${token}`);
    const text = await viewerResponse.clone().text();
    const viewer = await ok<Omit<SessionState, 'session'> & { session: Omit<SessionState['session'], 'share_token'> }>(viewerResponse);
    expect(viewer.session.id).toBe(session.session.id);
    for (const privateValue of [account.banker.id, account.banker.username, other.session.id, other.players[0]!.id, token]) expect(text).not.toContain(privateValue);
    expect(text).not.toContain('banker_id');
    expect((await request(`/view/${token}?since=${viewer.revision}`)).status).toBe(304);
    for (const method of ['POST', 'PATCH', 'DELETE']) expect((await request(`/view/${token}`, method, { op_id: randomUUID() })).status).toBe(401);
    await error(await request(`/sessions/${session.session.id}/entries`, 'POST', { op_id: randomUUID(), player_id: session.players[0]!.id, kind: 'buy_in', amount_minor: '10' }, { cookie: `pb_session=${token}`, ip: 'viewer' }), 401);
    session = await ok<SessionState>(await request(`/sessions/${session.session.id}/share`, 'POST', { op_id: randomUUID(), action: 'rotate' }, account));
    await error(await request(`/view/${token}`), 404);
    await ok(await request(`/view/${session.session.share_token}`));
    const rotated = session.session.share_token;
    session = await ok<SessionState>(await request(`/sessions/${session.session.id}/share`, 'POST', { op_id: randomUUID(), action: 'disable' }, account));
    expect(session.session.share_token).toBeNull();
    await error(await request(`/view/${rotated}`), 404);
    await error(await request('/view/invalid-token'), 404);
  });
});

describe('idempotency and concurrent transactions', () => {
  it('replays byte-identical JSON, writes once and rejects changed body or path', async () => {
    const account = await signup();
    const session = await seat(account, await game(account));
    const payload = { op_id: randomUUID(), player_id: session.players[0]!.id, kind: 'buy_in', amount_minor: '100', paid_now: false };
    const path = `/sessions/${session.session.id}/entries`;
    const first = await request(path, 'POST', payload, account);
    const saved = await first.text();
    expect(first.status).toBe(200);
    const replay = await request(path, 'POST', { paid_now: false, amount_minor: '100', kind: 'buy_in', player_id: payload.player_id, op_id: payload.op_id }, account);
    expect(await replay.text()).toBe(saved);
    await error(await request(path, 'POST', { ...payload, amount_minor: '200' }, account), 409, 'idempotency_mismatch');
    await error(await request('/players', 'POST', { op_id: payload.op_id, display_name: 'Someone' }, account), 409, 'idempotency_mismatch');
    expect((await database.pool.query('SELECT id FROM ledger_entries WHERE session_id = $1', [session.session.id])).rows).toHaveLength(1);
    expect((await ok<SessionState>(await request(`/sessions/${session.session.id}`, 'GET', undefined, account))).revision).toBe(String(BigInt(session.revision) + 1n));
  });
  it('serializes duplicate concurrent requests and keeps the same op_id independent across accounts', async () => {
    const a = await signup(), b = await signup();
    const op = randomUUID();
    const payload = { op_id: op, display_name: 'Same operation' };
    const responses = await Promise.all(Array.from({ length: 8 }, () => request('/players', 'POST', payload, a)));
    const texts = await Promise.all(responses.map(response => { expect(response.status).toBe(200); return response.text(); }));
    expect(new Set(texts).size).toBe(1);
    await ok(await request('/players', 'POST', payload, b));
    expect((await database.pool.query('SELECT id FROM players WHERE banker_id = $1', [a.banker.id])).rows).toHaveLength(1);
  });
  it('lands 20 parallel buy-ins with consecutive unique revisions', async () => {
    const account = await signup();
    const session = await seat(account, await game(account));
    const results = await Promise.all(Array.from({ length: 20 }, () => entry(account, session, 'buy_in', '100', false)));
    const revisions = results.map(result => Number(result.revision)).sort((a, b) => a - b);
    expect(revisions).toEqual(Array.from({ length: 20 }, (_, i) => Number(session.revision) + i + 1));
    const final = await ok<SessionState>(await request(`/sessions/${session.session.id}`, 'GET', undefined, account));
    expect(final.entries).toHaveLength(20);
    expect(final.players[0]!.bought_in_minor).toBe('2000');
    expect(final.revision).toBe(String(Number(session.revision) + 20));
  });
  it('two parallel voids leave exactly one void and one successful write', async () => {
    const account = await signup();
    const session = await entry(account, await seat(account, await game(account)), 'buy_in', '100', false);
    const entryId = session.entries[0]!.id;
    const results = await Promise.all(Array.from({ length: 2 }, () => request(`/sessions/${session.session.id}/entries/${entryId}/void`, 'POST', { op_id: randomUUID() }, account)));
    expect(results.map(response => response.status).sort()).toEqual([200, 409]);
    expect((await database.pool.query('SELECT id FROM ledger_entries WHERE voids_entry_id = $1', [entryId])).rows).toHaveLength(1);
    const final = await ok<SessionState>(await request(`/sessions/${session.session.id}`, 'GET', undefined, account));
    expect(final.players[0]!.bought_in_minor).toBe('0');
    expect(final.revision).toBe(String(Number(session.revision) + 1));
  });
  it('rejects close against a revision changed by a racing buy-in', async () => {
    const account = await signup();
    const session = await entry(account, await entry(account, await seat(account, await game(account))), 'cash_out', '10000');
    const locker = await database.pool.connect();
    await locker.query('BEGIN');
    await locker.query('SELECT id FROM game_sessions WHERE id = $1 FOR UPDATE', [session.session.id]);
    const buy = entry(account, session, 'buy_in', '100', false);
    const buyWaiter = await database.pool.query("SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE 'SELECT id,%'");
    let waiting = Number(buyWaiter.rows[0].count);
    for (let i = 0; i < 100 && waiting === 0; i++) {
      await new Promise(resolve => setTimeout(resolve, 5));
      waiting = Number((await database.pool.query("SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE 'SELECT id,%'")).rows[0].count);
    }
    expect(waiting).toBeGreaterThan(0);
    const closing = request(`/sessions/${session.session.id}/close`, 'POST', { op_id: randomUUID(), expected_revision: session.revision }, account);
    await locker.query('COMMIT');
    locker.release();
    await buy;
    await error(await closing, 409, 'revision_mismatch');
  });
});

describe('lifecycle and cumulative results', () => {
  it('refuses playing players, requires exact discrepancy, blocks closed writes and counts reclosure once', async () => {
    const account = await signup();
    let session = await entry(account, await seat(account, await game(account)), 'buy_in', '10000', false);
    const player = session.players[0]!.id;
    await error(await request(`/sessions/${session.session.id}/close`, 'POST', { op_id: randomUUID(), expected_revision: session.revision }, account), 409, 'players_active');
    session = await entry(account, session, 'cash_out', '12000');
    expect((await history(account, player)).cumulative).toEqual([]);
    for (const accept of [undefined, '1999', '-2000']) await error(await request(`/sessions/${session.session.id}/close`, 'POST', { op_id: randomUUID(), expected_revision: session.revision, ...(accept ? { accept_discrepancy_minor: accept } : {}) }, account), 409, 'discrepancy_unaccepted');
    session = await close(account, session, '2000');
    expect(session.session).toMatchObject({ status: 'closed', closed_balanced: false });
    expect((await history(account, player)).cumulative).toEqual([{ currency: 'USD', result_minor: '2000' }]);
    await error(await request(`/sessions/${session.session.id}/entries`, 'POST', { op_id: randomUUID(), player_id: player, kind: 'payment_out', amount_minor: '100' }, account), 409, 'session_closed');
    await error(await request(`/sessions/${session.session.id}/entries/${session.entries[0]!.id}/void`, 'POST', { op_id: randomUUID() }, account), 409, 'session_closed');
    await error(await request(`/sessions/${session.session.id}/players`, 'POST', { op_id: randomUUID(), new_player_name: 'Late' }, account), 409, 'session_closed');
    await error(await request(`/sessions/${session.session.id}/reopen`, 'POST', { op_id: randomUUID(), reason: ' ' }, account), 400);
    session = await ok<SessionState>(await request(`/sessions/${session.session.id}/reopen`, 'POST', { op_id: randomUUID(), reason: 'Correct the recap' }, account));
    expect(session.events[0]).toMatchObject({ kind: 'reopened', detail: { reason: 'Correct the recap' } });
    expect((await history(account, player)).cumulative).toEqual([]);
    session = await close(account, session, '2000');
    expect((await history(account, player)).cumulative).toEqual([{ currency: 'USD', result_minor: '2000' }]);
    expect(session.events.filter(event => event.kind === 'closed')).toHaveLength(2);
  });
  it('sums only closed sessions per currency and tracks outstanding separately', async () => {
    const account = await signup();
    let usd = await entry(account, await seat(account, await game(account)), 'buy_in', '100', false);
    const player = usd.players[0]!.id;
    usd = await entry(account, usd, 'cash_out', '150');
    await close(account, usd, '50');
    let usd2 = await seat(account, await game(account), player);
    usd2 = await entry(account, usd2, 'buy_in', '100', false);
    usd2 = await entry(account, usd2, 'cash_out', '80');
    await close(account, usd2, '-20');
    let jpy = await seat(account, await game(account, 'JPY'), player);
    jpy = await entry(account, jpy, 'buy_in', '1000', false);
    jpy = await entry(account, jpy, 'cash_out', '1500');
    await close(account, jpy, '500');
    const open = await seat(account, await game(account), player);
    await entry(account, await entry(account, open, 'buy_in', '100', false), 'cash_out', '900');
    const record = await history(account, player);
    expect(record.cumulative.sort((a, b) => a.currency.localeCompare(b.currency))).toEqual([{ currency: 'JPY', result_minor: '500' }, { currency: 'USD', result_minor: '30' }]);
    expect(record.sessions).toHaveLength(4);
    const roster = await ok<{ players: { id: string; cumulative: History['cumulative'] }[] }>(await request('/players', 'GET', undefined, account));
    expect(roster.players[0]!.cumulative).toEqual(record.cumulative);
  });
  it('closes balanced games and prevents a payment-only seated player being overlooked', async () => {
    const account = await signup();
    let session = await seat(account, await game(account));
    session = await entry(account, session, 'payment_in', '100');
    await error(await request(`/sessions/${session.session.id}/close`, 'POST', { op_id: randomUUID(), expected_revision: session.revision }, account), 409, 'players_active');
    const balanced = await close(account, await entry(account, await entry(account, session, 'buy_in', '100', false), 'cash_out', '100', true));
    expect(balanced.session.closed_balanced).toBe(true);
    const empty = await close(account, await game(account));
    expect(empty.session.closed_balanced).toBe(true);
  });
  it('closes exact aggregate discrepancies beyond a single Postgres bigint amount', async () => {
    const account = await signup();
    let session = await seat(account, await game(account));
    session = await entry(account, session, 'buy_in', '9223372036854775807', false);
    session = await entry(account, session, 'buy_in', '9223372036854775807', false);
    session = await entry(account, session, 'cash_out', '1');
    expect(session.totals.discrepancy_minor).toBe('-18446744073709551613');
    const closed = await close(account, session, '-18446744073709551613');
    expect(closed.session.status).toBe('closed');
  });
  it('orders events numerically across revision ten', async () => {
    const account = await signup();
    let session = await game(account);
    for (let i = 0; i < 11; i++) session = await ok<SessionState>(await request(`/sessions/${session.session.id}`, 'PATCH', { op_id: randomUUID(), name: `Game ${i}` }, account));
    expect(session.events.map(event => Number(event.revision))).toEqual(Array.from({ length: 12 }, (_, i) => 12 - i));
  });
  it('serves the API after migrations are rerun', async () => {
    await migrate(database.pool);
    const account = await signup();
    expect((await game(account)).revision).toBe('1');
  });
});
