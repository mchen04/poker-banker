import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import EmbeddedPostgres from 'embedded-postgres';
import { expect, it } from 'vitest';
import { stopOwnedProcess, withShutdownDeadline } from '../scripts/owned-process';

const strip = async (path: string) => stripTypeScriptTypes(await readFile(new URL(path, import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
const alive = (child: ChildProcess) => {
  try { process.kill(child.pid!, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
};
async function reap(child: ChildProcess) {
  if (!alive(child)) return;
  const exited = once(child, 'exit');
  process.kill(-child.pid!, 'SIGKILL');
  await withShutdownDeadline('Tooling regression child exit', () => exited);
}

it('finishes stack termination before signal cleanup permits engine removal', async () => {
  const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});console.log("ready");setInterval(()=>{},1000)'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let ownerStop: Promise<void> | undefined;
  try {
    await once(child.stdout!, 'data', { signal: AbortSignal.timeout(5000) });
    const source = await strip('../scripts/bench.ts');
    const start = source.indexOf('const stopForSignal =');
    const end = source.indexOf('\nconst checkInterrupted =', start);
    if (start < 0 || end < 0) throw new Error('Benchmark signal cleanup source was not found');
    const stackTask = new Promise(resolve => setTimeout(() => resolve({ stop: () => ownerStop ??= stopOwnedProcess(child, 'signal', true) }), 200));
    const lifecycle = new Function('withShutdownDeadline', 'stackTask', `let interrupted,signalCleanupError,signalStop=Promise.resolve();const process={exitCode:0};const interruptionController={abort(){}};${source.slice(start, end)};return {stopForSignal,signalStop:()=>signalStop,error:()=>signalCleanupError};`)(withShutdownDeadline, stackTask);
    lifecycle.stopForSignal('SIGTERM');
    await lifecycle.signalStop();
    expect({ ownerAliveAtEngineCleanup: alive(child) }).toEqual({ ownerAliveAtEngineCleanup: false });
    expect(lifecycle.error()).toBeInstanceOf(Error);
    expect(child.signalCode).toBe('SIGKILL');
  } finally {
    await reap(child);
    await ownerStop?.catch(() => {});
  }
});

it('finishes the installed PostgreSQL owner before local database shutdown exits after its deadline', async () => {
  const child = spawn(process.execPath, ['-e', 'process.on("SIGINT",()=>{});console.log("ready");setInterval(()=>{},1000)'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    await once(child.stdout!, 'data', { signal: AbortSignal.timeout(5000) });
    const database = Object.create(EmbeddedPostgres.prototype) as EmbeddedPostgres;
    Reflect.set(database, 'process', child);
    Reflect.set(database, 'options', { persistent: true });
    const source = await strip('../scripts/db-local.ts');
    const start = source.indexOf('function stop()');
    const end = source.indexOf('\ndatabase.stop = stop;', start);
    if (start < 0 || end < 0) throw new Error('Local database shutdown source was not found');
    const exits: { code: number; ownerAlive: boolean }[] = [];
    const errors: string[] = [];
    const fakeProcess = { exitCode: 0, exit: (code: number) => { exits.push({ code, ownerAlive: alive(child) }); } };
    const lifecycle = new Function('stopOwnedProcess', 'stopDatabase', 'database', 'process', 'errors', `let requested=false,stopping,exitCode=0;const startup=Promise.resolve();const child=undefined;const endPool=()=>Promise.resolve();function fail(message){exitCode=1;process.exitCode=1;errors.push(message);}${source.slice(start, end)};return {stop,finish};`)(stopOwnedProcess, database.stop.bind(database), database, fakeProcess, errors);
    lifecycle.finish(0);
    await lifecycle.stop();
    await Promise.resolve();
    expect(exits).toEqual([{ code: 1, ownerAlive: false }]);
    expect(errors).toContain('Local database shutdown failed');
    expect(child.signalCode).toBe('SIGKILL');
  } finally {
    await reap(child);
  }
});
