const currencies = new Set(Intl.supportedValuesOf('currency'));
export const MAX_MINOR = 9223372036854775807n;

export function currencyExponent(currency: string): number {
  if (!currencies.has(currency)) throw new Error('Unsupported ISO currency');
  return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits!;
}

export function parseMoney(input: string, currency: string): bigint {
  const exponent = currencyExponent(currency);
  const pattern = exponent === 0 ? /^\d+$/ : new RegExp(`^\\d+(?:\\.\\d{1,${exponent}})?$`);
  if (!pattern.test(input)) throw new Error('Enter an exact nonnegative amount');
  const [whole = '', fraction = ''] = input.split('.');
  const minor = BigInt(whole) * 10n ** BigInt(exponent) + BigInt(fraction.padEnd(exponent, '0') || '0');
  if (minor > MAX_MINOR) throw new Error('Amount is too large');
  return minor;
}

export function formatMoney(minor: bigint, currency: string, locale = 'en-US'): string {
  const exponent = currencyExponent(currency);
  const absolute = minor < 0n ? -minor : minor;
  const scale = 10n ** BigInt(exponent);
  const fraction = (absolute % scale).toString().padStart(exponent, '0');
  const parts = new Intl.NumberFormat(locale, { style: 'currency', currency }).formatToParts(absolute / scale);
  return (minor < 0n ? '−' : '') + parts.map(part => part.type === 'fraction' ? fraction : part.value).join('');
}
