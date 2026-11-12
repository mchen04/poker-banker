import { once } from 'node:events';
import { expect, it, vi } from 'vitest';
import { createProcessOwner, SHUTDOWN_GRACE_MS } from '../scripts/owned-process';

it.each([false, true])('waits for group disappearance after CONT permission failure, persistent=%s', async persistent => {
  const owner = createProcessOwner();
  const child = owner.spawn(process.execPath, ['-e', `process.on('SIGTERM',()=>{${persistent ? '' : 'setTimeout(()=>process.exit(0),50);'}});console.log('ready');setInterval(()=>{},1000);`], { stdio: ['ignore', 'pipe', 'ignore'] });
  const nativeKill = process.kill;
  const delivered: string[] = [];
  let spy: { mockRestore: () => void } | undefined;
  try {
    await once(child.stdout!, 'data', { signal: AbortSignal.timeout(3000) });
    spy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === -child.pid! && typeof signal === 'string') {
        delivered.push(signal);
        if (signal === 'SIGCONT') throw Object.assign(new Error('Fixture CONT permission failure'), { code: 'EPERM' });
      }
      return nativeKill.call(process, pid, signal);
    });
    const start = performance.now();
    if (persistent) {
      await expect(owner.stop()).rejects.toThrow('SIGKILL');
      expect(performance.now() - start).toBeGreaterThanOrEqual(SHUTDOWN_GRACE_MS);
      expect(delivered).toEqual(['SIGTERM', 'SIGCONT', 'SIGKILL']);
    } else {
      await expect(owner.stop()).resolves.toBeUndefined();
      expect(delivered).toEqual(['SIGTERM', 'SIGCONT']);
    }
    expect(() => nativeKill.call(process, -child.pid!, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }));
  } finally {
    spy?.mockRestore();
    await owner.stop().catch(() => {});
  }
});
