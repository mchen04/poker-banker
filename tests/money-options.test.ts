import { describe, expect, it } from 'vitest';
import type { LedgerEntry } from '../src/domain/session';
import { moneyOptions } from '../src/client/money-options';

function entry(id: string, player: string, kind: LedgerEntry['kind'], amount: string, method: LedgerEntry['method'] = null, voids: string | null = null): LedgerEntry {
  return { id, player_id: player, kind, amount_minor: amount, method, revision: id, voids_entry_id: voids, occurred_at: null, note: null, created_at: '2026-11-12T12:00:00Z' };
}

describe('reviewable money defaults', () => {
  it('has no invented session stake and no other player method on an empty history', () => {
    expect(moneyOptions([], 'a')).toEqual({ typicalBuy: undefined, lastBuy: undefined, lastBuyMethod: undefined, method: 'cash' });
    expect(moneyOptions([entry('1', 'b', 'payment_in', '900', 'zelle')], 'a').method).toBe('cash');
  });
  it('uses the player own latest effective method and session most common buy-in', () => {
    const entries = [entry('1', 'a', 'buy_in', '1250'), entry('2', 'a', 'payment_in', '1250', 'venmo'), entry('3', 'b', 'buy_in', '2500'), entry('4', 'b', 'payment_in', '2500', 'zelle'), entry('5', 'a', 'buy_in', '2500')];
    expect(moneyOptions(entries, 'a')).toEqual({ typicalBuy: '2500', lastBuy: '2500', lastBuyMethod: undefined, method: 'venmo' });
  });
  it('excludes voided methods and stakes while retaining a replacement', () => {
    const entries = [entry('1', 'a', 'buy_in', '2500'), entry('2', 'a', 'payment_in', '2500', 'venmo'), entry('3', 'a', 'payment_in', '2500', 'venmo', '2'), entry('4', 'a', 'payment_in', '2500', 'cash'), entry('5', 'b', 'payment_in', '8000', 'zelle')];
    expect(moneyOptions(entries, 'a').method).toBe('cash');
  });
  it('keeps the most recent buy-in suggestion after re-entry regardless of input ordering', () => {
    const entries = [entry('1', 'a', 'buy_in', '10000'), entry('2', 'a', 'cash_out', '15000'), entry('3', 'a', 'buy_in', '10000'), entry('4', 'a', 'buy_in', '5000')];
    expect(moneyOptions(entries, 'a').lastBuy).toBe('5000');
    expect(moneyOptions([...entries].reverse(), 'a').lastBuy).toBe('5000');
  });
  it('knows how the player latest buy-in was received at the table', () => {
    const paid = [entry('1', 'a', 'buy_in', '2500'), { ...entry('2', 'a', 'payment_in', '2500', 'venmo'), revision: '1' }];
    expect(moneyOptions(paid, 'a').lastBuyMethod).toBe('venmo');
    const settledAfterPaid = [...paid, entry('3', 'a', 'payment_in', '500', 'cash')];
    expect(moneyOptions(settledAfterPaid, 'a')).toMatchObject({ lastBuyMethod: 'venmo', method: 'cash' });
    const unpaidAfterPaid = [...paid, entry('3', 'a', 'buy_in', '2500')];
    expect(moneyOptions(unpaidAfterPaid, 'a').lastBuyMethod).toBeUndefined();
    const settledLater = [entry('1', 'a', 'buy_in', '2500'), entry('2', 'a', 'payment_in', '2500', 'cash')];
    expect(moneyOptions(settledLater, 'a').lastBuyMethod).toBeUndefined();
    const voidedPayment = [...paid, { ...entry('4', 'a', 'payment_in', '2500', 'venmo', '2'), revision: '4' }];
    expect(moneyOptions(voidedPayment, 'a').lastBuyMethod).toBeUndefined();
  });
  it('pairs a restored buy-in with a payment only when both were saved together', () => {
    const copy = (id: string, of: LedgerEntry, revision: string): LedgerEntry => ({ ...of, id, revision, restores_entry_id: of.id });
    const removed = (id: string, of: LedgerEntry, revision: string): LedgerEntry => ({ ...of, id, revision, voids_entry_id: of.id });
    const unpaidBuy = entry('1', 'a', 'buy_in', '10000'), laterVenmo = entry('2', 'a', 'payment_in', '10000', 'venmo');
    const settledThenRestored = [unpaidBuy, laterVenmo, removed('3', unpaidBuy, '3'), removed('4', laterVenmo, '3'), copy('5', unpaidBuy, '5'), copy('6', laterVenmo, '5')];
    expect(moneyOptions(settledThenRestored, 'a').lastBuyMethod).toBeUndefined();
    const paidBuy = entry('1', 'a', 'buy_in', '10000'), paidVenmo = { ...entry('2', 'a', 'payment_in', '10000', 'venmo'), revision: '1' };
    const paidThenRestored = [paidBuy, paidVenmo, removed('3', paidBuy, '3'), removed('4', paidVenmo, '3'), copy('5', paidBuy, '5'), copy('6', paidVenmo, '5')];
    expect(moneyOptions(paidThenRestored, 'a').lastBuyMethod).toBe('venmo');
    const restoredAgain = [...paidThenRestored, removed('7', paidThenRestored[4]!, '7'), removed('8', paidThenRestored[5]!, '7'), copy('9', paidThenRestored[4]!, '9'), copy('10', paidThenRestored[5]!, '9')];
    expect(moneyOptions(restoredAgain, 'a').lastBuyMethod).toBe('venmo');
  });
});
