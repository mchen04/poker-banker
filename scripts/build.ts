import { ownedMain, runOwned } from './owned-command';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { build, type PluginOption } from 'vite';
import { pathToFileURL } from 'node:url';
import type { ProcessOwner } from './owned-process';
import { generateIcons } from './icons';

export async function buildProduction(owner: ProcessOwner, options: { release: string; plugins?: PluginOption[] }) {
  const release = options.release.trim();
  if (!release || !/^[a-zA-Z0-9._-]{1,100}$/.test(release)) throw new Error('A nonempty release version is required');
  const previous = process.env.RELEASE_VERSION;
  process.env.RELEASE_VERSION = release;
  try {
    await runOwned(owner, process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit'], { stdio: 'inherit' });
    await generateIcons();
    await owner.launch(() => build({ plugins: options.plugins ?? [] }));
    owner.checkpoint();
    async function files(directory: string): Promise<string[]> {
      const entries = await readdir(directory, { withFileTypes: true });
      const nested = await Promise.all(entries.map(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]));
      return nested.flat();
    }
    const precache = (await files('dist')).filter(file => !file.endsWith('/sw.js') && !file.endsWith('.map'))
      .map(file => `/${file.slice('dist/'.length)}`).sort();
    if (!precache.includes('/index.html') || !precache.some(file => /^\/assets\/.+\.(js|css)$/.test(file))) throw new Error('The worker requires a shell and hashed assets to precache');
    const template = await readFile('public/sw.js', 'utf8');
    if (!template.includes('__PB_RELEASE__') || !template.includes('__PB_PRECACHE__')) throw new Error('Worker stamp markers are missing');
    const worker = template.replace('__PB_RELEASE__', JSON.stringify(release)).replace('__PB_PRECACHE__', JSON.stringify(precache));
    if (worker.includes('__PB_RELEASE__') || worker.includes('__PB_PRECACHE__')) throw new Error('Worker stamps are incomplete');
    await writeFile('dist/sw.js', worker);
    console.log(`Built release ${release}; precached ${precache.length} files`);

  } finally {
    if (previous === undefined) delete process.env.RELEASE_VERSION;
    else process.env.RELEASE_VERSION = previous;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pkg = JSON.parse(await readFile('package.json', 'utf8')) as { version: string };
  const release = process.env.RELEASE_VERSION ?? `${pkg.version}-${Date.now()}`;
  await ownedMain(owner => buildProduction(owner, { release }));
}
