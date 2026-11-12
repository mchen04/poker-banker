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

it('lets a pending host capture finish before stopping its process owner', async () => {
  const events: string[] = [];
  let release!: (value: string) => void;
  fixtures.command.mockResolvedValueOnce('').mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }).then(value => { events.push('capture-finished'); return value; }));
  fixtures.stop.mockImplementation(async () => { events.push('owner-stop'); fixtures.controller.abort(); });
  const monitor = await hostMonitor(0, 0, '/owned-engine', () => 'fixture');
  await vi.advanceTimersByTimeAsync(500);
  const stopped = monitor.stop();
  try {
    expect(fixtures.stop).not.toHaveBeenCalled();
    expect(monitor.stop()).toBe(stopped);
    await vi.advanceTimersByTimeAsync(500);
    expect(fixtures.command).toHaveBeenCalledTimes(2);
    expect(fixtures.stop).not.toHaveBeenCalled();
    release('');
    await stopped;
    expect(events).toEqual(['capture-finished', 'owner-stop']);
    expect(fixtures.stop).toHaveBeenCalledOnce();
  } finally { release(''); await stopped.catch(() => {}); }
});

it('preserves owner failure while bounding an unsettled host capture', async () => {
  fixtures.command.mockResolvedValueOnce('').mockImplementationOnce(() => new Promise<string>(() => {}));
  const failure = new Error('Owned process cleanup failed');
  fixtures.stop.mockImplementation(async () => { fixtures.controller.abort(); throw failure; });
  const monitor = await hostMonitor(0, 0, '/owned-engine', () => 'fixture');
  await vi.advanceTimersByTimeAsync(500);
  const result = monitor.stop().then(() => undefined, error => error as AggregateError);
  expect(fixtures.stop).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(SHUTDOWN_GRACE_MS + 1);
  const error = await result;
  expect(error).toBeInstanceOf(AggregateError);
  expect(fixtures.stop).toHaveBeenCalledOnce();
  expect(error!.errors).toContain(failure);
  expect(error!.errors.some((value: unknown) => value instanceof Error && value.message.includes('Benchmark host capture shutdown exceeded shutdown deadline'))).toBe(true);
});

it('preserves a capture rejection during graceful shutdown alongside owner failure', async () => {
  let rejectCapture!: (error: Error) => void;
  fixtures.command.mockResolvedValueOnce('').mockImplementationOnce(() => new Promise<string>((_, reject) => { rejectCapture = reject; }));
  const captureFailure = new Error('Host capture exited nonzero');
  const ownerFailure = new Error('Owned process cleanup failed');
  fixtures.stop.mockImplementation(async () => { fixtures.controller.abort(); throw ownerFailure; });
  const monitor = await hostMonitor(0, 0, '/owned-engine', () => 'fixture');
  await vi.advanceTimersByTimeAsync(500);
  const result = monitor.stop().then(() => undefined, error => error as AggregateError);
  rejectCapture(captureFailure);
  const error = await result;
  expect(error).toBeInstanceOf(AggregateError);
  expect(error!.errors).toEqual(expect.arrayContaining([captureFailure, ownerFailure]));
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
