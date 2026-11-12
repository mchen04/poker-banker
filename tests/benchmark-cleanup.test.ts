import { cleanupLeaves } from './teardown';
import { withShutdownDeadline } from '../scripts/owned-process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { beforeAll, expect, it } from 'vitest';
import { benchmarkStack } from '../scripts/bench/stack';

beforeAll(async () => { await mkdir('.cache', { recursive: true }); });
async function scratch() {
  return (await readdir('.cache')).filter(name => name.startsWith('pg-') || name.startsWith('bench-tls-')).sort();
}
it('removes only its database and TLS scratch after concurrent benchmark stops', async () => {
  const output = await mkdtemp(resolve('.cache/benchmark-cleanup-'));
  const sentinel = await mkdtemp(resolve('.cache/pg-preserved-'));
  let stack: Awaited<ReturnType<typeof benchmarkStack>> | undefined;
  try {
    await writeFile(join(sentinel, 'keep.txt'), 'Other owner');
    const before = await scratch();
    stack = await benchmarkStack(output);
    expect((await stack.client.request('/api/players')).status).toBe(200);
    await Promise.all([stack.stop(), stack.stop()]);
    expect(await scratch()).toEqual(before);
  } finally { try { await stack?.stop(); } finally { await cleanupLeaves(() => rm(output, { recursive: true, force: true }), () => rm(sentinel, { recursive: true, force: true })); } }
});
it('removes database and TLS scratch even when an owned benchmark cleanup fails', async () => {
  const output = await mkdtemp(resolve('.cache/benchmark-cleanup-'));
  const before = await scratch();
  let stack: Awaited<ReturnType<typeof benchmarkStack>> | undefined;
  let calls = 0;
  try {
    stack = await benchmarkStack(output);
    await stack.own(async () => { calls++; throw new Error('Intentional owned resource failure'); });
    const results = await Promise.allSettled([stack.stop(), stack.stop()]);
    expect(results.map(result => result.status)).toEqual(['rejected', 'rejected']);
    expect(calls).toBe(1);
    expect(await scratch()).toEqual(before);
  } finally { await stack?.stop().catch(() => {}); await withShutdownDeadline('Test directory cleanup', () => rm(output, { recursive: true, force: true })); }
});
it('releases database and TLS allocated before an invalid benchmark output path fails', async () => {
  const output = await mkdtemp(resolve('.cache/benchmark-cleanup-'));
  const before = await scratch();
  try {
    await expect(benchmarkStack(join(output, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await scratch()).toEqual(before);
  } finally { await withShutdownDeadline('Test directory cleanup', () => rm(output, { recursive: true, force: true })); }
});

it('bounds a stalled owned resource and still closes the server, database and TLS directory', async () => {
  const output = await mkdtemp(resolve('.cache/benchmark-cleanup-'));
  const before = await scratch();
  let stack: Awaited<ReturnType<typeof benchmarkStack>> | undefined;
  let calls = 0;
  try {
    stack = await benchmarkStack(output);
    await stack.own(() => { calls++; return new Promise(() => {}); });
    await expect(stack.stop()).rejects.toThrow('Owned benchmark cleanup failed');
    expect(calls).toBe(1);
    expect(await scratch()).toEqual(before);
  } finally { await stack?.stop().catch(() => {}); await withShutdownDeadline('Test directory cleanup', () => rm(output, { recursive: true, force: true })); }
});
