import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { expect, it, vi } from 'vitest';
import { SHUTDOWN_GRACE_MS, withShutdownDeadline } from '../scripts/owned-process';

it('awaits the completed verification shutdown response beyond one graceful deadline', async () => {
  const source = stripTypeScriptTypes(await readFile(new URL('../.claude/skills/verify-poker-banker/scripts/control.ts', import.meta.url), 'utf8'));
  const begin = source.indexOf('async function request(');
  const end = source.indexOf('\nasync function files(', begin);
  if (begin < 0 || end < 0) throw new Error('Verification request source was not found');
  vi.useFakeTimers();
  let idle: ReturnType<typeof setTimeout> | undefined;
  let ownerAlive = true;
  let result: unknown;
  const client = Object.assign(new EventEmitter(), {
    setTimeout(ms: number, callback: () => void) { idle = setTimeout(callback, ms); },
    write() {
      setTimeout(() => {
        ownerAlive = false;
        client.emit('data', JSON.stringify({ result: { cleaned: true } }));
        client.emit('end');
      }, SHUTDOWN_GRACE_MS + 1000);
    },
    destroy(error?: Error) { if (idle) clearTimeout(idle); if (error) client.emit('error', error); },
  });
  const request = new Function('createConnection', 'socket', 'withShutdownDeadline', `${source.slice(begin, end)};return request;`)(() => client, 'owned-fixture.sock', withShutdownDeadline) as (command: { action: string }) => Promise<unknown>;
  try {
    const pending = request({ action: 'cleanup' }).then(value => { result = value; }, error => { result = error; });
    client.emit('connect');
    await vi.advanceTimersByTimeAsync(SHUTDOWN_GRACE_MS + 100);
    expect(ownerAlive).toBe(true);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    expect(ownerAlive).toBe(false);
    expect(result).toEqual({ cleaned: true });
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.clearAllTimers(); vi.useRealTimers(); }
});
