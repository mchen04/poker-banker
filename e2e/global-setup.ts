import { ownedMain, runOwned } from '../scripts/owned-command';

export async function buildRelease(version: string) {
  await ownedMain(owner => runOwned(owner, 'pnpm', ['build'], { stdio: 'inherit', env: { ...process.env, RELEASE_VERSION: version } }));
}
export default async function globalSetup() { await buildRelease('e2e-A'); }
