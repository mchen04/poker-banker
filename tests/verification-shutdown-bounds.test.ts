import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { SHUTDOWN_GRACE_MS, withShutdownDeadline } from '../scripts/owned-process';

type Phase = 'healthy' | 'browser' | 'browser-server' | 'startup' | 'write' | 'manifest';
type Result = {
  events: string[];
  rejected: string[];
  outcomes: string[];
  failure?: string;
  metadataPreserved: boolean;
  metadataUnchanged: boolean;
  socketPreserved: boolean;
  proofsPreserved: boolean;
  cleanupProofCount?: number;
  elapsed: number;
};

async function probe(phase: Phase): Promise<Result> {
  const paths = {
    helper: fileURLToPath(new URL('../scripts/owned-process.ts', import.meta.url)),
    control: fileURLToPath(new URL('../.claude/skills/verify-poker-banker/scripts/control.ts', import.meta.url)),
  };
  const script = `
    import { readFile, writeFile, mkdir, mkdtemp, readdir, rm, access } from 'node:fs/promises';
    import { resolve, join } from 'node:path';
    import { stripTypeScriptTypes } from 'node:module';
    import { EventEmitter } from 'node:events';
    const paths = ${JSON.stringify(paths)};
    const phase = ${JSON.stringify(phase)};
    const strip = async path => stripTypeScriptTypes(await readFile(path, 'utf8'));
    const helper = (await strip(paths.helper)).replace(/^import .*;\\n/gm, '').replace(/^export /gm, '');
    const { withShutdownDeadline, stopOwnedProcess } = new Function(helper + '; return { withShutdownDeadline, stopOwnedProcess };')();
    const source = await strip(paths.control);
    const closeStart = source.indexOf('  const closeBrowser = ');
    const closeEnd = source.indexOf('\\n  const starting = ', closeStart);
    const cleanupStart = source.indexOf('  function cleanup()');
    const cleanupEnd = source.indexOf('\\n  async function contextPage(', cleanupStart);
    if ([closeStart, closeEnd, cleanupStart, cleanupEnd].some(index => index < 0)) throw new Error('Verification cleanup source was not found');
    const events = [], rejected = [];
    process.on('unhandledRejection', error => rejected.push(String(error)));
    const hang = () => new Promise(() => {});
    await mkdir('.cache', { recursive: true });
    const directory = await mkdtemp(resolve('.cache/verification-cleanup-'));
    try {
      const runId = 'verification-cleanup-fixture';
      const evidence = join(directory, 'evidence');
      const metadata = join(directory, 'run.json');
      const socket = join(directory, 'control.sock');
      await mkdir(evidence);
      const proofs = [['workspace.png', 'proof-image'], ['launch-result.json', '{"ready":true}']];
      for (const [name, content] of proofs) await writeFile(join(evidence, name), content);
      const meta = { runId, pid: process.pid, listenerPid: 12345, local: true, state: 'ready' };
      const initialMeta = JSON.stringify(meta);
      await writeFile(metadata, initialMeta);
      await writeFile(socket, 'owned-listener');
      const child = Object.assign(new EventEmitter(), {
        pid: 12345, exitCode: null, signalCode: null, connected: true,
        send() {
          events.push('child-stop');
          queueMicrotask(() => { child.exitCode = 0; child.emit('exit', 0, null); });
        },
        kill() { throw new Error('Unexpected fixture signal'); },
      });
      const browserOwner = Object.assign(new EventEmitter(), {
        pid: 12346, exitCode: null, signalCode: null, connected: false,
        kill(signal) {
          queueMicrotask(() => { browserOwner.signalCode = signal; browserOwner.emit('exit', null, signal); });
          return true;
        },
      });
      const fixtures = {
        browser: { close: async () => { events.push('browser-close'); if (phase === 'browser') await hang(); } },
        ownedBrowserServer: phase === 'browser-server' ? { close: hang, process: () => browserOwner } : undefined,
        startupTask: phase === 'startup' ? hang() : Promise.resolve(),
        child, meta, runId, evidence, metadata, socket, join, process, withShutdownDeadline,
        stopOwnedProcess: (owned, mode, group) => {
          if (owned !== child && owned !== browserOwner || group !== true) throw new Error('Unexpected fixture ownership');
          if (mode === 'signal') events.push('server-owner-finalized');
          return stopOwnedProcess(owned, mode, false);
        },
        files: async path => (await readdir(path)).map(name => join(path, name)),
        json: async (path, value) => {
          events.push('cleanup-write');
          if (phase === 'write') await hang();
          await writeFile(path, JSON.stringify(value));
        },
        manifest: async () => {
          events.push('manifest');
          if (phase === 'manifest') await hang();
          await writeFile(join(evidence, 'manifest.json'), JSON.stringify(await readdir(evidence)));
        },
        server: { close() { events.push('listener-close'); } },
        rm: async (path, options) => {
          events.push(path === socket ? 'socket-remove' : path === metadata ? 'metadata-remove' : 'unexpected-remove');
          await withShutdownDeadline('Test directory cleanup', () => rm(path, options));
        },
      };
      const setup = 'let cleanupTask, browserClosing; let browserServer = ownedBrowserServer; let stopping = false;\\n';
      const cleanup = new Function(...Object.keys(fixtures), setup + source.slice(closeStart, closeEnd) + '\\n' + source.slice(cleanupStart, cleanupEnd) + '; return cleanup;')(...Object.values(fixtures));
      const started = performance.now();
      const pending = cleanup();
      const repeated = cleanup();
      if (pending !== repeated) throw new Error('Verification cleanup was not coalesced');
      const settled = await Promise.allSettled([pending, repeated]);
      const elapsed = performance.now() - started;
      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));
      const exists = async path => { try { await access(path); return true; } catch { return false; } };
      const metadataPreserved = await exists(metadata);
      const metadataUnchanged = metadataPreserved && await readFile(metadata, 'utf8') === initialMeta;
      const socketPreserved = await exists(socket);
      const proofsPreserved = (await Promise.all(proofs.map(async ([name, content]) => await readFile(join(evidence, name), 'utf8') === content))).every(Boolean);
      const cleanupProofCount = await exists(join(evidence, 'cleanup.json')) ? JSON.parse(await readFile(join(evidence, 'cleanup.json'), 'utf8')).evidenceFilesPreserved : undefined;
      const failure = settled.find(result => result.status === 'rejected')?.reason?.message;
      process.stdout.write(JSON.stringify({ events, rejected, outcomes: settled.map(result => result.status), failure, metadataPreserved, metadataUnchanged, socketPreserved, proofsPreserved, cleanupProofCount, elapsed }));
    } finally {
      await withShutdownDeadline('Test directory cleanup', () => rm(directory, { recursive: true, force: true }));
    }
  `;
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let errors = '';
  child.stdout.on('data', chunk => { output += String(chunk); });
  child.stderr.on('data', chunk => { errors += String(chunk); });
  const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    const code = await Promise.race([
      exited,
      new Promise<never>((_, reject) => { watchdog = setTimeout(() => reject(new Error('Verification cleanup fixture exceeded 8 seconds')), 8000); }),
    ]);
    expect(code, errors).toBe(0);
    return JSON.parse(output) as Result;
  } finally {
    if (watchdog !== undefined) clearTimeout(watchdog);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await withShutdownDeadline('Verification regression child exit', () => exited.catch(() => {}));
  }
}

