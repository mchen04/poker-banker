export type Rational = { numerator: string; denominator: string };

function gcd(a: bigint, b: bigint): bigint {
  let left = a < 0n ? -a : a;
  let right = b < 0n ? -b : b;
  while (right !== 0n) [left, right] = [right, left % right];
  return left;
}

export function rational(numerator: bigint, denominator = 1n): Rational {
  if (denominator === 0n) throw new Error('A rational needs a nonzero denominator');
  const sign = denominator < 0n ? -1n : 1n;
  const divisor = gcd(numerator, denominator);
  return { numerator: String(numerator * sign / divisor), denominator: String(denominator * sign / divisor) };
}

export function add(a: Rational, b: Rational): Rational {
  return rational(BigInt(a.numerator) * BigInt(b.denominator) + BigInt(b.numerator) * BigInt(a.denominator), BigInt(a.denominator) * BigInt(b.denominator));
}

export function subtract(a: Rational, b: Rational): Rational {
  return add(a, { ...b, numerator: String(-BigInt(b.numerator)) });
}

export function multiply(a: Rational, b: Rational): Rational {
  return rational(BigInt(a.numerator) * BigInt(b.numerator), BigInt(a.denominator) * BigInt(b.denominator));
}

export function divide(a: Rational, b: Rational): Rational {
  return rational(BigInt(a.numerator) * BigInt(b.denominator), BigInt(a.denominator) * BigInt(b.numerator));
}

function scaleFor(places: number): bigint {
  if (!Number.isInteger(places) || places < 0 || places > 100) throw new Error('Decimal places must be between 0 and 100');
  return 10n ** BigInt(places);
}

function fixed(value: bigint, places: number): string {
  const negative = value < 0n;
  const digits = String(negative ? -value : value).padStart(places + 1, '0');
  const text = places === 0 ? digits : `${digits.slice(0, -places)}.${digits.slice(-places)}`;
  return (negative ? '−' : '') + text;
}

export function formatRational(value: Rational, places = 2): string {
  const normalized = rational(BigInt(value.numerator), BigInt(value.denominator));
  const numerator = BigInt(normalized.numerator);
  const absolute = (numerator < 0n ? -numerator : numerator) * scaleFor(places);
  const denominator = BigInt(normalized.denominator);
  let rounded = absolute / denominator;
  const remainder = absolute % denominator;
  if (remainder * 2n > denominator || (remainder * 2n === denominator && rounded % 2n !== 0n)) rounded++;
  return fixed(numerator < 0n ? -rounded : rounded, places);
}

function integerSquareRoot(value: bigint): bigint {
  if (value < 0n) throw new Error('Cannot take the square root of a negative value');
  if (value < 2n) return value;
  let current = 1n << BigInt(Math.ceil(value.toString(2).length / 2));
  while (true) {
    const next = (current + value / current) / 2n;
    if (next >= current) return current;
    current = next;
  }
}

export function formatSquareRoot(value: Rational, places = 2): string {
  const normalized = rational(BigInt(value.numerator), BigInt(value.denominator));
  const scale = scaleFor(places);
  const numerator = BigInt(normalized.numerator) * scale * scale;
  if (numerator < 0n) throw new Error('Cannot take the square root of a negative value');
  const denominator = BigInt(normalized.denominator);
  let rounded = integerSquareRoot(numerator / denominator);
  const comparison = numerator * 4n - denominator * (2n * rounded + 1n) ** 2n;
  if (comparison > 0n || (comparison === 0n && rounded % 2n !== 0n)) rounded++;
  return fixed(rounded, places);
}
