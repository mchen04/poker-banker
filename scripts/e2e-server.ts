import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stopOwnedProcess } from './owned-process';
import { testDatabase } from '../tests/database';

let database: Awaited<ReturnType<typeof testDatabase>> | undefined;
let certificateDir: string | undefined;
let child: ChildProcess | undefined;
let requested = false;
let stopping: Promise<void> | undefined;
async function initialize() {
  database = await testDatabase();
  if (requested) return;
  certificateDir = await mkdtemp(resolve('.cache/e2e-tls-'));
  if (requested) return;
  const key = `${certificateDir}/key.pem`;
  const cert = `${certificateDir}/cert.pem`;
  const certificate = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-keyout', key, '-out', cert], { stdio: 'ignore' });
  if (certificate.status !== 0) throw new Error('Could not generate the throwaway local HTTPS certificate');
  if (requested) return;
  child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../src/server/local.ts', import.meta.url))], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, DATABASE_URL: database.pool.options.connectionString, LOCAL_TLS_KEY: key, LOCAL_TLS_CERT: cert, APP_ORIGIN: `https://127.0.0.1:${process.env.PORT || 3000}` },
  });
  child.on('error', error => { console.error(error.message); void stop(1); });
  child.on('exit', code => { if (!requested) void stop(code ?? 1); });
}
const startup = initialize();
function stop(code: number): Promise<void> {
  requested = true;
  stopping ??= (async () => {
    await startup.catch(() => {});
    const errors: unknown[] = [];
    try {
      if (child) await stopOwnedProcess(child, 'signal');
    } catch (error) { errors.push(error); }
    try { await database?.stop(); } catch (error) { errors.push(error); }
    try { if (certificateDir) await rm(certificateDir, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    for (const error of errors) console.error(error instanceof Error ? error.message : String(error));
    process.exit(errors.length ? 1 : code);
  })();
  return stopping;
}
process.on('message', message => { if (message && typeof message === 'object' && 'type' in message && message.type === 'pb-shutdown') void stop(0); });
process.on('disconnect', () => { void stop(0); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void stop(0); });
void startup.catch(error => { console.error(error instanceof Error ? error.message : String(error)); void stop(1); });
