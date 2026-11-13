import { describe, expect, it } from 'vitest';
import { currencyExponent, formatMoney, MAX_MINOR, parseMoney } from '../src/domain/money';

describe('money entry', () => {
  it.each([
    ['12.5', 1250n], ['12.50', 1250n], ['.75', 75n], ['$.75', 75n],
    ['1,234.56', 123456n], ['  $1,234.56\n', 123456n], ['$ 12.50', 1250n],
    ['0', 0n], ['$0.00', 0n], [' .00 ', 0n], ['00012.50', 1250n],
  ])('accepts everyday USD entry %j exactly', (input, minor) => {
    expect(parseMoney(input, 'USD')).toBe(minor);
  });

  it.each(['1,23.45', '12,34,567.89', '1234,567.89', ',123', '1,,234', '1,234,', '1.234,56', '12 34', '1e2', '12.50x', '12.50 USD', '€12.50', '$$12.50', '+12', 'NaN', 'Infinity'])('rejects malformed USD entry %j with a usable example', input => {
    expect(() => parseMoney(input, 'USD')).toThrow('Enter a USD amount like 12.50 or 1,234.56. Use one decimal separator or commas in groups of three digits.');
  });

  it.each([
    ['12,5', 'USD', 1250n], ['12,50', 'USD', 1250n], ['1234,56', 'EUR', 123456n],
    ['€12,50', 'EUR', 1250n], ['12.', 'USD', 1200n], ['1,234.', 'USD', 123400n],
    ['1,234', 'USD', 123400n], ['1,234', 'KWD', 1234000n], ['1234,567', 'KWD', 1234567n],
  ])('accepts unambiguous comma decimals or trailing periods %j in %s', (input, currency, expected) => {
    expect(parseMoney(input, currency)).toBe(expected);
  });

  it.each(['', '  ', '$'])('asks for a missing amount %j', input => {
    expect(() => parseMoney(input, 'USD')).toThrow('Enter an amount in USD.');
  });

  it.each(['-1', '−1', '$-1', '$ −.75'])('explains how to fix a negative amount %j', input => {
    expect(() => parseMoney(input, 'USD')).toThrow('Enter zero or a positive amount; remove the minus sign.');
  });

  it.each(['1.005', '12.501', '0.001', '1,234.000'])('rejects excess precision without silently rounding %j', input => {
    expect(() => parseMoney(input, 'USD')).toThrow('Enter no more than 2 decimal places for USD.');
  });

  it('uses the selected currency symbol and exponent', () => {
    expect(parseMoney('0001.2', 'USD')).toBe(120n);
    expect(formatMoney(-500n, 'JPY')).toBe('−¥500');
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

describe('bounded currency formatting', () => {
  const cases: [bigint, string, string, string][] = [
    [123456n, 'USD', 'en-US', '$1,234.56'],
    [123456n, 'JPY', 'de-DE', '123.456\u00a0¥'],
    [123456n, 'KWD', 'en-US', 'KWD\u00a0123.456'],
    [123456n, 'EUR', 'de-DE', '1.234,56\u00a0€'],
    [123456n, 'USD', 'de-DE', '1.234,56\u00a0$'],
    [123456n, 'JPY', 'en-US', '¥123,456'],
    [123456n, 'KWD', 'de-DE', '123,456\u00a0KWD'],
    [123456n, 'EUR', 'en-US', '€1,234.56'],
    [-1n, 'USD', 'en-US', '−$0.01'],
    [-1n, 'JPY', 'de-DE', '−1\u00a0¥'],
    [-1n, 'KWD', 'en-US', '−KWD\u00a00.001'],
    [0n, 'EUR', 'de-DE', '0,00\u00a0€'],
    [MAX_MINOR, 'USD', 'en-US', '$92,233,720,368,547,758.07'],
    [MAX_MINOR, 'JPY', 'en-US', '¥9,223,372,036,854,775,807'],
    [MAX_MINOR, 'KWD', 'en-US', 'KWD\u00a09,223,372,036,854,775.807'],
    [MAX_MINOR, 'EUR', 'de-DE', '92.233.720.368.547.758,07\u00a0€'],
    [MAX_MINOR, 'USD', 'de-DE', '92.233.720.368.547.758,07\u00a0$'],
    [MAX_MINOR, 'JPY', 'de-DE', '9.223.372.036.854.775.807\u00a0¥'],
    [MAX_MINOR, 'KWD', 'de-DE', '9.223.372.036.854.775,807\u00a0KWD'],
    [MAX_MINOR, 'EUR', 'en-US', '€92,233,720,368,547,758.07'],
  ];

  it('keeps currency precision, grouping, symbols and locale spacing exact across mixed calls', () => {
    for (const [minor, currency, locale, expected] of cases) expect(formatMoney(minor, currency, locale)).toBe(expected);
    for (const [minor, currency, locale, expected] of [...cases].reverse()) expect(formatMoney(minor, currency, locale)).toBe(expected);
    expect([currencyExponent('USD'), currencyExponent('JPY'), currencyExponent('KWD'), currencyExponent('EUR')]).toEqual([2, 0, 3, 2]);
  });

  it('keeps exact displays after cycling through the full supported currency set', () => {
    for (const currency of Intl.supportedValuesOf('currency')) formatMoney(1n, currency, 'en-US');
    for (const [minor, currency, locale, expected] of cases) expect(formatMoney(minor, currency, locale)).toBe(expected);
  });

  it('preserves invalid-input errors and exact parser limits after formatter reuse', () => {
    expect(() => currencyExponent('invalid')).toThrow('Unsupported ISO currency');
    expect(() => parseMoney('1', 'ZZZ')).toThrow('Unsupported ISO currency');
    expect(() => formatMoney(1n, 'invalid', 'not_a_locale')).toThrow('Unsupported ISO currency');
    expect(() => formatMoney(1n, 'USD', 'not_a_locale')).toThrow(RangeError);
    expect(formatMoney(1n, 'USD')).toBe('$0.01');
    expect(parseMoney('$92,233,720,368,547,758.07', 'USD')).toBe(MAX_MINOR);
    expect(parseMoney('¥9,223,372,036,854,775,807', 'JPY')).toBe(MAX_MINOR);
    expect(parseMoney('KWD 9,223,372,036,854,775.807', 'KWD')).toBe(MAX_MINOR);
    expect(() => parseMoney('92233720368547758.08', 'USD')).toThrow('Enter $92,233,720,368,547,758.07 or less.');
    expect(() => parseMoney('1.0', 'JPY')).toThrow('JPY uses whole amounts. Remove the decimal part.');
  });
});
