import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';
import * as ownership from '../scripts/owned-process';

type Entry = 'db-local' | 'e2e-server' | 'local' | 'testDatabase' | 'benchmarkStack' | 'benchmarkBrowser' | 'verification';
type Point = { id: number; line: number; expression: string };
type Tree = { role: string; child: ChildProcess; descendant?: number; ready: Promise<unknown> };
type Observation = { step: string; alive: string[]; scratch: string[] };
const paths: Record<Entry, string> = {
  'db-local': 'scripts/db-local.ts',
  'e2e-server': 'scripts/e2e-server.ts',
  local: 'src/server/local.ts',
  testDatabase: 'tests/database.ts',
  benchmarkStack: 'scripts/bench/stack.ts',
  benchmarkBrowser: 'scripts/bench/browser.ts',
  verification: '.claude/skills/verify-poker-banker/scripts/control.ts',
};

function alive(pid: number | undefined) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}

const active = (tree: Tree) => alive(-tree.child.pid!) || alive(tree.child.pid) || alive(tree.descendant) || !!tree.descendant && alive(-tree.descendant);

function startupSource(entry: Entry, source: string) {
  if (entry === 'testDatabase') return source.slice(source.indexOf('async function availablePort'));
  if (entry === 'verification') return source.slice(source.indexOf('async function daemon()'), source.indexOf('\nawait mkdir(cache'));
  return source;
}

