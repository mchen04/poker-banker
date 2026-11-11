import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import pg from 'pg';
import { createApp } from '../src/server/app';
import { testDatabase } from './database';
import { seedBenchmark } from '../scripts/bench/seed';
import { playerHistory, playerRoster } from '../src/server/store';
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
it('loads the forty-player seeded roster with six database calls and preserves history with seven', async () => {
  const query = pg.Client.prototype.query;
  let calls = 0;
  const spy = vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function (this: pg.Client, ...args: Parameters<typeof query>) { calls++; return query.apply(this, args); } as typeof query);
  let response: Response;
  try { response = await app.request(`${origin}/api/players`, { headers: { cookie } }); } finally { spy.mockRestore(); }
  expect(response.status).toBe(200);
  const body = await response.json() as { players: { id: string; cumulative: { currency: string; result_minor: string }[] }[] };
  expect(body.players).toHaveLength(40);
  expect(body.players.every(player => player.cumulative.length === 1 && player.cumulative[0]!.currency === 'USD')).toBe(true);
  expect(calls).toBe(6);
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
it('matches history summary JSON for all 21 seeded bankers and searched rosters', async () => {
  const bankers = await database.pool.query<{ id: string }>('SELECT id FROM bankers ORDER BY id');
  expect(bankers.rows).toHaveLength(21);
  let checked = 0;
  for (const banker of bankers.rows) {
    const players = await database.pool.query<{ id: string; name_key: string }>('SELECT id,name_key FROM players WHERE banker_id=$1 ORDER BY name_key,id', [banker.id]);
    const expected = [];
    for (const player of players.rows) {
      const history = await playerHistory(database.pool, banker.id, player.id);
      expected.push({ ...history.player, cumulative: history.cumulative, outstanding: history.outstanding });
      checked++;
    }
    for (const search of ['', 'player', '01', 'other', 'absent', 'player 1']) {
      const matched = expected.filter((_, index) => players.rows[index]!.name_key.includes(search));
      expect(JSON.stringify(await playerRoster(database.pool, banker.id, search))).toBe(JSON.stringify(matched));
    }
  }
  expect(checked).toBe(280);
});
it('normalizes API roster searches before preserving summary JSON', async () => {
  for (const [search, count] of [['PLAYER', 40], ['  Player 01  ', 0], ['Ｐｌａｙｅｒ ０１', 1], ['absent', 0], ['', 40]] as const) {
    const response = await app.request(`${origin}/api/players?q=${encodeURIComponent(search)}`, { headers: { cookie } });
    expect(response.status).toBe(200);
    const expected = await playerRoster(database.pool, fixture.bankerId, search.normalize('NFKC').toLowerCase());
    expect(expected).toHaveLength(count);
    expect(await response.text()).toBe(JSON.stringify({ players: expected }));
  }
});
