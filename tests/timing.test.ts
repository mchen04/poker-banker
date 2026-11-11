import { expect, it } from 'vitest';
import { deriveSession, type LedgerEntry, type SessionSettings } from '../src/domain/session';

const settings: SessionSettings = {
  id: 's', name: 'Game', played_on: '2026-11-10', currency: 'USD', status: 'open',
  location: null, game: null, big_blind_minor: '200', started_at: '2026-11-10T00:00:00.000Z', ended_at: null,
  closed_balanced: null, closed_at: null, share_token: null, created_at: '', updated_at: '',
};
const chip = (id: string, kind: LedgerEntry['kind'], revision: number, occurred_at: string, extra: Partial<LedgerEntry> = {}): LedgerEntry => ({
  id, kind, revision: String(revision), occurred_at, player_id: 'p', amount_minor: '1000', method: null, note: null,
  created_at: '', voids_entry_id: null, ...extra,
});
const state = (entries: LedgerEntry[], overrides: Partial<SessionSettings> = {}, now = '2026-11-10T06:00:00.000Z') => deriveSession({ ...settings, ...overrides }, '9', [{ id: 'p', display_name: 'Justin' }], entries, [], now);
const hour = (number: number) => `2026-11-10T0${number}:00:00.000Z`;

it('uses player arrival and open interval time while hiding a playing result', () => {
  const result = state([chip('a', 'buy_in', 1, hour(2)), chip('b', 'buy_in', 2, hour(3))]);
  expect(result.timing.elapsed_ms).toBe('21600000');
  expect(result.players[0]).toMatchObject({ state: 'playing', duration_ms: '14400000', intervals: [{ started_at: hour(2), ended_at: null }], performance: { result_minor: null, per_hour: null, big_blinds: null } });
});
it('caps an open player interval at a persisted end and exposes no invented result', () => {
  const result = state([chip('a', 'buy_in', 1, hour(2))], { ended_at: hour(4) });
  expect(result.players[0]!.duration_ms).toBe('7200000');
  expect(result.timing.elapsed_ms).toBe('14400000');
  expect(result.players[0]!.performance.result_minor).toBeNull();
});
it('does not invent player duration for a lone cash-out or missing blind', () => {
  const result = state([chip('a', 'cash_out', 1, hour(2))], { big_blind_minor: null });
  expect(result.players[0]).toMatchObject({ state: 'cashed_out', result_minor: '1000', duration_ms: null, intervals: [], performance: { per_hour: null, big_blinds: null } });
});
it('keeps timestamp-tied chip order through amount-only correction chains', () => {
  const entries = [
    chip('a', 'buy_in', 1, hour(1)), chip('b', 'cash_out', 2, hour(1)),
    chip('void-a', 'buy_in', 3, hour(1), { voids_entry_id: 'a' }), chip('c', 'buy_in', 3, hour(1), { amount_minor: '1100' }),
    chip('void-c', 'buy_in', 4, hour(1), { voids_entry_id: 'c', amount_minor: '1100' }), chip('d', 'buy_in', 4, hour(1), { amount_minor: '1200' }),
  ];
  expect(state(entries).players[0]).toMatchObject({ state: 'cashed_out', result_minor: '-200', duration_ms: '0' });
});
it('preserves a cash-out before a timestamp-tied re-entry when correcting the cash-out', () => {
  const entries = [
    chip('a', 'buy_in', 1, hour(1)), chip('b', 'cash_out', 2, hour(2)), chip('c', 'buy_in', 3, hour(2)),
    chip('void-b', 'cash_out', 4, hour(2), { voids_entry_id: 'b' }), chip('d', 'cash_out', 4, hour(2), { amount_minor: '1200' }),
  ];
  const result = state(entries).players[0]!;
  expect(result).toMatchObject({ state: 'playing', duration_ms: '18000000' });
  expect(result.intervals).toEqual([{ started_at: hour(1), ended_at: hour(2) }, { started_at: hour(2), ended_at: null }]);
});
it('uses corrected occurrence time ahead of original revision and removes voided intervals', () => {
  const entries = [
    chip('a', 'buy_in', 1, hour(1)), chip('b', 'cash_out', 2, hour(2)),
    chip('void-a', 'buy_in', 3, hour(1), { voids_entry_id: 'a' }), chip('c', 'buy_in', 3, hour(3)),
  ];
  const result = state(entries).players[0]!;
  expect(result).toMatchObject({ state: 'playing', duration_ms: '10800000' });
  expect(result.intervals).toEqual([{ started_at: hour(3), ended_at: null }]);
});
it('marks unavailable time when the supplied server time precedes the recorded start', () => {
  const result = state([chip('a', 'buy_in', 1, hour(2))], { started_at: hour(2) }, hour(1));
  expect(result.timing.elapsed_ms).toBeNull();
  expect(result.players[0]!.duration_ms).toBeNull();
});
