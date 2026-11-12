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
let exitCode = 0;
function fail(message: string) {
  exitCode ||= 1;
  process.exitCode = exitCode;
  try { console.error(message); } catch {}
}
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
    env: { ...process.env, PB_TEST_EDGE_HEADERS: '1', DATABASE_URL: database.pool.options.connectionString, LOCAL_TLS_KEY: key, LOCAL_TLS_CERT: cert, APP_ORIGIN: `https://127.0.0.1:${process.env.PORT || 3000}` },
  });
  child.on('error', () => { fail('E2E app failed to start'); finish(1); });
  child.on('exit', code => { if (!requested || (code !== null && code !== 0)) finish(code ?? 1); });
}
const startup = initialize();
function stop(): Promise<void> {
  requested = true;
  return stopping ??= (async () => {
    await startup.catch(() => {});
    try {
      if (child) await stopOwnedProcess(child, 'signal');
    } catch { fail('E2E app shutdown failed'); }
    try { await database?.stop(); } catch { fail('E2E database shutdown failed'); }
    try { if (certificateDir) await rm(certificateDir, { recursive: true, force: true }); } catch { fail('E2E TLS cleanup failed'); }
  })();
}
function finish(code: number) {
  if (code !== 0 && exitCode === 0) {
    exitCode = code;
    process.exitCode = code;
  }
  void stop().then(
    () => process.exit(exitCode),
    () => { fail('E2E server shutdown failed'); process.exit(exitCode); },
  );
}
process.on('message', message => { if (message && typeof message === 'object' && 'type' in message && message.type === 'pb-shutdown') finish(0); });
process.on('disconnect', () => { finish(0); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { finish(0); });
void startup.catch(() => { fail('E2E server startup failed'); finish(1); });
