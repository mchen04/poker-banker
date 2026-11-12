import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { buildProduction } from './build';
import { runOwned } from './owned-command';
import type { ProcessOwner } from './owned-process';

export async function buildUpdateRelease(owner: ProcessOwner, release: string, previousDataPath?: string) {
  const source = `export const release = ${JSON.stringify(release)};\n`;
  const probe = `/assets/update-probe-${createHash('sha256').update(source).digest('hex').slice(0, 12)}.js`;
  const discoverySource = `export const purpose = 'discovery';\n${source}`;
  const discoveryProbe = `/assets/update-discovery-${createHash('sha256').update(discoverySource).digest('hex').slice(0, 12)}.js`;
  let previousReader: string | undefined, readerReference: string | undefined;
  await buildProduction(owner, { release, plugins: [{
    name: 'update-journey-lazy-probe',
    buildStart() {
      if (previousDataPath) readerReference = this.emitFile({ type: 'chunk', id: previousDataPath, name: 'previous-storage-reader', preserveSignature: 'strict' });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: probe.slice(1), source });
      this.emitFile({ type: 'asset', fileName: discoveryProbe.slice(1), source: discoverySource });
      if (readerReference) previousReader = `/${this.getFileName(readerReference)}`;
    },
  }] });
  if (previousDataPath && !previousReader) throw new Error('Previous-source reader chunk was not emitted');
  return { release, probe, discoveryProbe, previousReader };
}

export const previousSourceSha = 'dc2082b09d7bf8ad124f0e21f8826ef75c0b4e1f';
export type PreviousSourceInput = { manifest: string; manifestSha256: string };

export async function buildPreviousUpdateRelease(owner: ProcessOwner, release: string, input?: PreviousSourceInput) {
  return buildArchivedUpdateRelease(owner, release, previousSourceSha, input ?? (process.env.PB_UPDATE_PREVIOUS_MANIFEST ? {
    manifest: process.env.PB_UPDATE_PREVIOUS_MANIFEST,
    manifestSha256: process.env.PB_UPDATE_PREVIOUS_MANIFEST_SHA256 ?? '',
  } : undefined));
}

export async function buildArchivedUpdateRelease(owner: ProcessOwner, release: string, sourceSha: string, input?: PreviousSourceInput) {
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error('Archived update source requires a complete commit SHA');
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(release)) throw new Error('Archived update release stamp is invalid');
  await mkdir('.cache', { recursive: true });
  const scratch = await mkdtemp(resolve('.cache/update-previous-'));
  owner.addCleanup('Previous update source cleanup', 'cleanup', () => rm(scratch, { recursive: true, force: true }));
  const archive = join(scratch, 'previous.tar');
  const tree = join(scratch, 'tree');
  await mkdir(tree);
  const sourceInput = input;
  let manifestSha256: string | undefined;
  if (sourceInput) {
    const manifestPath = resolve(sourceInput.manifest);
    if (!manifestPath.startsWith(`${resolve('.cache')}/`)) throw new Error('Previous-source manifest must be inside checkout .cache');
    const bytes = await readFile(manifestPath);
    manifestSha256 = createHash('sha256').update(bytes).digest('hex');
    if (!/^[a-f0-9]{64}$/.test(sourceInput.manifestSha256) || manifestSha256 !== sourceInput.manifestSha256) throw new Error('Previous-source manifest SHA256 mismatch');
    const manifest = JSON.parse(bytes.toString('utf8')) as { sourceSha: string; archive: string; archiveSha256: string };
    if (manifest.sourceSha !== sourceSha || !/^[a-zA-Z0-9._-]+\.tar$/.test(manifest.archive) || !/^[a-f0-9]{64}$/.test(manifest.archiveSha256)) throw new Error(`Previous-source manifest must identify the pinned tracked ${sourceSha} archive`);
    const suppliedArchive = resolve(manifestPath, '..', manifest.archive);
    const archiveBytes = await readFile(suppliedArchive);
    if (createHash('sha256').update(archiveBytes).digest('hex') !== manifest.archiveSha256) throw new Error('Previous-source archive SHA256 mismatch');
    await cp(suppliedArchive, archive);
  } else await runOwned(owner, 'git', ['archive', '--format=tar', '--output', archive, sourceSha]);
  const archiveSha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
  const entries = (await runOwned(owner, 'tar', ['-tf', archive])).split('\n').filter(Boolean);
  if (entries.some(path => path.startsWith('/') || path.split('/').some(part => part === '..' || part.startsWith('.env') || part === '.vercel' || part === '.git'))) throw new Error('Previous-source archive contains an unsafe or credential path');
  await runOwned(owner, 'tar', ['-xf', archive, '-C', tree]);
  await symlink(resolve('node_modules'), join(tree, 'node_modules'), 'dir');
  await runOwned(owner, 'pnpm', ['build'], { cwd: tree, env: { ...process.env, RELEASE_VERSION: release } });
  await rm('dist', { recursive: true, force: true });
  await cp(join(tree, 'dist'), 'dist', { recursive: true });
  return { release, sourceSha, archiveSha256, manifestSha256, previousDataPath: join(tree, 'src/client/data.ts') };
}