function instrument(entry: Entry, source: string) {
  const points: Point[] = [];
  const startup = startupSource(entry, source);
  const offset = source.slice(0, source.indexOf(startup)).split('\n').length - 1;
  const parsed = ts.createSourceFile(paths[entry], startup, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const selected = (node: ts.AwaitExpression) => {
    const functions: string[] = [];
    let functionCount = 0;
    let parent: ts.Node | undefined = node.parent;
    while (parent) {
      if (ts.isFunctionLike(parent)) {
        functionCount++;
        if (ts.isCallExpression(parent.parent) && parent.parent.expression.getText(parsed).endsWith('.addCleanup')) return false;
        const name = 'name' in parent && parent.name ? parent.name.getText(parsed) : '';
        if (name) functions.push(name);
        else {
          const owner = parent.parent;
          if (owner && ts.isVariableDeclaration(owner)) functions.push(owner.name.getText(parsed));
        }
      }
      parent = parent.parent;
    }
    if (/^(?:stop\(|owner\.stop\(|cleanup\(|cleanupTask$)/.test(node.expression.getText(parsed))) return false;
    if (entry === 'local') return functionCount === 0 || functions[0] === 'initialize' && node.expression.getText(parsed).startsWith('owner.launch(');
    if (entry === 'db-local' || entry === 'e2e-server') return functions[0] === 'initialize';
    if (entry === 'testDatabase') return functions[0] === 'testDatabase' || functions[0] === 'availablePort';
    if (entry === 'benchmarkStack') return functions[0] === 'benchmarkStack' || functions[0] === 'availablePort';
    if (entry === 'benchmarkBrowser') return functions[0] === 'benchmarkBrowser' && /^(?:webkit\.(?:launchServer|connect)|owner\.launch|stack\.(?:own|owner\.launch)|stack\.client\.request)/.test(node.expression.getText(parsed));
    if (functions[0] === 'contextPage') return node.expression.getText(parsed).startsWith('browser.newContext(') || node.expression.getText(parsed) === 'context.newPage()';
    if (functions[0] === 'doctor') return true;
    if (functions.includes('cleanup') || functions.includes('closeBrowser') || functions.includes('handle')) return false;
    if (/^(?:closeBrowser\(|withShutdownDeadline\('Late verification)/.test(node.expression.getText(parsed))) return false;
    const start = parsed.text.indexOf('startupTask =');
    const end = parsed.text.indexOf('\n  try { await startupTask', start);
    return node.getStart(parsed) >= start && node.getEnd() <= end || functions[0] === 'daemon' && node.getStart(parsed) < start;
  };
  const transformer: ts.TransformerFactory<ts.SourceFile> = context => root => {
    const visit: ts.Visitor = node => {
      if (ts.isImportDeclaration(node)) return undefined;
      if (ts.isExpressionStatement(node) && ts.isVoidExpression(node.expression) && node.parent === parsed && node.expression.expression.getText(parsed).startsWith('initialize(')) return context.factory.updateExpressionStatement(node, context.factory.createAwaitExpression(ts.visitNode(node.expression.expression, visit) as ts.Expression));
      if (ts.isAwaitExpression(node) && selected(node)) {
        const id = points.length;
        points.push({ id, line: parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1 + offset, expression: node.expression.getText(parsed) });
        return context.factory.updateAwaitExpression(node, context.factory.createCallExpression(context.factory.createIdentifier('startupGate'), undefined, [context.factory.createNumericLiteral(id), context.factory.createArrowFunction([context.factory.createModifier(ts.SyntaxKind.AsyncKeyword)], undefined, [], undefined, context.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken), ts.visitNode(node.expression, visit) as ts.Expression)]));
      }
      return ts.visitEachChild(node, visit, context);
    };
    return ts.visitNode(root, visit) as ts.SourceFile;
  };
  const transformed = ts.transform(parsed, [transformer]);
  const code = ts.transpileModule(ts.createPrinter().printFile(transformed.transformed[0]!), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replace(/^export /gm, '').replaceAll('import.meta.url', JSON.stringify(new URL(`../${paths[entry]}`, import.meta.url).href));
  transformed.dispose();
  return { code, points };
}

async function run(entry: Entry, code: string, target: number | 'ready') {
  const trees: Tree[] = [];
  const scratch = new Set<string>();
  const treeCreated = new EventEmitter();
  const observations: Observation[] = [];
  const failures: unknown[] = [];
  const stopErrors: string[] = [];
  const finalizerErrors: string[] = [];
  const externalStops: Promise<unknown>[] = [];
  const owners: ReturnType<typeof ownership.createProcessOwner>[] = [];
  const visits: number[] = [];
  const controller = new AbortController();
  const fakeProcess = Object.assign(new EventEmitter(), {
    env: { LOCAL_TLS_KEY: 'fixture-key', LOCAL_TLS_CERT: 'fixture-cert' }, argv: ['node', 'fixture', 'fixture-app'], execPath: process.execPath,
    connected: true, pid: process.pid, exitCode: 0, stdout: { write() {} }, stderr: { write() {} }, send() {},
    exit(code: number) { exits.push(code); observe('exit'); finish(); },
  });
  const exits: number[] = [];
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  let cancel!: () => void;
  let cancelled = false;
  let defaultTermination = false;
  let forcedExpected = false;
  let reached!: () => void;
  const entered = new Promise<void>(resolve => { reached = resolve; });
  const observe = (step: string) => observations.push({ step, alive: trees.filter(tree => tree.role !== 'database' && active(tree)).map(tree => tree.role), scratch: [...scratch] });
  const fixtureSpawn = (role: string, options: SpawnOptions = {}, launch = spawn) => {
    const descendant = `process.on('SIGTERM',()=>{});process.on('SIGINT',()=>{});process.on('message',message=>{if(message==='fixture-finish')process.exit(0)});process.send({pid:process.pid});setInterval(()=>{},1000)`;
    const wrapper = `import {createProcessOwner} from ${JSON.stringify(new URL('../scripts/owned-process.ts', import.meta.url).href)};const owner=createProcessOwner();const child=owner.spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','ignore','ignore','ipc']});child.once('message',message=>{process.send({type:'fixture-tree',pid:message.pid});process.send({type:'pb-postgres-ready',directory:'/fixture-db'});console.log('Poker banker ready at fixture');});child.once('exit',()=>process.exit(0));process.on('message',message=>{if(message?.type==='pb-shutdown')process.exit(0);if(message==='fixture-finish')child.send(message);});`;
    const child = launch(process.execPath, ['--import', 'tsx', '--input-type', 'module', '-e', wrapper], { ...options, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const tree: Tree = { role, child, ready: Promise.resolve() };
    tree.ready = new Promise<void>((resolve, reject) => {
      child.on('message', message => { if (message && typeof message === 'object' && 'type' in message && message.type === 'fixture-tree' && 'pid' in message) { tree.descendant = Number(message.pid); resolve(); } });
      child.once('error', reject);
    });
    trees.push(tree);
    treeCreated.emit('spawn');
    return child;
  };
  const createProcessOwner = (options: Parameters<typeof ownership.createProcessOwner>[0] = {}) => {
    const owner = ownership.createProcessOwner(options);
    owners.push(owner);
    return new Proxy(owner, { get(value, key) {
      if (key === 'stop' || key === 'stopProcesses') return () => {
        const pending = value[key]();
        void pending.catch(error => { stopErrors.push(String(error)); });
        return pending;
      };
      if (key === 'launch') return <T>(action: () => Promise<T> | T, phase?: 'process' | 'database') => value.launch(async () => {
        const result = await action();
        if (!(result instanceof (await import('node:child_process')).ChildProcess)) await new Promise(resolve => setTimeout(resolve, 80));
        return result;
      }, phase);
      if (key === 'spawn') return (_executable: string, args: string[], options: SpawnOptions = {}) => {
        const role = args.some(arg => arg.includes('test-postgres')) ? 'database' : args.includes('fixture-command') ? 'command' : 'app';
        return fixtureSpawn(role, { ...options, detached: true }, value.spawn.bind(value) as typeof spawn);
      };
      return Reflect.get(value, key);
    } });
  };
  const pool = { options: { connectionString: 'postgresql://fixture' }, end: async () => { observe('pool-end'); }, query: async () => ({ rows: [] }) };
  class EmbeddedPostgres {
    process?: ChildProcess;
    async initialise() {}
    async start() { this.process = fixtureSpawn('database', { detached: true }); await trees.at(-1)!.ready; }
    async stop() { observe('database-stop'); }
  }
  const database = { pool, directory: '/fixture-db', stop: async () => { observe('database-stop'); } };
  const server = Object.assign(new EventEmitter(), {
    listening: false, listen(...args: unknown[]) { this.listening = true; queueMicrotask(() => (args.at(-1) as () => void)()); return this; },
    address: () => ({ port: 54321 }), close(callback?: (error?: Error) => void) { this.listening = false; queueMicrotask(() => callback?.()); }, closeAllConnections() {},
  });
  const page = { request: { get: async () => ({ status: () => 200, text: async () => '<meta name="pb-release" content="fixture">', json: async () => ({ banker: { id: 'fixture' } }) }) }, getByRole: () => ({}), screenshot: async () => {}, goto: async () => {}, on() {}, url: () => 'https://127.0.0.1', title: async () => 'fixture', evaluate: async () => true };
  const context = { newPage: async () => page, addInitScript: async () => {}, close: async () => {} };
  const browser = { newContext: async () => context, close: async () => {}, version: () => 'fixture' };
  const webkit = { launchServer: async () => {
    const child = fixtureSpawn('browser', { detached: true });
    await trees.at(-1)!.ready;
    return { process: () => child, close: async () => {}, wsEndpoint: () => 'fixture' };
  }, connect: async () => browser };
  const log = Object.assign(new EventEmitter(), { destroyed: false, write() {}, end(callback: () => void) { callback(); } });
  const fixtures: Record<string, unknown> = {
    ...ownership, createProcessOwner, process: fakeProcess, console: { log() {}, error(error: unknown) { failures.push(error); } },
    fixtureOwn: (owner: ReturnType<typeof ownership.createProcessOwner>) => controller.signal.addEventListener('abort', () => { externalStops.push(owner.stop().catch(error => failures.push(error))); }, { once: true }),
    runOwned: async (owner: ReturnType<typeof ownership.createProcessOwner>, executable: string) => {
      const child = owner.spawn(process.execPath, ['fixture-command']);
      const exit = once(child, 'exit');
      await trees.at(-1)!.ready;
      await new Promise(resolve => setTimeout(resolve, 100));
      if (!cancelled && child.connected) child.send('fixture-finish');
      await exit;
      const app = [...trees].reverse().find(tree => tree.role === 'app');
      return executable === 'lsof' ? String(app?.descendant ?? 12345) : executable === 'ps' ? String(app?.child.pid ?? 12345) : '';
    },
    ungated: (_id: number, action: () => Promise<unknown>) => action(),
    startupGate: async (id: number, action: () => Promise<unknown>) => {
      visits.push(id);
      const pending = action();
      void pending.catch(() => {});
      if (id === target && !cancelled) {
        cancelled = true;
        if ((entry === 'e2e-server' || entry === 'benchmarkStack') && !trees.length) await once(treeCreated, 'spawn', { signal: AbortSignal.timeout(3000) });
        await Promise.all(trees.map(tree => tree.ready));
        reached();
        await new Promise(resolve => setTimeout(resolve, 50));
        if (defaultTermination) throw new Error('Fixture process terminated by the default signal handler');
      }
      return pending;
    },
    spawn: (_executable: string, args: string[], options: SpawnOptions) => fixtureSpawn(args.some(arg => arg.includes('test-postgres')) ? 'database' : 'app', options),
    spawnSync: () => ({ status: 0 }), ChildProcess: (await import('node:child_process')).ChildProcess, EmbeddedPostgres,
    createPool: () => pool, migrate: async () => {}, mkdir: async () => {}, access: async () => { throw new Error('Missing fixture database directory'); },
    mkdtemp: async (prefix: string) => { const directory = `${prefix}fixture`; scratch.add(directory); return directory; },
    rm: async (path: string) => { if (scratch.has(path)) scratch.delete(path); },
    readFile: async () => 'fixture', resolve, join, fileURLToPath: (value: URL) => value.pathname,
    testDatabase: async () => database, seedBenchmark: async () => ({ username: 'fixture', password: 'fixture' }),
    createServer: () => server, createHttpsServer: () => server, closeOwnedServer: async () => {},
    createWriteStream: () => { queueMicrotask(() => log.emit('open')); return log; },
    LocalClient: class { async request() { return { status: 200, body: { entries: [], session: { name: 'fixture' }, players: [], totals: { total_in_minor: '0' } } }; } cookie() { return 'fixture'; } close() {} },
    CpuBudget: class { start() {} async pause() {} }, writeFile: async () => {},
    ShapedProxy: class { handle() {} close() {} },
    createApp: () => ({ use() {}, get() {}, fetch() {} }), compress: () => {}, serveStatic: () => {}, emulateEdgeHeaders: (value: unknown) => value, serve: () => server,
    args: ['--local'], runId: 'fixture', socket: '/fixture.sock', evidence: '/fixture-evidence', metadata: '/fixture-meta', webkit,
    createAccount: async () => ({ username: 'fixture', banker: { id: 'fixture' } }), devices: { 'iPhone 15': {} },
    createConnection: () => {}, createNetServer: () => server, chmod: async () => {}, json: async () => {}, manifest: async () => {}, files: async () => [],
    owned: () => {}, execFileSync: () => '12345', expect: () => ({ toBeVisible: async () => {}, toBe() {}, toEqual() {}, toHaveLength() {} }),
  };
  if (entry === 'e2e-server' || entry === 'benchmarkStack' || entry === 'benchmarkBrowser') {
    const module = instrument('testDatabase', await readFile(new URL('../tests/database.ts', import.meta.url), 'utf8')).code.replaceAll('startupGate(', 'ungated(');
    fixtures.testDatabase = new Function(...Object.keys(fixtures), `${module};return testDatabase;`)(...Object.values(fixtures));
  }
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<unknown>;
  const suffix = entry === 'testDatabase' ? '\nconst fixtureOwner=createProcessOwner();fixtureOwn(fixtureOwner);return testDatabase({owner:fixtureOwner});' : entry === 'benchmarkStack' ? '\nreturn benchmarkStack("/fixture", fixtureSignal);' : entry === 'benchmarkBrowser' ? '\nconst stack=await benchmarkStack("/fixture",fixtureSignal);fixtureOwn(stack.owner);return benchmarkBrowser(stack,{executable:"fixture"},"/fixture",()=>{},{samples:0,reverse:false,phase(){},metrics:new Set()});' : entry === 'verification' ? '\nreturn daemon();' : '';
  fixtures.fixtureSignal = controller.signal;
  let result: unknown;
  const pending = new AsyncFunction(...Object.keys(fixtures), code + suffix)(...Object.values(fixtures)).then(value => { result = value; }, error => { failures.push(error); });
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { watchdog = setTimeout(() => reject(new Error('Startup cancellation exceeded 18 seconds')), 18000); });
  cancel = () => {
    cancelled = true;
    forcedExpected = trees.some(active);
    controller.abort();
    if (['db-local', 'e2e-server', 'local', 'verification'].includes(entry) && fakeProcess.listenerCount('SIGTERM') === 0) {
      defaultTermination = true;
      fakeProcess.exit(1);
      return;
    }
    fakeProcess.emit('SIGTERM');
    fakeProcess.emit('message', { type: 'pb-shutdown' });
  };
  try {
    if (target === 'ready') {
      await Promise.race([pending, deadline]);
      await Promise.all(trees.map(tree => tree.ready));
      cancel();
      if (result && typeof result === 'object' && 'stop' in result) await (result as { stop(): Promise<void> }).stop().catch(error => failures.push(error));
    } else {
      await Promise.race([entered, pending.then(() => { if (!visits.includes(target)) throw new Error(`Startup point ${target} was not reached. ${failures.map(String).join('; ')}`); }), deadline]);
      cancel();
    }
    await Promise.race([pending, deadline]);
    await Promise.race([Promise.all(externalStops), deadline]);
    if (entry === 'db-local' || entry === 'e2e-server' || entry === 'local' || entry === 'verification') await Promise.race([finished, deadline]);
    await new Promise(resolve => setImmediate(resolve));
    return { visits, observations, failures, exits, forcedExpected, stopErrors, finalizerErrors, scratch: [...scratch], trees: trees.map(tree => ({ role: tree.role, alive: active(tree) })) };
  } finally {
    if (watchdog !== undefined) clearTimeout(watchdog);
    await Promise.allSettled(owners.map(owner => owner.stop()));
    const finalized = await Promise.allSettled(trees.map(tree => ownership.stopOwned(tree.child)));
    for (const result of finalized) if (result.status === 'rejected') finalizerErrors.push(String(result.reason));
  }
}

const matrix = await Promise.all((Object.keys(paths) as Entry[]).map(async entry => {
  const source = await readFile(new URL(`../${paths[entry]}`, import.meta.url), 'utf8');
  const { code, points } = instrument(entry, source);
  if (!points.length) throw new Error(`No startup cancellation points found in ${paths[entry]}`);
  const setup = entry === 'benchmarkBrowser' ? instrument('benchmarkStack', await readFile(new URL('../scripts/bench/stack.ts', import.meta.url), 'utf8')).code.replaceAll('startupGate(', 'ungated(') : '';
  return { entry, launcher: entry === 'benchmarkBrowser' ? 'benchmarkStack' : entry, path: paths[entry], code: setup + code, points };
}));

if (process.env.PB_SHUTDOWN_MATRIX_INVENTORY) await writeFile(process.env.PB_SHUTDOWN_MATRIX_INVENTORY, JSON.stringify({ regression: 'tests/structural-shutdown.test.ts', startupAwaitPoints: matrix.reduce((count, suite) => count + suite.points.length, 0), afterStartupCases: 6, launchers: matrix.map(({ launcher, path, points }) => ({ launcher, path, points })) }, null, 2));

it.each(matrix.flatMap(suite => suite.points.map(point => ({ ...suite, point, ordinal: point.id + 1 }))))('$launcher cancels startup await $ordinal on line $point.line', async ({ entry, code, point }) => {
  const result = await run(entry, code, point.id);
  expect(result.visits).toContain(point.id);
  expect(result.trees.filter(tree => tree.alive)).toEqual([]);
  expect(result.observations.filter(value => value.alive.length)).toEqual([]);
  expect(result.finalizerErrors.some(error => error.includes('not registered'))).toBe(false);
  if (result.forcedExpected) {
    expect(result.stopErrors.some(error => error.includes('SIGKILL'))).toBe(true);
    expect(result.finalizerErrors.some(error => error.includes('SIGKILL'))).toBe(true);
    if (result.exits.length) expect(result.exits.every(code => code !== 0)).toBe(true);
  }
  expect(result.scratch).toEqual([]);
  expect(result.observations.filter(value => value.step === 'exit' && value.scratch.length)).toEqual([]);
});

it.each(matrix.filter(suite => suite.entry !== 'benchmarkBrowser'))('$launcher removes every group when cancelled after startup', async ({ entry, code }) => {
  const result = await run(entry, code, 'ready');
  expect(result.trees.filter(tree => tree.alive)).toEqual([]);
  expect(result.observations.filter(value => value.alive.length)).toEqual([]);
  expect(result.finalizerErrors.some(error => error.includes('not registered'))).toBe(false);
  if (result.forcedExpected) {
    expect(result.stopErrors.some(error => error.includes('SIGKILL'))).toBe(true);
    expect(result.finalizerErrors.some(error => error.includes('SIGKILL'))).toBe(true);
    if (result.exits.length) expect(result.exits.every(code => code !== 0)).toBe(true);
  }
  expect(result.scratch).toEqual([]);
  expect(result.observations.filter(value => value.step === 'exit' && value.scratch.length)).toEqual([]);
});
