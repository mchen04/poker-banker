import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import pg from 'pg';
import { createApp } from '../src/server/app';
import { testDatabase } from './database';
import { seedBenchmark } from '../scripts/bench/seed';
let database: Awaited<ReturnType<typeof testDatabase>>;
let app: ReturnType<typeof createApp>;
let cookie = '';
let fixture: Awaited<ReturnType<typeof seedBenchmark>>;
const origin = 'https://roster.test';
beforeAll(async () => {
  database = await testDatabase(); fixture = await seedBenchmark(database.pool);
  app = createApp(database.pool, { origin });
  const login = await app.request(`${origin}/api/auth/login`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ username: fixture.username, password: fixture.password }) });
  expect(login.status).toBe(200); cookie = login.headers.get('set-cookie')!.split(';')[0]!;
});
afterAll(async () => { await database?.stop(); });
it('loads the forty-player seeded roster with a fixed seven database calls and preserves history', async () => {
  const query = pg.Client.prototype.query;
  let calls = 0;
  const spy = vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function (this: pg.Client, ...args: Parameters<typeof query>) { calls++; return query.apply(this, args); } as typeof query);
  let response: Response;
  try { response = await app.request(`${origin}/api/players`, { headers: { cookie } }); } finally { spy.mockRestore(); }
  expect(response.status).toBe(200);
  const body = await response.json() as { players: { id: string; cumulative: { currency: string; result_minor: string }[] }[] };
  expect(body.players).toHaveLength(40);
  expect(body.players.every(player => player.cumulative.length === 1 && player.cumulative[0]!.currency === 'USD')).toBe(true);
  expect(calls).toBe(7);
  calls = 0;
  const historySpy = vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function (this: pg.Client, ...args: Parameters<typeof query>) { calls++; return query.apply(this, args); } as typeof query);
  let history: Response;
  try { history = await app.request(`${origin}/api/players/${fixture.playerId}`, { headers: { cookie } }); } finally { historySpy.mockRestore(); }
  expect(history.status).toBe(200);
  const detail = await history.json() as { player: { id: string }; sessions: unknown[]; cumulative: unknown[] };
  expect(detail.player.id).toBe(fixture.playerId); expect(detail.sessions.length).toBeGreaterThan(60);
  expect(detail.cumulative).toEqual(body.players.find(player => player.id === fixture.playerId)!.cumulative);
  expect(calls).toBe(7);
  const other = randomUUID();
  expect((await app.request(`${origin}/api/players/${other}`, { headers: { cookie } })).status).toBe(404);
});
