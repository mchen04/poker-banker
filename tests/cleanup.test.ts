import { closeOwnedServer } from '../scripts/close-server';
import { spawn } from './processes';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { testDatabase } from './database';
import { stopOwnedProcess, withShutdownDeadline } from '../scripts/owned-process';

await mkdir('.cache', { recursive: true });
const marker = await mkdtemp(resolve('.cache/pg-sentinel-'));
await writeFile(`${marker}/keep.txt`, 'another run');
afterAll(async () => { await withShutdownDeadline('Test directory cleanup', () => rm(marker, { recursive: true, force: true })); });
async function scratch() { return (await readdir(resolve('.cache'))).filter(name => /^(pg-|e2e-tls-)/.test(name)).sort(); }
async function exists(path: string) { try { await access(path); return true; } catch { return false; } }
async function availablePort() {
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await closeOwnedServer(server); return port;
}
function exited(child: ChildProcess) { return child.exitCode !== null || child.signalCode !== null ? Promise.resolve(child.exitCode) : once(child, 'exit', { signal: AbortSignal.timeout(10000) }).then(([code]) => code as number | null); }
async function ready(child: ChildProcess, output: () => string, signal: AbortSignal) {
  const stopped = new AbortController();
  const onExit = () => stopped.abort(new Error('Owned server exited before readiness'));
  child.once('exit', onExit);
  try {
    if (child.exitCode !== null || child.signalCode !== null) onExit();
    const current = AbortSignal.any([signal, stopped.signal]);
    while (!output().includes('Poker banker ready at')) await once(child.stdout!, 'data', { signal: current });
  } finally { child.removeListener('exit', onExit); }
}
it('removes exactly its database directory after concurrent stops while keeping another run intact', async () => {
  const before = await scratch();
  const database = await testDatabase();
  expect((await database.pool.query('SELECT 7 AS value')).rows[0]!.value).toBe(7);
  expect(await exists(database.directory)).toBe(true);
  await Promise.all([database.stop(), database.stop()]);
  await database.stop();
  expect(await exists(database.directory)).toBe(false);
  expect(await scratch()).toEqual(before);
  expect(await readFile(`${marker}/keep.txt`, 'utf8')).toBe('another run');
});
it('removes its directory when PostgreSQL cannot start', async () => {
  const before = await scratch();
  await expect(testDatabase({ postgresFlags: ['-c', 'missing_owned_setting=1'] })).rejects.toThrow();
  expect(await scratch()).toEqual(before);
});
it('removes its database on migration failure without touching the caller-owned migration files', async () => {
  const directory = await mkdtemp(resolve('.cache/migrations-'));
  const before = await scratch();
  try {
    await writeFile(`${directory}/0001_bad.sql`, 'SELECT * FROM absent_cleanup_table');
    await expect(testDatabase({ migrationDirectory: directory })).rejects.toThrow();
    expect(await scratch()).toEqual(before);
    expect(await readFile(`${directory}/0001_bad.sql`, 'utf8')).toBe('SELECT * FROM absent_cleanup_table');
  } finally { await withShutdownDeadline('Test directory cleanup', () => rm(directory, { recursive: true, force: true })); }
});
for (const method of ['ipc', 'signal', 'startup'] as const) it(`cleans database and TLS scratch on ${method} server shutdown`, async ({ signal }) => {
  const before = await scratch();
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/e2e-server.ts'], { env: { ...process.env, PORT: String(await availablePort()) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = '';
  child.stdout!.on('data', chunk => { output += String(chunk); });
  child.stderr!.on('data', chunk => { output += String(chunk); });
  try {
    if (method === 'startup') {
      await expect.poll(async () => (await scratch()).filter(name => !before.includes(name)).length).toBeGreaterThan(0);
      await stopOwnedProcess(child);
    } else {
      await ready(child, () => output, signal);
      if (method === 'signal') {
        const done = exited(child); child.kill('SIGTERM'); expect(await done).toBe(0);
      } else await stopOwnedProcess(child);
    }
    expect(output).not.toContain('terminating connection due to administrator command');
    expect(await scratch()).toEqual(before);
  } finally { if (child.exitCode === null && child.signalCode === null) await stopOwnedProcess(child); }
});
it('cleans database and TLS scratch when the HTTP listener cannot start', async () => {
  const before = await scratch(); const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/e2e-server.ts'], { env: { ...process.env, PORT: String((server.address() as { port: number }).port) }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  try { expect(await exited(child)).toBe(1); expect(await scratch()).toEqual(before); }
  finally { try { await closeOwnedServer(server); } finally { if (child.exitCode === null && child.signalCode === null) await stopOwnedProcess(child); } }
});

it('removes its database after its owning process exits without calling stop', async () => {
  const before = await scratch();
  const script = "const {testDatabase}=await import('./tests/database.ts'); const database=await testDatabase(); process.send({directory:database.directory}); process.exit(17);";
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const done = exited(child);
  const directory = await new Promise<string>((resolve, reject) => { child.once('error', reject); child.once('message', message => { if (message && typeof message === 'object' && 'directory' in message) resolve(String(message.directory)); else reject(new Error('Owned process did not return its directory')); }); });
  expect(await done).toBe(17);
  await expect.poll(() => exists(directory)).toBe(false);
  expect(await scratch()).toEqual(before);
});

it('reports a failed spawn without waiting for an exit event that cannot arrive', async () => {
  const child = spawn(`${marker}/missing-owned-process`, [], { stdio: 'ignore' });
  await new Promise<void>(resolve => child.once('error', () => resolve()));
  await expect(stopOwnedProcess(child)).rejects.toThrow('ENOENT');
});

it('removes a database when its owner exits during startup before readiness', async () => {
  const before = await scratch();
  const script = "process.on('message',message=>{if(message==='exit')process.exit(17)}); const {testDatabase}=await import('./tests/database.ts'); await testDatabase(); process.send('ready');";
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const done = exited(child); let ready = false;
  child.on('message', message => { if (message === 'ready') ready = true; });
  try {
    await expect.poll(async () => (await scratch()).filter(name => !before.includes(name)).length).toBeGreaterThan(0);
    expect(ready).toBe(false);
    child.send('exit');
    expect(await done).toBe(17);
    await expect.poll(scratch).toEqual(before);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.send('exit');
    await done;
    await expect.poll(scratch).toEqual(before);
  }
});

it('accepts requested termination before a handler is installed but rejects unrelated failed exits', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  await stopOwnedProcess(child);
  expect(child.signalCode).toBe('SIGTERM');
  const failed = spawn(process.execPath, ['-e', 'process.exit(17)'], { stdio: 'ignore' });
  await exited(failed);
  await expect(stopOwnedProcess(failed)).rejects.toThrow('Owned process exited 17');
});
