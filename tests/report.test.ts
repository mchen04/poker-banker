import { describe, expect, it } from 'vitest';
import { playerReport, type PlayerReportSession, type ReportFilters } from '../src/domain/report';
import { add, divide, formatRational, formatSquareRoot, multiply, rational, subtract } from '../src/domain/rational';

const row = (id: string, values: Partial<PlayerReportSession> = {}): PlayerReportSession => ({
  id, played_on: '2026-11-10', currency: 'USD', location: 'Home', game: 'NLH', big_blind_minor: '200',
  status: 'closed', result_minor: '6000', expense_minor: '300', duration_ms: '7200000', has_entries: true, ...values,
});
const fixtures = [
  row('win'),
  row('loss', { played_on: '2026-11-11', location: 'Club', game: 'PLO', big_blind_minor: '100', result_minor: '-3000', expense_minor: '500', duration_ms: '3600000' }),
  row('even', { played_on: '2026-12-03', big_blind_minor: '300', result_minor: '0', expense_minor: '0', duration_ms: '10800000' }),
];
const metrics = (rows = fixtures) => playerReport(rows).groups[0]!.metrics;
const exact = (numerator: string, denominator = '1') => ({ numerator, denominator });

it('reports independently computed win, loss and breakeven totals with tips and meals kept separate', () => {
  const report = playerReport(fixtures);
  const result = report.groups[0]!;
  expect(report.variation_label).toBe('Variation across session rates');
  expect(report.rates_before_expenses).toBe(true);
  expect(result).toMatchObject({ key: 'overall', currency: 'USD', sessions_count: 3 });
  expect(result.metrics.profit_loss_minor).toEqual({ sessions_used: 3, value: exact('3000'), unavailable: null });
  expect(result.metrics.per_session_minor.value).toEqual(exact('1000'));
  expect(result.metrics.expenses_minor.value).toEqual(exact('800'));
  expect(result.metrics.net_after_expenses_minor.value).toEqual(exact('2200'));
  expect(result.metrics.winning_sessions.value).toEqual(exact('1'));
  expect(result.metrics.winning_percentage.value).toEqual(exact('100', '3'));
  expect(result.metrics.duration_ms.value).toEqual(exact('21600000'));
});

it('weights unequal durations and uses each session blind instead of averaging rates', () => {
  const result = metrics();
  expect(result.per_hour_minor.value).toEqual(exact('500'));
  expect(result.big_blinds_per_hour.value).toEqual(exact('0'));
  const nonzero = metrics([fixtures[0]!, row('second', { result_minor: '-1000', big_blind_minor: '100', duration_ms: '3600000', expense_minor: '0' })]);
  expect(nonzero.per_hour_minor.value).toEqual(exact('5000', '3'));
  expect(nonzero.big_blinds_per_hour.value).toEqual(exact('20', '3'));
});

it('returns exact sample variation across three rates with half-even presentation only at the edge', () => {
  const result = metrics();
  expect(result.variation_per_hour_minor).toEqual({ sessions_used: 3, value: { sqrt_of: exact('9000000') }, unavailable: null });
  expect(result.variation_big_blinds_per_hour).toEqual({ sessions_used: 3, value: { sqrt_of: exact('525') }, unavailable: null });
  expect(formatSquareRoot(result.variation_per_hour_minor.value!.sqrt_of)).toBe('3000.00');
  expect(formatSquareRoot(result.variation_big_blinds_per_hour.value!.sqrt_of)).toBe('22.91');
  expect(formatRational(result.winning_percentage.value!)).toBe('33.33');
});

it('reports zero variation when valid session rates are identical', () => {
  const result = metrics([row('a'), row('b')]);
  expect(result.variation_per_hour_minor.value).toEqual({ sqrt_of: exact('0') });
  expect(result.variation_big_blinds_per_hour.value).toEqual({ sqrt_of: exact('0') });
});

