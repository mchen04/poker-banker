import { afterEach, expect, it, vi } from 'vitest';
import { closeOwnedServer } from '../scripts/close-server';
import { SHUTDOWN_GRACE_MS } from '../scripts/owned-process';
import { cleanupLeaves } from './teardown';

afterEach(() => { vi.useRealTimers(); });

it('bounds a stalled server close and releases its owned connections', async () => {
  vi.useFakeTimers();
  const closeAllConnections = vi.fn();
  const result = closeOwnedServer({ close: () => {}, closeAllConnections });
  const rejected = expect(result).rejects.toThrow('Owned server close exceeded shutdown deadline');
  await vi.advanceTimersByTimeAsync(SHUTDOWN_GRACE_MS);
  await rejected;
  expect(closeAllConnections).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('preserves server errors while releasing owned connections', async () => {
  const closeAllConnections = vi.fn();
  await expect(closeOwnedServer({ close: callback => callback(new Error('close failed')), closeAllConnections })).rejects.toThrow('close failed');
  expect(closeAllConnections).toHaveBeenCalledOnce();
});

it('accepts a completed close without leaving a timer', async () => {
  vi.useFakeTimers();
  await expect(closeOwnedServer({ close: callback => callback() })).resolves.toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
});

it('finishes the other cleanup leaves before reporting a stalled resource', async () => {
  vi.useFakeTimers();
  const closed: string[] = [];
  const result = cleanupLeaves(() => new Promise(() => {}), () => { closed.push('second'); });
  const rejected = expect(result).rejects.toThrow('Test cleanup failed');
  await vi.advanceTimersByTimeAsync(SHUTDOWN_GRACE_MS);
  await rejected;
  expect(closed).toEqual(['second']);
  expect(vi.getTimerCount()).toBe(0);
});
