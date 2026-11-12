import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { join, relative, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { stopOwnedProcess, withShutdownDeadline } from '../scripts/owned-process';

it('settles an interrupted comparison when its owned benchmark child ignores shutdown', async () => {
  const source = stripTypeScriptTypes(await readFile(new URL('../scripts/bench-compare.ts', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
  const owner = Object.assign(new EventEmitter(), { argv: ['node', 'compare', 'shutdown-fixture', '.', '.', 'api.players'], execPath: process.execPath, exitCode: 0 });
  let child: ChildProcess | undefined;
  let ready!: () => void;
  const started = new Promise<void>(done => { ready = done; });
  const fixtures = {
    assert, process: owner, resolve, join, relative, stopOwnedProcess, withShutdownDeadline,
    mkdir: async () => {}, cp: async () => {}, writeFile: async () => {},
    readFile: async () => { throw new Error('Unexpected measurement after interruption'); },
    summarize: () => [], console: { log() {}, error() {} },
    spawn: () => {
      child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
      void once(child.stdout!, 'data', { signal: AbortSignal.timeout(3000) }).then(() => ready(), () => ready());
      return child;
    },
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  let settled = false;
  let failed = false;
  const main = new AsyncFunction(...Object.keys(fixtures), source)(...Object.values(fixtures)).then(() => { settled = true; }, () => { settled = true; failed = true; });
  try {
    await withShutdownDeadline('Comparison fixture readiness', () => started);
    owner.emit('SIGTERM');
    owner.emit('SIGINT');
    await new Promise(done => setTimeout(done, 3400));
    expect(settled).toBe(true);
    expect(failed || owner.exitCode !== 0).toBe(true);
    expect(child!.signalCode).toBe('SIGKILL');
    expect(owner.exitCode).toBe(143);
    expect(owner.listenerCount('SIGTERM')).toBe(0);
    expect(owner.listenerCount('SIGINT')).toBe(0);
    expect(owner.listenerCount('SIGHUP')).toBe(0);
  } finally {
    if (child) await stopOwnedProcess(child, 'signal', true).catch(() => {});
    await withShutdownDeadline('Comparison fixture settlement', () => main);
  }
}, 12000);
