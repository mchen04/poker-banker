import { add, divide, multiply, rational, subtract, type Rational } from './rational.js';

export type PlayerReportSession = {
  id: string;
  played_on: string;
  currency: string;
  location: string | null;
  game: string | null;
  big_blind_minor: string | null;
  status: 'open' | 'closed';
  result_minor: string;
  expense_minor: string;
  duration_ms: string | null;
  has_entries: boolean;
};
export type ReportGrouping = 'overall' | 'location' | 'game' | 'weekday' | 'month';
export type ReportFilters = {
  group?: ReportGrouping;
  location?: string;
  game?: string;
  weekday?: string;
  month?: string;
  from?: string;
  to?: string;
};
export type Metric<T = Rational> = { sessions_used: number; value: T | null; unavailable: string | null };
export type SquareRoot = { sqrt_of: Rational };

function available<T>(value: T, sessions: number): Metric<T> {
  return { sessions_used: sessions, value, unavailable: null };
}

function unavailable<T>(reason: string, sessions = 0): Metric<T> {
  return { sessions_used: sessions, value: null, unavailable: reason };
}

function sum(values: Rational[]): Rational {
  return values.reduce(add, rational(0n));
}

function variation(rates: Rational[]): Metric<SquareRoot> {
  if (rates.length < 2) return unavailable('insufficient_sessions', rates.length);
  const count = rational(BigInt(rates.length));
  const total = sum(rates);
  const squares = sum(rates.map(rate => multiply(rate, rate)));
  const variance = divide(subtract(squares, divide(multiply(total, total), count)), rational(BigInt(rates.length - 1)));
  return available({ sqrt_of: variance }, rates.length);
}

function weekday(playedOn: string): string {
  const day = new Date(`${playedOn}T00:00:00Z`).getUTCDay();
  return String(day === 0 ? 7 : day);
}

function groupKey(session: PlayerReportSession, group: ReportGrouping): string | null {
  if (group === 'location') return session.location;
  if (group === 'game') return session.game;
  if (group === 'weekday') return weekday(session.played_on);
  if (group === 'month') return session.played_on.slice(0, 7);
  return 'overall';
}

function summarize(rows: PlayerReportSession[]) {
  const count = rows.length;
  const result = rows.reduce((total, row) => total + BigInt(row.result_minor), 0n);
  const expenses = rows.reduce((total, row) => total + BigInt(row.expense_minor), 0n);
  const wins = rows.filter(row => BigInt(row.result_minor) > 0n).length;
  const timed = rows.filter(row => row.duration_ms !== null && BigInt(row.duration_ms) > 0n);
  const duration = timed.reduce((total, row) => total + BigInt(row.duration_ms!), 0n);
  const timedResult = timed.reduce((total, row) => total + BigInt(row.result_minor), 0n);
  const moneyRates = timed.map(row => rational(BigInt(row.result_minor) * 3_600_000n, BigInt(row.duration_ms!)));
  const blinded = timed.filter(row => row.big_blind_minor !== null && BigInt(row.big_blind_minor) > 0n);
  const blindDuration = blinded.reduce((total, row) => total + BigInt(row.duration_ms!), 0n);
  const blindResults = blinded.map(row => rational(BigInt(row.result_minor), BigInt(row.big_blind_minor!)));
  const blindRates = blinded.map(row => rational(BigInt(row.result_minor) * 3_600_000n, BigInt(row.big_blind_minor!) * BigInt(row.duration_ms!)));
  return {
    profit_loss_minor: available(rational(result), count),
    per_hour_minor: duration > 0n ? available(rational(timedResult * 3_600_000n, duration), timed.length) : unavailable<Rational>('no_valid_duration'),
    per_session_minor: available(rational(result, BigInt(count)), count),
    duration_ms: duration > 0n ? available(rational(duration), timed.length) : unavailable<Rational>('no_valid_duration'),
    winning_sessions: available(rational(BigInt(wins)), count),
    winning_percentage: available(rational(BigInt(wins) * 100n, BigInt(count)), count),
    expenses_minor: available(rational(expenses), count),
    net_after_expenses_minor: available(rational(result - expenses), count),
    big_blinds_per_hour: blindDuration > 0n ? available(multiply(sum(blindResults), rational(3_600_000n, blindDuration)), blinded.length) : unavailable<Rational>('no_valid_duration_and_blind'),
    variation_per_hour_minor: variation(moneyRates),
    variation_big_blinds_per_hour: variation(blindRates),
  };
}

export function playerReport(rows: PlayerReportSession[], filters: ReportFilters = {}) {
  const group = filters.group ?? 'overall';
  const groups = new Map<string, { key: string | null; currency: string; rows: PlayerReportSession[] }>();
  for (const row of rows) {
    if (row.status !== 'closed' || !row.has_entries) continue;
    if (filters.location !== undefined && row.location !== filters.location) continue;
    if (filters.game !== undefined && row.game !== filters.game) continue;
    if (filters.weekday !== undefined && weekday(row.played_on) !== filters.weekday) continue;
    if (filters.month !== undefined && row.played_on.slice(0, 7) !== filters.month) continue;
    if (filters.from !== undefined && row.played_on < filters.from) continue;
    if (filters.to !== undefined && row.played_on > filters.to) continue;
    const key = groupKey(row, group);
    const id = JSON.stringify([key, row.currency]);
    let bucket = groups.get(id);
    if (!bucket) { bucket = { key, currency: row.currency, rows: [] }; groups.set(id, bucket); }
    bucket.rows.push(row);
  }
  return {
    group,
    variation_label: 'Variation across session rates',
    rates_before_expenses: true,
    groups: [...groups.values()].sort((a, b) => {
      if (a.key === null && b.key !== null) return -1;
      if (a.key !== null && b.key === null) return 1;
      return (a.key ?? '').localeCompare(b.key ?? '') || a.currency.localeCompare(b.currency);
    }).map(bucket => ({ key: bucket.key, currency: bucket.currency, sessions_count: bucket.rows.length, metrics: summarize(bucket.rows) })),
  };
}
