import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { SHUTDOWN_GRACE_MS, stopOwnedProcess, withShutdownDeadline } from '../scripts/owned-process';

function ownedProcess() {
  const kill = vi.fn(() => true);
  const send = vi.fn();
  const child = Object.assign(new EventEmitter(), {
    pid: 12345,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    connected: true,
    kill,
    send,
  }) as unknown as ChildProcess;
  return { child, kill, send };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('forces an IPC child whose send callback never fires and rejects even when forced exit reports zero', async () => {
  vi.useFakeTimers();
  const { child, kill, send } = ownedProcess();
  kill.mockImplementation(() => {
    Object.assign(child, { exitCode: 0 });
    child.emit('exit', 0, null);
    return true;
  });
  const stopped = stopOwnedProcess(child);
  const rejection = expect(stopped).rejects.toThrow('SIGKILL');
  await vi.advanceTimersByTimeAsync(SHUTDOWN_GRACE_MS);
  await rejection;
  expect(send).toHaveBeenCalledOnce();
  expect(kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
  expect(child.listenerCount('exit')).toBe(0);
  expect(child.listenerCount('error')).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([false, true])('bounds the exit wait when SIGKILL returns %s without an exit event', async killed => {
  vi.useFakeTimers();
  const { child, kill } = ownedProcess();
  kill.mockReturnValue(killed);
  const stopped = stopOwnedProcess(child);
  const rejection = expect(stopped).rejects.toThrow('still running after SIGKILL');
  await vi.advanceTimersByTimeAsync(SHUTDOWN_GRACE_MS);
  expect(kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
  await vi.advanceTimersByTimeAsync(SHUTDOWN_GRACE_MS);
  await rejection;
  expect(child.listenerCount('exit')).toBe(0);
  expect(child.listenerCount('error')).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it('forces the child after a synchronous dispatch failure', async () => {
  vi.useFakeTimers();
  const { child, kill, send } = ownedProcess();
  send.mockImplementation(() => { throw new Error('send failed'); });
  kill.mockImplementation(() => {
    Object.assign(child, { signalCode: 'SIGKILL' });
    child.emit('exit', null, 'SIGKILL');
    return true;
  });
  await expect(stopOwnedProcess(child)).rejects.toThrow('SIGKILL: send failed');
  expect(kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
  expect(child.listenerCount('error')).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it('uses a process group only when explicitly requested', async () => {
  vi.useFakeTimers();
  const { child, kill } = ownedProcess();
  const groupKill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
    if (signal === 0) throw Object.assign(new Error('No owned group'), { code: 'ESRCH' });
    Object.assign(child, { signalCode: 'SIGKILL' });
    child.emit('exit', null, 'SIGKILL');
    return true;
  });
  const rejection = expect(stopOwnedProcess(child, 'ipc', true)).rejects.toThrow('SIGKILL');
  await vi.advanceTimersByTimeAsync(SHUTDOWN_GRACE_MS);
  await rejection;
  expect(groupKill.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([[-12345, 'SIGKILL']]);
  expect(kill).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('bounds group disappearance after a wrapper exits and stops polling after the deadline', async () => {
  vi.useFakeTimers();
  const { child, send } = ownedProcess();
  send.mockImplementation(() => {
    Object.assign(child, { exitCode: 1 });
    child.emit('exit', 1, null);
  });
  const groupKill = vi.spyOn(process, 'kill').mockReturnValue(true);
  const rejected = expect(stopOwnedProcess(child, 'ipc', true)).rejects.toThrow('Owned process exited 1; Owned process group exit exceeded shutdown deadline');
  await vi.advanceTimersByTimeAsync(SHUTDOWN_GRACE_MS);
  await rejected;
  await vi.runAllTimersAsync();
  expect(groupKill.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([[-12345, 'SIGKILL']]);
  expect(vi.getTimerCount()).toBe(0);
});

it('accepts an already-gone owned group without signalling a different process', async () => {
  const { child, send } = ownedProcess();
  send.mockImplementation(() => {
    Object.assign(child, { exitCode: 0 });
    child.emit('exit', 0, null);
  });
  const groupKill = vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('No owned group'), { code: 'ESRCH' });
  });
  await expect(stopOwnedProcess(child, 'ipc', true)).resolves.toBeUndefined();
  expect(groupKill).toHaveBeenCalledExactlyOnceWith(-12345, 0);
});

it('waits through a transient permission result while its killed group disappears', async () => {
  vi.useFakeTimers();
  const { child, send } = ownedProcess();
  send.mockImplementation(() => {
    Object.assign(child, { exitCode: 1 });
    child.emit('exit', 1, null);
  });
  let checks = 0;
  const groupKill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
    if (signal !== 0) return true;
    checks++;
    if (checks === 1) return true;
    throw Object.assign(new Error('Owned group state'), { code: checks === 2 ? 'EPERM' : 'ESRCH' });
  });
  const rejected = expect(stopOwnedProcess(child, 'ipc', true)).rejects.toThrow('Owned process exited 1; Owned process group required SIGKILL');
  await vi.advanceTimersByTimeAsync(10);
  await rejected;
  expect(groupKill.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([[-12345, 'SIGKILL']]);
  expect(vi.getTimerCount()).toBe(0);
});

it('consumes late action rejection after its deadline', async () => {
  vi.useFakeTimers();
  const action = () => new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('late failure')), SHUTDOWN_GRACE_MS * 2);
  });
  const rejection = expect(withShutdownDeadline('Late cleanup', action)).rejects.toThrow('Late cleanup exceeded shutdown deadline');
  await vi.advanceTimersByTimeAsync(SHUTDOWN_GRACE_MS);
  await rejection;
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(SHUTDOWN_GRACE_MS);
  expect(vi.getTimerCount()).toBe(0);
});

it('clears the deadline after synchronous action failure and exposes the injected helper alias', async () => {
  vi.useFakeTimers();
  expect(stopOwnedProcess.withDeadline).toBe(withShutdownDeadline);
  await expect(withShutdownDeadline('Cleanup', () => { throw new Error('cleanup failed'); })).rejects.toThrow('cleanup failed');
  expect(vi.getTimerCount()).toBe(0);
});
