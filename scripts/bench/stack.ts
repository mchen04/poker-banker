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
import { SHUTDOWN_GRACE_MS, stopOwnedProcess, withShutdownDeadline } from '../owned-process';
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
export async function benchmarkStack(output: string, signal?: AbortSignal) {
  let database: Awaited<ReturnType<typeof testDatabase>> | undefined;
  let directory: string | undefined;
  let child: ChildProcess | undefined;
  let proxy: ShapedProxy | undefined;
  let listener: ReturnType<typeof createHttpsServer> | undefined;
  let client: LocalClient | undefined;
  let log: ReturnType<typeof createWriteStream> | undefined;
  let stopping: Promise<void> | undefined;
  const lifecycleSignal = typeof signal === 'undefined' ? undefined : signal;
  let rejectStartup!: (error: Error) => void;
  const startupStopped = new Promise<never>((_, reject) => { rejectStartup = reject; });
  void startupStopped.catch(() => {});
  async function starting<T>(action: () => Promise<T>, cleanup?: (value: T) => Promise<unknown>): Promise<T> {
    if (stopping || lifecycleSignal?.aborted) throw new Error('Owned benchmark startup was stopped');
    const task = Promise.resolve().then(() => {
      if (stopping || lifecycleSignal?.aborted) throw new Error('Owned benchmark startup was stopped');
      return action();
    }).then(async value => {
      if (stopping || lifecycleSignal?.aborted) {
        if (cleanup) await cleanup(value);
        throw new Error('Owned benchmark startup was stopped');
      }
      return value;
    });
    return Promise.race([task, startupStopped]);
  }
  const owned = new Map<() => Promise<void>, boolean>();
  async function own(cleanup: () => Promise<void>, options: { selfBounded?: boolean } = {}) {
    if (stopping) { await (options.selfBounded ? cleanup() : withShutdownDeadline('Late benchmark cleanup', cleanup)); throw new Error('Owned benchmark stack is stopping'); }
    owned.set(cleanup, options.selfBounded ?? false);
    return () => { owned.delete(cleanup); };
  }
  own.withDeadline = withShutdownDeadline;
  own.stopProcess = stopOwnedProcess;
  function stop(): Promise<void> {
    stopping ??= (async () => {
      rejectStartup(new Error('Owned benchmark startup was stopped'));
      const errors: unknown[] = [];
      const attempt = async (action: () => unknown | Promise<unknown>) => { try { await action(); } catch (error) { errors.push(error); } };
      const bounded = (label: string, action: () => unknown | Promise<unknown>) => attempt(() => withShutdownDeadline(label, action));
      for (const [cleanup, selfBounded] of owned) await (selfBounded ? attempt(cleanup) : bounded('Owned benchmark action cleanup', cleanup));
      owned.clear();
      await bounded('Benchmark client close', () => client?.close());
      await bounded('Benchmark proxy close', () => proxy?.close());
      await bounded('Benchmark listener close', async () => { if (listener?.listening) { listener.closeAllConnections(); await new Promise<void>((resolve, reject) => listener!.close(error => error ? reject(error) : resolve())); } });
      await attempt(async () => { if (child) await stopOwnedProcess(child, 'signal', true); });
      await attempt(async () => { await database?.stop(); });
      await bounded('Benchmark TLS removal', async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
      await bounded('Benchmark log close', async () => { if (log && !log.destroyed) await new Promise<void>((resolve, reject) => { log!.once('error', reject); log!.end(resolve); }); });
      lifecycleSignal?.removeEventListener('abort', abort);
      if (errors.length) throw new AggregateError(errors, 'Owned benchmark cleanup failed');
    })();
    return stopping;
  }
  const abort = () => { void stop().catch(() => {}); };
  lifecycleSignal?.addEventListener('abort', abort, { once: true });
  try {
    database = await starting(() => testDatabase(), value => value.stop());
    directory = await starting(() => mkdtemp(resolve('.cache/bench-tls-')), value => withShutdownDeadline('Late benchmark TLS removal', () => rm(value, { recursive: true, force: true })));
    log = createWriteStream(join(output, 'server.log'), { flags: 'a' });
    await starting(() => new Promise<void>((resolve, reject) => { log!.once('open', () => resolve()); log!.once('error', reject); }));
    const fixture = await starting(() => seedBenchmark(database!.pool));
    const key = join(directory, 'key.pem'), certificate = join(directory, 'cert.pem');
    const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-keyout', key, '-out', certificate], { stdio: 'ignore', timeout: SHUTDOWN_GRACE_MS, killSignal: 'SIGKILL' });
    if (generated.status !== 0) throw new Error('Owned benchmark TLS certificate failed');
    const port = await starting(availablePort); const backend = `https://127.0.0.1:${port}`;
    proxy = new ShapedProxy(backend);
    listener = createHttpsServer({ key: await starting(() => readFile(key)), cert: await starting(() => readFile(certificate)) }, proxy.handle);
    await starting(() => new Promise<void>((resolve, reject) => { listener!.once('error', reject); listener!.listen(0, '127.0.0.1', resolve); }), () => withShutdownDeadline('Late benchmark listener close', () => new Promise<void>((resolve, reject) => listener!.close(error => error ? reject(error) : resolve()))));
    const address = listener.address(); if (!address || typeof address === 'string') throw new Error('No shaping port');
    const origin = `https://127.0.0.1:${address.port}`;
    child = spawn(process.execPath, ['--import', 'tsx', 'src/server/local.ts'], { detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, NODE_ENV: 'production', PORT: String(port), DATABASE_URL: database.pool.options.connectionString, APP_ORIGIN: origin, LOCAL_TLS_KEY: key, LOCAL_TLS_CERT: certificate, PB_BENCHMARK_TIMING: '1' } });
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
    return { fixture, database, backend, origin, client, proxy, serverPid: child.pid!, stop, own };
  } catch (error) {
    try { await stop(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Owned benchmark startup and cleanup failed'); }
    throw error;
  }
}
