import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { createProcessOwner, spawnOwned } from '../scripts/owned-process';

it.each([
  { scenario: 'handles SIGTERM while waiting for its benchmark child', interrupt: true, expectedCode: 143, diagnostic: '' },
  { scenario: 'fails when its benchmark child exits 17', interrupt: false, expectedCode: 1, diagnostic: 'Owned process exited 17' },
])('$scenario without a pending launch deadline', async ({ interrupt, expectedCode, diagnostic }) => {
  const owner = createProcessOwner();
  await mkdir('.cache', { recursive: true });
  const fixture = await mkdtemp(resolve('.cache/compare-wait-'));
  const id = `owned-wait-${fixture.split('-').at(-1)!.toLowerCase()}`;
  owner.addCleanup('Comparison fixture removal', 'cleanup', () => rm(fixture, { recursive: true, force: true }));
  owner.addCleanup('Comparison evidence removal', 'cleanup', () => rm(resolve('evidence/bench/hillclimb', id), { recursive: true, force: true }));
  let errors = '', code: number | null | undefined, signal: NodeJS.Signals | null | undefined, cleanupFailure: unknown;
  try {
    await mkdir(join(fixture, 'scripts'));
    await writeFile(join(fixture, 'scripts/bench.ts'), `process.stdout.write('Owned comparison fixture ready\\n'); ${interrupt ? 'setInterval(() => {}, 1000)' : 'process.exit(17)'};\n`);
    const child = spawnOwned(owner, process.execPath, ['--import', 'tsx', 'scripts/bench-compare.ts', id, relative(resolve('.'), fixture), relative(resolve('.'), fixture), 'api.fixture'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stderr!.on('data', chunk => { errors += String(chunk); });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Comparison fixture did not start: ${errors}`)), 10000);
      child.stdout!.on('data', chunk => { output += String(chunk); if (output.includes('Owned comparison fixture ready')) { clearTimeout(timeout); resolve(); } });
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Comparison exited before its child was ready: ${code}: ${errors}`)); });
    });
    const closed = once(child, 'close', { signal: AbortSignal.timeout(10000) });
    if (interrupt) expect(child.kill('SIGTERM')).toBe(true);
    [code, signal] = await closed;
  } finally { await owner.stop().catch(error => { cleanupFailure = error; }); }
  expect(code, errors).toBe(expectedCode);
  expect(signal).toBeNull();
  expect(errors).not.toContain('Owned pending launches');
  if (interrupt) expect(errors).toBe('');
  else expect(errors).toContain(diagnostic);
  expect(cleanupFailure).toBeInstanceOf(AggregateError);
  expect(cleanupFailure).toHaveProperty('message', `Owned process exited ${expectedCode}`);
  expect(owner.groupsGone()).toBe(true);
});
