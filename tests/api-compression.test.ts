import { closeOwnedServer } from '../scripts/close-server';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { gunzipSync, inflateSync } from 'node:zlib';
import { getRequestListener } from '@hono/node-server';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import type { SessionState } from '../src/domain/session';
import { testDatabase } from './database';

type Account = { banker: { id: string; username: string }; cookie: string };
type Options = { account?: Account; method?: string; body?: unknown; headers?: Record<string, string> };
let database: Awaited<ReturnType<typeof testDatabase>>;
let server: Server;
let base: string;
let account: Account;
let fixture: SessionState;
let standardReplay: Options;
const password = randomUUID();

beforeAll(async () => {
  database = await testDatabase();
  const app = createApp(database.pool);
  server = createServer(getRequestListener(request => app.fetch(request)));
  const listening = once(server, 'listening', { signal: AbortSignal.timeout(10_000) });
  server.listen(0, '127.0.0.1');
  await listening;
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No compression test port');
  base = `http://127.0.0.1:${address.port}`;
  account = await signup();
  fixture = await state(await request('/sessions', 'identity', { account, method: 'POST', body: {
    op_id: randomUUID(), name: 'Compression fixture ♠', played_on: '2026-11-10', currency: 'USD',
  } }));
  fixture = await state(await request(`/sessions/${fixture.session.id}/players`, 'identity', { account, method: 'POST', body: {
    op_id: randomUUID(), new_player_name: 'Compression player',
  } }));
  for (let i = 0; i < 60; i++) {
    const options: Options = { account, method: 'POST', body: {
      op_id: randomUUID(), player_id: fixture.players[0]!.id, kind: 'buy_in', amount_minor: '100', paid_now: false,
      note: `Entry ${i}: ${'Compression fixture ledger note. '.repeat(12)}`,
    } };
    fixture = await state(await request(`/sessions/${fixture.session.id}/entries`, 'identity', options));
    if (i === 19) standardReplay = options;
  }
  fixture = await state(await request(`/sessions/${fixture.session.id}/share`, 'identity', { account, method: 'POST', body: {
    op_id: randomUUID(), action: 'enable',
  } }));
});

afterAll(async () => {
  try { if (server) await closeOwnedServer(server); }
  finally { await database?.stop(); }
});

function headers(encoding: string, options: Options) {
  return {
    origin: base, 'content-type': 'application/json', 'accept-encoding': encoding,
    ...(options.account ? { cookie: options.account.cookie, 'X-PB-Expected-Banker-ID': options.account.banker.id } : {}),
    ...options.headers,
  };
}

