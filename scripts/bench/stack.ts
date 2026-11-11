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
async function availablePort() {
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No local benchmark port');
  await new Promise<void>(resolve => server.close(() => resolve())); return address.port;
}
export async function benchmarkStack(output: string, cpuProfile = false) {
  const database = await testDatabase();
  const directory = await mkdtemp(resolve('.cache/bench-tls-'));
  let child: ChildProcess | undefined;
  let proxy: ShapedProxy | undefined;
  let listener: ReturnType<typeof createHttpsServer> | undefined;
  let client: LocalClient | undefined;
  const log = createWriteStream(join(output, 'server.log'), { flags: 'a' });
  async function stop() {
    client?.close(); proxy?.close();
    if (listener) { listener.closeAllConnections(); await new Promise<void>(resolve => listener!.close(() => resolve())); }
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => child!.once('exit', () => resolve())); process.kill(-child.pid, 'SIGTERM'); await exited;
    }
    await database.stop(); await rm(directory, { recursive: true, force: true }); log.end();
  }
  try {
    const fixture = await seedBenchmark(database.pool);
    const key = join(directory, 'key.pem'), certificate = join(directory, 'cert.pem');
    const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-keyout', key, '-out', certificate], { stdio: 'ignore' });
    if (generated.status !== 0) throw new Error('Owned benchmark TLS certificate failed');
    const port = await availablePort(); const backend = `https://127.0.0.1:${port}`;
    proxy = new ShapedProxy(backend);
    listener = createHttpsServer({ key: await readFile(key), cert: await readFile(certificate) }, proxy.handle);
    await new Promise<void>(resolve => listener!.listen(0, '127.0.0.1', resolve));
    const address = listener.address(); if (!address || typeof address === 'string') throw new Error('No shaping port');
    const origin = `https://127.0.0.1:${address.port}`;
    child = spawn(cpuProfile ? process.execPath : 'pnpm', cpuProfile ? ['--cpu-prof', `--cpu-prof-dir=${output}`, '--import', 'tsx', 'src/server/local.ts'] : ['start:local'], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_ENV: 'production', PORT: String(port), DATABASE_URL: database.pool.options.connectionString, APP_ORIGIN: origin, LOCAL_TLS_KEY: key, LOCAL_TLS_CERT: certificate, PB_BENCHMARK_TIMING: '1' } });
    await new Promise<void>((resolve, reject) => {
      let text = ''; const timeout = setTimeout(() => reject(new Error('Owned benchmark server startup timed out')), 30000);
      child!.stdout!.on('data', chunk => { log.write(chunk); text += String(chunk); if (text.includes('Poker banker ready at')) { clearTimeout(timeout); resolve(); } });
      child!.stderr!.on('data', chunk => log.write(chunk));
      child!.once('error', reject); child!.once('exit', code => { clearTimeout(timeout); reject(new Error(`Owned benchmark server exited ${code}`)); });
    });
    client = new LocalClient(backend, origin);
    const login = await client.request('/api/auth/login', { method: 'POST', body: { username: fixture.username, password: fixture.password } });
    if (login.status !== 200) throw new Error(`Owned benchmark sign-in failed ${login.status}`);
    client.cookie();
    return { fixture, database, backend, origin, client, proxy, serverPid: child.pid!, stop };
  } catch (error) { await stop(); throw error; }
}
