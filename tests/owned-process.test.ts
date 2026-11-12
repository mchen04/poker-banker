import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { stopOwnedProcess } from '../scripts/owned-process';

async function ownedChild(ignores: boolean) {
  const script = `
    process.on('SIGTERM', () => { ${ignores ? "console.log('ignored signal')" : 'process.exit(0)'}; });
    process.on('message', message => { if (message?.type === 'pb-shutdown') { ${ignores ? "console.log('ignored ipc')" : 'process.exit(0)'}; } });
    console.log('ready');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore', 'ipc'] });
  await once(child.stdout!, 'data', { signal: AbortSignal.timeout(5000) });
  return child;
}

async function forceCleanup(child: ChildProcess, exited: Promise<unknown>) {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await exited;
}

for (const mode of ['signal', 'ipc'] as const) {
  it(`escalates an ignored ${mode} shutdown to SIGKILL and rejects within a bounded interval`, async () => {
    const child = await ownedChild(true);
    const exited = once(child, 'exit');
    const started = performance.now();
    const stopped = stopOwnedProcess(child, mode).then(() => ({ kind: 'success', message: '' }), error => ({ kind: 'rejected', message: String(error.message) }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([stopped, new Promise<{ kind: string; message: string }>(resolve => { timer = setTimeout(() => resolve({ kind: 'pending', message: 'Shutdown did not finish' }), 8000); })]);
      expect(result).toMatchObject({ kind: 'rejected' });
      expect(result.message).toContain('SIGKILL');
      expect(performance.now() - started).toBeGreaterThanOrEqual(2000);
      expect(performance.now() - started).toBeLessThan(8000);
      expect(child.signalCode).toBe('SIGKILL');
      expect(child.listenerCount('error')).toBe(0);
    } finally {
      if (timer) clearTimeout(timer);
      await forceCleanup(child, exited);
      await stopped;
    }
  });

  it(`accepts cooperative ${mode} shutdown and shares concurrent callers`, async () => {
    const child = await ownedChild(false);
    const exited = once(child, 'exit');
    try {
      const first = stopOwnedProcess(child, mode);
      const second = stopOwnedProcess(child, mode);
      expect(second).toBe(first);
      await expect(first).resolves.toBeUndefined();
      expect(child.exitCode).toBe(0);
      expect(child.listenerCount('error')).toBe(0);
    } finally { await forceCleanup(child, exited); }
  });
}
