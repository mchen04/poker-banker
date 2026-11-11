import { describe, expect, it } from 'vitest';
import { duration, resultMoney, resultCurrencyDecimal, resultNumber } from '../src/client/views/common';

describe('clear display values', () => {
  it('uses whole minutes for durations including zero and padded hours', () => {
    expect(duration(null)).toBe('No time recorded');
    expect(duration('59999')).toBe('0 min');
    expect(duration('60000')).toBe('1 min');
    expect(duration('11100000')).toBe('3 h 05 min');
  });
  it('signs money results and distinguishes even from unsigned cash amounts', () => {
    expect(resultMoney('4000', 'USD')).toBe('+$40.00');
    expect(resultMoney('-4000', 'USD')).toBe('−$40.00');
    expect(resultMoney('0', 'USD')).toBe('Even');
    expect(resultMoney('42', 'JPY')).toBe('+¥42');
  });
  it('rounds rational results half even before displaying the sign', () => {
    expect(resultCurrencyDecimal({ numerator: '1', denominator: '2' }, 'USD')).toBe('Even');
    expect(resultCurrencyDecimal({ numerator: '3', denominator: '2' }, 'USD')).toBe('+$0.02');
    expect(resultCurrencyDecimal({ numerator: '-3', denominator: '2' }, 'USD')).toBe('−$0.02');
    expect(resultNumber({ numerator: '1', denominator: '3' })).toBe('+0.33');
    expect(resultNumber({ numerator: '0', denominator: '1' })).toBe('Even');
  });
});
