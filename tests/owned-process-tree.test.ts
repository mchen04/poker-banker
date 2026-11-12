import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { expect, it } from 'vitest';
import { stopOwnedProcess } from '../scripts/owned-process';

async function bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Owned process tree test timed out')), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
    socket.setTimeout(500, () => { socket.destroy(); reject(new Error('Port probe timed out')); });
  });
}

it('kills an owned wrapper group before its nested shutdown can orphan a listening grandchild', async () => {
  const grandchildScript = `
    const server = require('node:net').createServer(socket => socket.end());
    process.on('SIGTERM', () => {});
    server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
  `;
  const wrapperScript = `
    import { spawn } from 'node:child_process';
    import { stopOwnedProcess } from ${JSON.stringify(new URL('../scripts/owned-process.ts', import.meta.url).href)};
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    child.on('message', message => process.send(message));
    process.on('message', async message => {
      if (message?.type !== 'pb-shutdown') return;
      try { await stopOwnedProcess(child, 'signal'); process.exit(0); }
      catch { process.exit(1); }
    });
  `;
  const wrapper = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', wrapperScript], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const exited = new Promise<void>(resolve => {
    wrapper.once('exit', () => resolve());
    wrapper.once('error', () => resolve());
  });
  let onReady: ((message: unknown) => void) | undefined;
  let onError: ((error: Error) => void) | undefined;
  try {
    const port = await bounded(new Promise<number>((resolve, reject) => {
      onReady = message => {
        if (typeof message === 'object' && message !== null && 'port' in message && typeof message.port === 'number') resolve(message.port);
      };
      onError = reject;
      wrapper.on('message', onReady);
      wrapper.once('error', onError);
    }), 5000);
    expect(await portOpen(port)).toBe(true);
    const started = performance.now();
    await expect(bounded(stopOwnedProcess(wrapper, 'ipc', true), 6000)).rejects.toThrow('SIGKILL');
    expect(performance.now() - started).toBeLessThan(6000);
    expect(wrapper.signalCode).toBe('SIGKILL');
    const portDeadline = performance.now() + 1000;
    let listening = await portOpen(port);
    while (listening && performance.now() < portDeadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
      listening = await portOpen(port);
    }
    expect(listening).toBe(false);
  } finally {
    if (onReady) wrapper.removeListener('message', onReady);
    if (onError) wrapper.removeListener('error', onError);
    if (wrapper.pid) {
      try { process.kill(-wrapper.pid, 'SIGKILL'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
    await bounded(exited, 1500);
  }
}, 15000);
