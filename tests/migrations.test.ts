import { withShutdownDeadline } from '../scripts/owned-process';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { migrate } from '../scripts/migrate';
import { testDatabase } from './database';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

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

it('rolls back a failed file without rolling back an earlier migration', async () => {
  const directory = await mkdtemp(resolve('.cache/migrations-'));
  try {
    await writeFile(`${directory}/0002_good.sql`, 'CREATE TABLE migration_good (id integer PRIMARY KEY)');
    await writeFile(`${directory}/0003_bad.sql`, 'CREATE TABLE migration_bad (id integer); SELECT * FROM missing_migration_table');
    await expect(migrate(database.pool, directory)).rejects.toMatchObject({ code: '42P01' });
    const tables = await database.pool.query("SELECT to_regclass('migration_good') AS good, to_regclass('migration_bad') AS bad");
    expect(tables.rows[0]).toEqual({ good: 'migration_good', bad: null });
    const receipts = await database.pool.query("SELECT version FROM schema_migrations WHERE version IN ('0002_good.sql','0003_bad.sql')");
    expect(receipts.rows).toEqual([{ version: '0002_good.sql' }]);
  } finally { await withShutdownDeadline('Test directory cleanup', () => rm(directory, { recursive: true, force: true })); }
});
