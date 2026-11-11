import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, isProvenNotApplied, newerSnapshot, pollSession } from '../src/client/data';
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

describe('confirmed mutation rejection policy', () => {
  it.each([
    [400, 'invalid_request'], [400, 'outside_timer_bounds'], [404, 'not_found'],
    [409, 'already_seated'], [409, 'session_closed'], [409, 'already_voided'],
    [409, 'revision_mismatch'], [409, 'entries_outside_timing'], [422, 'invalid_player'],
  ])('settles an explicit %i %s rejection even after a lost reply', (status, code) => {
    expect(isProvenNotApplied(new ApiError('Rejected', status, code))).toBe(true);
  });
  it.each([
    [401, 'unauthorized'], [403, 'invalid_origin'], [408, 'request_timeout'],
    [415, 'json_required'], [429, 'auth_locked'], [409, 'idempotency_mismatch'],
    [400, 'request_failed'], [409, 'request_failed'], [404, ''], [409, '   '],
    [500, 'internal_error'], [502, 'bad_gateway'], [503, 'unavailable'],
  ])('keeps %i %s uncertain when it cannot settle a previous attempt', (status, code) => {
    expect(isProvenNotApplied(new ApiError('Unconfirmed', status, code))).toBe(false);
  });
  it.each([new TypeError('Connection lost'), new DOMException('Timed out', 'AbortError'), { status: 409, code: 'already_seated' }])('keeps transport and unverified errors uncertain: %s', problem => {
    expect(isProvenNotApplied(problem)).toBe(false);
  });
  it('does not mistake an HTTP error without an API code for confirmed nonapplication', async () => {
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Gateway refused this request' } }), { status: 409 })));
    let problem: unknown;
    try { await api('/api/sessions/s/players', 'POST', {}); } catch (error) { problem = error; }
    expect(problem).toBeInstanceOf(ApiError);
    expect(isProvenNotApplied(problem)).toBe(false);
  });
});

it.each([null, 409, {}, ['already_seated']])('does not accept a malformed API error code as delivery proof: %s', async code => {
  vi.stubGlobal('window', { setTimeout, clearTimeout });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code, message: 'Unverified failure' } }), { status: 409 })));
  let problem: unknown;
  try { await api('/api/sessions/s/players', 'POST', {}); } catch (error) { problem = error; }
  expect(isProvenNotApplied(problem)).toBe(false);
});
