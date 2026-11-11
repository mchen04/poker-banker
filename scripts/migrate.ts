import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { type Database } from '../src/server/db';

export async function migrate(pool: Database, directory = fileURLToPath(new URL('../migrations/', import.meta.url))): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(734820091)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const files = (await readdir(directory)).filter(file => /^\d{4}_[a-z0-9_]+\.sql$/.test(file)).sort();
    for (const file of files) {
      const existing = await client.query('SELECT version FROM schema_migrations WHERE version = $1', [file]);
      if (existing.rowCount) continue;
      const sql = await readFile(`${directory}/${file}`, 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    try { await client.query('SELECT pg_advisory_unlock(734820091)'); } finally { client.release(); }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL_UNPOOLED or DATABASE_URL is required');
  const pool = new pg.Pool({ connectionString });
  try { await migrate(pool); } finally { await pool.end(); }
}
