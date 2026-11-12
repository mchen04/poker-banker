import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { expect, it } from 'vitest';
import { stopOwnedProcess, withShutdownDeadline } from '../scripts/owned-process';

function alive(child: ChildProcess) {
  try { process.kill(child.pid!, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}

async function launch(ignores: boolean) {
  const script = `process.on('SIGTERM',()=>${ignores ? '{}' : 'process.exit(0)'});process.on('message',m=>{if(m?.type==='pb-shutdown')process.exit(0)});console.log('ready');setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['-e', script], { detached: true, stdio: ['ignore', 'pipe', 'ignore', 'ipc'] });
  try { await once(child.stdout!, 'data', { signal: AbortSignal.timeout(5000) }); }
  catch (error) { await stopOwnedProcess(child, 'signal', true).catch(() => {}); throw error; }
  return child;
}

for (const hangs of [false, true]) it(`terminates the verification browser before its database owner when close hangs=${hangs}`, async () => {
  const browserChild = await launch(hangs);
  let app: ChildProcess | undefined;
  try {
    app = await launch(false);
    const databaseObservations: boolean[] = [];
    const original = await readFile(new URL('../.claude/skills/verify-poker-banker/scripts/control.ts', import.meta.url), 'utf8');
    const source = stripTypeScriptTypes(original);
    const begin = source.indexOf('  const closeBrowser = ');
    const end = source.indexOf('\n  const starting = ', begin);
    const cleanupBegin = source.indexOf('  function cleanup()');
    const cleanupEnd = source.indexOf('\n  async function contextPage(', cleanupBegin);
    if ([begin, end, cleanupBegin, cleanupEnd].some(index => index < 0)) throw new Error('Verification cleanup source was not found');
    const fixtures = {
      browser: { close: async () => {} },
      browserServer: { close: () => hangs ? new Promise<void>(() => {}) : stopOwnedProcess(browserChild, 'signal', true), process: () => browserChild },
      child: app, startupTask: Promise.resolve(), withShutdownDeadline,
      stopOwnedProcess: (owned: ChildProcess, mode: 'signal' | 'ipc', group: boolean) => {
        if (owned === app) databaseObservations.push(alive(browserChild));
        else if (owned !== browserChild) throw new Error('Unexpected owner');
        return stopOwnedProcess(owned, mode, group);
      },
      meta: { state: 'ready' }, files: async () => [], json: async () => {}, manifest: async () => {},
      evidence: 'fixture', runId: 'ordered-fixture', socket: 'fixture.sock', metadata: 'fixture.json',
      join: (...parts: string[]) => parts.join('/'), rm: async () => {}, server: { close() {} }, process,
    };
    const cleanup = new Function(...Object.keys(fixtures), `let stopping=false,cleanupTask,browserClosing;${source.slice(begin, end)}\n${source.slice(cleanupBegin, cleanupEnd)};return cleanup;`)(...Object.values(fixtures)) as () => Promise<void>;
    const result = await cleanup().then(() => undefined, error => error as Error);
    expect(alive(browserChild)).toBe(false);
    expect(databaseObservations.length).toBeGreaterThan(0);
    expect(databaseObservations.every(value => value === false)).toBe(true);
    expect(Boolean(result)).toBe(hangs);
  } finally {
    if (app) await stopOwnedProcess(app, 'ipc', true).catch(() => {});
    await stopOwnedProcess(browserChild, 'signal', true).catch(() => {});
  }
}, 20000);
