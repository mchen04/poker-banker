import { afterAll, beforeAll, expect, it } from 'vitest';
import { migrate } from '../scripts/migrate';
import { testDatabase } from './database';
import { randomUUID } from 'node:crypto';

let database: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => { database = await testDatabase(); });
afterAll(async () => { await database?.stop(); });
it('migrates an empty database and reruns without changing its migration receipt', async () => {
  const before = await database.pool.query('SELECT * FROM schema_migrations');
  expect(before.rows).toHaveLength(1);
  await migrate(database.pool);
  expect((await database.pool.query('SELECT * FROM schema_migrations')).rows).toEqual(before.rows);
  expect((await database.pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")).rows).toHaveLength(11);
});
it('enforces cross-account session and player ownership in composite foreign keys', async () => {
  const a = randomUUID(), b = randomUUID(), session = randomUUID(), player = randomUUID();
  await database.pool.query("INSERT INTO bankers(id,username,password_hash) VALUES ($1,'banker-a','hash'),($2,'banker-b','hash')", [a, b]);
  await database.pool.query("INSERT INTO game_sessions(id,banker_id,name,played_on,currency) VALUES ($1,$2,'Game','2026-11-10','USD')", [session, a]);
  await database.pool.query("INSERT INTO players(id,banker_id,display_name,name_key) VALUES ($1,$2,'Justin','justin')", [player, b]);
  await expect(database.pool.query('INSERT INTO session_players(session_id,player_id,banker_id) VALUES ($1,$2,$3)', [session, player, a])).rejects.toMatchObject({ code: '23503' });
});
