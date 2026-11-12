import { access, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import EmbeddedPostgres from 'embedded-postgres';
import { createPool } from '../src/server/db';
import { migrate } from './migrate';
import { stopOwnedProcess } from './owned-process';

const directory = resolve('.local-db');
await mkdir(directory, { recursive: true });
const port = Number(process.env.PG_LOCAL_PORT || 55432);
const database = new EmbeddedPostgres({
  databaseDir: directory, port, user: 'poker', password: 'local-poker-only', persistent: true,
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
  postgresFlags: ['-h', '127.0.0.1', '-k', directory],
});
try { await access(`${directory}/PG_VERSION`); } catch { await database.initialise(); }
await database.start();
const connectionString = `postgresql://poker:local-poker-only@127.0.0.1:${port}/postgres`;
const pool = createPool(connectionString);
try { await migrate(pool); } finally { await pool.end(); }
console.log(`Local database ready. DATABASE_URL=${connectionString}`);
let child: ReturnType<typeof spawn> | undefined;
let stopping: Promise<void> | undefined;
const stopDatabase = database.stop.bind(database);
function stop(): Promise<void> {
  return stopping ??= (async () => {
    try {
      if (child && child.exitCode === null && child.signalCode === null) await stopOwnedProcess(child, 'signal');
    } finally { await stopDatabase(); }
  })();
}
database.stop = stop;
process.on('SIGINT', () => { void stop().then(() => process.exit(0)); });
process.on('SIGTERM', () => { void stop().then(() => process.exit(0)); });
if (process.argv.length > 2) {
  const [command, ...args] = process.argv.slice(2);
  child = spawn(command!, args, { stdio: 'inherit', env: { ...process.env, DATABASE_URL: connectionString, DATABASE_URL_UNPOOLED: connectionString } });
  child.on('exit', (code) => { void stop().then(() => process.exit(code ?? 1)); });
} else {
  await new Promise(() => {});
}
