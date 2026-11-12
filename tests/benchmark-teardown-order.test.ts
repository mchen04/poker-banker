import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { expect, it } from 'vitest';
import { stopOwnedProcess, withShutdownDeadline } from '../scripts/owned-process';

const strip = async (path: string) => stripTypeScriptTypes(await readFile(new URL(path, import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
const alive = (child: ChildProcess) => {
  try { process.kill(child.pid!, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
};

for (const stalled of [true, false]) it(`finishes browser termination before database cleanup and stack settlement when browser closes ${stalled ? 'stall' : 'succeed'}`, async () => {
  const child = spawn(process.execPath, ['-e', `${stalled ? 'process.on("SIGTERM",()=>{});' : ''}console.log("ready");setInterval(()=>{},1000);`], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let main: Promise<unknown> | undefined;
  try {
    await once(child.stdout!, 'data', { signal: AbortSignal.timeout(5000) });
    const source = await strip('../scripts/bench/stack.ts');
    const start = source.indexOf('  let database');
    const end = source.indexOf('\n  try {\n    database =');
    if (start < 0 || end < 0) throw new Error('Benchmark lifecycle source was not found');
    const databaseChildAlive: boolean[] = [];
    const stack = new Function('withShutdownDeadline', 'stopOwnedProcess', 'fixtures', `${source.slice(start, end)};database=fixtures.database;return {own,stop};`)(withShutdownDeadline, stopOwnedProcess, { database: { stop: async () => { databaseChildAlive.push(alive(child)); } } });
    stack.fixture = { sessionId: 'fixture' };
    stack.client = { request: async () => { throw new Error('initial request failed'); } };
    let closing!: () => void;
    const startedClosing = new Promise<void>(resolve => { closing = resolve; });
    let browserCloses = 0;
    let serverCloses = 0;
    const close = () => stalled ? new Promise<void>(() => {}) : Promise.resolve();
    const browser = { close: () => { browserCloses++; closing(); return close(); } };
    const server = { wsEndpoint: () => 'fixture', process: () => child, close: () => { serverCloses++; return close(); } };
    class CpuBudget { async pause() {} }
    const browserSource = await strip('../scripts/bench/browser.ts');
    const benchmarkBrowser = new Function('webkit', 'CpuBudget', `${browserSource};return benchmarkBrowser;`)({ launchServer: async () => server, connect: async () => browser }, CpuBudget);
    main = benchmarkBrowser(stack, {}, 'fixture', () => {}, { samples: 1, reverse: false, phase() {} }).then(() => ({ rejected: false }), () => ({ rejected: true }));
    await startedClosing;
    const stopped = await Promise.allSettled([stack.stop(), stack.stop()]);
    expect({ childAliveAtSettlement: alive(child), databaseChildAlive }).toEqual({ childAliveAtSettlement: false, databaseChildAlive: [false] });
    expect(stopped.map(result => result.status)).toEqual(stalled ? ['rejected', 'rejected'] : ['fulfilled', 'fulfilled']);
    expect(await main).toEqual({ rejected: true });
    expect(browserCloses).toBe(1);
    expect(serverCloses).toBe(1);
    expect(child.signalCode).toBe(stalled ? 'SIGKILL' : 'SIGTERM');
  } finally {
    if (alive(child)) {
      const exited = once(child, 'exit');
      process.kill(-child.pid!, 'SIGKILL');
      await withShutdownDeadline('Ordered browser regression cleanup', () => exited);
    }
    await main;
  }
});
