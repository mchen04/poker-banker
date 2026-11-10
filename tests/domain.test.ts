import { describe, expect, it } from 'vitest';
import { formatMoney, parseMoney } from '../src/domain/money';
import { deriveSession, type LedgerEntry, type SessionSettings } from '../src/domain/session';

const settings: SessionSettings = {
  id: 'session', name: 'Friday', played_on: '2026-11-10', currency: 'USD', status: 'open',
  closed_balanced: null, closed_at: null, share_token: null, created_at: '', updated_at: '',
};
const entry = (kind: LedgerEntry['kind'], amount: string, revision: number, extra: Partial<LedgerEntry> = {}): LedgerEntry => ({
  id: String(revision), player_id: 'p', kind, amount_minor: amount, note: null, voids_entry_id: null,
  created_at: '', revision: String(revision), ...extra,
});
const state = (entries: LedgerEntry[]) => deriveSession(settings, '9', [{ id: 'p', display_name: 'Justin' }], entries);

describe('exact money', () => {
  it('parses currency exponents without floats', () => {
    expect(parseMoney('20.50', 'USD')).toBe(2050n);
    expect(parseMoney('0001.2', 'USD')).toBe(120n);
    expect(parseMoney('500', 'JPY')).toBe(500n);
    expect(parseMoney('1.234', 'KWD')).toBe(1234n);
    expect(parseMoney('0', 'USD')).toBe(0n);
    expect(parseMoney('92233720368547758.07', 'USD')).toBe(9223372036854775807n);
  });
  it.each(['1.005', '1e2', ' 1', '1 ', '+1', '-1', '.5', '1.', '1x', '1\n', '', 'NaN', '1,000'])('rejects junk %j', input => {
    expect(() => parseMoney(input, 'USD')).toThrow();
  });
  it('rejects currency and range errors', () => {
    expect(() => parseMoney('1.0', 'JPY')).toThrow();
    expect(() => parseMoney('1', 'ZZZ')).toThrow();
    expect(() => parseMoney('92233720368547758.08', 'USD')).toThrow();
  });
  it('formats exact large and negative amounts', () => {
    expect(formatMoney(2050n, 'USD')).toBe('$20.50');
    expect(formatMoney(-1n, 'USD')).toBe('−$0.01');
    expect(formatMoney(-500n, 'JPY')).toBe('−¥500');
    expect(formatMoney(9223372036854775807n, 'USD')).toBe('$92,233,720,368,547,758.07');
  });
});

describe('ledger state', () => {
  it('seats players without claiming a result', () => {
    expect(state([]).players[0]).toMatchObject({ state: 'seated', balance_minor: '0' });
    expect(state([]).players[0]).not.toHaveProperty('result_minor');
  });
  it('rebuy hides an early cash-out result and returns to playing', () => {
    const entries = [entry('buy_in', '100', 1), entry('cash_out', '150', 2)];
    expect(state(entries).players[0]).toMatchObject({ state: 'cashed_out', result_minor: '50' });
    const rebuy = state([...entries, entry('buy_in', '200', 3)]);
    expect(rebuy.players[0]).toMatchObject({ state: 'playing', bought_in_minor: '300' });
    expect(rebuy.players[0]).not.toHaveProperty('result_minor');
    expect(rebuy.totals).toMatchObject({ on_table_minor: '150', discrepancy_minor: null });
  });
  it('derives partial payments, discrepancy and both outstanding directions', () => {
    const result = state([entry('buy_in', '10000', 1), entry('payment_in', '5000', 2), entry('cash_out', '12000', 3), entry('payment_out', '1000', 4)]);
    expect(result.players[0]).toMatchObject({ result_minor: '2000', balance_minor: '-6000' });
    expect(result.totals).toMatchObject({ discrepancy_minor: '2000', owed_by_banker_minor: '6000', owed_to_banker_minor: '0' });
    expect(state([entry('buy_in', '10000', 1), entry('payment_in', '2000', 2)]).totals.owed_to_banker_minor).toBe('8000');
  });
  it('removes void rows and originals from every sum and chip state', () => {
    const result = state([entry('buy_in', '100', 1), entry('cash_out', '200', 2), entry('cash_out', '200', 3, { voids_entry_id: '2' })]);
    expect(result.players[0]).toMatchObject({ state: 'playing', cashed_out_minor: '0' });
  });
});
