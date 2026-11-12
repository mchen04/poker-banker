import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

type Scenario = {
  launcher: 'database' | 'local' | 'e2e';
  childFailure?: boolean;
  databaseFailure?: boolean;
  poolFailure?: boolean;
  closeFailure?: boolean;
  logFailure?: boolean;
  removalFailure?: boolean;
};
type Result = { events: string[]; rejected: string[]; exits: number[]; exitEvents: string[][]; runError?: string; childExit?: number | null };

async function probe(input: Scenario): Promise<Result> {
  const script = `
    import { readFile } from 'node:fs/promises';
    import { stripTypeScriptTypes } from 'node:module';
    import { EventEmitter, once } from 'node:events';
    import { spawn } from 'node:child_process';
    import { stopOwnedProcess } from ${JSON.stringify(new URL('../scripts/owned-process.ts', import.meta.url).href)};
    const input = ${JSON.stringify(input)};
    const events = [], rejected = [], exits = [], exitEvents = [];
    process.on('unhandledRejection', error => rejected.push(error instanceof Error ? error.message : 'unknown rejection'));
    const fakeProcess = Object.assign(new EventEmitter(), {
      env: {}, argv: ['node', 'launcher.ts', 'app'], execPath: process.execPath,
      exit: code => { exits.push(code); exitEvents.push([...events]); }, exitCode: undefined,
    });
    const fakeConsole = {
      log() {},
      error() { if (input.logFailure) throw new Error('Log sink unavailable'); },
    };
    const pool = { options: { connectionString: 'postgresql://fixture' }, end: async () => {
      events.push('pool-end');
      if (input.poolFailure) throw new Error('Pool end failed');
    } };
    let database;
    class EmbeddedPostgres {
      constructor() { database = this; }
      async start() {}
      async initialise() {}
      async stop() {
        events.push('database-stop');
        if (input.databaseFailure) throw new Error('Database stop failed');
      }
    }
    let child;
    if (input.launcher !== 'local') {
      child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>process.exit(' + (input.childFailure ? 1 : 0) + ')); console.log("ready"); setInterval(()=>{},1000)'], { stdio: ['ignore', 'pipe', 'ignore'] });
      await once(child.stdout, 'data');
    }
    const spawnOwned = () => {
      child.once('exit', () => events.push('child-stop'));
      return child;
    };
    const server = { close(callback) {
      events.push('server-close');
      setImmediate(() => callback(input.closeFailure ? new Error('HTTP close failed') : undefined));
    } };
    const app = { use() {}, get() {}, fetch() {} };
    const fixtures = {
      mkdir: async () => {}, access: async () => {}, resolve: value => value,
      spawn: spawnOwned, EmbeddedPostgres, createPool: () => pool,
      migrate: async () => {}, stopOwnedProcess, process: fakeProcess, console: fakeConsole,
      readFile: async () => '', createHttpsServer: () => {},
      serve: () => server, compress: () => {}, serveStatic: () => {},
      createApp: () => app, emulateEdgeHeaders: value => value,
      spawnSync: () => ({ status: 0 }), mkdtemp: async () => '/fixture-tls',
      rm: async () => {
        events.push('tls-remove');
        if (input.removalFailure) throw new Error('TLS removal failed');
      }, fileURLToPath: value => value.pathname,
      testDatabase: async () => ({ pool, stop: async () => {
        events.push('database-stop');
        if (input.databaseFailure) throw new Error('Database stop failed');
      } }),
    };
    const paths = ${JSON.stringify({ database: fileURLToPath(new URL('../scripts/db-local.ts', import.meta.url)), local: fileURLToPath(new URL('../src/server/local.ts', import.meta.url)), e2e: fileURLToPath(new URL('../scripts/e2e-server.ts', import.meta.url)) })};
    const source = stripTypeScriptTypes(await readFile(paths[input.launcher], 'utf8'))
      .replace(/^import .*;\\n/gm, '')
      .replaceAll('import.meta.url', JSON.stringify(new URL('file://' + paths[input.launcher]).href));
    const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
    let runError;
    try { await new AsyncFunction(...Object.keys(fixtures), source)(...Object.values(fixtures)); }
    catch (error) { runError = error instanceof Error ? error.message : 'unknown execution failure'; }
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    const exited = child ? once(child, 'exit') : undefined;
    if (runError && child) child.kill('SIGTERM');
    fakeProcess.emit('SIGINT');
    fakeProcess.emit('SIGTERM');
    if (input.launcher === 'database') {
      void (async () => { await database.stop(); events.push('hook-complete'); })();
    }
    if (input.launcher === 'e2e') {
      fakeProcess.emit('message', { type: 'pb-shutdown' });
      fakeProcess.emit('disconnect');
    }
    if (exited) await exited;
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    process.stdout.write(JSON.stringify({ events, rejected, exits, exitEvents, runError, childExit: child?.exitCode }));
  `;
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let errors = '';
  child.stdout.on('data', chunk => { output += String(chunk); });
  child.stderr.on('data', chunk => { errors += String(chunk); });
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  expect(code, errors).toBe(0);
  return JSON.parse(output) as Result;
}

