import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as createHttpsServer } from 'node:https';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { resolve, join } from 'node:path';
import { testDatabase } from '../../tests/database';
import { seedBenchmark, type SeedOptions } from './seed';
import { LocalClient } from './http';
import { ShapedProxy } from './network';
import { createProcessOwner, spawnOwned, withShutdownDeadline } from '../owned-process';
import { runOwned } from '../owned-command';
async function availablePort() {
  const server = createServer();
  try {
    await withShutdownDeadline('Benchmark port acquisition', () => new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No local benchmark port');
    return address.port;
  } finally {
    await withShutdownDeadline('Benchmark port release', () => new Promise<void>((resolve, reject) => server.close(error => error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve())));
  }
}
export async function benchmarkStack(output: string, signal?: AbortSignal, options: SeedOptions = {}) {
  let database: Awaited<ReturnType<typeof testDatabase>> | undefined;
  let directory: string | undefined;
  let child: ChildProcess | undefined;
  let proxy: ShapedProxy | undefined;
  let listener: ReturnType<typeof createHttpsServer> | undefined;
  let client: LocalClient | undefined;
  let log: ReturnType<typeof createWriteStream> | undefined;
  const owner = createProcessOwner();
  const stop = () => owner.stop();
  const abort = () => { void stop().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  owner.addCleanup('Benchmark abort listener removal', 'cleanup', () => signal?.removeEventListener('abort', abort));
  owner.addCleanup('Benchmark log close', 'cleanup', async () => { if (log && !log.destroyed) await new Promise<void>((resolve, reject) => { log!.once('error', reject); log!.end(resolve); }); });
  owner.addCleanup('Benchmark TLS removal', 'cleanup', async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
  owner.addCleanup('Benchmark listener close', 'pool', async () => { if (listener?.listening) { listener.closeAllConnections(); await new Promise<void>((resolve, reject) => listener!.close(error => error ? reject(error) : resolve())); } });
  owner.addCleanup('Benchmark proxy close', 'pool', () => proxy?.close());
  owner.addCleanup('Benchmark client close', 'pool', () => client?.close());
  const starting = <T>(action: () => Promise<T>) => owner.launch(action);
  if (signal?.aborted) owner.cancel();
  try {
    database = await starting(async () => database = await testDatabase({ owner }));
    directory = await starting(async () => directory = await mkdtemp(resolve('.cache/bench-tls-')));
    log = createWriteStream(join(output, 'server.log'), { flags: 'a' });
    await starting(() => new Promise<void>((resolve, reject) => { log!.once('open', () => resolve()); log!.once('error', reject); }));
    const fixture = await starting(() => seedBenchmark(database!.pool, options));
    const key = join(directory, 'key.pem'), certificate = join(directory, 'cert.pem');
    await runOwned(owner, 'openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-keyout', key, '-out', certificate], { stdio: 'ignore' });
    const port = await starting(availablePort); const backend = `https://127.0.0.1:${port}`;
    proxy = new ShapedProxy(backend);
    listener = createHttpsServer({ key: await starting(() => readFile(key)), cert: await starting(() => readFile(certificate)) }, proxy.handle);
    await starting(() => new Promise<void>((resolve, reject) => { listener!.once('error', reject); listener!.listen(0, '127.0.0.1', resolve); }));
    const address = listener.address(); if (!address || typeof address === 'string') throw new Error('No shaping port');
    const origin = `https://127.0.0.1:${address.port}`;
    child = spawnOwned(owner, process.execPath, ['--import', 'tsx', 'src/server/local.ts'], { detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, NODE_ENV: 'production', PORT: String(port), DATABASE_URL: database.pool.options.connectionString, APP_ORIGIN: origin, LOCAL_TLS_KEY: key, LOCAL_TLS_CERT: certificate, PB_BENCHMARK_TIMING: '1' } });
    await starting(() => new Promise<void>((resolve, reject) => {
      let text = ''; const timeout = setTimeout(() => reject(new Error('Owned benchmark server startup timed out')), 30000);
      child!.stdout!.on('data', chunk => { log!.write(chunk); text += String(chunk); if (text.includes('Poker banker ready at')) { clearTimeout(timeout); resolve(); } });
      child!.stderr!.on('data', chunk => log!.write(chunk));
      child!.once('error', error => { clearTimeout(timeout); reject(error); }); child!.once('exit', code => { clearTimeout(timeout); reject(new Error(`Owned benchmark server exited ${code}`)); });
    }));
    client = new LocalClient(backend, origin);
    const login = await starting(() => client!.request('/api/auth/login', { method: 'POST', body: { username: fixture.username, password: fixture.password } }));
    if (login.status !== 200) throw new Error(`Owned benchmark sign-in failed ${login.status}`);
    client.cookie();
    return { fixture, database, backend, origin, client, proxy, serverPid: child.pid!, stop, owner };
  } catch (error) {
    try { await stop(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Owned benchmark startup and cleanup failed'); }
    throw error;
  }
}
