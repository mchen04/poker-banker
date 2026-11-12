import { closeOwnedServer } from '../scripts/close-server';
import { fileURLToPath } from 'node:url';
import { rm } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { createServer } from 'node:net';
import type { ChildProcess } from 'node:child_process';
import pg from 'pg';
import { createPool } from '../src/server/db';
import { migrate } from '../scripts/migrate';
import { createProcessOwner, spawnOwned, type ProcessOwner } from '../scripts/owned-process';

async function availablePort(): Promise<number> {
  const server = createServer();
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    return address.port;
  } finally { await closeOwnedServer(server); }
}

export async function testDatabase(options: { migrationDirectory?: string; postgresFlags?: string[]; owner?: ProcessOwner } = {}) {
  const owner = options.owner ?? createProcessOwner();
  let pool: pg.Pool | undefined;
  let worker: ChildProcess | undefined;
  let ownedDirectory: string | undefined;
  owner.addCleanup('Owned database directory cleanup', 'cleanup', () => ownedDirectory ? rm(ownedDirectory, { recursive: true, force: true }) : undefined);
  owner.addCleanup('Owned database worker shutdown', 'database', () => {
    const child = worker;
    if (!child || child.exitCode !== null || child.signalCode !== null || !child.connected) return;
    return new Promise<void>((resolve, reject) => {
      child.once('exit', () => resolve());
      child.send({ type: 'pb-shutdown' }, error => { if (error) reject(error); });
    });
  });
  const stop = () => owner.stop();
  try {
    const port = await owner.launch(availablePort);
    const child = await owner.launch(() => {
      const child = spawnOwned(owner, process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../scripts/test-postgres.ts', import.meta.url)), String(port), JSON.stringify(options.postgresFlags ?? [])], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      worker = child;
      child.on('message', message => {
        if (message && typeof message === 'object' && 'type' in message && message.type === 'pb-postgres-directory' && 'directory' in message && typeof message.directory === 'string') {
          const path = resolve(message.directory);
          if (dirname(path) === resolve('.cache') && /^pg-[a-zA-Z0-9]+$/.test(basename(path))) ownedDirectory = path;
        }
      });
      return child;
    }, 'database');
    let output = '';
    child.stderr!.on('data', chunk => { output += String(chunk); });
    const directory = await owner.launch(() => new Promise<string>((resolve, reject) => {
      const finish = (error?: Error, path?: string) => {
        child.removeListener('error', onError);
        child.removeListener('exit', onExit);
        child.removeListener('message', onMessage);
        if (error) reject(error); else resolve(path!);
      };
      const onError = (error: Error) => finish(error);
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => finish(new Error(`Owned Postgres exited ${code ?? signal}${output ? `: ${output}` : ''}`));
      const onMessage = (message: unknown) => {
        if (!message || typeof message !== 'object' || !('type' in message)) return;
        if (message.type === 'pb-postgres-ready' && 'directory' in message && typeof message.directory === 'string') finish(undefined, message.directory);
        if (message.type === 'pb-postgres-error') finish(new Error('message' in message ? String(message.message) : 'Owned Postgres startup failed'));
      };
      child.once('error', onError);
      child.once('exit', onExit);
      child.on('message', onMessage);
    }));
    owner.checkpoint();
    pool = createPool(`postgresql://poker:test-only@127.0.0.1:${port}/postgres`, 25);
    owner.addCleanup('Owned database pool shutdown', 'pool', () => pool!.end());
    await owner.launch(() => migrate(pool!, options.migrationDirectory));
    return { pool, directory, owner, stop };
  } catch (error) {
    if (!options.owner) {
      try { await stop(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Owned database startup and cleanup failed'); }
    }
    throw error;
  }
}