it('makes variation unavailable for one valid session and uses the sample denominator for two', () => {
  const one = metrics([fixtures[0]!]);
  expect(one.variation_per_hour_minor).toEqual({ sessions_used: 1, value: null, unavailable: 'insufficient_sessions' });
  expect(one.variation_big_blinds_per_hour).toEqual({ sessions_used: 1, value: null, unavailable: 'insufficient_sessions' });
  const two = metrics(fixtures.slice(0, 2));
  expect(two.variation_per_hour_minor.value).toEqual({ sqrt_of: exact('18000000') });
  expect(two.variation_big_blinds_per_hour.value).toEqual({ sqrt_of: exact('2025', '2') });
});

it('uses per-metric sample counts when timing and blinds are absent or nonpositive', () => {
  const rows = [
    ...fixtures,
    row('no-time', { result_minor: '1000', duration_ms: null, expense_minor: '0' }),
    row('no-blind', { result_minor: '2000', big_blind_minor: null, duration_ms: '3600000', expense_minor: '0' }),
    row('zero-time-and-blind', { result_minor: '3000', big_blind_minor: '0', duration_ms: '0', expense_minor: '0' }),
  ];
  const result = metrics(rows);
  expect(result.profit_loss_minor).toEqual({ sessions_used: 6, value: exact('9000'), unavailable: null });
  expect(result.per_hour_minor).toEqual({ sessions_used: 4, value: exact('5000', '7'), unavailable: null });
  expect(result.duration_ms).toEqual({ sessions_used: 4, value: exact('25200000'), unavailable: null });
  expect(result.big_blinds_per_hour).toEqual({ sessions_used: 3, value: exact('0'), unavailable: null });
  expect(result.variation_per_hour_minor).toEqual({ sessions_used: 4, value: { sqrt_of: exact('7000000') }, unavailable: null });
  expect(result.variation_big_blinds_per_hour.sessions_used).toBe(3);
  const none = metrics([rows[3]!]);
  expect(none.per_hour_minor).toEqual({ sessions_used: 0, value: null, unavailable: 'no_valid_duration' });
  expect(none.duration_ms.value).toBeNull();
  expect(none.big_blinds_per_hour).toEqual({ sessions_used: 0, value: null, unavailable: 'no_valid_duration_and_blind' });
  expect(none.variation_per_hour_minor).toEqual({ sessions_used: 0, value: null, unavailable: 'insufficient_sessions' });
});

it('excludes open sessions and seats without entries without excluding breakeven sessions', () => {
  const report = playerReport([...fixtures, row('open', { status: 'open', result_minor: '999999' }), row('empty', { has_entries: false, result_minor: '999999' })]);
  expect(report.groups[0]!.sessions_count).toBe(3);
  expect(report.groups[0]!.metrics.profit_loss_minor.value).toEqual(exact('3000'));
  expect(playerReport([]).groups).toEqual([]);
  expect(playerReport([row('open', { status: 'open' })]).groups).toEqual([]);
});

it('keeps independent currencies in every grouping and distinguishes missing location from an empty location', () => {
  const report = playerReport([...fixtures, row('yen', { currency: 'JPY', result_minor: '250', expense_minor: '30' })]);
  expect(report.groups.map(group => [group.currency, group.metrics.profit_loss_minor.value])).toEqual([
    ['JPY', exact('250')], ['USD', exact('3000')],
  ]);
  const locations = playerReport([row('unknown', { location: null }), row('empty', { location: '' })], { group: 'location' });
  expect(locations.groups.map(group => group.key)).toEqual([null, '']);
});

describe('all grouping views', () => {
  it.each([
    ['overall', [['overall', 3]]],
    ['location', [['Club', 1], ['Home', 2]]],
    ['game', [['NLH', 2], ['PLO', 1]]],
    ['weekday', [['2', 1], ['3', 1], ['4', 1]]],
    ['month', [['2026-11', 2], ['2026-12', 1]]],
  ] as const)('groups %s from played_on and stored session details', (group, expected) => {
    const report = playerReport(fixtures, { group });
    expect(report.group).toBe(group);
    expect(report.groups.map(bucket => [bucket.key, bucket.sessions_count])).toEqual(expected);
  });
});

