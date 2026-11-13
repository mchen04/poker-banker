import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { ownedMain, runOwned } from '../scripts/owned-command';
import { withShutdownDeadline } from '../scripts/owned-process';
import { prepareUpdateFixtures } from '../scripts/prepare-update-fixtures';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

it('prepares deterministic tracked-source archives and independent manifest hashes for a Git-less mirror', async () => {
  await mkdir('.cache', { recursive: true });
  const scratch = await mkdtemp(resolve('.cache/update-input-test-'));
  const output = join(scratch, 'mirror/.cache/mini-update-fixtures');
  try {
    await ownedMain(async owner => {
      const repo = join(scratch, 'repo');
      await mkdir(repo);
      await runOwned(owner, 'git', ['init', '-q', repo]);
      await writeFile(join(repo, 'tracked.txt'), 'Archived client source');
      await runOwned(owner, 'git', ['add', 'tracked.txt'], { cwd: repo });
      await runOwned(owner, 'git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Fixture source'], { cwd: repo });
      const source = (await runOwned(owner, 'git', ['rev-parse', 'HEAD'], { cwd: repo })).trim();
      const invoke = () => prepareUpdateFixtures(owner, repo, output, [['previous', source], ['legacy', source]]);
      const hashes = await invoke();
      const expectedArchive = join(scratch, 'expected.tar');
      await runOwned(owner, 'git', ['archive', '--format=tar', '--output', expectedArchive, source], { cwd: repo });
      for (const name of ['previous', 'legacy']) {
        const bytes = await readFile(join(output, name, 'manifest.json'));
        expect(hash(bytes)).toBe(hashes[name]);
        const manifest = JSON.parse(bytes.toString('utf8')) as { sourceSha: string; archive: string; archiveSha256: string };
        expect(manifest.sourceSha).toBe(source);
        expect(manifest.archive).toBe('previous.tar');
        const archive = await readFile(join(output, name, manifest.archive));
        expect(archive).toEqual(await readFile(expectedArchive));
        expect(hash(archive)).toBe(manifest.archiveSha256);
        expect(await runOwned(owner, 'tar', ['-tf', join(output, name, manifest.archive)])).toBe('tracked.txt\n');
      }
      expect(await invoke()).toEqual(hashes);
    });
    expect((await readdir(output)).sort()).toEqual(['legacy', 'previous']);
  } finally { await withShutdownDeadline('Update source test scratch cleanup', () => rm(scratch, { recursive: true, force: true })); }
});

it('reports the required pinned archive instead of a Git exit code when a mirror has no inputs', async () => {
  await mkdir('.cache', { recursive: true });
  const scratch = await mkdtemp(resolve('.cache/update-missing-input-'));
  try {
    const entry = pathToFileURL(resolve('scripts/update-release.ts')).href;
    const ownerModule = pathToFileURL(resolve('scripts/owned-command.ts')).href;
    const source = `import { buildArchivedUpdateRelease } from ${JSON.stringify(entry)}; import { ownedMain } from ${JSON.stringify(ownerModule)}; process.chdir(process.argv[1]); let message = ''; await ownedMain(async owner => { try { await buildArchivedUpdateRelease(owner, 'fixture', 'dc2082b09d7bf8ad124f0e21f8826ef75c0b4e1f'); } catch (error) { message = error.message; } }); console.log(JSON.stringify({ message }));`;
    const result = await ownedMain(owner => runOwned(owner, process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source, scratch], { env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(scratch) } }));
    if (result === undefined) throw new Error('Missing-input probe was interrupted');
    const { message } = JSON.parse(result.trim()) as { message: string };
    expect(message).toContain('Git-less checkout');
    expect(message).toContain('dc2082b09d7bf8ad124f0e21f8826ef75c0b4e1f');
    expect(message).toContain('scripts/mini.sh');
    expect(await readdir(scratch)).toEqual([]);
  } finally { await withShutdownDeadline('Update source test scratch cleanup', () => rm(scratch, { recursive: true, force: true })); }
});
