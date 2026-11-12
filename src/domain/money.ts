const currencies = new Set(Intl.supportedValuesOf('currency'));
export const MAX_MINOR = 9223372036854775807n;

export function currencyExponent(currency: string): number {
  if (!currencies.has(currency)) throw new Error('Unsupported ISO currency');
  return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits!;
}

export function parseMoney(input: string, currency: string): bigint {
  const exponent = currencyExponent(currency);
  let amount = input.trim();
  const symbols = [...new Set((['symbol', 'narrowSymbol'] as const).map(currencyDisplay =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency, currencyDisplay })
      .formatToParts(0n).find(part => part.type === 'currency')!.value,
  ))].sort((left, right) => right.length - left.length);
  const symbol = symbols.find(value => amount.startsWith(value));
  if (symbol) amount = amount.slice(symbol.length).trimStart();
  if (!amount) throw new Error(`Enter an amount in ${currency}.`);
  if (/^[-−]/.test(amount)) throw new Error('Enter zero or a positive amount; remove the minus sign.');
  const commaDecimal = /^(\d*),(\d+)$/.exec(amount);
  if (exponent > 0 && commaDecimal && commaDecimal[2]!.length <= exponent && !/^\d{1,3},\d{3}$/.test(amount)) amount = amount.replace(',', '.');
  if (!/^(?:(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d*)?|\.\d+)$/.test(amount)) {
    throw new Error(exponent === 0
      ? `Enter a whole ${currency} amount like 1234 or 1,234.`
      : `Enter a ${currency} amount like 12.50 or 1,234.56. Use one decimal separator or commas in groups of three digits.`);
  }
  const [whole = '', fraction = ''] = amount.replaceAll(',', '').split('.');
  if (fraction.length > exponent) {
    throw new Error(exponent === 0
      ? `${currency} uses whole amounts. Remove the decimal part.`
      : `Enter no more than ${exponent} decimal places for ${currency}.`);
  }
  const minor = BigInt(whole || '0') * 10n ** BigInt(exponent) + BigInt(fraction.padEnd(exponent, '0') || '0');
  if (minor > MAX_MINOR) throw new Error(`Enter ${formatMoney(MAX_MINOR, currency)} or less.`);
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
