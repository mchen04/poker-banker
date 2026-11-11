import { spawnSync } from 'node:child_process';

export function buildRelease(version: string) {
  const build = spawnSync('pnpm', ['build'], { stdio: 'inherit', env: { ...process.env, RELEASE_VERSION: version } });
  if (build.status !== 0) throw new Error(`Build ${version} failed with exit ${build.status}`);
}
export default function globalSetup() { buildRelease('e2e-A'); }
