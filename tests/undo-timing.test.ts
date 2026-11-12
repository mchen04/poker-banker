import { expect, it } from 'vitest';
import { autoStartedTimer, retainedTimerAfterUndo } from '../src/client/undo-timing';
import { deriveSession, type LedgerEntry, type SessionSettings } from '../src/domain/session';

const startedAt = '2026-11-12T20:02:00.000Z';
const settings: SessionSettings = {
  id: 's', name: 'Game', played_on: '2026-11-12', currency: 'USD', status: 'open',
  location: null, game: null, big_blind_minor: null, started_at: startedAt, ended_at: null,
  closed_balanced: null, closed_at: null, share_token: null, created_at: startedAt, updated_at: startedAt,
};
const buy: LedgerEntry = { id: 'buy', player_id: 'p', kind: 'buy_in', amount_minor: '1000', note: null, method: null, occurred_at: startedAt, voids_entry_id: null, created_at: startedAt, revision: '2' };
const started = { id: 'timer', kind: 'timer_started', revision: '2', created_at: startedAt, detail: { old: { started_at: null, ended_at: null }, new: { started_at: startedAt, ended_at: null } } };
const state = (entries: LedgerEntry[], overrides: Partial<SessionSettings> = {}) => deriveSession({ ...settings, ...overrides }, '2', [{ id: 'p', display_name: 'Player' }], entries, [started], startedAt);

it('recognizes only the timer event belonging to the effective saved buy-in receipt', () => {
  const receipt = state([buy]);
  expect(autoStartedTimer(receipt, 'buy')).toBe(startedAt);
  expect(autoStartedTimer({ ...receipt, events: [{ ...started, detail: { old: { started_at: null }, new: { started_at: '2026-11-12T20:02:00Z' } } }] }, 'buy')).toBe(startedAt);
  expect(autoStartedTimer({ ...receipt, events: [{ ...started, revision: '1' }] }, 'buy')).toBeNull();
  expect(autoStartedTimer({ ...receipt, events: [{ ...started, detail: { old: { started_at: startedAt }, new: { started_at: startedAt } } }] }, 'buy')).toBeNull();
  expect(autoStartedTimer({ ...receipt, events: [] }, 'buy')).toBeNull();
  expect(autoStartedTimer(state([buy], { started_at: '2026-11-12T19:00:00.000Z' }), 'buy')).toBeNull();
  expect(autoStartedTimer(state([{ ...buy, kind: 'payment_in' }]), 'buy')).toBeNull();
});

it('explains a running retained timer only when no effective buy-in remains after Undo', () => {
  const voided = { ...buy, id: 'void', revision: '3', voids_entry_id: 'buy' };
  const undone = state([buy, voided]);
  expect(autoStartedTimer(undone, 'buy')).toBeNull();
  expect(retainedTimerAfterUndo(undone, autoStartedTimer(state([buy]), 'buy'))).toBe(startedAt);
  expect(retainedTimerAfterUndo(state([buy]), startedAt)).toBeNull();
  expect(retainedTimerAfterUndo(state([buy, voided, { ...buy, id: 'replacement', revision: '4' }]), startedAt)).toBeNull();
  expect(retainedTimerAfterUndo(undone, null)).toBeNull();
  expect(retainedTimerAfterUndo(state([buy, voided], { ended_at: startedAt }), startedAt)).toBeNull();
  expect(retainedTimerAfterUndo(state([buy, voided], { started_at: '2026-11-12T19:00:00.000Z' }), startedAt)).toBeNull();
});
