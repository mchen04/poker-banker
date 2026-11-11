import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { handle } from '@hono/node-server/vercel';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import * as data from '../src/client/data';
import { createApp } from '../src/server/app';
import type { SessionState } from '../src/domain/session';
import { testDatabase } from './database';

let database: Awaited<ReturnType<typeof testDatabase>>;
let server: Server;
let origin: string;
const nativeFetch = globalThis.fetch;
const password = 'a-secure-request-boundary-password';

type Account = { id: string; cookie: string };
const privateClient = (banker: string) => data.bankerClient(banker);

beforeAll(async () => {
  database = await testDatabase();
  server = createServer(handle(createApp(database.pool)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No request boundary test port');
  origin = `http://127.0.0.1:${address.port}`;
});

afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  try {
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } finally { await database?.stop(); }
});

function request(path: string, cookie = '', method = 'GET', body?: unknown) {
  return nativeFetch(`${origin}/api${path}`, {
    method, headers: { origin, cookie, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function signup(): Promise<Account> {
  const response = await request('/auth/signup', '', 'POST', { username: `request-${randomUUID().slice(0, 12)}`, password });
  expect(response.status).toBe(200);
  const value = await response.json() as { banker: { id: string } };
  return { id: value.banker.id, cookie: response.headers.get('set-cookie')!.split(';')[0]! };
}

async function setup(fault?: 'missing owner' | 'foreign owner' | 'foreign owner 500' | 'missing owner 503') {
  const a = await signup();
  const b = await signup();
  const create = async (owner: Account) => {
    const response = await request('/sessions', owner.cookie, 'POST', { op_id: randomUUID(), name: `Private ${owner.id}`, played_on: '2026-11-10', currency: 'USD' });
    expect(response.status).toBe(200);
    const session = await response.json() as SessionState;
    const added = await request(`/sessions/${session.session.id}/players`, owner.cookie, 'POST', { op_id: randomUUID(), new_player_name: `Player ${owner.id}` });
    expect(added.status).toBe(200);
    return added.json() as Promise<SessionState>;
  };
  const stateA = await create(a);
  const initialB = await create(b);
  const enabled = await request(`/sessions/${initialB.session.id}/share`, b.cookie, 'POST', { op_id: randomUUID(), action: 'enable' });
  expect(enabled.status).toBe(200);
  const stateB = await enabled.json() as SessionState;
  let activeCookie = b.cookie;
  const requests: { path: string; expected: string | null; status: number }[] = [];
  const events = new EventTarget();
  const saved = new Map([['pb-banker', JSON.stringify({ id: a.id, username: 'Displayed A' })]]);
  vi.stubGlobal('localStorage', { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value), removeItem: (key: string) => saved.delete(key) });
  vi.stubGlobal('window', { setTimeout, clearTimeout, dispatchEvent: events.dispatchEvent.bind(events), addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) });
  vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const expected = headers.get('X-PB-Expected-Banker-ID');
    if (fault && expected === a.id) headers.delete('X-PB-Expected-Banker-ID');
    headers.set('origin', origin);
    headers.set('cookie', activeCookie);
    const response = await nativeFetch(new URL(path, origin), { ...init, headers });
    let delivered = response;
    if (fault && expected === a.id) {
      const proof = new Headers(response.headers);
      if (fault.startsWith('missing owner')) proof.delete('X-PB-Banker-ID');
      if (fault.endsWith('500') || fault.endsWith('503')) {
        await response.body?.cancel();
        delivered = new Response(JSON.stringify({ error: { code: 'unavailable', message: 'Temporary transport failure' } }), { status: fault.endsWith('500') ? 500 : 503, headers: proof });
      } else if (fault === 'missing owner') delivered = new Response(response.body, { status: response.status, headers: proof });
    }
    requests.push({ path, expected, status: delivered.status });
    return delivered;
  });
  return { a, b, stateA, stateB, requests, client: privateClient(a.id), saved, useCookie(cookie: string) { activeCookie = cookie; fault = undefined; } };
}

it.each(['sessions', 'poll', 'unchanged poll', 'roster', 'report', 'suggestions', 'identity', 'share', 'logout'] as const)('blocks a displayed A / cookie B %s request at the real HTTP boundary', async operation => {
  const { a, b, stateA, stateB, requests, client, saved } = await setup();
  const pathB = `/api/sessions/${stateB.session.id}`;
  const attempt = () => {
    if (operation === 'poll') return client.pollSession(pathB);
    if (operation === 'unchanged poll') return client.pollSession(pathB, stateB.revision);
    if (operation === 'sessions') return client.api('/api/sessions');
    if (operation === 'roster') return client.api('/api/players?q=Player');
    if (operation === 'report') return client.api(`/api/players/${stateB.players[0]!.id}/report?group=overall`);
    if (operation === 'suggestions') return client.api('/api/suggestions');
    if (operation === 'identity') return client.api('/api/auth/me');
    if (operation === 'share') return client.api(`${pathB}/share`, 'POST', { op_id: randomUUID(), action: 'disable' });
    return client.api('/api/auth/logout', 'POST', {});
  };
  await expect(attempt()).rejects.toMatchObject({ status: 409, code: 'account_changed' });
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ expected: a.id, status: 409 });
  expect(JSON.parse(saved.get('pb-banker')!).id).toBe(a.id);
  const authB = await request('/auth/me', b.cookie);
  expect(authB.status).toBe(200);
  expect((await authB.json()).banker.id).toBe(b.id);
  for (const [owner, state] of [[a, stateA], [b, stateB]] as const) {
    const response = await request(`/sessions/${state.session.id}`, owner.cookie);
    expect(response.status).toBe(200);
    const retained = await response.json() as SessionState;
    expect(retained.revision).toBe(state.revision);
    expect(retained.session.share_token).toBe(state.session.share_token);
    expect(retained.players.map(player => player.id)).toEqual(state.players.map(player => player.id));
  }
});