function request(path: string, encoding = 'identity', options: Options = {}) {
  return fetch(`${base}/api${path}`, {
    method: options.method ?? 'GET', headers: headers(encoding, options), signal: AbortSignal.timeout(10_000),
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

function raw(path: string, encoding: string, options: Options = {}) {
  return new Promise<{ status: number; headers: Headers; body: Buffer }>((resolve, reject) => {
    const outgoing = httpRequest(`${base}/api${path}`, {
      method: options.method ?? 'GET', headers: headers(encoding, options), agent: false, signal: AbortSignal.timeout(10_000),
    }, incoming => {
      const chunks: Buffer[] = [];
      incoming.on('data', chunk => chunks.push(Buffer.from(chunk)));
      incoming.once('error', reject);
      incoming.once('aborted', () => reject(new Error('Compression response aborted')));
      incoming.once('end', () => {
        const received = new Headers();
        for (let i = 0; i < incoming.rawHeaders.length; i += 2) received.append(incoming.rawHeaders[i]!, incoming.rawHeaders[i + 1]!);
        resolve({ status: incoming.statusCode!, headers: received, body: Buffer.concat(chunks) });
      });
    });
    outgoing.once('error', reject);
    outgoing.end(options.body === undefined ? undefined : JSON.stringify(options.body));
  });
}

async function state(response: Response): Promise<SessionState> {
  expect(response.status).toBe(200);
  return await response.json() as SessionState;
}

async function signup(encoding = 'identity'): Promise<Account> {
  const response = await request('/auth/signup', encoding, { method: 'POST', body: {
    username: `compress-${randomUUID().slice(0, 16)}`, password,
  } });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('content-encoding')).toBeNull();
  expect(response.headers.get('vary')).toBeNull();
  expect(response.headers.getSetCookie()).toHaveLength(1);
  for (const attribute of ['pb_session=', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=15552000']) {
    expect(response.headers.get('set-cookie')).toContain(attribute);
  }
  const body = await response.json() as { banker: Account['banker']; recovery_codes: string[] };
  expect(body.recovery_codes).toHaveLength(10);
  return { banker: body.banker, cookie: response.headers.getSetCookie()[0]!.split(';')[0]! };
}

it('negotiates smaller gzip and deflate bytes without changing a replayed full JSON response or writing twice', async () => {
  const path = `/sessions/${fixture.session.id}/entries`;
  const options: Options = { account, method: 'POST', body: {
    op_id: randomUUID(), player_id: fixture.players[0]!.id, kind: 'expense', amount_minor: '100', note: 'Replayed entry',
  } };
  const before = await database.pool.query<{ count: string }>('SELECT count(*)::text FROM ledger_entries WHERE session_id = $1 AND banker_id = $2', [fixture.session.id, account.banker.id]);
  const identity = await raw(path, 'identity', options);
  expect(identity.status).toBe(200);
  expect(identity.headers.get('content-encoding')).toBeNull();
  expect(identity.headers.get('content-length')).toBe(String(identity.body.length));
  expect(identity.body.length).toBeGreaterThanOrEqual(32_768);
  const decoded = JSON.parse(identity.body.toString()) as SessionState;
  expect(Object.keys(decoded).sort()).toEqual(['entries', 'events', 'players', 'revision', 'server_now', 'session', 'timing', 'totals']);
  expect(decoded.entries).toHaveLength(61);
  expect(decoded.players).toHaveLength(1);
  expect(decoded.session.share_token).toBe(fixture.session.share_token);
  for (const [accepted, encoding] of [['gzip', 'gzip'], ['deflate', 'deflate'], ['gzip;q=0, deflate;q=0, *;q=0', null]] as const) {
    const response = await raw(path, accepted, options);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-encoding')).toBe(encoding);
    const bytes = encoding === 'gzip' ? gunzipSync(response.body) : encoding === 'deflate' ? inflateSync(response.body) : response.body;
    expect(bytes.equals(identity.body)).toBe(true);
    if (encoding) {
      expect(response.body.length).toBeLessThan(identity.body.length);
      expect(response.headers.get('content-length')).not.toBe(String(identity.body.length));
    } else expect(response.headers.get('content-length')).toBe(String(identity.body.length));
    expect(response.headers.get('x-pb-banker-id')).toBe(account.banker.id);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('vary')).toMatch(/(?:^|,\s*)Accept-Encoding(?:,|$)/i);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.getSetCookie()).toEqual([]);
  }
  const native = await request(path, 'gzip', { method: 'POST', body: options.body, headers: { cookie: account.cookie } });
  expect(native.headers.get('content-encoding')).toBe('gzip');
  expect(native.headers.get('x-pb-banker-id')).toBe(account.banker.id);
  expect(await native.text()).toBe(identity.body.toString());
  const after = await database.pool.query<{ count: string }>('SELECT count(*)::text FROM ledger_entries WHERE session_id = $1 AND banker_id = $2', [fixture.session.id, account.banker.id]);
  expect(BigInt(after.rows[0]!.count) - BigInt(before.rows[0]!.count)).toBe(1n);
  const saved = await database.pool.query('SELECT response FROM idempotency_keys WHERE banker_id = $1 AND key = $2', [account.banker.id, (options.body as { op_id: string }).op_id]);
  expect(saved.rows).toHaveLength(1);
  expect(saved.rows[0]!.response).toEqual(decoded);
});

it('keeps small and standard session bodies, authentication and reports uncompressed', async () => {
  const signedUp = await signup('gzip');
  const login = await request('/auth/login', 'deflate', { method: 'POST', body: { username: signedUp.banker.username, password } });
  expect(login.status).toBe(200);
  expect(login.headers.get('content-encoding')).toBeNull();
  expect(login.headers.get('vary')).toBeNull();
  expect(await login.json()).toEqual({ banker: signedUp.banker });
  expect(login.headers.getSetCookie()).toHaveLength(1);
  for (const attribute of ['pb_session=', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=15552000']) expect(login.headers.get('set-cookie')).toContain(attribute);
  const loggedIn = { ...signedUp, cookie: login.headers.getSetCookie()[0]!.split(';')[0]! };
  const smallOptions: Options = { account: loggedIn, method: 'POST', body: {
    op_id: randomUUID(), name: 'Small session', played_on: '2026-11-10', currency: 'USD',
  } };
  const small = await raw('/sessions', 'identity', smallOptions);
  const smallGzip = await raw('/sessions', 'gzip', smallOptions);
  const standard = await raw(`/sessions/${fixture.session.id}/entries`, 'identity', standardReplay);
  const standardGzip = await raw(`/sessions/${fixture.session.id}/entries`, 'gzip', standardReplay);
  expect(smallGzip.body.equals(small.body)).toBe(true);
  expect(standardGzip.body.equals(standard.body)).toBe(true);
  expect(standard.body.length).toBeGreaterThan(10_000);
  for (const response of [small, smallGzip, standard, standardGzip]) {
    expect(response.status).toBe(200);
    expect(response.body.length).toBeLessThan(32_768);
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.headers.get('vary')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-pb-banker-id')).toBe(response === small || response === smallGzip ? loggedIn.banker.id : account.banker.id);
  }
  const smallState = JSON.parse(small.body.toString()) as SessionState;
  const smallGet = await raw(`/sessions/${smallState.session.id}`, 'gzip', { account: loggedIn });
  expect(smallGet.status).toBe(200);
  expect(smallGet.headers.get('content-encoding')).toBeNull();
  expect(smallGet.headers.get('vary')).toBeNull();
  expect((JSON.parse(smallGet.body.toString()) as SessionState).session).toEqual(smallState.session);
  const report = await request(`/players/${fixture.players[0]!.id}/report`, 'gzip', { account });
  expect(report.status).toBe(200);
  expect(report.headers.get('content-encoding')).toBeNull();
  expect(report.headers.get('vary')).toBeNull();
  await report.json();
  const logout = await request('/auth/logout', 'gzip', { account: loggedIn, method: 'POST', body: {} });
  expect(logout.status).toBe(200);
  expect(logout.headers.get('cache-control')).toBe('no-store');
  expect(logout.headers.get('content-encoding')).toBeNull();
  expect(logout.headers.get('vary')).toBeNull();
  expect(logout.headers.get('x-pb-banker-id')).toBe(loggedIn.banker.id);
  expect(logout.headers.getSetCookie()).toEqual([]);
  expect(await logout.json()).toEqual({ ok: true });
  const expired = await request('/auth/me', 'gzip', { account: loggedIn });
  expect(expired.status).toBe(401);
  expect(await expired.json()).toMatchObject({ error: { code: 'unauthorized' } });
});

it('keeps unchanged polls and HEAD responses empty with owner and no-store headers', async () => {
  const current = await state(await request(`/sessions/${fixture.session.id}`, 'identity', { account }));
  const unchanged = await raw(`/sessions/${fixture.session.id}?since=${current.revision}`, 'gzip', { account });
  const head = await raw(`/sessions/${fixture.session.id}`, 'gzip', { account, method: 'HEAD' });
  expect(unchanged.status).toBe(304);
  expect(head.status).toBe(200);
  for (const response of [unchanged, head]) {
    expect(response.body.length).toBe(0);
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.headers.get('x-pb-banker-id')).toBe(account.banker.id);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.getSetCookie()).toEqual([]);
  }
});

it('preserves JSON errors and rejects banker mismatches before a ledger write', async () => {
  const before = await state(await request(`/sessions/${fixture.session.id}`, 'identity', { account }));
  for (const [path, options, status, code, owner] of [
    ['/sessions', { account, headers: { 'X-PB-Expected-Banker-ID': randomUUID() } }, 409, 'account_changed', account.banker.id],
    [`/sessions/${fixture.session.id}?since=invalid`, { account }, 400, 'invalid_request', account.banker.id],
    ['/sessions', { account, method: 'POST', body: {}, headers: { origin: 'https://invalid.example' } }, 403, 'invalid_origin', null],
  ] as const) {
    const identity = await raw(path, 'identity', options);
    const negotiated = await raw(path, 'gzip', options);
    expect(negotiated.status).toBe(status);
    expect(negotiated.headers.get('content-encoding')).toBeNull();
    expect(negotiated.headers.get('vary')).toBeNull();
    expect(negotiated.body.equals(identity.body)).toBe(true);
    expect(JSON.parse(negotiated.body.toString())).toMatchObject({ error: { code, message: expect.any(String) } });
    expect(negotiated.headers.get('x-pb-banker-id')).toBe(owner);
    expect(negotiated.headers.get('cache-control')).toBe('no-store');
    expect(negotiated.headers.getSetCookie()).toEqual([]);
  }
  const rejected = await request(`/sessions/${fixture.session.id}/entries`, 'gzip', { account, method: 'POST', headers: {
    'X-PB-Expected-Banker-ID': randomUUID(),
  }, body: { op_id: randomUUID(), player_id: fixture.players[0]!.id, kind: 'expense', amount_minor: '100' } });
  expect(rejected.status).toBe(409);
  await rejected.json();
  const unchanged = await state(await request(`/sessions/${fixture.session.id}`, 'identity', { account }));
  expect(unchanged.entries).toEqual(before.entries);
  expect(unchanged.revision).toBe(before.revision);
});

it('compresses the public viewer without adding banker scope or exposing the share token', async () => {
  const current = await state(await request(`/sessions/${fixture.session.id}`, 'identity', { account }));
  const path = `/view/${fixture.session.share_token}`;
  const response = await request(path, 'gzip', { headers: { 'X-PB-Expected-Banker-ID': randomUUID() } });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-encoding')).toBe('gzip');
  expect(response.headers.get('x-pb-banker-id')).toBeNull();
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('vary')).toMatch(/Accept-Encoding/i);
  expect(response.headers.getSetCookie()).toEqual([]);
  const viewer = await response.json() as SessionState;
  expect(Object.keys(viewer).sort()).toEqual(Object.keys(current).sort());
  expect(Object.keys(viewer.session).sort()).toEqual(Object.keys(current.session).filter(key => key !== 'share_token').sort());
  expect(viewer.session).not.toHaveProperty('share_token');
  expect(viewer.entries).toEqual(current.entries);
  expect(viewer.players).toEqual(current.players);
  expect(viewer.revision).toBe(current.revision);
  const unchanged = await raw(`${path}?since=${viewer.revision}`, 'gzip');
  expect(unchanged.status).toBe(304);
  expect(unchanged.body.length).toBe(0);
  expect(unchanged.headers.get('content-encoding')).toBeNull();
  expect(unchanged.headers.get('x-pb-banker-id')).toBeNull();
  expect(unchanged.headers.get('cache-control')).toBe('no-store');
});
