import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { createProcessOwner, spawnOwned, stopOwned, type ProcessOwner } from './owned-process';

export function waitOwned(child: ChildProcess) {
  return new Promise<number | null>((resolve, reject) => {
    const cleanup = () => { child.removeListener('error', failed); child.removeListener('exit', exited); };
    const failed = (error: Error) => { cleanup(); reject(error); };
    const exited = (code: number | null, signal: NodeJS.Signals | null) => { cleanup(); if (signal) reject(new Error(`Owned command exited ${signal}`)); else resolve(code); };
    child.once('error', failed);
    child.once('exit', exited);
  });
}

export async function runOwned(owner: ProcessOwner, executable: string, args: readonly string[] = [], options: SpawnOptions = {}) {
  const child = spawnOwned(owner, executable, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
  let output = '', errors = '';
  const stdout = (chunk: Buffer) => { output += String(chunk); };
  const stderr = (chunk: Buffer) => { errors += String(chunk); };
  child.stdout?.on('data', stdout);
  child.stderr?.on('data', stderr);
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  try {
    const code = await waitOwned(child);
    await stopOwned(child);
    await closed;
    if (code !== 0) throw new Error(`${executable} exited ${code}${errors ? `\n${errors}` : ''}`);
    return output;
  } finally {
    child.stdout?.removeListener('data', stdout);
    child.stderr?.removeListener('data', stderr);
  }
}

export async function ownedMain<T>(action: (owner: ProcessOwner) => Promise<T>) {
  const owner = createProcessOwner();
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  const handlers = signals.map(signal => {
    const handler = () => {
      process.exitCode = signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 129;
      owner.cancel();
    };
    process.on(signal, handler);
    return { signal, handler };
  });
  const disconnect = () => { process.exitCode = 143; owner.cancel(); };
  const message = (value: unknown) => { if (value && typeof value === 'object' && 'type' in value && value.type === 'pb-shutdown') disconnect(); };
  if (typeof process.send === 'function') { process.on('disconnect', disconnect); process.on('message', message); }
  let abort!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(owner.signal.reason ?? new Error('Owned command interrupted'));
    owner.signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(() => { owner.checkpoint(); return action(owner); }), interrupted]); }
  catch (error) { if (!owner.signal.aborted) throw error; }
  finally {
    try { await owner.stop(); }
    finally {
      owner.signal.removeEventListener('abort', abort);
      for (const { signal, handler } of handlers) process.removeListener(signal, handler);
      process.removeListener('disconnect', disconnect);
      process.removeListener('message', message);
    }
  }
}
