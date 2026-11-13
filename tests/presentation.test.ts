import { describe, expect, it } from 'vitest';
import { currencyDecimal, duration, resultMoney, resultCurrencyDecimal, resultNumber } from '../src/client/views/common';

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
  it('groups reported currency rates and variation without losing bigint precision', () => {
    expect(currencyDecimal({ numerator: '123456789', denominator: '1' }, 'USD')).toBe('$1,234,567.89');
    expect(currencyDecimal({ numerator: '-123456789', denominator: '1' }, 'USD')).toBe('−$1,234,567.89');
    expect(currencyDecimal({ numerator: String(123456789n ** 2n), denominator: '1' }, 'USD', true)).toBe('$1,234,567.89');
    expect(currencyDecimal({ numerator: '9223372036854775807', denominator: '1' }, 'USD')).toBe('$92,233,720,368,547,758.07');
    expect(currencyDecimal({ numerator: '1234567', denominator: '1' }, 'JPY')).toBe('¥1,234,567');
    expect(currencyDecimal({ numerator: '2005', denominator: '2' }, 'USD')).toBe('$10.02');
    expect(currencyDecimal({ numerator: '1234567', denominator: '1' }, 'KWD')).toContain('1,234.567');
  });
});
