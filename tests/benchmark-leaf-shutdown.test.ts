import { afterEach, expect, it, vi } from 'vitest';
import { SHUTDOWN_GRACE_MS } from '../scripts/owned-process';

const fixtures = vi.hoisted(() => ({
  remove: vi.fn(),
  exec: vi.fn(() => ''),
  launchServer: vi.fn(),
  connect: vi.fn(),
  launch: vi.fn(),
  newContext: vi.fn(),
}));
vi.mock('node:fs/promises', () => ({
  mkdtemp: async () => '/owned-engine', cp: async () => {},
  readFile: async () => Buffer.from('identical engine'),
  rm: fixtures.remove,
}));
vi.mock('node:child_process', () => ({ execFileSync: fixtures.exec }));
vi.mock('@playwright/test', () => ({
  webkit: { executablePath: () => '/installed/engine/pw_run.sh', launchServer: fixtures.launchServer, connect: fixtures.connect, launch: fixtures.launch },
  devices: { 'iPhone 15': {} }, expect,
  request: { newContext: fixtures.newContext },
}));
import { CpuBudget, isolatedEngine, primeEngine } from '../scripts/bench/profile';
import { LiveClient } from '../scripts/bench/live-client';
import { liveBrowser } from '../scripts/bench/live-browser';

const never = () => new Promise<never>(() => {});
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
async function outcome(task: Promise<unknown>) {
  let result = 'pending';
  const observed = task.then(() => { result = 'resolved'; }, () => { result = 'rejected'; });
  await vi.advanceTimersByTimeAsync(SHUTDOWN_GRACE_MS + 1);
  expect(result).toBe('rejected');
  await observed;
}

it('prime engine shutdown reaches the browser server when its browser close stalls', async () => {
  vi.useFakeTimers();
  const serverClose = vi.fn(async () => {});
  fixtures.launchServer.mockResolvedValue({ wsEndpoint: () => 'owned', close: serverClose });
  fixtures.connect.mockResolvedValue({ newPage: async () => ({ setContent: async () => {}, screenshot: async () => {} }), close: never });
  await outcome(primeEngine({ executable: 'owned' } as Awaited<ReturnType<typeof isolatedEngine>>));
  expect(serverClose).toHaveBeenCalledOnce();
});

it('CPU shaping pause settles when its old loop fails to settle', async () => {
  vi.useFakeTimers();
  const budget = new CpuBudget('/owned-engine', {} as ConstructorParameters<typeof CpuBudget>[1]);
  Object.assign(budget, { loop: never() });
  await outcome(budget.pause());
  expect(fixtures.exec).toHaveBeenCalled();
});

it('exclusive engine directory cleanup has its own bound', async () => {
  vi.useFakeTimers();
  fixtures.remove.mockImplementation(never);
  const engine = await isolatedEngine();
  await outcome(engine.cleanup());
  expect(fixtures.remove).toHaveBeenCalledExactlyOnceWith('/owned-engine', { recursive: true, force: true });
});

it('a live controller disposal has its own bound', async () => {
  vi.useFakeTimers();
  fixtures.newContext.mockResolvedValue({ dispose: never });
  const client = await LiveClient.create('http://127.0.0.1:1234');
  await outcome(client.close());
});

it('live browser failure settles when final browser close stalls', async () => {
  vi.useFakeTimers();
  fixtures.launch.mockResolvedValue({ newContext: async () => { throw new Error('owned context failed'); }, contexts: () => [], close: never });
  const client = { request: async () => ({ status: 200, body: { session: { name: 'Owned' } } }) } as unknown as LiveClient;
  await outcome(liveBrowser(client, { sessionId: 'owned' } as Parameters<typeof liveBrowser>[1], () => {}, false, 1, '/owned-evidence'));
});

