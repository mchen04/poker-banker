import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../scripts/migrate';
import { SHUTDOWN_GRACE_MS, withShutdownDeadline } from '../scripts/owned-process';
import type { Database } from '../src/server/db';
import { testDatabase } from './database';

describe('migration transactions and ownership', () => {
  let database: Awaited<ReturnType<typeof testDatabase>>;
  beforeAll(async () => { database = await testDatabase(); });
  afterAll(async () => { await database?.stop(); });
  it('migrates an empty database and reruns without changing its migration receipt', async () => {
    const before = await database.pool.query('SELECT * FROM schema_migrations');
    expect(before.rows).toHaveLength(2);
    await migrate(database.pool);
    expect((await database.pool.query('SELECT * FROM schema_migrations')).rows).toEqual(before.rows);
    expect((await database.pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")).rows).toHaveLength(12);
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
});

describe('additive deletion migration', () => {
  let database: Awaited<ReturnType<typeof testDatabase>>;
  let directory: string;
  beforeAll(async () => {
    await mkdir('.cache', { recursive: true });
    directory = await mkdtemp(resolve('.cache/migrations-existing-'));
    await copyFile(resolve('migrations/0001_foundation.sql'), resolve(directory, '0001_foundation.sql'));
    database = await testDatabase({ migrationDirectory: directory });
  });
  afterAll(async () => {
    await database?.stop();
    await withShutdownDeadline('Existing-data migration fixture cleanup', () => rm(directory, { recursive: true, force: true }));
  });
  it('applies on top of existing rows without rewriting them', async () => {
    const banker = randomUUID(), session = randomUUID(), player = randomUUID(), entry = randomUUID();
    await database.pool.query("INSERT INTO bankers(id,username,password_hash) VALUES ($1,'existing','hash')", [banker]);
    await database.pool.query("INSERT INTO players(id,banker_id,display_name,name_key) VALUES ($1,$2,'Justin','justin')", [player, banker]);
    await database.pool.query("INSERT INTO game_sessions(id,banker_id,name,played_on,currency) VALUES ($1,$2,'Game','2026-11-10','USD')", [session, banker]);
    await database.pool.query('INSERT INTO session_players(session_id,player_id,banker_id) VALUES ($1,$2,$3)', [session, player, banker]);
    await database.pool.query("INSERT INTO ledger_entries(id,banker_id,session_id,player_id,kind,amount_minor,revision) VALUES ($1,$2,$3,$4,'buy_in',1000,1)", [entry, banker, session, player]);
    await migrate(database.pool);
    const columns = await database.pool.query<{ table_name: string; column_name: string }>(`SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name IN ('deleted_at','removed_at','restores_entry_id','removal_id') ORDER BY table_name, column_name`);
    expect(columns.rows).toEqual([
      { table_name: 'game_sessions', column_name: 'deleted_at' },
      { table_name: 'ledger_entries', column_name: 'removal_id' },
      { table_name: 'ledger_entries', column_name: 'restores_entry_id' },
      { table_name: 'players', column_name: 'deleted_at' },
      { table_name: 'session_player_removals', column_name: 'removed_at' },
      { table_name: 'session_players', column_name: 'removed_at' },
    ]);
    expect((await database.pool.query('SELECT id, amount_minor::text, restores_entry_id, removal_id FROM ledger_entries WHERE id = $1', [entry])).rows)
      .toEqual([{ id: entry, amount_minor: '1000', restores_entry_id: null, removal_id: null }]);
    await database.pool.query('INSERT INTO session_player_removals(id,session_id,player_id,banker_id) VALUES ($1,$2,$3,$4)', [randomUUID(), session, player, banker]);
  });
});

describe('bounded migration failure cleanup', () => {
  for (const phase of ['unlock', 'rollback'] as const) it(`bounds a stalled migration ${phase} and discards its connection`, async () => {
    await mkdir('.cache', { recursive: true });
    const directory = await mkdtemp(resolve('.cache/migrations-'));
    const released: boolean[] = [];
    const queries: string[] = [];
    const original = new Error('migration failed');
    const client = {
      query: async (sql: string) => {
        queries.push(sql);
        if (sql === 'broken migration') throw original;
        if (phase === 'unlock' && sql.includes('pg_advisory_unlock') || phase === 'rollback' && sql === 'ROLLBACK') return new Promise(() => {});
        return { rowCount: 0 };
      },
      release: (discard: boolean) => { released.push(discard); },
    };
    try {
      if (phase === 'rollback') await writeFile(`${directory}/0001_broken.sql`, 'broken migration');
      const started = performance.now();
      const result = await migrate({ connect: async () => client } as unknown as Database, directory).then(() => undefined, error => error as Error);
      expect(result).toBeInstanceOf(Error);
      expect(performance.now() - started).toBeLessThan(SHUTDOWN_GRACE_MS + 2000);
      expect(released).toEqual([true]);
      if (phase === 'rollback') {
        expect(result).toBeInstanceOf(AggregateError);
        expect((result as AggregateError).errors).toContain(original);
        expect(queries.some(sql => sql.includes('pg_advisory_unlock'))).toBe(false);
      } else expect(result!.message).toContain('Migration advisory unlock exceeded shutdown deadline');
    } finally { await withShutdownDeadline('Migration fixture cleanup', () => rm(directory, { recursive: true, force: true })); }
  });
});
