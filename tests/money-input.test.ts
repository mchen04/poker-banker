import { describe, expect, it } from 'vitest';
import { formatMoney, MAX_MINOR, parseMoney } from '../src/domain/money';

describe('money entry', () => {
  it.each([
    ['12.5', 1250n], ['12.50', 1250n], ['.75', 75n], ['$.75', 75n],
    ['1,234.56', 123456n], ['  $1,234.56\n', 123456n], ['$ 12.50', 1250n],
    ['0', 0n], ['$0.00', 0n], [' .00 ', 0n], ['00012.50', 1250n],
  ])('accepts everyday USD entry %j exactly', (input, minor) => {
    expect(parseMoney(input, 'USD')).toBe(minor);
  });

  it.each(['1,23.45', '12,34,567.89', '1234,567.89', ',123', '1,,234', '1,234,', '1.234,56', '12 34', '1e2', '12.50x', '12.50 USD', '€12.50', '$$12.50', '12.', '+12', 'NaN', 'Infinity'])('rejects malformed USD entry %j with a usable example', input => {
    expect(() => parseMoney(input, 'USD')).toThrow('Enter a USD amount like 12.50 or 1,234.56. Use commas only in groups of three digits.');
  });

  it.each(['', '  ', '$'])('asks for a missing amount %j', input => {
    expect(() => parseMoney(input, 'USD')).toThrow('Enter an amount in USD.');
  });

  it.each(['-1', '−1', '$-1', '$ −.75'])('explains how to fix a negative amount %j', input => {
    expect(() => parseMoney(input, 'USD')).toThrow('Enter zero or a positive amount; remove the minus sign.');
  });

  it.each(['12.501', '0.001', '1,234.000'])('rejects excess precision without silently rounding %j', input => {
    expect(() => parseMoney(input, 'USD')).toThrow('Enter no more than 2 decimal places for USD.');
  });

  it('uses the selected currency symbol and exponent', () => {
    expect(parseMoney(' ¥1,234 ', 'JPY')).toBe(1234n);
    expect(parseMoney('0', 'JPY')).toBe(0n);
    expect(parseMoney('CA$12.50', 'CAD')).toBe(1250n);
    expect(parseMoney('$12.50', 'CAD')).toBe(1250n);
    expect(parseMoney('€12.50', 'EUR')).toBe(1250n);
    expect(parseMoney('£.75', 'GBP')).toBe(75n);
    expect(parseMoney('KWD 1.234', 'KWD')).toBe(1234n);
    expect(parseMoney('.234', 'KWD')).toBe(234n);
    expect(() => parseMoney('$12', 'JPY')).toThrow('Enter a whole JPY amount like 1234 or 1,234.');
    expect(() => parseMoney('1,23', 'JPY')).toThrow('Enter a whole JPY amount like 1234 or 1,234.');
    expect(() => parseMoney('¥1.0', 'JPY')).toThrow('JPY uses whole amounts. Remove the decimal part.');
    expect(() => parseMoney('.75', 'JPY')).toThrow('JPY uses whole amounts. Remove the decimal part.');
    expect(() => parseMoney('1.2345', 'KWD')).toThrow('Enter no more than 3 decimal places for KWD.');
  });

  it.each([
    ['USD', '$92,233,720,368,547,758.07', '92233720368547758.08'],
    ['JPY', '¥9,223,372,036,854,775,807', '9223372036854775808'],
    ['KWD', '9,223,372,036,854,775.807', '9223372036854775.808'],
  ])('allows the actual database maximum in %s and rejects one minor unit more', (currency, maximum, overflow) => {
    expect(parseMoney(maximum, currency)).toBe(MAX_MINOR);
    expect(() => parseMoney(overflow, currency)).toThrow(`Enter ${formatMoney(MAX_MINOR, currency)} or less.`);
  });

  it('keeps cents exact beyond the Number safe-integer range', () => {
    expect(parseMoney('90,071,992,547,409.93', 'USD')).toBe(9007199254740993n);
    expect(formatMoney(9007199254740993n, 'USD')).toBe('$90,071,992,547,409.93');
    expect(formatMoney(-75n, 'USD')).toBe('−$0.75');
    expect(formatMoney(75n, 'USD')).toBe('$0.75');
  });

  it.each(['USD', 'JPY', 'CAD', 'EUR', 'GBP', 'SGD', 'HKD', 'AUD', 'KWD'])('can reuse its displayed positive %s amount without losing precision', currency => {
    for (const minor of [0n, 1n, 1250n, 9007199254740993n, MAX_MINOR]) {
      expect(parseMoney(formatMoney(minor, currency), currency)).toBe(minor);
    }
  });
});
