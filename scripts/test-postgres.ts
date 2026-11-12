import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { stopOwnedProcess } from './owned-process';

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
let startAttempted = false;
let startupSettled = false;
let stopConfirmed = false;
let databaseStopping: Promise<void> | undefined;
let stopDatabase: (() => Promise<void>) | undefined;
let stopping: Promise<void> | undefined;
function fail(error: unknown) {
  process.exitCode = 1;
  try { console.error(error instanceof Error ? error.message : String(error)); } catch {}
}
function endDatabase(): Promise<void> {
  return databaseStopping ??= (async () => {
    try {
      if (started || (startAttempted && !startupSettled)) await stopOwnedProcess.withDeadline('Owned PostgreSQL shutdown', () => stopDatabase!());
      stopConfirmed = startupSettled;
    } catch (error) { fail(error); }
  })();
}
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
    databaseDir: directory, port: Number(rawPort), user: 'poker', password: 'test-only', persistent: true,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    postgresFlags: ['-h', '127.0.0.1', '-k', '', ...flags], onLog: () => {}, onError: () => {},
  });
  stopDatabase = database.stop.bind(database);
  database.stop = endDatabase;
  await database.initialise();
  if (requested) return;
  startAttempted = true;
  await database.start();
  started = true;
  if (!requested) notify({ type: 'pb-postgres-ready', directory });
}
function stop(code: number): Promise<void> {
  if (code === 1) process.exitCode = 1;
  requested = true;
  stopping ??= (async () => {
    try { await stopOwnedProcess.withDeadline('Owned PostgreSQL startup shutdown', () => startup.catch(() => {})); }
    catch (error) { fail(error); }
    if (database) await endDatabase();
    if (directory && startupSettled && (!database || stopConfirmed)) {
      try { await stopOwnedProcess.withDeadline('Owned PostgreSQL directory cleanup', () => rm(directory!, { recursive: true, force: true })); }
      catch (error) { fail(error); }
    }
    process.exit(process.exitCode === 1 ? 1 : code);
  })();
  return stopping;
}
process.on('message', message => { if (message && typeof message === 'object' && 'type' in message && message.type === 'pb-shutdown') void stop(0); });
process.on('disconnect', () => { void stop(0); });
const startup = initialize().finally(() => { startupSettled = true; });
void startup.catch(error => {
  notify({ type: 'pb-postgres-error', message: error instanceof Error ? error.message : String(error ?? 'Postgres startup failed') });
  void stop(1);
});
