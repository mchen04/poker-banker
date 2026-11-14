import { describe, expect, it } from 'vitest';
import type { LedgerEntry } from '../src/domain/session';
import { moneyOptions } from '../src/client/money-options';

function entry(id: string, player: string, kind: LedgerEntry['kind'], amount: string, method: LedgerEntry['method'] = null, voids: string | null = null): LedgerEntry {
  return { id, player_id: player, kind, amount_minor: amount, method, revision: id, voids_entry_id: voids, occurred_at: null, note: null, created_at: '2026-11-12T12:00:00Z' };
}

describe('reviewable money defaults', () => {
  it('has no invented session stake and no other player method on an empty history', () => {
    expect(moneyOptions([], 'a')).toEqual({ typicalBuy: undefined, lastBuy: undefined, lastBuyPaid: false, method: 'cash' });
    expect(moneyOptions([entry('1', 'b', 'payment_in', '900', 'zelle')], 'a').method).toBe('cash');
  });
  it('uses the player own latest effective method and session most common buy-in', () => {
    const entries = [entry('1', 'a', 'buy_in', '1250'), entry('2', 'a', 'payment_in', '1250', 'venmo'), entry('3', 'b', 'buy_in', '2500'), entry('4', 'b', 'payment_in', '2500', 'zelle'), entry('5', 'a', 'buy_in', '2500')];
    expect(moneyOptions(entries, 'a')).toEqual({ typicalBuy: '2500', lastBuy: '2500', lastBuyPaid: false, method: 'venmo' });
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
  it('knows whether the player latest buy-in was received at the table', () => {
    const paid = [entry('1', 'a', 'buy_in', '2500'), { ...entry('2', 'a', 'payment_in', '2500', 'venmo'), revision: '1' }];
    expect(moneyOptions(paid, 'a').lastBuyPaid).toBe(true);
    const unpaidAfterPaid = [...paid, entry('3', 'a', 'buy_in', '2500')];
    expect(moneyOptions(unpaidAfterPaid, 'a').lastBuyPaid).toBe(false);
    const settledLater = [entry('1', 'a', 'buy_in', '2500'), entry('2', 'a', 'payment_in', '2500', 'cash')];
    expect(moneyOptions(settledLater, 'a').lastBuyPaid).toBe(false);
    const voidedPayment = [...paid, { ...entry('4', 'a', 'payment_in', '2500', 'venmo', '2'), revision: '4' }];
    expect(moneyOptions(voidedPayment, 'a').lastBuyPaid).toBe(false);
  });
});
