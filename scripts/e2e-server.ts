import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { testDatabase } from '../tests/database';

let shutdownRequested = false;
let requestShutdown = () => { shutdownRequested = true; };
process.on('message', message => { if (message && typeof message === 'object' && 'type' in message && message.type === 'pb-shutdown') requestShutdown(); });
const database = await testDatabase();
if (shutdownRequested) { await database.stop(); process.exit(0); }
const certificateDir = await mkdtemp(resolve('.cache/e2e-tls-'));
const key = `${certificateDir}/key.pem`;
const cert = `${certificateDir}/cert.pem`;
const certificate = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-keyout', key, '-out', cert], { stdio: 'ignore' });
if (certificate.status !== 0) {
  await database.stop();
  await rm(certificateDir, { recursive: true, force: true });
  throw new Error('Could not generate the throwaway local HTTPS certificate');
}
const child = spawn('pnpm', ['start:local'], {
  stdio: ['ignore', 'inherit', 'inherit'],
  detached: true,
  env: { ...process.env, DATABASE_URL: database.pool.options.connectionString, LOCAL_TLS_KEY: key, LOCAL_TLS_CERT: cert, APP_ORIGIN: `https://127.0.0.1:${process.env.PORT || 3000}` },
});
let stopping = false;
async function stop(code: number) {
  if (stopping) return;
  stopping = true;
  if (child.exitCode === null && child.signalCode === null) {
    process.kill(-child.pid!, 'SIGTERM');
    await new Promise<void>(resolve => child.once('exit', () => resolve()));
  }
  await database.stop();
  await rm(certificateDir, { recursive: true, force: true });
  process.exit(code);
}
child.on('error', error => { console.error(error); void stop(1); });
child.on('exit', code => { void stop(code ?? 1); });
requestShutdown = () => { void stop(0); };
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void stop(0); });
if (shutdownRequested) await stop(0);
