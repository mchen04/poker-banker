import type { ChildProcess } from 'node:child_process';

const stopping = new WeakMap<ChildProcess, Promise<void>>();
export function stopOwnedProcess(child: ChildProcess, mode: 'ipc' | 'signal' = 'ipc'): Promise<void> {
  const previous = stopping.get(child);
  if (previous) return previous;
  const pending = (async () => {
    if (!child.pid) throw new Error('Owned process failed to start');
    const running = child.exitCode === null && child.signalCode === null;
    const exit = !running
      ? Promise.resolve({ code: child.exitCode, signal: child.signalCode })
      : new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve({ code, signal }));
      });
    let sentSignal = false;
    if (running) {
      if (mode === 'signal') sentSignal = child.kill('SIGTERM');
      else if (child.connected) {
        await new Promise<void>((resolve, reject) => child.send({ type: 'pb-shutdown' }, error => {
          if (error && child.connected) reject(error); else resolve();
        }));
      }
    }
    const result = await exit;
    if (result.code !== 0 && !(sentSignal && result.signal === 'SIGTERM')) throw new Error(`Owned process exited ${result.code ?? result.signal}`);
  })();
  stopping.set(child, pending);
  return pending;
}
