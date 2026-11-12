import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { createProcessOwner, withShutdownDeadline } from './owned-process';

const owner = createProcessOwner({ phase: 'database' });
if (!process.connected) throw new Error('An IPC owner is required for a throwaway database');
const [rawPort, rawFlags] = process.argv.slice(2);
if (!rawPort) throw new Error('Owned database port is required');
const inputFlags: unknown = JSON.parse(rawFlags ?? '[]');
if (!Array.isArray(inputFlags) || !inputFlags.every(flag => typeof flag === 'string')) throw new Error('Invalid owned database flags');
const flags: string[] = inputFlags;
let exitCode = 0;
let stopping: Promise<void> | undefined;
let directory: string | undefined;
owner.addCleanup('Owned PostgreSQL directory cleanup', 'cleanup', () => directory ? rm(directory, { recursive: true, force: true }) : undefined);
function fail(message: string) {
  exitCode = 1;
  process.exitCode = 1;
  try { console.error(message); } catch {}
}
function stop(): Promise<void> { return stopping ??= owner.stop(); }
function finish(code: number) {
  exitCode ||= code;
  void stop().then(() => process.exit(exitCode), () => { fail('Owned PostgreSQL shutdown failed'); process.exit(exitCode); });
}
function notify(message: unknown) {
  if (!process.connected || !process.send) { finish(1); return; }
  try { process.send(message, error => { if (error) finish(1); }); } catch { finish(1); }
}
process.on('message', message => { if (message && typeof message === 'object' && 'type' in message && message.type === 'pb-shutdown') finish(0); });
process.on('disconnect', () => finish(1));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => finish(0));

async function initialize() {
  await owner.launch(() => mkdir('.cache', { recursive: true }));
  const path = await owner.launch(async () => {
    directory = await mkdtemp(resolve('.cache/pg-'));
    notify({ type: 'pb-postgres-directory', directory });
    return directory;
  });
  const database = new EmbeddedPostgres({
    databaseDir: path, port: Number(rawPort), user: 'poker', password: 'test-only', persistent: true,
    initdbFlags: ['--encoding=UTF8', '--locale=C'], postgresFlags: ['-h', '127.0.0.1', '-k', '', ...flags], onLog: () => {}, onError: () => {},
  });
  const rawStop = database.stop.bind(database);
  let ending: Promise<void> | undefined;
  const endDatabase = () => ending ??= withShutdownDeadline('Owned PostgreSQL graceful stop', rawStop);
  database.stop = () => owner.stop().catch(() => {});
  owner.addCleanup('Owned PostgreSQL graceful stop', 'database', endDatabase);
  await owner.launch(() => database.initialise());
  await owner.launch(() => database.start());
  owner.checkpoint();
  notify({ type: 'pb-postgres-ready', directory: path });
}
void initialize().catch(() => {
  if (!owner.signal.aborted) { notify({ type: 'pb-postgres-error', message: 'Owned PostgreSQL startup failed' }); finish(1); }
  else finish(0);
});