for (const scenario of [
  { name: 'successful coalesced shutdown', failure: false },
  { name: 'an owned app exiting nonzero', childFailure: true, failure: true },
  { name: 'PostgreSQL stop failure', databaseFailure: true, failure: true },
  { name: 'PostgreSQL stop failure with a throwing log sink', databaseFailure: true, logFailure: true, failure: true },
]) it(`consumes local database launcher shutdown failures after ${scenario.name}`, async () => {
  const result = await probe({ launcher: 'database', ...scenario });
  expect(result.runError).toBeUndefined();
  expect(result.childExit).toBe(scenario.childFailure ? 1 : 0);
  expect(result.rejected).toEqual([]);
  expect(result.events).toEqual(['pool-end', 'child-stop', 'database-stop', 'hook-complete']);
  expect(result.exits.length).toBeGreaterThan(0);
  expect(result.exits.every(code => code === (scenario.failure ? 1 : 0))).toBe(true);
  for (const events of result.exitEvents) expect(events.filter(event => event !== 'hook-complete')).toEqual(['pool-end', 'child-stop', 'database-stop']);
});

for (const scenario of [
  { name: 'successful repeated signals', failure: false },
  { name: 'a rejected pool end', poolFailure: true, failure: true },
  { name: 'an HTTP close callback error', closeFailure: true, failure: true },
  { name: 'a rejected pool end with a throwing log sink', poolFailure: true, logFailure: true, failure: true },
]) it(`finishes local HTTP server shutdown once after ${scenario.name}`, async () => {
  const result = await probe({ launcher: 'local', ...scenario });
  expect(result.runError).toBeUndefined();
  expect(result.rejected).toEqual([]);
  expect(result.events).toEqual(['server-close', 'pool-end']);
  expect(result.exits.length).toBeGreaterThan(0);
  expect(result.exits.every(code => code === (scenario.failure ? 1 : 0))).toBe(true);
  for (const events of result.exitEvents) expect(events).toEqual(['server-close', 'pool-end']);
});

for (const scenario of [
  { name: 'successful coalesced owner events', failure: false },
  { name: 'an owned app exiting nonzero', childFailure: true, failure: true },
  { name: 'database cleanup failure', databaseFailure: true, failure: true },
  { name: 'database cleanup failure with a throwing log sink', databaseFailure: true, logFailure: true, failure: true },
  { name: 'TLS removal failure', removalFailure: true, failure: true },
  { name: 'every cleanup step failing with a throwing log sink', childFailure: true, databaseFailure: true, removalFailure: true, logFailure: true, failure: true },
]) it(`finishes e2e fixture cleanup after ${scenario.name}`, async () => {
  const result = await probe({ launcher: 'e2e', ...scenario });
  expect(result.runError).toBeUndefined();
  expect(result.childExit).toBe(scenario.childFailure ? 1 : 0);
  expect(result.rejected).toEqual([]);
  expect(result.events).toEqual(['child-stop', 'database-stop', 'tls-remove']);
  expect(result.exits.length).toBeGreaterThan(0);
  expect(result.exits.every(code => code === (scenario.failure ? 1 : 0))).toBe(true);
  for (const events of result.exitEvents) expect(events).toEqual(['child-stop', 'database-stop', 'tls-remove']);
});
