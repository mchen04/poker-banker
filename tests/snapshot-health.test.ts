import { afterEach, expect, it, vi } from 'vitest';
import { deriveSession, type SessionSettings } from '../src/domain/session';

type Opening = { result?: unknown; onsuccess?: () => void; onerror?: () => void; onblocked?: () => void; onupgradeneeded?: (event: { oldVersion: number }) => void };
const settings = (id: string): SessionSettings => ({
  id, name: 'Game', played_on: '2026-11-10', currency: 'USD', status: 'open', location: null, game: null,
  big_blind_minor: null, started_at: null, ended_at: null, closed_balanced: null, closed_at: null,
  share_token: null, deleted_at: null, created_at: '', updated_at: '',
});
function request<T>(value: T) {
  const result: { result?: T; onsuccess?: () => void; onerror?: () => void } = {};
  queueMicrotask(() => { result.result = value; result.onsuccess?.(); });
  return result;
}
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it('skips only the malformed snapshot record', async () => {
  const complete = deriveSession(settings('bad-players'), '1', [], [], [], '2026-11-10T00:30:00.000Z');
  const records = [
    { key: 'banker/a', banker_id: 'banker', state: deriveSession(settings('a'), '2', [], [], [], '2026-11-10T01:00:00.000Z') },
    { key: 'banker/bad-state', banker_id: 'banker', state: null },
    { key: 'banker/bad-session', banker_id: 'banker', state: { revision: '1', session: null } },
    { key: 'banker/bad-revision', banker_id: 'banker', state: { revision: 4, session: { id: 'bad' } } },
    { key: 'banker/bad-players', banker_id: 'banker', state: { ...complete, players: null } },
    { key: 'banker/b', banker_id: 'banker', state: deriveSession(settings('b'), '3', [], [], [], '2026-11-10T02:00:00.000Z') },
  ];
  const db = { transaction: () => ({ objectStore: () => ({ getAll: () => request(records) }) }) };
  vi.stubGlobal('indexedDB', { open() {
    const opening: Opening = {};
    queueMicrotask(() => { opening.result = db; opening.onsuccess?.(); });
    return opening;
  } });
  const { listSnapshots } = await import('../src/client/data');
  expect((await listSnapshots('banker')).map(state => state.session.id)).toEqual(['a', 'b']);
});
