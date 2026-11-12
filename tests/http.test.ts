import { closeOwnedServer } from '../scripts/close-server';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { handle } from '@hono/node-server/vercel';
import { createApp } from '../src/server/app';
import { testDatabase } from './database';

let database: Awaited<ReturnType<typeof testDatabase>>;
let server: Server;
let url: string;
beforeAll(async () => {
  database = await testDatabase();
  server = createServer(handle(createApp(database.pool)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No HTTP test port');
  url = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  try { if (server) await closeOwnedServer(server); }
  finally { await database?.stop(); }
});

it('serves real HTTP via the Vercel Node adapter and preserves secure cookies', async () => {
  const username = `http-${randomUUID().slice(0, 12)}`;
  const response = await fetch(`${url}/api/auth/signup`, {
    method: 'POST', headers: { origin: url, 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: randomUUID() }),
  });
  expect(response.status).toBe(200);
  const cookie = response.headers.get('set-cookie')!;
  expect(cookie).toContain('Secure');
  const me = await fetch(`${url}/api/auth/me`, { headers: { cookie: cookie.split(';')[0]! } });
  expect(me.status).toBe(200);
  expect(await me.json()).toMatchObject({ banker: { username } });
  const missing = await fetch(`${url}/api/unknown`, { headers: { cookie: cookie.split(';')[0]! } });
  expect(missing.status).toBe(404);
  expect(missing.headers.get('content-type')).toContain('application/json');
});

it('checks the HTTPS Origin behind Vercel TLS termination', async () => {
  const previous = process.env.VERCEL;
  process.env.VERCEL = '1';
  try {
    const body = JSON.stringify({ username: `tls-${randomUUID().slice(0, 12)}`, password: randomUUID() });
    const response = await fetch(`${url}/api/auth/signup`, { method: 'POST', headers: { origin: url.replace('http:', 'https:'), 'content-type': 'application/json' }, body });
    expect(response.status).toBe(200);
    const rejected = await fetch(`${url}/api/auth/signup`, { method: 'POST', headers: { origin: url, 'content-type': 'application/json' }, body });
    expect(rejected.status).toBe(403);
  } finally {
    if (previous === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previous;
  }
});

it('throttles the socket IP even if a client spoofs X-Forwarded-For', async () => {
  for (let i = 0; i < 5; i++) {
    const response = await fetch(`${url}/api/auth/login`, {
      method: 'POST', headers: { origin: url, 'content-type': 'application/json', 'x-forwarded-for': `192.0.2.${i}` },
      body: JSON.stringify({ username: `missing-${randomUUID().slice(0, 12)}`, password: randomUUID() }),
    });
    expect(response.status).toBe(i === 4 ? 429 : 401);
  }
});
