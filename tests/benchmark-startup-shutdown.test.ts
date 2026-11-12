import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';
import { SHUTDOWN_GRACE_MS, stopOwnedProcess, withShutdownDeadline } from '../scripts/owned-process';

const strip = async (path: string) => stripTypeScriptTypes(await readFile(new URL(path, import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
afterEach(() => { vi.useRealTimers(); });

it('releases a cancelled benchmark startup and closes a database acquired afterwards', async () => {
  const source = await strip('../scripts/bench/stack.ts');
  let acquire!: (database: unknown) => void;
  const pending = new Promise(resolve => { acquire = resolve; });
  const events: string[] = [];
  const benchmarkStack = new Function('testDatabase', 'withShutdownDeadline', 'stopOwnedProcess', `${source};return benchmarkStack;`)(() => pending, withShutdownDeadline, stopOwnedProcess);
  const controller = new AbortController();
  const result = benchmarkStack('fixture', controller.signal).then(() => ({ rejected: false }), () => ({ rejected: true }));
  await Promise.resolve();
  controller.abort();
  expect(await result).toEqual({ rejected: true });
  acquire({ stop: async () => { events.push('database-stop'); throw new Error('Late database close failed'); } });
  await new Promise(resolve => setImmediate(resolve));
  expect(events).toEqual(['database-stop']);
});

it('stops an acquired database and TLS when benchmark seeding never settles', async () => {
  const source = await strip('../scripts/bench/stack.ts');
  const events: string[] = [];
  let seeded!: () => void;
  const seeding = new Promise<void>(resolve => { seeded = resolve; });
  const fixtures = {
    testDatabase: async () => ({ stop: async () => { events.push('database-stop'); }, pool: {} }),
    withShutdownDeadline, stopOwnedProcess,
    mkdtemp: async () => '/owned-tls',
    resolve: (path: string) => path,
    join: (...paths: string[]) => paths.join('/'),
    rm: async (path: string) => { events.push(`remove:${path}`); },
    createWriteStream: () => {
      const log = Object.assign(new EventEmitter(), { destroyed: false, end: (callback: () => void) => { events.push('log-end'); callback(); } });
      setImmediate(() => log.emit('open'));
      return log;
    },
    seedBenchmark: () => { seeded(); return new Promise(() => {}); },
  };
  const benchmarkStack = new Function(...Object.keys(fixtures), `${source};return benchmarkStack;`)(...Object.values(fixtures));
  const controller = new AbortController();
  const result = benchmarkStack('fixture', controller.signal).then(() => ({ rejected: false }), () => ({ rejected: true }));
  await seeding;
  controller.abort();
  expect(await result).toEqual({ rejected: true });
  expect(events).toEqual(['database-stop', 'remove:/owned-tls', 'log-end']);
});

it('settles the benchmark controller main and signal cleanup when startup never resolves', async () => {
  const source = await strip('../scripts/bench.ts');
  const start = source.indexOf('let engine');
  const end = source.indexOf('\nconst handlers =');
  if (start < 0 || end < 0) throw new Error('Benchmark controller lifecycle source was not found');
  const process = { exitCode: 0 };
  const lifecycle = new Function('withShutdownDeadline', 'process', `${source.slice(start, end)};stackTask=new Promise(()=>{});return {running,stopForSignal,signal:()=>signalStop,error:()=>signalCleanupError};`)(withShutdownDeadline, process);
  vi.useFakeTimers();
  const main = lifecycle.running(() => new Promise(() => {})).then(() => ({ rejected: false }), () => ({ rejected: true }));
  lifecycle.stopForSignal('SIGTERM');
  expect(await main).toEqual({ rejected: true });
  await vi.advanceTimersByTimeAsync(SHUTDOWN_GRACE_MS);
  await lifecycle.signal();
  expect(lifecycle.error()).toBeInstanceOf(Error);
  expect(process.exitCode).toBe(143);
});
