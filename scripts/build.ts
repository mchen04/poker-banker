import { ownedMain, runOwned } from './owned-command';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'vite';
import { generateIcons } from './icons';

const pkg = JSON.parse(await readFile('package.json', 'utf8')) as { version: string };
const supplied = process.env.RELEASE_VERSION;
const release = supplied === undefined ? `${pkg.version}-${Date.now()}` : supplied.trim();
if (!release || !/^[a-zA-Z0-9._-]{1,100}$/.test(release)) throw new Error('A nonempty release version is required');
process.env.RELEASE_VERSION = release;
await ownedMain(async owner => {
  await runOwned(owner, process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit'], { stdio: 'inherit' });
  await generateIcons();
  await owner.launch(() => build());
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

});
