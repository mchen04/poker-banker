import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { testDatabase } from './database';

const execute = promisify(execFile);
const origin = 'https://poker-banker.example';
let database: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => { database = await testDatabase(); });
afterAll(async () => { await database?.stop(); });

async function invoke(body: string) {
  const { stdout } = await execute(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import pg from 'pg';
    import { withShutdownDeadline } from './scripts/owned-process.ts';
    const pools = [];
    const Pool = pg.Pool;
    pg.Pool = class extends Pool {
      constructor(...args) { super(...args); pools.push(this); }
    };
    let result;
    try {
      const entry = await import('./api/[...route].ts');
      const response = await entry.POST(new Request('${origin}/api/auth/signup', {
        method: 'POST', headers: { origin: '${origin}', 'content-type': 'application/json' }, body: process.argv[1],
      }));
      const cookie = response.headers.get('set-cookie');
      const body = await response.json();
      const me = response.status === 200 ? await entry.GET(new Request('${origin}/api/auth/me', {
        headers: { cookie: cookie.split(';')[0] },
      })) : undefined;
      result = { methods: Object.keys(entry).sort(), status: response.status, body, cookie,
        me: me ? { status: me.status, body: await me.json() } : null };
    } finally {
      try {
        const results = await Promise.allSettled(pools.map(pool => withShutdownDeadline('Vercel test pool shutdown', () => pool.end())));
        const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
        if (failures.length) throw new AggregateError(failures, 'Vercel test pools failed to close');
      } finally { pg.Pool = Pool; }
    }
    console.log(JSON.stringify({ ...result, poolsEnded: pools.length > 0 && pools.every(pool => pool.ended) }));
    process.exit(0);
  `, body], {
    env: { ...process.env, DATABASE_URL: database.pool.options.connectionString, APP_ORIGIN: origin, VERCEL: '1' },
    timeout: 5000,
  });
  return JSON.parse(stdout) as {
    methods: string[];
    poolsEnded: boolean;
    status: number;
    body: { banker?: { id: string; username: string }; recovery_codes?: string[]; error?: { code: string } };
    cookie: string | null;
    me: { status: number; body: { banker: { id: string; username: string } } } | null;
  };
}

it.each(['{"username":"x","password":"y"}', '{'])('returns validation errors promptly through the real Web Request entry for %s', async body => {
  const result = await invoke(body);
  expect(result.poolsEnded).toBe(true);
  expect(result.status).toBe(400);
  expect(result.body).toEqual({ error: { code: 'invalid_request', message: 'Request validation failed' } });
  expect(result.cookie).toBeNull();
}, 10000);

it('signs up through the real entry and authenticates the returned cookie against disposable PostgreSQL', async () => {
  const username = `vercel-${randomUUID().slice(0, 12)}`;
  const result = await invoke(JSON.stringify({ username, password: 'a-secure-vercel-password' }));
  expect(result.poolsEnded).toBe(true);
  expect(result.methods).toEqual(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT']);
  expect(result.status).toBe(200);
  expect(result.body.banker).toMatchObject({ username });
  expect(result.body.recovery_codes).toHaveLength(10);
  expect(result.cookie).toContain('Secure');
  expect(result.cookie).toContain('HttpOnly');
  expect(result.me).toEqual({ status: 200, body: { banker: result.body.banker } });
  const stored = await database.pool.query('SELECT id,username FROM bankers WHERE username = $1', [username]);
  expect(stored.rows).toEqual([result.body.banker]);
}, 10000);
