import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ownedMain, runOwned } from './owned-command';
import type { ProcessOwner } from './owned-process';

export const updateFixtureSources = [
  ['previous', 'dc2082b09d7bf8ad124f0e21f8826ef75c0b4e1f'],
  ['legacy', '30209c1bff774172c89e8dba1901a1e597e860b6'],
] as const;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export async function prepareUpdateFixtures(owner: ProcessOwner, repo: string, destination: string, sources: ReadonlyArray<readonly [string, string]> = updateFixtureSources) {
  await mkdir(destination, { recursive: true });
  const manifests: Record<string, string> = {};
  for (const [label, source] of sources) {
    if (!['previous', 'legacy'].includes(label) || !/^[a-f0-9]{40}$/.test(source)) throw new Error('Update fixtures require named, complete pinned source commits');
    owner.checkpoint();
    const target = join(destination, label);
    await mkdir(target, { recursive: true });
    const scratch = await mkdtemp(join(destination, '.prepare-'));
    owner.addCleanup('Update input staging cleanup', 'cleanup', () => rm(scratch, { recursive: true, force: true }));
    const archive = join(scratch, 'previous.tar');
    await runOwned(owner, 'git', ['archive', '--format=tar', '--output', archive, source], { cwd: repo });
    const entries = (await runOwned(owner, 'tar', ['-tf', archive])).split('\n').filter(Boolean);
    if (entries.some(path => path.startsWith('/') || path.split('/').some(part => part === '..' || part.startsWith('.env') || part === '.git' || part === '.vercel'))) throw new Error('Update fixture archive contains an unsafe or credential path');
    const manifest = join(scratch, 'manifest.json');
    const bytes = Buffer.from(`${JSON.stringify({ sourceSha: source, archive: 'previous.tar', archiveSha256: hash(await readFile(archive)) }, null, 2)}\n`);
    owner.checkpoint();
    await writeFile(manifest, bytes);
    manifests[label] = hash(bytes);
    owner.checkpoint();
    await rename(archive, join(target, 'previous.tar'));
    await rename(manifest, join(target, 'manifest.json'));
  }
  return manifests;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await ownedMain(async owner => {
    const timer = setTimeout(() => { process.exitCode = 1; console.error('Pinned update archive preparation exceeded 15 seconds'); owner.cancel(); }, 15000);
    try {
      await prepareUpdateFixtures(owner, process.cwd(), resolve('.cache/mini-update-fixtures'));
      console.log('Prepared pinned public update archives');
    } finally { clearTimeout(timer); }
  }).catch(() => { console.error(`Cannot prepare pinned update archives. The local Git checkout must contain ${updateFixtureSources.map(([, source]) => source).join(' and ')}.`); process.exitCode = 1; });
}
