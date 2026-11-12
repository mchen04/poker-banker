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
