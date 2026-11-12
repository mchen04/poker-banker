import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { getRequestListener } from '@hono/node-server';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import { testDatabase } from './database';

let database: Awaited<ReturnType<typeof testDatabase>>;
let server: Server;
let base: string;
let hold: { path: string; ready: () => void; release: Promise<void> } | undefined;
const password = 'a-secure-race-test-password';
type Account = { banker: { id: string; username: string }; recovery_codes: string[] };

class CookieJar {
  values = new Map<string, string>();
  apply(response: Response) {
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const equals = pair!.indexOf('=');
      const name = pair!.slice(0, equals);
      const value = pair!.slice(equals + 1);
      if (value === '' || /Max-Age=0(?:;|$)/i.test(cookie)) this.values.delete(name);
      else this.values.set(name, value);
    }
  }
  header() { return [...this.values].map(([name, value]) => `${name}=${value}`).join('; '); }
}

beforeAll(async () => {
  database = await testDatabase();
  const app = createApp(database.pool);
  server = createServer(getRequestListener(async request => {
    const response = await app.fetch(request);
    const waiting = hold;
    if (waiting && new URL(request.url).pathname === waiting.path) {
      hold = undefined;
      waiting.ready();
      await waiting.release;
    }
    return response;
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No auth race port');
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await database?.stop();
});

function request(jar: CookieJar, path: string, body?: unknown, expectedBanker?: string) {
  return fetch(`${base}/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { origin: base, 'content-type': 'application/json', cookie: jar.header(), ...(expectedBanker ? { 'X-PB-Expected-Banker-ID': expectedBanker } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function signup(jar: CookieJar) {
  const response = await request(jar, '/auth/signup', { username: `race-${randomUUID().slice(0, 16)}`, password });
  expect(response.status).toBe(200);
  expect(response.headers.getSetCookie()).toHaveLength(1);
  for (const attribute of ['pb_session=', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=15552000']) expect(response.headers.get('set-cookie')).toContain(attribute);
  jar.apply(response);
  return await response.json() as Account;
}

it.each(['startup', 'logout', 'recovery', 'password', 'recovery-codes'] as const)('a delayed %s response cannot replace or clear a newer login over real HTTP', async kind => {
  const jar = new CookieJar();
  const account = await signup(jar);
  const second = await signup(new CookieJar());
  let release!: () => void;
  let ready!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { ready = resolve; });
  const route = kind === 'startup' ? 'me' : kind === 'recovery' ? 'recover' : kind;
  hold = { path: `/api/auth/${route}`, ready, release: held };
  const body = kind === 'startup' ? undefined : kind === 'logout' ? {} : kind === 'recovery'
    ? { username: account.banker.username, recovery_code: account.recovery_codes[0], new_password: `${password}-new` }
    : kind === 'password' ? { current_password: password, new_password: `${password}-new` } : { password };
  const delayed = request(jar, `/auth/${route}`, body);
  try {
    await started;
    if (kind !== 'logout' && kind !== 'recovery') {
      const logout = await request(jar, '/auth/logout', {});
      expect(logout.status).toBe(200);
      jar.apply(logout);
    }
    const login = await request(jar, '/auth/login', { username: second.banker.username, password });
    expect(login.status).toBe(200);
    expect(login.headers.getSetCookie()).toHaveLength(1);
    expect(login.headers.get('set-cookie')).toContain('Max-Age=15552000');
    jar.apply(login);
    const before = await request(jar, '/auth/me', undefined, second.banker.id);
    expect(await before.json()).toEqual({ banker: second.banker });
    release();
    const stale = await delayed;
    expect(stale.status).toBe(200);
    expect(stale.headers.getSetCookie()).toEqual([]);
    jar.apply(stale);
    const after = await request(jar, '/auth/me', undefined, second.banker.id);
    expect(after.status).toBe(200);
    expect(await after.json()).toEqual({ banker: second.banker });
  } finally {
    release();
    await delayed;
  }
});

it('a delayed explicit sign-in remains user intent and expected-banker binding rejects the previous account', async () => {
  const jar = new CookieJar();
  const first = await signup(jar);
  const second = await signup(new CookieJar());
  const delayed = await request(jar, '/auth/login', { username: first.banker.username, password });
  expect(delayed.status).toBe(200);
  const newer = await request(jar, '/auth/login', { username: second.banker.username, password });
  jar.apply(newer);
  expect((await request(jar, '/auth/me', undefined, second.banker.id)).status).toBe(200);
  jar.apply(delayed);
  const changed = await request(jar, '/sessions', undefined, second.banker.id);
  expect(changed.status).toBe(409);
  expect(await changed.json()).toMatchObject({ error: { code: 'account_changed' } });
  expect(changed.headers.get('X-PB-Banker-ID')).toBe(first.banker.id);
  expect(changed.headers.getSetCookie()).toEqual([]);
});
