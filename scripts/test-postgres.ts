import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

if (!process.connected) throw new Error('An IPC owner is required for a throwaway database');
const [rawPort, rawFlags] = process.argv.slice(2);
if (!rawPort) throw new Error('Owned database port is required');
const inputFlags = JSON.parse(rawFlags ?? '[]') as unknown;
if (!Array.isArray(inputFlags) || !inputFlags.every(flag => typeof flag === 'string')) throw new Error('Invalid owned database flags');
const flags: string[] = inputFlags;
let directory: string | undefined;
let database: EmbeddedPostgres | undefined;
let requested = false;
let started = false;
let stopping: Promise<void> | undefined;
type Notification = { type: 'pb-postgres-ready'; directory: string } | { type: 'pb-postgres-error'; message: string };
function notify(message: Notification) {
  if (!process.connected || !process.send) { void stop(0); return; }
  try { process.send(message, error => { if (error) void stop(0); }); }
  catch { void stop(0); }
}
async function initialize() {
  await mkdir('.cache', { recursive: true });
  if (requested) return;
  directory = await mkdtemp(resolve('.cache/pg-'));
  if (requested) return;
  database = new EmbeddedPostgres({
    databaseDir: directory, port: Number(rawPort), user: 'poker', password: 'test-only', persistent: false,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    postgresFlags: ['-h', '127.0.0.1', '-k', '', ...flags], onLog: () => {}, onError: () => {},
  });
  await database.initialise();
  if (requested) return;
  await database.start();
  started = true;
  if (!requested) notify({ type: 'pb-postgres-ready', directory });
}
function stop(code: number): Promise<void> {
  if (code === 1) process.exitCode = 1;
  requested = true;
  stopping ??= (async () => {
    await startup.catch(() => {});
    try {
      if (started) await database!.stop();
      if (directory) await rm(directory, { recursive: true, force: true });
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
    process.exit(process.exitCode === 1 ? 1 : code);
  })();
  return stopping;
}
process.on('message', message => { if (message && typeof message === 'object' && 'type' in message && message.type === 'pb-shutdown') void stop(0); });
process.on('disconnect', () => { void stop(0); });
const startup = initialize();
void startup.catch(error => {
  notify({ type: 'pb-postgres-error', message: error instanceof Error ? error.message : String(error ?? 'Postgres startup failed') });
  void stop(1);
});
