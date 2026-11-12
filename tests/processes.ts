import { afterEach } from 'vitest';
import type { SpawnOptions } from 'node:child_process';
import { createProcessOwner, spawnOwned } from '../scripts/owned-process';
import { runOwned } from '../scripts/owned-command';

const owners = new Set<ReturnType<typeof createProcessOwner>>();
export function spawn(executable: string, args: readonly string[] = [], options: SpawnOptions = {}) {
  const owner = createProcessOwner();
  owners.add(owner);
  return spawnOwned(owner, executable, args, options);
}
export async function execute(executable: string, args: readonly string[] = [], options: SpawnOptions = {}) {
  const owner = createProcessOwner();
  owners.add(owner);
  try { return { stdout: await runOwned(owner, executable, args, options), stderr: '' }; }
  finally { await owner.stop(); }
}

afterEach(async () => {
  const results = await Promise.allSettled([...owners].filter(owner => !owner.groupsGone()).map(owner => owner.stop()));
  owners.clear();
  const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : []);
  if (errors.length) throw new AggregateError(errors, 'Test-owned process cleanup failed');
});
