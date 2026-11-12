import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProcessOwner, spawnOwned } from './owned-process';
import { runOwned } from './owned-command';
import { testDatabase } from '../tests/database';

const owner = createProcessOwner();
let exitCode = 0;
let stopping: Promise<void> | undefined;
function fail(message: string) {
  exitCode ||= 1;
  process.exitCode = exitCode;
  try { console.error(message); } catch {}
}
function stop(): Promise<void> { return stopping ??= owner.stop(); }
function finish(code: number) {
  exitCode ||= code;
  void stop().then(() => process.exit(exitCode), () => { fail('E2E shutdown failed'); process.exit(exitCode); });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => finish(0));
process.on('message', message => { if (message && typeof message === 'object' && 'type' in message && message.type === 'pb-shutdown') finish(0); });
process.on('disconnect', () => finish(1));
if (typeof process.send === 'function' && !process.connected) finish(1);

async function initialize() {
  const database = await testDatabase({ owner });
  const certificateDir = await owner.launch(() => mkdtemp(resolve('.cache/e2e-tls-')));
  owner.addCleanup('E2E TLS cleanup', 'cleanup', () => rm(certificateDir, { recursive: true, force: true }));
  const key = `${certificateDir}/key.pem`;
  const cert = `${certificateDir}/cert.pem`;
  await runOwned(owner, 'openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-keyout', key, '-out', cert]);
  owner.checkpoint();
  const child = spawnOwned(owner, process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../src/server/local.ts', import.meta.url))], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: { ...process.env, PB_TEST_EDGE_HEADERS: '1', DATABASE_URL: database.pool.options.connectionString, LOCAL_TLS_KEY: key, LOCAL_TLS_CERT: cert, APP_ORIGIN: `https://127.0.0.1:${process.env.PORT || 3000}` },
  });
  child.on('error', () => { fail('E2E app failed to start'); finish(1); });
  child.on('exit', code => { if (!owner.signal.aborted) finish(code ?? 1); });
}
void initialize().catch(() => { if (!owner.signal.aborted) fail('E2E startup failed'); finish(0); });
