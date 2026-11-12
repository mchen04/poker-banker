import { access, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { createPool } from '../src/server/db';
import { migrate } from './migrate';
import { createProcessOwner, spawnOwned, withShutdownDeadline } from './owned-process';

const owner = createProcessOwner();
const directory = resolve('.local-db');
const port = Number(process.env.PG_LOCAL_PORT || 55432);
const database = new EmbeddedPostgres({
  databaseDir: directory, port, user: 'poker', password: 'local-poker-only', persistent: true,
  initdbFlags: ['--encoding=UTF8', '--locale=C'], postgresFlags: ['-h', '127.0.0.1', '-k', directory],
});
const connectionString = `postgresql://poker:local-poker-only@127.0.0.1:${port}/postgres`;
let exitCode = 0;
let stopping: Promise<void> | undefined;
let databaseStopping: Promise<void> | undefined;
const rawStop = database.stop.bind(database);
const stopDatabase = () => databaseStopping ??= withShutdownDeadline('Local PostgreSQL graceful stop', rawStop);
database.stop = () => owner.stop().catch(() => {});
owner.addCleanup('Local PostgreSQL graceful stop', 'database', stopDatabase);
function fail(message: string) {
  exitCode ||= 1;
  process.exitCode = exitCode;
  try { console.error(message); } catch {}
}
function stop(): Promise<void> { return stopping ??= owner.stop(); }
function finish(code: number) {
  exitCode ||= code;
  void stop().then(() => process.exit(exitCode), () => { fail('Local database shutdown failed'); process.exit(exitCode); });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => finish(0));
if (typeof process.send === 'function') process.on('disconnect', () => finish(1));

async function initialize() {
  await owner.launch(() => mkdir(directory, { recursive: true }));
  try { await owner.launch(() => access(`${directory}/PG_VERSION`)); }
  catch (error) { owner.checkpoint(); await owner.launch(() => database.initialise(), 'database'); }
  await owner.launch(() => database.start(), 'database');
  owner.checkpoint();
  const pool = createPool(connectionString);
  let ending: Promise<void> | undefined;
  const endPool = () => ending ??= withShutdownDeadline('Local migration pool shutdown', () => pool.end());
  owner.addCleanup('Local migration pool shutdown', 'pool', endPool);
  try { await owner.launch(() => migrate(pool)); } finally { await endPool(); }
  owner.checkpoint();
  console.log(`Local database ready. DATABASE_URL=${connectionString}`);
  if (process.argv.length > 2) {
    const [command, ...args] = process.argv.slice(2);
    const child = spawnOwned(owner, command!, args, { stdio: 'inherit', env: { ...process.env, DATABASE_URL: connectionString, DATABASE_URL_UNPOOLED: connectionString } });
    child.on('error', () => { fail('Local app failed to start'); finish(1); });
    child.on('exit', code => { if (!owner.signal.aborted) finish(code ?? 1); });
  }
}
void initialize().catch(() => { if (!owner.signal.aborted) fail('Local database startup failed'); finish(0); });
