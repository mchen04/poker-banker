import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as createHttpsServer } from 'node:https';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { resolve, join } from 'node:path';
import { testDatabase } from '../../tests/database';
import { seedBenchmark } from './seed';
import { LocalClient } from './http';
import { ShapedProxy } from './network';
import { stopOwnedProcess } from '../owned-process';
async function availablePort() {
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No local benchmark port');
  await new Promise<void>(resolve => server.close(() => resolve())); return address.port;
}
export async function benchmarkStack(output: string) {
  let database: Awaited<ReturnType<typeof testDatabase>> | undefined;
  let directory: string | undefined;
  let child: ChildProcess | undefined;
  let proxy: ShapedProxy | undefined;
  let listener: ReturnType<typeof createHttpsServer> | undefined;
  let client: LocalClient | undefined;
  let log: ReturnType<typeof createWriteStream> | undefined;
  let stopping: Promise<void> | undefined;
  const owned = new Set<() => Promise<void>>();
  async function own(cleanup: () => Promise<void>) {
    if (stopping) { await cleanup(); throw new Error('Owned benchmark stack is stopping'); }
    owned.add(cleanup);
    return () => { owned.delete(cleanup); };
  }
  function stop(): Promise<void> {
    stopping ??= (async () => {
      const errors: unknown[] = [];
      const attempt = async (action: () => unknown | Promise<unknown>) => { try { await action(); } catch (error) { errors.push(error); } };
      for (const cleanup of owned) await attempt(cleanup);
      owned.clear();
      await attempt(() => client?.close());
      await attempt(() => proxy?.close());
      await attempt(async () => { if (listener?.listening) { listener.closeAllConnections(); await new Promise<void>((resolve, reject) => listener!.close(error => error ? reject(error) : resolve())); } });
      await attempt(async () => { if (child) await stopOwnedProcess(child, 'signal'); });
      await attempt(async () => { await database?.stop(); });
      await attempt(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
      await attempt(async () => { if (log && !log.destroyed) await new Promise<void>((resolve, reject) => { log!.once('error', reject); log!.end(resolve); }); });
      if (errors.length) throw new AggregateError(errors, 'Owned benchmark cleanup failed');
    })();
    return stopping;
  }
  try {
    database = await testDatabase();
    directory = await mkdtemp(resolve('.cache/bench-tls-'));
    log = createWriteStream(join(output, 'server.log'), { flags: 'a' });
    await new Promise<void>((resolve, reject) => { log!.once('open', () => resolve()); log!.once('error', reject); });
    const fixture = await seedBenchmark(database.pool);
    const key = join(directory, 'key.pem'), certificate = join(directory, 'cert.pem');
    const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-keyout', key, '-out', certificate], { stdio: 'ignore' });
    if (generated.status !== 0) throw new Error('Owned benchmark TLS certificate failed');
    const port = await availablePort(); const backend = `https://127.0.0.1:${port}`;
    proxy = new ShapedProxy(backend);
    listener = createHttpsServer({ key: await readFile(key), cert: await readFile(certificate) }, proxy.handle);
    await new Promise<void>((resolve, reject) => { listener!.once('error', reject); listener!.listen(0, '127.0.0.1', resolve); });
    const address = listener.address(); if (!address || typeof address === 'string') throw new Error('No shaping port');
    const origin = `https://127.0.0.1:${address.port}`;
    child = spawn(process.execPath, ['--import', 'tsx', 'src/server/local.ts'], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_ENV: 'production', PORT: String(port), DATABASE_URL: database.pool.options.connectionString, APP_ORIGIN: origin, LOCAL_TLS_KEY: key, LOCAL_TLS_CERT: certificate, PB_BENCHMARK_TIMING: '1' } });
    await new Promise<void>((resolve, reject) => {
      let text = ''; const timeout = setTimeout(() => reject(new Error('Owned benchmark server startup timed out')), 30000);
      child!.stdout!.on('data', chunk => { log!.write(chunk); text += String(chunk); if (text.includes('Poker banker ready at')) { clearTimeout(timeout); resolve(); } });
      child!.stderr!.on('data', chunk => log!.write(chunk));
      child!.once('error', error => { clearTimeout(timeout); reject(error); }); child!.once('exit', code => { clearTimeout(timeout); reject(new Error(`Owned benchmark server exited ${code}`)); });
    });
    client = new LocalClient(backend, origin);
    const login = await client.request('/api/auth/login', { method: 'POST', body: { username: fixture.username, password: fixture.password } });
    if (login.status !== 200) throw new Error(`Owned benchmark sign-in failed ${login.status}`);
    client.cookie();
    return { fixture, database, backend, origin, client, proxy, serverPid: child.pid!, stop, own };
  } catch (error) {
    try { await stop(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Owned benchmark startup and cleanup failed'); }
    throw error;
  }
}
