import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { createProcessOwner, spawnOwned, withShutdownDeadline } from '../scripts/owned-process';
import { benchmarkStack } from '../scripts/bench/stack';
import { cleanupLeaves } from './teardown';

describe('benchmark stack cleanup', () => {
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
      stack.owner.addCleanup('Intentional owned resource failure', 'pool', async () => { calls++; throw new Error('Intentional owned resource failure'); });
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
      stack.owner.addCleanup('Stalled owned resource', 'pool', () => { calls++; return new Promise(() => {}); });
      await expect(stack.stop()).rejects.toThrow('Stalled owned resource');
      expect(calls).toBe(1);
      expect(await scratch()).toEqual(before);
    } finally { await stack?.stop().catch(() => {}); await withShutdownDeadline('Test directory cleanup', () => rm(output, { recursive: true, force: true })); }
  });
});

describe('benchmark comparison shutdown', () => {
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
});

describe('profile and verification preflight cancellation', () => {
  function alive(pid: number) {
    try { process.kill(pid, 0); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
  }

  it('closes a TERM-resistant preflight ps before an interrupted profile exits', async () => {
    const owner = createProcessOwner();
    await mkdir('.cache', { recursive: true });
    const fixture = await mkdtemp(resolve('.cache/profile-preflight-'));
    const output = resolve('evidence/bench', `profile-preflight-${fixture.split('-').at(-1)}`);
    const marker = join(fixture, 'ps.pid');
    owner.addCleanup('Profile fixture removal', 'cleanup', () => rm(fixture, { recursive: true, force: true }));
    owner.addCleanup('Profile evidence removal', 'cleanup', () => rm(output, { recursive: true, force: true }));
    try {
      await writeFile(join(fixture, 'ps'), `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nprocess.on('SIGTERM', () => {});\nwriteFileSync(process.env.PB_PROFILE_PS_MARKER, String(process.pid));\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
      const child = spawnOwned(owner, process.execPath, ['--import', 'tsx', 'scripts/bench/players-profile.ts', '--output', output], { env: { ...process.env, PATH: `${fixture}:${process.env.PATH}`, PB_PROFILE_PS_MARKER: marker }, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout!.resume(); child.stderr!.resume();
      let psPid = 0;
      const deadline = Date.now() + 10000;
      while (!psPid && Date.now() < deadline) {
        try { psPid = Number(await readFile(marker, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (!psPid) await pause(10);
      }
      expect(psPid).toBeGreaterThan(0);
      const exited = once(child, 'exit');
      expect(child.kill('SIGTERM')).toBe(true);
      const [code, signal] = await exited;
      expect(code !== 0 || signal !== null).toBe(true);
      expect(alive(psPid)).toBe(false);
    } finally { await owner.stop().catch(() => {}); }
  }, 30000);

  it.each(['doctor', 'launch'] as const)('closes a TERM-resistant ps before verification %s exits', async action => {
    const owner = createProcessOwner();
    await mkdir('.cache', { recursive: true });
    const fixture = await mkdtemp(resolve('.cache/verify-preflight-'));
    const marker = join(fixture, 'ps.pid');
    const id = 'owned-preflight';
    owner.addCleanup('Verification fixture removal', 'cleanup', () => rm(fixture, { recursive: true, force: true }));
    try {
      await mkdir(join(fixture, '.cache/verify'), { recursive: true });
      await writeFile(join(fixture, '.cache/verify', `${id}.json`), JSON.stringify({ runId: id, pid: 123456789, local: true, state: 'ready', baseURL: 'https://127.0.0.1:1' }));
      await writeFile(join(fixture, 'ps'), `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nprocess.on('SIGTERM', () => {});\nwriteFileSync(process.env.PB_PROFILE_PS_MARKER, String(process.pid));\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
      const options = action === 'doctor' ? ['doctor', '--run', id] : ['launch', '--local'];
      const child = spawnOwned(owner, process.execPath, ['--import', 'tsx', resolve('.claude/skills/verify-poker-banker/scripts/control.ts'), ...options], { cwd: fixture, env: { ...process.env, PATH: `${fixture}:${process.env.PATH}`, PB_PROFILE_PS_MARKER: marker }, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout!.resume(); child.stderr!.resume();
      let psPid = 0;
      const deadline = Date.now() + 10000;
      while (!psPid && Date.now() < deadline) {
        try { psPid = Number(await readFile(marker, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (!psPid) await pause(10);
      }
      expect(psPid).toBeGreaterThan(0);
      const exited = once(child, 'exit');
      expect(child.kill('SIGTERM')).toBe(true);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const [code, signal] = await Promise.race([exited, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Verification did not exit after SIGTERM')), 7000); })]);
        expect(code !== 0 || signal !== null).toBe(true);
        expect(alive(psPid)).toBe(false);
      } finally { clearTimeout(timeout); }
    } finally { await owner.stop().catch(() => {}); }
  }, 30000);

  it('rejects a missing verification PID without poisoning parent process cleanup', async () => {
    const owner = createProcessOwner();
    await mkdir('.cache', { recursive: true });
    const fixture = await mkdtemp(resolve('.cache/verify-missing-pid-'));
    const id = 'missing-owned-daemon';
    owner.addCleanup('Missing verification fixture removal', 'cleanup', () => rm(fixture, { recursive: true, force: true }));
    try {
      await mkdir(join(fixture, '.cache/verify'), { recursive: true });
      await writeFile(join(fixture, '.cache/verify', `${id}.json`), JSON.stringify({ runId: id, pid: 2147483647, local: true, state: 'ready', baseURL: 'https://127.0.0.1:1' }));
      const child = spawnOwned(owner, process.execPath, ['--import', 'tsx', resolve('.claude/skills/verify-poker-banker/scripts/control.ts'), 'doctor', '--run', id], { cwd: fixture, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout!.resume();
      let errors = '';
      child.stderr!.on('data', chunk => { errors += String(chunk); });
      const [code] = await once(child, 'close');
      expect(code).not.toBe(0);
      expect(errors).toContain('PID no longer belongs to this verification run');
      expect(errors).not.toContain('Owned process exited 1');
    } finally { await owner.stop().catch(() => {}); }
  }, 10000);
});
