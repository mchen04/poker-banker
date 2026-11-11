import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, newerSnapshot, pollSession } from '../src/client/data';
import { deriveSession, type SessionSettings } from '../src/domain/session';

const settings: SessionSettings = {
  id: 's', name: 'Game', played_on: '2026-11-10', currency: 'USD', status: 'open', location: null, game: null,
  big_blind_minor: null, started_at: '2026-11-10T00:00:00.000Z', ended_at: null,
  closed_balanced: null, closed_at: null, share_token: null, created_at: '', updated_at: '',
};
const snapshot = (revision: string, time: string) => deriveSession(settings, revision, [], [], [], time);
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('retains the fresher server clock when a lost-response replay has the same revision', () => {
  const initial = snapshot('3', '2026-11-10T01:00:00.000Z');
  const polled = snapshot('3', '2026-11-10T02:00:00.000Z');
  expect(newerSnapshot(polled, initial)).toBe(polled);
  expect(newerSnapshot(initial, polled)).toBe(polled);
  expect(newerSnapshot(polled, initial).timing.elapsed_ms).toBe('7200000');
});
it('prefers a newer ledger revision even if the older revision has a later clock', () => {
  const initial = snapshot('3', '2026-11-10T02:00:00.000Z');
  const updated = snapshot('4', '2026-11-10T01:00:00.000Z');
  expect(newerSnapshot(initial, updated)).toBe(updated);
  expect(newerSnapshot(updated, initial)).toBe(updated);
});
describe('HTTP boundaries', () => {
  it('keeps the timeout active through a stalled JSON response body', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    vi.stubGlobal('fetch', vi.fn(async (_path: string, init: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({ start(controller) {
        init.signal!.addEventListener('abort', () => controller.error(new DOMException('Request timed out', 'AbortError')));
      } });
      return new Response(stream, { headers: { 'Content-Type': 'application/json' } });
    }));
    const pending = api('/api/sessions');
    const failure = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(15000);
    await failure;
  });
  it('preserves API error status and message and accepts unchanged polling', async () => {
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'session_closed', message: 'Reopen this session before writing' } }), { status: 409 })));
    await expect(api('/api/sessions/s/entries', 'POST', {})).rejects.toMatchObject({ status: 409, code: 'session_closed', message: 'Reopen this session before writing' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 304 })));
    expect(await pollSession('/api/sessions/s', '3')).toBeUndefined();
  });
});
