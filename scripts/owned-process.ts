import type { ChildProcess } from 'node:child_process';

export const SHUTDOWN_GRACE_MS = 3000;

export async function withShutdownDeadline<T>(label: string, action: () => Promise<T> | T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(action),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded shutdown deadline (${SHUTDOWN_GRACE_MS}ms)`)), SHUTDOWN_GRACE_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const stopping = new WeakMap<ChildProcess, Promise<void>>();
export function stopOwnedProcess(child: ChildProcess, mode: 'ipc' | 'signal' = 'ipc', processGroup = false): Promise<void> {
  const previous = stopping.get(child);
  if (previous) return previous;
  const pending = Promise.resolve().then(async () => {
    if (!child.pid) throw new Error('Owned process failed to start');
    const running = () => child.exitCode === null && child.signalCode === null;
    type Exit = { code: number | null; signal: NodeJS.Signals | null };
    let resolveExit!: (result: Exit) => void;
    let resolveError!: (error: Error) => void;
    const exit = new Promise<Exit>(resolve => { resolveExit = resolve; });
    const failure = new Promise<{ error: Error }>(resolve => { resolveError = error => resolve({ error }); });
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => resolveExit({ code, signal });
    const onError = (error: Error) => resolveError(error);
    let sentSignal = false;
    let acceptingDispatch = true;
    child.once('exit', onExit);
    child.on('error', onError);
    if (!running()) resolveExit({ code: child.exitCode, signal: child.signalCode });
    const sendSignal = () => {
      sentSignal = child.kill('SIGTERM');
      if (!sentSignal && running()) throw new Error('Owned process could not receive SIGTERM');
    };
    try {
      let result: Exit;
      try {
        const outcome = await withShutdownDeadline('Owned process shutdown', () => {
          if (running()) {
            if (mode === 'signal' || !child.connected) sendSignal();
            else child.send({ type: 'pb-shutdown' }, error => {
              if (!error || !acceptingDispatch || !running()) return;
              try {
                if (!child.connected) sendSignal();
                else resolveError(error);
              } catch (dispatchError) {
                resolveError(dispatchError instanceof Error ? dispatchError : new Error(String(dispatchError)));
              }
            });
          }
          return Promise.race([exit, failure]);
        });
        if ('error' in outcome) throw outcome.error;
        result = outcome;
      } catch (error) {
        acceptingDispatch = false;
        if (!running()) throw error;
        let killFailure = '';
        try {
          const killed = processGroup ? process.kill(-child.pid, 'SIGKILL') : child.kill('SIGKILL');
          if (!killed) killFailure = '; SIGKILL could not be sent';
        } catch (killError) {
          killFailure = `; SIGKILL failed: ${killError instanceof Error ? killError.message : String(killError)}`;
        }
        try {
          await withShutdownDeadline('Owned process SIGKILL exit', () => exit);
        } catch {
          throw new Error(`Owned process still running after SIGKILL${killFailure}`);
        }
        throw new Error(`Owned process required SIGKILL: ${error instanceof Error ? error.message : String(error)}${killFailure}`);
      } finally {
        acceptingDispatch = false;
      }
      if (result.code !== 0 && !(sentSignal && result.signal === 'SIGTERM')) throw new Error(`Owned process exited ${result.code ?? result.signal}`);
    } finally {
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
    }
  });
  stopping.set(child, pending);
  return pending;
}

stopOwnedProcess.withDeadline = withShutdownDeadline;
