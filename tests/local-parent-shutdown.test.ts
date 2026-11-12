import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { expect, it } from 'vitest';
import { closeOwnedServer } from '../scripts/close-server';
import { stopOwnedProcess } from '../scripts/owned-process';
import { testDatabase } from './database';

for (const phase of ['ready', 'before-import'] as const) it(`stops its detached local server when the IPC owner dies at ${phase}`, async () => {
  const database = await testDatabase();
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = (socket.address() as { port: number }).port;
  await closeOwnedServer(socket);
  const script = `
    const { spawn } = require('node:child_process');
    const args = ${JSON.stringify(phase === 'ready' ? ['--import', 'tsx', 'src/server/local.ts'] : ['--import', 'tsx', '--input-type=module', '-e', "setTimeout(() => { void import('./src/server/local.ts'); }, 200);"])};
    const child = spawn(process.execPath, args, {
      detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: process.env,
    });
    if (${JSON.stringify(phase)} === 'before-import') process.send({ pid: child.pid });
    let output = '';
    child.stdout.on('data', bytes => {
      output += bytes;
      if (output.includes('Poker banker ready at')) process.send({ pid: child.pid });
    });
    child.stderr.resume();
  `;
  const owner = spawn(process.execPath, ['-e', script], {
    detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...process.env, DATABASE_URL: database.pool.options.connectionString, PORT: String(port) },
  });
  let app: number | undefined;
  try {
    const [message] = await once(owner, 'message', { signal: AbortSignal.timeout(10000) }) as [{ pid: number }];
    app = message.pid;
    const ended = once(owner, 'exit', { signal: AbortSignal.timeout(10000) });
    owner.kill('SIGKILL');
    await ended;
    await expect.poll(() => {
      try { process.kill(app!, 0); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
    }, { timeout: 9000 }).toBe(false);
    expect((await database.pool.query('SELECT 1 AS value')).rows[0]!.value).toBe(1);
  } finally {
    try {
      if (app) {
        try { process.kill(-app, 'SIGKILL'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
      await stopOwnedProcess(owner, 'signal', true).catch(error => {
        if (!String(error).includes('Owned process exited SIGKILL')) throw error;
      });
    } finally { await database.stop(); }
  }
});
