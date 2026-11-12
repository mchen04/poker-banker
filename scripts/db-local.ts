import { access, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import EmbeddedPostgres from 'embedded-postgres';
import { createPool } from '../src/server/db';
import { migrate } from './migrate';
import { stopOwnedProcess } from './owned-process';

const directory = resolve('.local-db');
const port = Number(process.env.PG_LOCAL_PORT || 55432);
const database = new EmbeddedPostgres({
  databaseDir: directory, port, user: 'poker', password: 'local-poker-only', persistent: true,
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
  postgresFlags: ['-h', '127.0.0.1', '-k', directory],
});
const connectionString = `postgresql://poker:local-poker-only@127.0.0.1:${port}/postgres`;
let pool: ReturnType<typeof createPool> | undefined;
let child: ReturnType<typeof spawn> | undefined;
let requested = false;
let ending: Promise<void> | undefined;
let stopping: Promise<void> | undefined;
let exitCode = 0;
const stopDatabase = database.stop.bind(database);
const endPool = () => pool ? ending ??= pool.end() : Promise.resolve();
function fail(message: string) {
  exitCode ||= 1;
  process.exitCode = exitCode;
  try { console.error(message); } catch {}
}
async function initialize() {
  await mkdir(directory, { recursive: true });
  if (requested) return;
  try { await access(`${directory}/PG_VERSION`); } catch {
    if (requested) return;
    await database.initialise();
  }
  if (requested) return;
  await database.start();
  if (requested) return;
  pool = createPool(connectionString);
  try { await migrate(pool); } finally { await endPool(); }
  if (requested) return;
  console.log(`Local database ready. DATABASE_URL=${connectionString}`);
  if (process.argv.length > 2) {
    const [command, ...args] = process.argv.slice(2);
    child = spawn(command!, args, { stdio: 'inherit', env: { ...process.env, DATABASE_URL: connectionString, DATABASE_URL_UNPOOLED: connectionString } });
    child.on('error', () => { fail('Local app failed to start'); finish(1); });
    child.on('exit', code => { if (!requested || (code !== null && code !== 0)) finish(code ?? 1); });
  }
}
function stop(): Promise<void> {
  requested = true;
  return stopping ??= (async () => {
    await startup.catch(() => {});
    try {
      if (child && child.exitCode === null && child.signalCode === null) await stopOwnedProcess(child, 'signal');
    } catch { fail('Local app shutdown failed'); }
    try { await endPool(); } catch { fail('Local database pool shutdown failed'); }
    try { await stopDatabase(); } catch { fail('Local database shutdown failed'); }
  })();
}
function finish(code: number) {
  if (code !== 0 && exitCode === 0) {
    exitCode = code;
    process.exitCode = code;
  }
  void stop().then(
    () => process.exit(exitCode),
    () => { fail('Local database shutdown failed'); process.exit(exitCode); },
  );
}
database.stop = stop;
process.on('SIGINT', () => { finish(0); });
process.on('SIGTERM', () => { finish(0); });
const startup = initialize();
await startup.catch(() => { fail('Local database startup failed'); finish(1); });
if (!requested && !child) await new Promise(() => {});
