import { closeOwnedServer } from '../scripts/close-server';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createPool } from '../src/server/db';
import { stopOwnedProcess, withShutdownDeadline } from '../scripts/owned-process';
import { testDatabase } from './database';

let database: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => { database = await testDatabase(); });
afterAll(async () => { await database?.stop(); });

it('handles an idle backend termination without an uncaught exception and reconnects for the next query', async () => {
  const script = `
    import { createPool } from './src/server/db.ts';
    import { withShutdownDeadline } from './scripts/owned-process.ts';
    let pool;
    let closing;
    const close = () => closing ??= withShutdownDeadline('Idle pool test shutdown', () => pool?.end());
    process.once('SIGTERM', () => { void close().then(() => process.exit(0), () => process.exit(1)); });
    const uncaught = [];
    const logged = [];
    process.on('uncaughtException', error => { uncaught.push(error.code ?? 'unknown'); });
    console.error = (...values) => { logged.push(values.map(value => typeof value === 'string' ? value : '<non-string>')); };
    process.once('message', async input => {
      try {
        pool = createPool(input.connectionString);
        const client = await pool.connect();
        const { rows } = await client.query('SELECT pg_backend_pid() AS pid');
        const ended = new Promise(resolve => client.once('end', resolve));
        client.release();
        process.send({ type: 'ready', pid: rows[0].pid });
        await ended;
        await new Promise(resolve => setImmediate(resolve));
        const next = await pool.query('SELECT 1 AS value, pg_backend_pid() AS pid');
        await close();
        process.send({ type: 'result', uncaught, logged, ...next.rows[0], poolEnded: pool.ended });
      } catch (error) {
        process.send({ type: 'failed', code: error.code ?? 'unknown' });
      } finally { try { await close(); } catch { process.exitCode = 1; } process.disconnect(); }
    });
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  try {
    const ready = once(child, 'message', { signal: AbortSignal.timeout(10000) });
    child.send({ connectionString: database.pool.options.connectionString });
    const [first] = await ready as [{ type: string; pid: number }];
    expect(first.type).toBe('ready');
    const finished = once(child, 'message', { signal: AbortSignal.timeout(10000) });
    const killed = await database.pool.query('SELECT pg_terminate_backend($1) AS terminated', [first.pid]);
    expect(killed.rows[0].terminated).toBe(true);
    const [result] = await finished as [{ type: string; uncaught: string[]; logged: string[][]; value: number; pid: number; poolEnded: boolean }];
    expect(result.type).toBe('result');
    expect(result.uncaught).toEqual([]);
    expect(result.logged).toEqual([['57P01']]);
    expect(result.value).toBe(1);
    expect(result.pid).not.toBe(first.pid);
    expect(result.poolEnded).toBe(true);
  } finally { await stopOwnedProcess(child, 'signal'); }
});

it('logs only the error code or a fixed safe message without exposing error or connection details', async () => {
  const pool = createPool(database.pool.options.connectionString);
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const message = `must-not-log ${database.pool.options.connectionString}`;
    expect(() => pool.emit('error', Object.assign(new Error(message), { code: '57P01' }))).not.toThrow();
    expect(log).toHaveBeenLastCalledWith('57P01');
    expect(() => pool.emit('error', new Error(message))).not.toThrow();
    expect(log).toHaveBeenLastCalledWith('Database connection error');
    expect(() => pool.emit('error', Object.assign(new Error(message), { code: message }))).not.toThrow();
    expect(log).toHaveBeenLastCalledWith('Database connection error');
    expect(() => pool.emit('error', Object.assign(new Error(message), { code: 'ECONNRESET' }))).not.toThrow();
    expect(log).toHaveBeenLastCalledWith('ECONNRESET');
    expect(log.mock.calls.flat().every(value => typeof value === 'string' && !value.includes('must-not-log') && !value.includes('postgresql://'))).toBe(true);
    log.mockImplementationOnce(() => { throw new Error('Log sink unavailable'); });
    expect(() => pool.emit('error', Object.assign(new Error(message), { code: '57P01' }))).not.toThrow();
  } finally { try { await withShutdownDeadline('Test pool shutdown', () => pool.end()); } finally { log.mockRestore(); } }
});

it.each([0, 1])('ends the local app child pool before its embedded database when the child exits %s', async childExit => {
  const directory = await mkdtemp(resolve('.cache/db-launcher-'));
  const marker = resolve(directory, 'child-stopped.json');
  const diagnostics = resolve(directory, 'launcher-exit.json');
  const server = createServer();
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as { port: number }).port;
  await closeOwnedServer(server);
  const script = `
    import { writeFile } from 'node:fs/promises';
    import { withShutdownDeadline } from ${JSON.stringify(new URL('../scripts/owned-process.ts', import.meta.url).href)};
    import { createPool } from ${JSON.stringify(new URL('../src/server/db.ts', import.meta.url).href)};
    const pool = createPool();
    await pool.query('SELECT 1');
    process.on('SIGTERM', () => { void (async () => {
      const result = await withShutdownDeadline('Test shutdown query', () => pool.query('SELECT 1 AS value'));
      await withShutdownDeadline('Test pool shutdown', () => pool.end());
      await withShutdownDeadline('Test shutdown marker', () => writeFile(${JSON.stringify(marker)}, JSON.stringify({ value: result.rows[0].value, ended: pool.ended })));
      process.exit(${childExit});
    })().catch(() => process.exit(1)); });
    console.log('APP_READY:' + process.pid);
  `;
  const launcher = `
    import { writeFileSync } from 'node:fs';
    const rejected = [];
    process.on('unhandledRejection', error => rejected.push(error instanceof Error ? error.message : 'Unknown failure'));
    process.on('exit', code => writeFileSync(${JSON.stringify(diagnostics)}, JSON.stringify({ code, rejected })));
    await import(${JSON.stringify(new URL('../scripts/db-local.ts', import.meta.url).href)});
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', launcher, 'db-local', process.execPath, '--import', 'tsx', '--input-type=module', '-e', script], { cwd: directory, env: { ...process.env, PG_LOCAL_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let appPid: number | undefined;
  let output = '';
  const ready = new Promise<void>((done, reject) => {
    child.stdout!.on('data', chunk => { output += String(chunk); const match = /APP_READY:(\d+)/.exec(output); if (match) { appPid = Number(match[1]); done(); } });
    child.once('error', reject);
    child.once('exit', () => { if (!appPid) reject(new Error('Local app exited before readiness')); });
  });
  child.stderr!.resume();
  try {
    await ready;
    const exited = once(child, 'exit', { signal: AbortSignal.timeout(10000) });
    child.kill('SIGTERM');
    const [code] = await exited;
    expect(JSON.parse(await readFile(diagnostics, 'utf8'))).toEqual({ code: childExit, rejected: [] });
    expect(code).toBe(childExit);
    expect(JSON.parse(await readFile(marker, 'utf8'))).toEqual({ value: 1, ended: true });
  } finally {
    try {
      if (child.exitCode === null && child.signalCode === null) await stopOwnedProcess(child, 'signal');
    } finally {
      try {
        if (appPid) {
          try { process.kill(appPid, 'SIGTERM'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
          try { await vi.waitFor(() => { try { process.kill(appPid!, 0); throw new Error('Owned app has not stopped'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } }, { timeout: 3000 }); }
          catch (error) { try { process.kill(appPid, 'SIGKILL'); } catch (killError) { if ((killError as NodeJS.ErrnoException).code !== 'ESRCH') throw killError; } throw error; }
        }
      } finally { await withShutdownDeadline('Test directory cleanup', () => rm(directory, { recursive: true, force: true })); }
    }
  }
});

it('ends a live migration pool before PostgreSQL when local startup is cancelled', async () => {
  const directory = await mkdtemp(resolve('.cache/db-launcher-'));
  const marker = resolve(directory, 'migration-ended.json');
  const server = createServer();
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as { port: number }).port;
  await closeOwnedServer(server);
  const script = `
    import pg from 'pg';
    import { writeFile } from 'node:fs/promises';
    import { withShutdownDeadline } from ${JSON.stringify(new URL('../scripts/owned-process.ts', import.meta.url).href)};
    let release;
    const held = new Promise(done => { release = done; });
    process.on('message', message => { if (message === 'continue') release(); });
    process.on('SIGTERM', () => process.send({ type: 'cancelled' }));
    const Pool = pg.Pool;
    let first = true;
    pg.Pool = class extends Pool {
      connect(...args) {
        if (args.length) return super.connect(...args);
        return (async () => {
          const client = await super.connect();
          if (first) { first = false; process.send({ type: 'migration' }); await held; }
          return client;
        })();
      }
      async end() {
        const result = await withShutdownDeadline('Test shutdown query', () => this.query('SELECT 1 AS value'));
        await withShutdownDeadline('Test pool shutdown', () => super.end());
        await withShutdownDeadline('Test shutdown marker', () => writeFile(${JSON.stringify(marker)}, JSON.stringify({ value: result.rows[0].value, ended: this.ended })));
      }
    };
    await import(${JSON.stringify(new URL('../scripts/db-local.ts', import.meta.url).href)});
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: directory, env: { ...process.env, PG_LOCAL_PORT: String(port) }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  try {
    const [ready] = await once(child, 'message', { signal: AbortSignal.timeout(10000) }) as [{ type: string }];
    expect(ready.type).toBe('migration');
    const cancelled = once(child, 'message', { signal: AbortSignal.timeout(10000) });
    const exited = once(child, 'exit', { signal: AbortSignal.timeout(10000) });
    child.kill('SIGTERM');
    expect((await cancelled)[0]).toEqual({ type: 'cancelled' });
    child.send('continue');
    expect((await exited)[0]).toBe(0);
    expect(JSON.parse(await readFile(marker, 'utf8'))).toEqual({ value: 1, ended: true });
  } finally {
    try {
      if (child.connected) child.send('continue', () => {});
      if (child.exitCode === null && child.signalCode === null) await stopOwnedProcess(child, 'signal');
    } finally { await withShutdownDeadline('Test directory cleanup', () => rm(directory, { recursive: true, force: true })); }
  }
});
