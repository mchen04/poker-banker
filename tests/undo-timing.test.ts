import { expect, it } from 'vitest';
import { autoStartedTimer, retainedTimerAfterUndo, retainedTimerStart } from '../src/client/undo-timing';
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

it('reconstructs the retained timer notice from the real voided first buy-in receipt', () => {
  const voided = { ...buy, id: 'void', revision: '3', voids_entry_id: 'buy' };
  const payment: LedgerEntry = { ...buy, id: 'paid', kind: 'payment_in', method: 'cash' };
  const receipt = state([buy, payment]);
  const undone = { ...state([voided, { ...payment, id: 'void-paid', revision: '3', voids_entry_id: 'paid' }, ...receipt.entries]), revision: '3' };
  expect(retainedTimerStart(receipt)).toBeNull();
  expect(retainedTimerStart(undone)).toBe(startedAt);
  expect(retainedTimerStart(JSON.parse(JSON.stringify(undone)))).toBe(startedAt);
});

it('clears the retained notice after timing correction even when the time is unchanged', () => {
  const voided = { ...buy, id: 'void', revision: '3', voids_entry_id: 'buy' };
  const undone = state([voided, buy]);
  const corrected = { ...started, id: 'corrected', kind: 'timing_corrected', revision: '4' };
  expect(retainedTimerStart({ ...undone, events: [corrected, started] })).toBeNull();
  const changedAt = '2026-11-12T19:00:00.000Z';
  expect(retainedTimerStart({ ...undone, session: { ...undone.session, started_at: changedAt }, events: [started, { ...corrected, detail: { old: { started_at: startedAt }, new: { started_at: changedAt } } }] })).toBeNull();
});

it('keeps the retained notice through later payments and hides it after a new effective buy-in', () => {
  const voided = { ...buy, id: 'void', revision: '3', voids_entry_id: 'buy' };
  const payment: LedgerEntry = { ...buy, id: 'paid', kind: 'payment_in', revision: '10' };
  const undone = { ...state([payment, voided, buy]), revision: '10', events: [{ ...started, id: 'payment-event', kind: 'payment_recorded', revision: '10' }, started] };
  expect(retainedTimerStart(undone)).toBe(startedAt);
  expect(retainedTimerStart({ ...undone, entries: [{ ...buy, id: 'replacement', revision: '11' }, ...undone.entries] })).toBeNull();
});

it('shows the current manual start only after a buy-in has been undone', () => {
  const manualAt = '2026-11-12T19:00:00.000Z';
  const manual = { ...state([], { started_at: manualAt }), events: [{ ...started, revision: '1', detail: { old: { started_at: null }, new: { started_at: manualAt } } }] };
  expect(retainedTimerStart(manual)).toBeNull();
  expect(retainedTimerStart({ ...manual, entries: [{ ...buy, id: 'void', revision: '3', voids_entry_id: 'buy' }, buy] })).toBe(manualAt);
});

it('compares corrections with the latest void revision exactly without relying on array order', () => {
  const revision = '9007199254740993';
  const voided = { ...buy, id: 'void', revision, voids_entry_id: 'buy' };
  const corrected = { ...started, id: 'corrected', kind: 'timing_corrected', revision: '9007199254740992' };
  const undone = { ...state([voided, buy]), revision, events: [corrected, started] };
  expect(retainedTimerStart(undone)).toBe(startedAt);
  expect(retainedTimerStart({ ...undone, events: [started, { ...corrected, revision: '9007199254740994' }] })).toBeNull();
  const laterBuy = { ...buy, id: 'later-buy', revision: '9007199254740995' };
  const laterVoid = { ...laterBuy, id: 'later-void', revision: '9007199254740996', voids_entry_id: laterBuy.id };
  expect(retainedTimerStart({ ...undone, entries: [laterVoid, buy, laterBuy, voided], events: [{ ...corrected, revision: '9007199254740994' }, started] })).toBe(startedAt);
});

it('requires an open running timer and an actual voided buy-in', () => {
  const entries = [buy, { ...buy, id: 'void', revision: '3', voids_entry_id: 'buy' }];
  expect(retainedTimerStart(state(entries, { status: 'closed' }))).toBeNull();
  expect(retainedTimerStart(state(entries, { ended_at: startedAt }))).toBeNull();
  expect(retainedTimerStart(state(entries, { started_at: null }))).toBeNull();
  expect(retainedTimerStart(state([{ ...buy, kind: 'payment_in' }, { ...buy, kind: 'payment_in', id: 'void', revision: '3', voids_entry_id: 'buy' }]))).toBeNull();
  expect(retainedTimerStart(state([{ ...buy, id: 'void', revision: '3', voids_entry_id: 'buy' }]))).toBeNull();
});
