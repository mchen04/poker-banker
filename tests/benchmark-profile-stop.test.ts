import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { createProcessOwner, spawnOwned } from '../scripts/owned-process';

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
