import { mkdtemp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { migrate } from '../scripts/migrate';

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

export async function testDatabase() {
  await mkdir('.cache', { recursive: true });
  const directory = await mkdtemp(resolve('.cache/pg-'));
  const port = await availablePort();
  const database = new EmbeddedPostgres({
    databaseDir: directory, port, user: 'poker', password: 'test-only', persistent: false,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    postgresFlags: ['-h', '127.0.0.1', '-k', directory], onLog: () => {}, onError: () => {},
  });
  await database.initialise();
  await database.start();
  const pool = new pg.Pool({ connectionString: `postgresql://poker:test-only@127.0.0.1:${port}/postgres`, max: 25 });
  try { await migrate(pool); } catch (error) { await pool.end(); await database.stop(); throw error; }
  return { pool, stop: async () => { await pool.end(); await database.stop(); } };
}