it.each([
  ['poll success', 'foreign owner'], ['API rejection', 'foreign owner'],
  ['API server failure', 'foreign owner 500'],
] as const)('rejects a delivered %s with %s before accepting private data', async (kind, fault) => {
  const { a, b, stateA, stateB, requests, client, useCookie } = await setup(fault);
  const path = `/api/sessions/${stateB.session.id}`;
  const pending = kind === 'poll success' ? client.pollSession(path)
    : client.api(kind === 'API rejection' ? `/api/sessions/${stateA.session.id}` : '/api/sessions');
  await expect(pending).rejects.toMatchObject({ status: 409, code: 'account_changed', bankerId: a.id });
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ expected: a.id, status: kind === 'API rejection' ? 404 : kind === 'API server failure' ? 500 : 200 });
  await expect(client.api('/api/sessions')).rejects.toMatchObject({ code: 'account_changed' });
  const constructedWhileBlocked = data.bankerClient(a.id);
  expect(constructedWhileBlocked.isCurrent()).toBe(false);
  await expect(constructedWhileBlocked.api('/api/sessions')).rejects.toMatchObject({ code: 'account_changed' });
  expect(requests).toHaveLength(1);
  expect((await data.discoverAccount()).banker.id).toBe(b.id);
  expect(requests.at(-1)).toMatchObject({ path: '/api/auth/me', expected: null, status: 200 });
  data.resumeBankerWork(b.id);
  const own = await data.bankerClient(b.id).api<{ sessions: { id: string }[] }>('/api/sessions');
  expect(own.sessions.map(session => session.id)).toEqual([stateB.session.id]);
  useCookie(a.cookie);
  expect((await data.discoverAccount()).banker.id).toBe(a.id);
  data.resumeBankerWork(a.id);
  expect(client.isCurrent()).toBe(false);
  expect(constructedWhileBlocked.isCurrent()).toBe(false);
  const beforeStaleAttempt = requests.length;
  await expect(constructedWhileBlocked.api('/api/sessions')).rejects.toMatchObject({ code: 'account_changed' });
  expect(requests).toHaveLength(beforeStaleAttempt);
  const resumed = data.bankerClient(a.id);
  expect(resumed.isCurrent()).toBe(true);
  expect((await resumed.api<{ sessions: { id: string }[] }>('/api/sessions')).sessions.map(session => session.id)).toEqual([stateA.session.id]);
});

it('rejects missing-proof private data without accepting it or changing the displayed owner', async () => {
  const { a, requests, client } = await setup('missing owner');
  let problem: unknown;
  try { await client.api('/api/sessions'); } catch (failure) { problem = failure; }
  expect(problem).toMatchObject({ name: 'UnverifiedResponseError', responseStatus: 200 });
  expect(data.isProvenNotApplied(problem)).toBe(false);
  expect(requests).toEqual([{ path: '/api/sessions', expected: a.id, status: 200 }]);
  expect(client.isCurrent()).toBe(true);
});

it('accepts a stripped unchanged response after the real server checks the expected banker', async () => {
  const { a, stateA, requests, client, useCookie } = await setup();
  useCookie(a.cookie);
  const boundFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
    const response = await boundFetch(path, init);
    if (response.status !== 304) return response;
    expect(response.headers.get('X-PB-Banker-ID')).toBe(a.id);
    const headers = new Headers(response.headers);
    headers.delete('X-PB-Banker-ID');
    return new Response(null, { status: 304, headers });
  });
  expect(await client.pollSession(`/api/sessions/${stateA.session.id}`, stateA.revision)).toBeUndefined();
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ expected: a.id, status: 304 });
  expect(client.isCurrent()).toBe(true);
});

it('keeps public viewer reads and explicit account discovery neutral while private raw requests fail closed', async () => {
  const { b, stateB, requests } = await setup();
  await expect(data.api('/api/sessions')).rejects.toThrow('account-bound');
  await expect(data.pollSession(`/api/sessions/${stateB.session.id}`)).rejects.toThrow('account-bound');
  await expect(data.api('/api/auth/logout', 'POST', {})).rejects.toThrow('account-bound');
  await expect(data.api('/api/auth/me')).rejects.toThrow('account-bound');
  expect(() => data.bankerClient('')).toThrow('banker');
  expect(() => data.bankerClient('   ')).toThrow('banker');
  expect(requests).toHaveLength(0);
  expect((await data.discoverAccount()).banker.id).toBe(b.id);
  const path = `/api/view/${stateB.session.share_token}`;
  const viewed = await data.api<SessionState>(path);
  expect(viewed.session.id).toBe(stateB.session.id);
  expect((await data.pollSession(path, viewed.revision))).toBeUndefined();
  expect(requests.map(request => request.expected)).toEqual([null, null, null]);
});

it('keeps a missing-owner 503 unverified and permits a verified retry', async () => {
  const { a, stateA, requests, client, useCookie } = await setup('missing owner 503');
  let problem: unknown;
  try { await client.api('/api/sessions'); } catch (failure) { problem = failure; }
  expect(problem).toMatchObject({ name: 'UnverifiedResponseError', responseStatus: 503 });
  expect(data.isProvenNotApplied(problem)).toBe(false);
  expect(client.isCurrent()).toBe(true);
  expect(requests).toEqual([{ path: '/api/sessions', expected: a.id, status: 503 }]);
  useCookie(a.cookie);
  const result = await client.api<{ sessions: { id: string }[] }>('/api/sessions');
  expect(result.sessions.map(session => session.id)).toEqual([stateA.session.id]);
});
