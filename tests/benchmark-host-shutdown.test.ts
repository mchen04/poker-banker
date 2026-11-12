import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fixtures = vi.hoisted(() => ({ command: vi.fn(), stop: vi.fn(), controller: new AbortController() }));
vi.mock('../scripts/owned-command', () => ({ runOwned: fixtures.command }));
vi.mock('../scripts/owned-process', async importOriginal => ({
  ...(await importOriginal<typeof import('../scripts/owned-process')>()),
  createProcessOwner: () => ({ signal: fixtures.controller.signal, addCleanup: vi.fn(), stop: fixtures.stop }),
}));
import { SHUTDOWN_GRACE_MS } from '../scripts/owned-process';
import { hostMonitor } from '../scripts/bench/host';

beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); fixtures.controller = new AbortController(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

it('stops the process owner before joining a pending host capture', async () => {
  const events: string[] = [];
  let release!: (value: string) => void;
  fixtures.command.mockResolvedValueOnce('').mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }).then(value => { events.push('capture-finished'); return value; }));
  fixtures.stop.mockImplementation(async () => { events.push('owner-stop'); fixtures.controller.abort(); release(''); });
  const monitor = await hostMonitor(0, 0, '/owned-engine', () => 'fixture');
  await vi.advanceTimersByTimeAsync(500);
  const stopped = monitor.stop();
  try {
    expect(fixtures.stop).toHaveBeenCalledOnce();
    await stopped;
    expect(events).toEqual(['owner-stop', 'capture-finished']);
    expect(monitor.stop()).toBe(stopped);
  } finally { release(''); await stopped.catch(() => {}); }
});

it('preserves owner failure while bounding an unsettled host capture', async () => {
  fixtures.command.mockResolvedValueOnce('').mockImplementationOnce(() => new Promise<string>(() => {}));
  const failure = new Error('Owned process cleanup failed');
  fixtures.stop.mockImplementation(async () => { fixtures.controller.abort(); throw failure; });
  const monitor = await hostMonitor(0, 0, '/owned-engine', () => 'fixture');
  await vi.advanceTimersByTimeAsync(500);
  const result = monitor.stop().then(() => undefined, error => error as AggregateError);
  await vi.advanceTimersByTimeAsync(SHUTDOWN_GRACE_MS + 1);
  const error = await result;
  expect(error).toBeInstanceOf(AggregateError);
  expect(error!.errors).toContain(failure);
  expect(error!.errors.some((value: unknown) => value instanceof Error && value.message.includes('Benchmark host capture shutdown exceeded shutdown deadline'))).toBe(true);
});

it('preserves a capture failure that happened before shutdown', async () => {
  const failure = new Error('Host sampling failed');
  fixtures.command.mockResolvedValueOnce('').mockRejectedValueOnce(failure);
  fixtures.stop.mockImplementation(async () => { fixtures.controller.abort(); });
  const monitor = await hostMonitor(0, 0, '/owned-engine', () => 'fixture');
  await vi.advanceTimersByTimeAsync(500);
  const error = await monitor.stop().then(() => undefined, error => error as AggregateError);
  expect(error).toBeInstanceOf(AggregateError);
  expect(error!.errors).toContain(failure);
});
