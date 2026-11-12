import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import { expect, it } from 'vitest';
import { stopOwnedProcess, withShutdownDeadline } from '../scripts/owned-process';

function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}

async function listening(port: number) {
  return new Promise<boolean>((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
    socket.setTimeout(500, () => { socket.destroy(); reject(new Error('Owned descendant port check timed out')); });
  });
}

async function cleanup(child: ChildProcess, group: boolean, descendant?: number) {
  const exited = child.exitCode === null && child.signalCode === null ? once(child, 'exit') : Promise.resolve();
  try {
    if (group && child.pid && (child.exitCode === null && child.signalCode === null || descendant && alive(descendant))) process.kill(-child.pid, 'SIGKILL');
    else if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  await withShutdownDeadline('Owned group regression cleanup', async () => { await exited; });
}

for (const code of [0, 1]) it(`removes remaining owned group descendants after wrapper exit ${code} and preserves an unrelated sibling`, async () => {
  const sibling = spawn(process.execPath, ['-e', "console.log('ready');setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
  let wrapper: ChildProcess | undefined;
  let descendantPid: number | undefined;
  try {
    await once(sibling.stdout!, 'data', { signal: AbortSignal.timeout(3000) });
    const descendant = `
      const server = require('node:net').createServer(socket => socket.end());
      process.on('SIGTERM', () => {});
      server.listen(0, '127.0.0.1', () => process.send({ descendant: process.pid, port: server.address().port }));
    `;
    const script = `
      const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      child.on('message', message => process.send(message));
      process.on('message', message => { if (message?.type === 'pb-shutdown') process.exit(${code}); });
    `;
    wrapper = spawn(process.execPath, ['-e', script], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const [message] = await once(wrapper, 'message', { signal: AbortSignal.timeout(3000) }) as [{ descendant: number; port: number }];
    descendantPid = message.descendant;
    expect(await listening(message.port)).toBe(true);
    const outcome = await stopOwnedProcess(wrapper, 'ipc', true).then(() => ({ ok: true, message: '' }), error => ({ ok: false, message: String(error.message) }));
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain('SIGKILL');
    if (code === 1) expect(outcome.message).toContain('Owned process exited 1');
    expect(alive(sibling.pid!)).toBe(true);
    expect(await listening(message.port)).toBe(false);
    expect(alive(message.descendant)).toBe(false);
  } finally {
    if (wrapper) await cleanup(wrapper, true, descendantPid);
    await cleanup(sibling, false);
  }
});
