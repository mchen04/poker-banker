import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { handle } from '@hono/node-server/vercel';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import type { SessionState } from '../src/domain/session';
import { testDatabase } from './database';

let database: Awaited<ReturnType<typeof testDatabase>>;
let server: Server;
let origin: string;

beforeAll(async () => {
  database = await testDatabase();
  server = createServer(handle(createApp(database.pool)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No account proof test port');
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  try {
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } finally { await database?.stop(); }
});

function request(path: string, cookie = '', method = 'GET', body?: unknown, claimedOwner?: string, expectedOwner?: string) {
  return fetch(`${origin}/api${path}`, {
    method,
    headers: { origin, cookie, 'content-type': 'application/json', ...(claimedOwner ? { 'X-PB-Banker-ID': claimedOwner } : {}), ...(expectedOwner ? { 'X-PB-Expected-Banker-ID': expectedOwner } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function signup() {
  const response = await request('/auth/signup', '', 'POST', { username: `proof-${randomUUID().slice(0, 12)}`, password: 'a-secure-response-proof-password' });
  expect(response.status).toBe(200);
  const value = await response.json() as { banker: { id: string } };
  return { id: value.banker.id, cookie: response.headers.get('set-cookie')!.split(';')[0]! };
}

it('binds successful, rejected and replayed HTTP mutation responses to the authenticated banker', async () => {
  const a = await signup();
  const b = await signup();
  const created = await request('/sessions', a.cookie, 'POST', { op_id: randomUUID(), name: 'Response owner', played_on: '2026-11-10', currency: 'USD' });
  expect(created.status).toBe(200);
  expect(created.headers.get('X-PB-Banker-ID')).toBe(a.id);
  const session = await created.json() as SessionState;
  const seated = await request(`/sessions/${session.session.id}/players`, a.cookie, 'POST', { op_id: randomUUID(), new_player_name: 'Justin' });
  expect(seated.status).toBe(200);
  const state = await seated.json() as SessionState;
  const body = { op_id: randomUUID(), player_id: state.players[0]!.id, kind: 'buy_in', amount_minor: '10000', paid_now: false, occurred_at: null };
  const path = `/sessions/${session.session.id}/entries`;
  const saved = await request(path, a.cookie, 'POST', body);
  expect(saved.status).toBe(200);
  expect(saved.headers.get('X-PB-Banker-ID')).toBe(a.id);
  const otherAccount = await request(path, b.cookie, 'POST', body, a.id);
  expect(otherAccount.status).toBe(404);
  expect(otherAccount.headers.get('X-PB-Banker-ID')).toBe(b.id);
  expect(await otherAccount.json()).toMatchObject({ error: { code: 'not_found' } });
  const invalid = await request(path, a.cookie, 'POST', { op_id: randomUUID() });
  expect(invalid.status).toBe(400);
  expect(invalid.headers.get('X-PB-Banker-ID')).toBe(a.id);
  const guarded = await request('/sessions', b.cookie, 'POST', { op_id: randomUUID(), name: 'Wrong account write', played_on: '2026-11-10', currency: 'USD' }, undefined, a.id);
  expect(guarded.status).toBe(409);
  expect(guarded.headers.get('X-PB-Banker-ID')).toBe(b.id);
  expect(await guarded.json()).toMatchObject({ error: { code: 'account_changed' } });
  const otherSessions = await request('/sessions', b.cookie);
  expect((await otherSessions.json()).sessions).toEqual([]);
  const replay = await request(path, a.cookie, 'POST', body);
  expect(replay.status).toBe(200);
  expect(replay.headers.get('X-PB-Banker-ID')).toBe(a.id);
  const confirmed = await replay.json() as SessionState;
  expect(confirmed.entries).toHaveLength(1);
  expect(confirmed.entries[0]!.amount_minor).toBe('10000');
  const anonymous = await request(path, '', 'POST', body, a.id);
  expect(anonymous.status).toBe(401);
  expect(anonymous.headers.get('X-PB-Banker-ID')).toBeNull();
  const share = await request(`/sessions/${session.session.id}/share`, a.cookie, 'POST', { op_id: randomUUID(), action: 'enable' });
  expect(share.status).toBe(200);
  const shared = await share.json() as SessionState;
  const publicView = await request(`/view/${shared.session.share_token}`, a.cookie, 'GET', undefined, a.id);
  expect(publicView.status).toBe(200);
  expect(publicView.headers.get('X-PB-Banker-ID')).toBeNull();
  const rows = await database.pool.query('SELECT count(*)::int AS count, sum(amount_minor)::text AS total FROM ledger_entries WHERE session_id = $1', [session.session.id]);
  expect(rows.rows).toEqual([{ count: 1, total: '10000' }]);
});
