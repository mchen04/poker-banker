import { afterEach, expect, it, vi } from 'vitest';
import type { BrowserServer } from '@playwright/test';
import { CpuBudget, engineProcesses } from '../scripts/bench/profile';
import { createProcessOwner, type ProcessOwner } from '../scripts/owned-process';
import { runOwned } from '../scripts/owned-command';

vi.mock('../scripts/owned-command', () => ({ runOwned: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.mocked(runOwned).mockReset(); });
const engine = '/exclusive/engine';
const started = 'Thu Nov 12 09:40:00 2026';
const row = (pid: number, executable = `${engine}/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent.Development`, start = started) => `${pid} 999 ${start} ${executable}`;
const server = { process: () => ({ exitCode: null }) } as unknown as BrowserServer;

it('attributes isolated WebKit XPC executables across separate groups and excludes adjacent engine paths', () => {
  const values = engineProcesses([row(201), row(202, '/exclusive/engine-other/WebContent'), row(203, '/original/WebContent'), 'malformed', row(0)].join('\n'), engine);
  expect(values).toEqual([{ pid: 201, group: 999, started, executable: `${engine}/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent.Development` }]);
});

it('resumes individually identified XPC processes after owner cancellation before closing its scanner', async () => {
  const owner = createProcessOwner();
  const scanners = new Set<ProcessOwner>();
  vi.mocked(runOwned).mockImplementation(async scanner => { scanners.add(scanner); expect(scanner.signal.aborted).toBe(false); return row(201); });
  const signal = vi.spyOn(process, 'kill').mockReturnValue(true);
  const budget = await owner.launch(() => new CpuBudget(engine, server, owner));
  owner.addCleanup('CPU pause fixture', 'pool', () => budget.pause());
  try {
    await budget.start();
    await vi.waitFor(() => expect(signal).toHaveBeenCalledWith(201, 'SIGSTOP'));
    owner.cancel();
    await budget.pause();
    expect(signal).toHaveBeenCalledWith(201, 'SIGCONT');
    expect(signal.mock.calls.every(([pid]) => Number(pid) > 0)).toBe(true);
    expect([...scanners].every(scanner => !scanner.signal.aborted)).toBe(true);
    await owner.stop();
    expect([...scanners].every(scanner => scanner.signal.aborted)).toBe(true);
  } finally { await owner.stop(); }
});

it.each(['different start time', 'different executable'])('does not resume a reused PID with %s', async changed => {
  const owner = createProcessOwner();
  let snapshot = row(201);
  vi.mocked(runOwned).mockImplementation(async () => snapshot);
  const signal = vi.spyOn(process, 'kill').mockReturnValue(true);
  const budget = new CpuBudget(engine, server, owner);
  owner.addCleanup('CPU pause fixture', 'pool', () => budget.pause());
  try {
    await budget.start();
    await vi.waitFor(() => expect(signal).toHaveBeenCalledWith(201, 'SIGSTOP'));
    snapshot = changed === 'different start time' ? row(201, undefined, 'Thu Nov 12 09:41:00 2026') : row(201, '/unrelated/WebContent');
    owner.cancel();
    await budget.pause();
    expect(signal).not.toHaveBeenCalledWith(201, 'SIGCONT');
  } finally { await owner.stop(); }
});
