import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { migrate } from '../scripts/migrate';
import { SHUTDOWN_GRACE_MS, withShutdownDeadline } from '../scripts/owned-process';
import type { Database } from '../src/server/db';

for (const phase of ['unlock', 'rollback'] as const) it(`bounds a stalled migration ${phase} and discards its connection`, async () => {
  await mkdir('.cache', { recursive: true });
  const directory = await mkdtemp(resolve('.cache/migrations-'));
  const released: boolean[] = [];
  const queries: string[] = [];
  const original = new Error('migration failed');
  const client = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql === 'broken migration') throw original;
      if (phase === 'unlock' && sql.includes('pg_advisory_unlock') || phase === 'rollback' && sql === 'ROLLBACK') return new Promise(() => {});
      return { rowCount: 0 };
    },
    release: (discard: boolean) => { released.push(discard); },
  };
  try {
    if (phase === 'rollback') await writeFile(`${directory}/0001_broken.sql`, 'broken migration');
    const started = performance.now();
    const result = await migrate({ connect: async () => client } as unknown as Database, directory).then(() => undefined, error => error as Error);
    expect(result).toBeInstanceOf(Error);
    expect(performance.now() - started).toBeLessThan(SHUTDOWN_GRACE_MS + 2000);
    expect(released).toEqual([true]);
    if (phase === 'rollback') {
      expect(result).toBeInstanceOf(AggregateError);
      expect((result as AggregateError).errors).toContain(original);
      expect(queries.some(sql => sql.includes('pg_advisory_unlock'))).toBe(false);
    } else expect(result!.message).toContain('Migration advisory unlock exceeded shutdown deadline');
  } finally { await withShutdownDeadline('Migration fixture cleanup', () => rm(directory, { recursive: true, force: true })); }
});
