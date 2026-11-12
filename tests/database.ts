import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import pg from 'pg';
import { createPool } from '../src/server/db';
import { migrate } from '../scripts/migrate';
import { stopOwnedProcess } from '../scripts/owned-process';

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}
export async function testDatabase(options: { migrationDirectory?: string; postgresFlags?: string[] } = {}) {
  let child: ReturnType<typeof spawn> | undefined;
  let pool: pg.Pool | undefined;
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => {
    try { if (pool) await stopOwnedProcess.withDeadline('Owned database pool shutdown', () => pool!.end()); }
    finally {
      if (child?.pid) await stopOwnedProcess(child, 'ipc', true);
    }
  })();
  try {
    const port = await availablePort();
    child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../scripts/test-postgres.ts', import.meta.url)), String(port), JSON.stringify(options.postgresFlags ?? [])], { detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let output = '';
    child.stderr!.on('data', chunk => { output += String(chunk); });
    const directory = await new Promise<string>((resolve, reject) => {
      const finish = (error?: Error, directory?: string) => {
        child!.removeListener('error', onError);
        child!.removeListener('exit', onExit);
        child!.removeListener('message', onMessage);
        if (error) reject(error); else resolve(directory!);
      };
      const onError = (error: Error) => finish(error);
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => finish(new Error(`Owned Postgres exited ${code ?? signal}${output ? `: ${output}` : ''}`));
      const onMessage = (message: unknown) => {
        if (!message || typeof message !== 'object' || !('type' in message)) return;
        if (message.type === 'pb-postgres-ready' && 'directory' in message && typeof message.directory === 'string') finish(undefined, message.directory);
        if (message.type === 'pb-postgres-error') finish(new Error('message' in message ? String(message.message) : 'Owned Postgres startup failed'));
      };
      child!.once('error', onError);
      child!.once('exit', onExit);
      child!.on('message', onMessage);
    });
    pool = createPool(`postgresql://poker:test-only@127.0.0.1:${port}/postgres`, 25);
    await migrate(pool, options.migrationDirectory);
    return { pool, directory, stop };
  } catch (error) {
    try { await stop(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Owned database startup and cleanup failed'); }
    throw error;
  }
}