describe('every report filter', () => {
  it.each([
    [{ location: 'Home' }, 2, '6000'],
    [{ location: 'home' }, 0, null],
    [{ game: 'PLO' }, 1, '-3000'],
    [{ weekday: '2' }, 1, '6000'],
    [{ month: '2026-11' }, 2, '3000'],
    [{ from: '2026-11-11' }, 2, '-3000'],
    [{ to: '2026-11-11' }, 2, '3000'],
    [{ from: '2026-11-11', to: '2026-11-11' }, 1, '-3000'],
    [{ location: 'Home', game: 'NLH', weekday: '2', month: '2026-11', from: '2026-11-10', to: '2026-11-10' }, 1, '6000'],
  ] satisfies [ReportFilters, number, string | null][])('matches exact filters %j', (filters, count, total) => {
    const report = playerReport(fixtures, filters);
    expect(report.groups.reduce((sum, bucket) => sum + bucket.sessions_count, 0)).toBe(count);
    expect(report.groups[0]?.metrics.profit_loss_minor.value ?? null).toEqual(total === null ? null : exact(total));
  });
  it('uses ISO Sunday 7 and inclusive year/month boundaries', () => {
    const sunday = row('sunday', { played_on: '2027-01-03' });
    expect(playerReport([sunday], { group: 'weekday', weekday: '7', month: '2027-01' }).groups[0]!.key).toBe('7');
  });
});

describe('integer rational presentation', () => {
  it('reduces signs and exact arithmetic beyond safe integers', () => {
    expect(rational(2n, -4n)).toEqual(exact('-1', '2'));
    expect(rational(0n, -4n)).toEqual(exact('0'));
    expect(add(rational(1n, 3n), rational(1n, 6n))).toEqual(exact('1', '2'));
    expect(subtract(rational(1n, 3n), rational(1n, 2n))).toEqual(exact('-1', '6'));
    expect(multiply(rational(2n, 3n), rational(3n, 4n))).toEqual(exact('1', '2'));
    expect(divide(rational(2n, 3n), rational(-4n, 9n))).toEqual(exact('-3', '2'));
    expect(formatRational(rational(9223372036854775807n))).toBe('9223372036854775807.00');
    expect(() => rational(1n, 0n)).toThrow();
  });
  it.each([
    [1005n, 1000n, 2, '1.00'],
    [1015n, 1000n, 2, '1.02'],
    [-1005n, 1000n, 2, '−1.00'],
    [-1015n, 1000n, 2, '−1.02'],
    [-1n, 1000n, 2, '0.00'],
    [5n, 2n, 0, '2'],
    [7n, 2n, 0, '4'],
    [1n, 3n, 4, '0.3333'],
  ])('rounds half-even %s/%s at %i places', (numerator, denominator, places, expected) => {
    expect(formatRational(rational(numerator, denominator), places)).toBe(expected);
  });
  it('rounds square roots without a floating approximation, including exact midpoints', () => {
    expect(formatSquareRoot(rational(2n))).toBe('1.41');
    expect(formatSquareRoot(rational(0n))).toBe('0.00');
    expect(formatSquareRoot(rational(1002001n, 1000000n))).toBe('1.00');
    expect(formatSquareRoot(rational(25n, 4n), 0)).toBe('2');
    expect(formatSquareRoot(rational(49n, 4n), 0)).toBe('4');
    expect(formatSquareRoot(rational(1010025n, 1000000n))).toBe('1.00');
    expect(formatSquareRoot(rational(1030225n, 1000000n))).toBe('1.02');
    expect(formatSquareRoot(rational(9223372036854775807n ** 2n))).toBe('9223372036854775807.00');
    expect(() => formatSquareRoot(rational(-1n))).toThrow();
    expect(() => formatSquareRoot(rational(-1n, 100000n))).toThrow();
    expect(() => formatRational(rational(1n), -1)).toThrow();
  });
});