function expectCleanup(result: Result, failure?: string) {
  expect(result.rejected).toEqual([]);
  expect(result.proofsPreserved).toBe(true);
  expect(result.socketPreserved).toBe(false);
  expect(result.events.filter(event => event === 'browser-close')).toHaveLength(1);
  expect(result.events.filter(event => event === 'child-stop')).toHaveLength(1);
  expect(result.events.slice(-2)).toEqual(failure ? ['listener-close', 'socket-remove'] : ['socket-remove', 'metadata-remove']);
  expect(result.events.indexOf('child-stop')).toBeLessThan(result.events.indexOf('cleanup-write'));
  expect(result.events.indexOf('manifest')).toBeLessThan(result.events.indexOf('listener-close'));
  expect(result.outcomes).toEqual(failure ? ['rejected', 'rejected'] : ['fulfilled', 'fulfilled']);
  expect(result.metadataPreserved).toBe(Boolean(failure));
  if (failure) {
    expect(result.failure).toContain(failure);
    expect(result.failure).toContain('shutdown deadline (3000ms)');
    expect(result.metadataUnchanged).toBe(true);
    expect(result.elapsed).toBeGreaterThanOrEqual(SHUTDOWN_GRACE_MS - 100);
    expect(result.elapsed).toBeLessThan(SHUTDOWN_GRACE_MS + 2000);
  } else {
    expect(result.failure).toBeUndefined();
  }
}

it('coalesces verification cleanup while preserving proof files and removing owned metadata', async () => {
  const result = await probe('healthy');
  expectCleanup(result);
  expect(result.cleanupProofCount).toBe(2);
});

it('bounds a verification browser close that never settles and continues owned child cleanup', async () => {
  const result = await probe('browser');
  expectCleanup(result, 'Verification browser close');
  expect(result.cleanupProofCount).toBe(2);
});

it('finalizes the owned browser server process after its close deadline', async () => {
  const result = await probe('browser-server');
  expectCleanup(result, 'Verification browser server close');
  expect(result.events).toContain('server-owner-finalized');
});

it('bounds a verification startup barrier that never settles and continues remaining cleanup', async () => {
  const result = await probe('startup');
  expectCleanup(result, 'Verification startup shutdown barrier');
  expect(result.cleanupProofCount).toBe(2);
});

it('bounds stalled verification evidence writes and manifests before closing its listener and socket', async () => {
  const results = await Promise.all([probe('write'), probe('manifest')]);
  expectCleanup(results[0]!, 'Verification cleanup evidence');
  expectCleanup(results[1]!, 'Verification evidence manifest');
  expect(results[0]!.cleanupProofCount).toBeUndefined();
  expect(results[1]!.cleanupProofCount).toBe(2);
});
