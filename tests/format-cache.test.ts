import { expect, it } from 'vitest';
import { currencyExponent, formatMoney, MAX_MINOR, parseMoney } from '../src/domain/money';

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
  expect(() => formatMoney(1n, 'invalid', 'not_a_locale')).toThrow('Unsupported ISO currency');
  expect(() => formatMoney(1n, 'USD', 'not_a_locale')).toThrow(RangeError);
  expect(formatMoney(1n, 'USD')).toBe('$0.01');
  expect(parseMoney('$92,233,720,368,547,758.07', 'USD')).toBe(MAX_MINOR);
  expect(parseMoney('¥9,223,372,036,854,775,807', 'JPY')).toBe(MAX_MINOR);
  expect(parseMoney('KWD 9,223,372,036,854,775.807', 'KWD')).toBe(MAX_MINOR);
  expect(() => parseMoney('92233720368547758.08', 'USD')).toThrow('Enter $92,233,720,368,547,758.07 or less.');
  expect(() => parseMoney('1.0', 'JPY')).toThrow('JPY uses whole amounts. Remove the decimal part.');
});