it('priming interruption closes its server and any browser connection acquired afterwards', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const serverClose = vi.fn(async () => {});
  const browserClose = vi.fn(async () => {});
  let connected!: (value: { close: typeof browserClose }) => void;
  fixtures.launchServer.mockResolvedValue({ wsEndpoint: () => 'owned', close: serverClose });
  fixtures.connect.mockReturnValue(new Promise(resolve => { connected = resolve; }));
  const task = primeEngine({ executable: 'owned' } as Awaited<ReturnType<typeof isolatedEngine>>, controller.signal);
  const rejected = expect(task).rejects.toThrow('cancel priming');
  await vi.advanceTimersByTimeAsync(0);
  controller.abort(new Error('cancel priming'));
  await rejected;
  expect(serverClose).toHaveBeenCalledOnce();
  connected({ close: browserClose });
  await vi.advanceTimersByTimeAsync(0);
  expect(browserClose).toHaveBeenCalledOnce();
});

it('priming forces its owned browser server after graceful close fails and preserves failure', async () => {
  vi.useFakeTimers();
  const kill = vi.fn(async () => {});
  fixtures.launchServer.mockResolvedValue({ wsEndpoint: () => 'owned', close: never, kill });
  fixtures.connect.mockResolvedValue({ newPage: async () => ({ setContent: async () => {}, screenshot: async () => {} }), close: async () => {} });
  await outcome(primeEngine({ executable: 'owned' } as Awaited<ReturnType<typeof isolatedEngine>>));
  expect(kill).toHaveBeenCalledOnce();
});

it('live controller close reuses its bounded result across cleanup callers', async () => {
  vi.useFakeTimers();
  const dispose = vi.fn(async () => {});
  fixtures.newContext.mockResolvedValue({ dispose });
  const client = await LiveClient.create('http://127.0.0.1:1234');
  const first = client.close();
  expect(client.close()).toBe(first);
  await first;
  expect(dispose).toHaveBeenCalledOnce();
});

it('live browser cleanup closes every context and browser even when one context stalls', async () => {
  vi.useFakeTimers();
  const first = { pages: () => [], close: vi.fn(never) };
  const second = { pages: () => [], close: vi.fn(async () => {}) };
  const browserClose = vi.fn(async () => {});
  fixtures.launch.mockResolvedValue({ newContext: async () => { throw new Error('setup failed'); }, contexts: () => [first, second], close: browserClose });
  const client = { request: async () => ({ status: 200, body: { session: { name: 'Owned' } } }) } as unknown as LiveClient;
  await outcome(liveBrowser(client, { sessionId: 'owned' } as Parameters<typeof liveBrowser>[1], () => {}, false, 1, '/owned-evidence'));
  expect(first.close).toHaveBeenCalledOnce();
  expect(second.close).toHaveBeenCalledOnce();
  expect(browserClose).toHaveBeenCalledOnce();
});

it('a players diagnostic signal leaves a stalled main operation and finishes bounded cleanup', async () => {
  const { readFile } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const { stripTypeScriptTypes } = await import('node:module');
  const { EventEmitter } = await import('node:events');
  const { withShutdownDeadline } = await import('../scripts/owned-process');
  const source = stripTypeScriptTypes(await readFile(new URL('../scripts/bench/players-profile.ts', import.meta.url), 'utf8'));
  const start = source.indexOf('const stackTask = benchmarkStack(output)');
  expect(start).toBeGreaterThan(0);
  vi.useFakeTimers();
  const process = Object.assign(new EventEmitter(), { exitCode: 0 });
  const stop = vi.fn(async () => {});
  const stack = { database: { directory: '/owned-database' }, stop };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const task = new AsyncFunction('benchmarkStack', 'output', 'host', 'withShutdownDeadline', 'process', 'readFile', 'join', 'writeFile', source.slice(start))(
    async () => stack, '/owned-evidence', {}, withShutdownDeadline, process, never, (...parts: string[]) => parts.join('/'), async () => {},
  ) as Promise<void>;
  let result = 'pending';
  const observed = task.then(() => { result = 'resolved'; }, () => { result = 'rejected'; });
  await vi.advanceTimersByTimeAsync(0);
  process.emit('SIGTERM');
  await vi.advanceTimersByTimeAsync(SHUTDOWN_GRACE_MS + 1);
  expect(result).toBe('rejected');
  expect(process.exitCode).toBe(143);
  expect(stop).toHaveBeenCalled();
  await observed;
});
