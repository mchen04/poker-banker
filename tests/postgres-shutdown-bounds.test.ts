import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { SHUTDOWN_GRACE_MS, withShutdownDeadline } from '../scripts/owned-process';

type Phase = 'healthy' | 'initialise' | 'start' | 'stop' | 'remove';
type Result = {
  events: string[];
  exits: number[];
  rejected: string[];
  errors: string[];
  removed: string[];
  elapsed: number;
  exitHookSafe: boolean;
  persistent?: boolean;
};

async function probe(phase: Phase, logFailure = false): Promise<Result> {
  const paths = {
    helper: fileURLToPath(new URL('../scripts/owned-process.ts', import.meta.url)),
    worker: fileURLToPath(new URL('../scripts/test-postgres.ts', import.meta.url)),
  };
  const script = `
    import { readFile } from 'node:fs/promises';
    import { stripTypeScriptTypes } from 'node:module';
    import { EventEmitter } from 'node:events';
    const paths = ${JSON.stringify(paths)};
    const phase = ${JSON.stringify(phase)};
    const logFailure = ${JSON.stringify(logFailure)};
    const strip = async path => stripTypeScriptTypes(await readFile(path, 'utf8'))
      .replace(/^import .*;\\n/gm, '').replace(/^export /gm, '');
    const stopOwnedProcess = new Function((await strip(paths.helper)) + '; return stopOwnedProcess;')();
    const events = [], exits = [], rejected = [], errors = [], removed = [];
    process.on('unhandledRejection', error => rejected.push(String(error)));
    let complete;
    const done = new Promise(resolve => { complete = resolve; });
    let requestedAt;
    let database;
    let persistent;
    const fakeProcess = Object.assign(new EventEmitter(), {
      connected: true, argv: ['node', 'test-postgres.ts', '55439', '[]'], exitCode: undefined,
      send(message, callback) {
        events.push(message.type);
        callback?.(null);
        if (message.type === 'pb-postgres-ready') setImmediate(shutdown);
      },
      exit(code) { exits.push(code); events.push('exit'); complete(); },
    });
    function shutdown() {
      if (requestedAt !== undefined) return;
      requestedAt = performance.now();
      fakeProcess.emit('message', { type: 'pb-shutdown' });
      fakeProcess.emit('disconnect');
    }
    const hang = () => new Promise(() => {});
    class EmbeddedPostgres {
      constructor(options) { database = this; persistent = options.persistent; events.push('database-create'); }
      async initialise() {
        events.push('database-initialise');
        if (phase === 'initialise') { setImmediate(shutdown); await hang(); }
      }
      async start() {
        events.push('database-start');
        if (phase === 'start') { setImmediate(shutdown); await hang(); }
      }
      async stop() {
        events.push('database-stop');
        if (phase === 'stop') await hang();
        events.push('database-stopped');
      }
    }
    const fixtures = {
      mkdir: async () => { events.push('mkdir'); },
      mkdtemp: async () => { events.push('directory-create'); return '/fixture-owned-pg'; },
      rm: async path => {
        removed.push(path); events.push('directory-remove');
        if (phase === 'remove') await hang();
      },
      resolve: value => value,
      EmbeddedPostgres, stopOwnedProcess, process: fakeProcess,
      console: { error(message) { errors.push(String(message)); if (logFailure) throw new Error('Log sink unavailable'); } },
    };
    const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
    await new AsyncFunction(...Object.keys(fixtures), await strip(paths.worker))(...Object.values(fixtures));
    await done;
    const elapsed = performance.now() - requestedAt;
    let exitHookSafe = false;
    if (database) {
      await database.stop();
      await database.stop();
      exitHookSafe = true;
    }
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    process.stdout.write(JSON.stringify({ events, exits, rejected, errors, removed, elapsed, exitHookSafe, persistent }));
  `;
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let errors = '';
  child.stdout.on('data', chunk => { output += String(chunk); });
  child.stderr.on('data', chunk => { errors += String(chunk); });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    const code = await Promise.race([
      exited,
      new Promise<never>((_, reject) => {
        watchdog = setTimeout(() => reject(new Error('PostgreSQL shutdown fixture exceeded 20 seconds')), 20000);
      }),
    ]);
    expect(code, errors).toBe(0);
    return JSON.parse(output) as Result;
  } finally {
    if (watchdog !== undefined) clearTimeout(watchdog);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await withShutdownDeadline('PostgreSQL regression child exit', () => exited.catch(() => {}));
  }
}

for (const scenario of [
  { phase: 'healthy', code: 0, stopCalls: 1, removeCalls: 1, logFailure: false },
  { phase: 'initialise', code: 1, stopCalls: 0, removeCalls: 0, logFailure: true },
  { phase: 'start', code: 1, stopCalls: 1, removeCalls: 0, logFailure: false },
  { phase: 'stop', code: 1, stopCalls: 1, removeCalls: 0, logFailure: false },
  { phase: 'remove', code: 1, stopCalls: 1, removeCalls: 1, logFailure: false },
] as const) it(`bounds owned PostgreSQL cleanup while ${scenario.phase} ${scenario.phase === 'healthy' ? 'completes' : 'never settles'}`, async () => {
  const result = await probe(scenario.phase, scenario.logFailure);
  expect(result.exits).toEqual([scenario.code]);
  expect(result.rejected).toEqual([]);
  expect(result.exitHookSafe).toBe(true);
  expect(result.persistent).toBe(true);
  expect(result.events.filter(event => event === 'database-stop')).toHaveLength(scenario.stopCalls);
  expect(result.removed).toEqual(scenario.removeCalls ? ['/fixture-owned-pg'] : []);
  expect(result.elapsed).toBeLessThan(SHUTDOWN_GRACE_MS * 2 + 2000);
  if (scenario.phase === 'healthy') {
    expect(result.errors).toEqual([]);
    expect(result.events.indexOf('database-stopped')).toBeLessThan(result.events.indexOf('directory-remove'));
    expect(result.events.indexOf('directory-remove')).toBeLessThan(result.events.indexOf('exit'));
  } else {
    expect(result.elapsed).toBeGreaterThanOrEqual(SHUTDOWN_GRACE_MS - 100);
    expect(result.errors.some(message => message.includes('shutdown deadline'))).toBe(true);
  }
  if (scenario.phase === 'initialise') expect(result.events).not.toContain('database-start');
  if (scenario.phase === 'start') expect(result.events).toContain('database-stopped');
  if (scenario.phase === 'stop') expect(result.events).not.toContain('database-stopped');
}, 25000);
