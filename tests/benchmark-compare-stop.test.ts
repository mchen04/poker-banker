import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { createProcessOwner, spawnOwned, stopOwned } from '../scripts/owned-process';

it('stops a comparison waiting for its benchmark child without a pending launch deadline', async () => {
  const owner = createProcessOwner();
  await mkdir('.cache', { recursive: true });
  const fixture = await mkdtemp(resolve('.cache/compare-wait-'));
  const id = `owned-wait-${fixture.split('-').at(-1)!.toLowerCase()}`;
  owner.addCleanup('Comparison fixture removal', 'cleanup', () => rm(fixture, { recursive: true, force: true }));
  owner.addCleanup('Comparison evidence removal', 'cleanup', () => rm(resolve('evidence/bench/hillclimb', id), { recursive: true, force: true }));
  try {
    await mkdir(join(fixture, 'scripts'));
    await writeFile(join(fixture, 'scripts/bench.ts'), "process.stdout.write('Owned comparison fixture ready\\n'); setInterval(() => {}, 1000);\n");
    const child = spawnOwned(owner, process.execPath, ['--import', 'tsx', 'scripts/bench-compare.ts', id, relative(resolve('.'), fixture), relative(resolve('.'), fixture), 'api.fixture'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stderr!.on('data', chunk => { errors += String(chunk); });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Comparison fixture did not start: ${errors}`)), 10000);
      child.stdout!.on('data', chunk => { output += String(chunk); if (output.includes('Owned comparison fixture ready')) { clearTimeout(timeout); resolve(); } });
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Comparison exited before its child was ready: ${code}: ${errors}`)); });
    });
    await expect(stopOwned(child)).resolves.toBeUndefined();
    expect(errors).not.toContain('Owned pending launches');
    expect(child.exitCode === 143 || child.signalCode === 'SIGTERM').toBe(true);
  } finally { await owner.stop(); }
});
