import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import type { EntryKind, SessionState } from '../src/domain/session';
import type { playerReport } from '../src/domain/report';
import { testDatabase } from './database';

type Report = ReturnType<typeof playerReport>;
type Account = { id: string; cookie: string };
let database: Awaited<ReturnType<typeof testDatabase>>;
let app: ReturnType<typeof createApp>;
const origin = 'https://poker.test';
const errors: unknown[] = [];
beforeAll(async () => {
  database = await testDatabase();
  app = createApp(database.pool, { origin, onError: error => errors.push(error) });
});
afterAll(async () => { await database?.stop(); expect(errors).toEqual([]); });
function request(account: Account | null, path: string, method = 'GET', body?: unknown) {
  return app.request(`${origin}/api${path}`, {
    method, headers: { origin, 'content-type': 'application/json', ...(account ? { cookie: account.cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function ok<T>(response: Response): Promise<T> {
  const value: unknown = await response.json();
  expect(response.status, JSON.stringify(value)).toBe(200);
  return value as T;
}
async function rejects(response: Response, status: number, code?: string) {
  const body = await response.json() as { error: { code: string } };
  expect(response.status, JSON.stringify(body)).toBe(status);
  if (code) expect(body.error.code).toBe(code);
}
async function account(): Promise<Account> {
  const response = await request(null, '/auth/signup', 'POST', { username: `feedback-${randomUUID().slice(0, 12)}`, password: 'a-secure-feedback-password' });
  const result = await ok<{ banker: { id: string } }>(response);
  return { id: result.banker.id, cookie: response.headers.get('set-cookie')!.split(';')[0]! };
}
async function session(owner: Account, details: Record<string, unknown> = {}, player?: string) {
  const created = await ok<SessionState>(await request(owner, '/sessions', 'POST', { op_id: randomUUID(), name: 'Feedback', played_on: '2026-11-10', currency: 'USD', ...details }));
  return ok<SessionState>(await request(owner, `/sessions/${created.session.id}/players`, 'POST', { op_id: randomUUID(), ...(player ? { player_id: player } : { new_player_name: 'Justin' }) }));
}
async function write(owner: Account, state: SessionState, suffix: string, body: Record<string, unknown>, method = 'POST') {
  return ok<SessionState>(await request(owner, `/sessions/${state.session.id}${suffix}`, method, { op_id: randomUUID(), ...body }));
}
async function entry(owner: Account, state: SessionState, kind: EntryKind, amount: string, time?: string, extra: Record<string, unknown> = {}) {
  return write(owner, state, '/entries', { player_id: state.players[0]!.id, kind, amount_minor: amount, ...(time ? { occurred_at: time } : {}), ...(kind === 'buy_in' ? { paid_now: false } : {}), ...extra });
}
async function close(owner: Account, state: SessionState) {
  return write(owner, state, '/close', { expected_revision: state.revision, accept_discrepancy_minor: state.totals.discrepancy_minor });
}
async function report(owner: Account | null, player: string, query = '') { return ok<Report>(await request(owner, `/players/${player}/report${query}`)); }
const exact = (numerator: string, denominator = '1') => ({ numerator, denominator });

it('persists session details, supports clearing them, and scopes exact suggestions to one banker', async () => {
  const a = await account(), b = await account();
  let state = await session(a, { location: 'Home', game: 'NLH', big_blind_minor: '200' });
  await session(a, { location: 'Club', game: 'PLO', big_blind_minor: '400' });
  await session(b, { location: 'Private B', game: 'Other' });
  state = await write(a, state, '', { location: 'Garden', game: null, big_blind_minor: '500' }, 'PATCH');
  expect(state.session).toMatchObject({ location: 'Garden', game: null, big_blind_minor: '500' });
  expect(state.events[0]).toMatchObject({ kind: 'details_changed', detail: { old: { location: 'Home', game: 'NLH', big_blind_minor: '200' }, new: { location: 'Garden', game: null, big_blind_minor: '500' } } });
  expect(await ok(await request(a, '/suggestions'))).toEqual({ locations: ['Club', 'Garden'], games: ['PLO'] });
  expect(await ok(await request(b, '/suggestions'))).toEqual({ locations: ['Private B'], games: ['Other'] });
  state = await write(a, state, '', { big_blind_minor: null, location: null }, 'PATCH');
  expect(state.session.big_blind_minor).toBeNull();
  await rejects(await request(a, `/sessions/${state.session.id}`, 'PATCH', { op_id: randomUUID(), big_blind_minor: '0' }), 400);
});

describe('payment labels and expenses', () => {
  it('requires payment methods and records an unpaid buy-in only when a later payment arrives', async () => {
    const owner = await account();
    let state = await session(owner);
    const base = { op_id: randomUUID(), player_id: state.players[0]!.id, kind: 'buy_in', amount_minor: '10000' };
    await rejects(await request(owner, `/sessions/${state.session.id}/entries`, 'POST', base), 400);
    for (const kind of ['payment_in', 'payment_out']) await rejects(await request(owner, `/sessions/${state.session.id}/entries`, 'POST', { ...base, op_id: randomUUID(), kind }), 400);
    await rejects(await request(owner, `/sessions/${state.session.id}/entries`, 'POST', { ...base, paid_now: false, method: 'cash' }), 400);
    state = await entry(owner, state, 'buy_in', '10000');
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]!.method).toBeNull();
    expect(state.players[0]).toMatchObject({ payment_in_minor: '0', balance_minor: '10000' });
    state = await entry(owner, state, 'payment_in', '4000', undefined, { method: 'venmo' });
    expect(state.players[0]).toMatchObject({ payment_in_minor: '4000', balance_minor: '6000' });
    expect(state.entries.find(row => row.kind === 'payment_in')!.method).toBe('venmo');
    state = await entry(owner, state, 'buy_in', '5000', undefined, { paid_now: true, method: 'zelle' });
    expect(state.players[0]).toMatchObject({ bought_in_minor: '15000', payment_in_minor: '9000', balance_minor: '6000' });
    const loaded = await ok<SessionState>(await request(owner, `/sessions/${state.session.id}`));
    expect(loaded.entries.filter(row => row.method !== null).map(row => row.method).sort()).toEqual(['venmo', 'zelle']);
  });
  it('keeps method changes and amounts in append-only correction history', async () => {
    const owner = await account();
    let state = await entry(owner, await session(owner), 'buy_in', '10000', undefined, { paid_now: true, method: 'cash' });
    const paid = state.entries.find(row => row.kind === 'payment_in')!;
    state = await write(owner, state, `/entries/${paid.id}/void`, { replacement_method: 'zelle' });
    expect(state.entries.find(row => row.id === paid.id)).toMatchObject({ method: 'cash', amount_minor: '10000' });
    expect(state.entries.find(row => row.voids_entry_id === paid.id)).toMatchObject({ method: 'cash', amount_minor: '10000' });
    const replacement = state.entries.find(row => row.kind === 'payment_in' && row.id !== paid.id && row.voids_entry_id === null)!;
    expect(replacement).toMatchObject({ method: 'zelle', amount_minor: '10000', occurred_at: paid.occurred_at });
    expect(state.players[0]!.payment_in_minor).toBe('10000');
    state = await write(owner, state, `/entries/${replacement.id}/void`, { replacement_amount_minor: '8000', replacement_method: 'venmo' });
    expect(state.players[0]!.balance_minor).toBe('2000');
    await rejects(await request(owner, `/sessions/${state.session.id}/entries/${state.entries.find(row => row.kind === 'buy_in')!.id}/void`, 'POST', { op_id: randomUUID(), replacement_method: 'cash' }), 400);
  });
  it('requires a payout method for paid cash-outs and keeps expenses outside reconciliation', async () => {
    const owner = await account();
    let state = await entry(owner, await session(owner), 'buy_in', '10000', undefined, { paid_now: true, method: 'cash' });
    state = await entry(owner, state, 'expense', '200', undefined, { note: 'Tip' });
    state = await entry(owner, state, 'expense', '500', undefined, { note: 'Meal' });
    expect(state.players[0]).toMatchObject({ bought_in_minor: '10000', expense_minor: '700', balance_minor: '0' });
    expect(state.totals).toMatchObject({ total_in_minor: '10000', total_out_minor: '0', owed_to_banker_minor: '0', owed_by_banker_minor: '0' });
    await rejects(await request(owner, `/sessions/${state.session.id}/entries`, 'POST', { op_id: randomUUID(), player_id: state.players[0]!.id, kind: 'cash_out', amount_minor: '10000', paid_now: true }), 400);
    state = await entry(owner, state, 'cash_out', '10000', undefined, { paid_now: true, method: 'cash' });
    expect(state.players[0]).toMatchObject({ state: 'cashed_out', result_minor: '0', expense_minor: '700', balance_minor: '0' });
    state = await close(owner, state);
    expect(state.session.closed_balanced).toBe(true);
    const metrics = (await report(owner, state.players[0]!.id)).groups[0]!.metrics;
    expect(metrics.profit_loss_minor.value).toEqual(exact('0'));
    expect(metrics.net_after_expenses_minor.value).toEqual(exact('-700'));
  });
  it('enforces the payment-method check independently in Postgres', async () => {
    const owner = await account();
    const state = await session(owner);
    const sql = 'INSERT INTO ledger_entries(id,banker_id,session_id,player_id,kind,amount_minor,revision,method) VALUES ($1,$2,$3,$4,$5,100,3,$6)';
    for (const [kind, method] of [['payment_in', null], ['payment_out', null], ['buy_in', 'cash'], ['expense', 'zelle'], ['payment_in', 'wire']]) {
      await expect(database.pool.query(sql, [randomUUID(), owner.id, state.session.id, state.players[0]!.id, kind, method])).rejects.toMatchObject({ code: '23514' });
    }
  });
});

describe('persisted timers and participation', () => {
  it('auto-starts once, survives reload, stops on close and keeps its end on reopen', async () => {
    const owner = await account();
    let state = await session(owner);
    expect(state.timing).toEqual({ started_at: null, ended_at: null, elapsed_ms: null });
    state = await entry(owner, state, 'buy_in', '10000', state.server_now);
    const start = state.session.started_at;
    expect(start).not.toBeNull();
    expect(state.events[0]!.kind).toBe('timer_started');
    expect(state.entries[0]!.occurred_at).toBe(start);
    expect(state.players[0]!.duration_ms).not.toBeNull();
    const reload = await ok<SessionState>(await request(owner, `/sessions/${state.session.id}`));
    expect(reload.session.started_at).toBe(start);
    expect(Date.parse(reload.server_now)).toBeGreaterThanOrEqual(Date.parse(start!));
    state = await entry(owner, state, 'buy_in', '1000');
    expect(state.session.started_at).toBe(start);
    state = await close(owner, await entry(owner, state, 'cash_out', '11000'));
    const end = state.session.ended_at;
    expect(end).not.toBeNull();
    const frozen = await ok<SessionState>(await request(owner, `/sessions/${state.session.id}`));
    expect(frozen.timing.elapsed_ms).toBe(state.timing.elapsed_ms);
    state = await write(owner, state, '/reopen', { reason: 'Resume play' });
    expect(state.session.ended_at).toBe(end);
    await rejects(await request(owner, `/sessions/${state.session.id}/entries`, 'POST', { op_id: randomUUID(), player_id: state.players[0]!.id, kind: 'buy_in', amount_minor: '100', paid_now: false, occurred_at: new Date(Date.parse(end!) + 1000).toISOString() }), 400, 'outside_timer_bounds');
    state = await write(owner, state, '/timing', { started_at: start, ended_at: null }, 'PATCH');
    state = await entry(owner, state, 'buy_in', '100');
    expect(state.players[0]!.state).toBe('playing');
  });
  it('starts explicitly, corrects old/new timing with history and rejects invalid bounds atomically', async () => {
    const owner = await account();
    let state = await session(owner);
    const op = randomUUID();
    const path = `/sessions/${state.session.id}/start`;
    const first = await request(owner, path, 'POST', { op_id: op });
    const saved = await first.text();
    expect(first.status).toBe(200);
    expect(await (await request(owner, path, 'POST', { op_id: op })).text()).toBe(saved);
    state = JSON.parse(saved) as SessionState;
    const before = state.session.started_at;
    await rejects(await request(owner, path, 'POST', { op_id: randomUUID() }), 409, 'timer_started');
    state = await write(owner, state, '/timing', { started_at: '2026-11-10T00:00:00Z', ended_at: '2026-11-10T06:00:00Z' }, 'PATCH');
    expect(state.timing.elapsed_ms).toBe('21600000');
    expect(state.events[0]).toMatchObject({ kind: 'timing_corrected', detail: { old: { started_at: before, ended_at: null }, new: { started_at: '2026-11-10T00:00:00.000Z', ended_at: '2026-11-10T06:00:00.000Z' } } });
    const revision = state.revision;
    await rejects(await request(owner, `/sessions/${state.session.id}/timing`, 'PATCH', { op_id: randomUUID(), started_at: '2026-11-10T06:00:00Z', ended_at: '2026-11-10T00:00:00Z' }), 400);
    for (const started_at of ['0000-01-01T00:00:00Z', '0001-01-01T00:00:00+01:00', '9999-12-31T23:59:59-01:00']) await rejects(await request(owner, `/sessions/${state.session.id}/timing`, 'PATCH', { op_id: randomUUID(), started_at, ended_at: null }), 400);
    expect((await ok<SessionState>(await request(owner, `/sessions/${state.session.id}`))).revision).toBe(revision);
    await expect(database.pool.query("UPDATE game_sessions SET started_at = '2026-11-11', ended_at = '2026-11-10' WHERE id = $1", [state.session.id])).rejects.toMatchObject({ code: '23514' });
  });
  it('derives late arrival, rebuys and re-entry from occurred time with exact display inputs', async () => {
    const owner = await account();
    let state = await session(owner, { big_blind_minor: '200' });
    state = await write(owner, state, '/timing', { started_at: '2026-11-10T00:00:00Z', ended_at: '2026-11-10T06:00:00Z' }, 'PATCH');
    state = await entry(owner, state, 'buy_in', '10000', '2026-11-10T01:00:00Z');
    state = await entry(owner, state, 'buy_in', '2000', '2026-11-10T01:30:00Z');
    state = await entry(owner, state, 'cash_out', '16000', '2026-11-10T02:00:00Z');
    state = await entry(owner, state, 'buy_in', '10000', '2026-11-10T04:00:00Z');
    state = await entry(owner, state, 'cash_out', '12000', '2026-11-10T05:00:00Z');
    const player = state.players[0]!;
    expect(player.intervals).toEqual([
      { started_at: '2026-11-10T01:00:00.000Z', ended_at: '2026-11-10T02:00:00.000Z' },
      { started_at: '2026-11-10T04:00:00.000Z', ended_at: '2026-11-10T05:00:00.000Z' },
    ]);
    expect(player.duration_ms).toBe('7200000');
    expect(player.performance).toEqual({ result_minor: '6000', duration_ms: '7200000', big_blind_minor: '200', per_hour: exact('21600000000', '7200000'), big_blinds: exact('6000', '200') });
    state = await close(owner, state);
    expect(state.session.ended_at).toBe('2026-11-10T06:00:00.000Z');
    const metrics = (await report(owner, player.id)).groups[0]!.metrics;
    expect(metrics.per_hour_minor.value).toEqual(exact('3000'));
    expect(metrics.big_blinds_per_hour.value).toEqual(exact('15'));
  });
  it('corrects occurred time, re-derives intervals, and rejects chip entries or corrected timing outside bounds', async () => {
    const owner = await account();
    let state = await session(owner);
    state = await write(owner, state, '/timing', { started_at: '2026-11-10T00:00:00Z', ended_at: '2026-11-10T06:00:00Z' }, 'PATCH');
    state = await entry(owner, state, 'buy_in', '100', '2026-11-10T01:00:00Z');
    state = await entry(owner, state, 'cash_out', '150', '2026-11-10T02:00:00Z');
    const chip = state.entries.find(row => row.kind === 'buy_in')!;
    state = await write(owner, state, `/entries/${chip.id}/void`, { replacement_occurred_at: '2026-11-10T00:30:00Z' });
    expect(state.players[0]).toMatchObject({ state: 'cashed_out', result_minor: '50', duration_ms: '5400000' });
    const last = state.entries.find(row => row.kind === 'cash_out')!;
    await rejects(await request(owner, `/sessions/${state.session.id}/entries/${last.id}/void`, 'POST', { op_id: randomUUID(), replacement_occurred_at: '2026-11-10T07:00:00Z' }), 400, 'outside_timer_bounds');
    state = await entry(owner, state, 'expense', '100', '2026-11-09T23:00:00Z');
    expect(state.entries.find(row => row.kind === 'expense')?.occurred_at).toBe('2026-11-09T23:00:00.000Z');
    await rejects(await request(owner, `/sessions/${state.session.id}/timing`, 'PATCH', { op_id: randomUUID(), started_at: '2026-11-10T01:00:00Z', ended_at: '2026-11-10T06:00:00Z' }), 409, 'entries_outside_timing');
    expect((await ok<SessionState>(await request(owner, `/sessions/${state.session.id}`))).revision).toBe(state.revision);
  });
});

async function finalized(owner: Account, player: string | undefined, day: string, result: string, durationHours: number, blind: string | null, location = 'Home', game = 'NLH', expense = '0') {
  let state = await session(owner, { played_on: day, big_blind_minor: blind, location, game }, player);
  state = await write(owner, state, '/timing', { started_at: `${day}T00:00:00Z`, ended_at: `${day}T06:00:00Z` }, 'PATCH');
  state = await entry(owner, state, 'buy_in', '10000', `${day}T01:00:00Z`);
  state = await entry(owner, state, 'cash_out', String(10000n + BigInt(result)), `${day}T0${1 + durationHours}:00:00Z`);
  if (expense !== '0') state = await entry(owner, state, 'expense', expense, `${day}T01:30:00Z`);
  return close(owner, state);
}

describe('player reporting over real ledger rows', () => {
  it('counts a corrected session and a reopened then re-closed session exactly once', async () => {
    const owner = await account();
    let state = await finalized(owner, undefined, '2026-11-10', '6000', 2, '200');
    const player = state.players[0]!.id;
    state = await write(owner, state, '/reopen', { reason: 'Correct cash-out and tip' });
    expect((await report(owner, player)).groups).toEqual([]);
    const old = state.entries.find(row => row.kind === 'cash_out')!;
    state = await write(owner, state, `/entries/${old.id}/void`, { replacement_amount_minor: '14000' });
    state = await entry(owner, state, 'expense', '300', '2026-11-10T01:30:00Z');
    state = await close(owner, state);
    const result = (await report(owner, player)).groups[0]!;
    expect(result.sessions_count).toBe(1);
    expect(result.metrics.profit_loss_minor.value).toEqual(exact('4000'));
    expect(result.metrics.per_hour_minor.value).toEqual(exact('2000'));
    expect(result.metrics.net_after_expenses_minor.value).toEqual(exact('3700'));
    expect(result.metrics.variation_per_hour_minor).toEqual({ sessions_used: 1, value: null, unavailable: 'insufficient_sessions' });
  });
  it('produces hand-computed weighted reports for all five groups and each filter', async () => {
    const owner = await account();
    const first = await finalized(owner, undefined, '2026-11-10', '6000', 2, '200', 'Home', 'NLH', '300');
    const player = first.players[0]!.id;
    await finalized(owner, player, '2026-11-11', '-3000', 1, '100', 'Club', 'PLO', '500');
    await finalized(owner, player, '2026-12-03', '0', 3, '300');
    const result = (await report(owner, player)).groups[0]!;
    expect(result.sessions_count).toBe(3);
    expect(result.metrics.profit_loss_minor.value).toEqual(exact('3000'));
    expect(result.metrics.per_hour_minor.value).toEqual(exact('500'));
    expect(result.metrics.per_session_minor.value).toEqual(exact('1000'));
    expect(result.metrics.duration_ms.value).toEqual(exact('21600000'));
    expect(result.metrics.expenses_minor.value).toEqual(exact('800'));
    expect(result.metrics.net_after_expenses_minor.value).toEqual(exact('2200'));
    expect(result.metrics.winning_percentage.value).toEqual(exact('100', '3'));
    expect(result.metrics.big_blinds_per_hour.value).toEqual(exact('0'));
    expect(result.metrics.variation_per_hour_minor.value).toEqual({ sqrt_of: exact('9000000') });
    expect(result.metrics.variation_big_blinds_per_hour.value).toEqual({ sqrt_of: exact('525') });
    const groupings = [
      ['overall', ['overall']], ['location', ['Club', 'Home']], ['game', ['NLH', 'PLO']], ['weekday', ['2', '3', '4']], ['month', ['2026-11', '2026-12']],
    ] as const;
    for (const [group, keys] of groupings) expect((await report(owner, player, `?group=${group}`)).groups.map(row => row.key)).toEqual(keys);
    for (const [query, total, count] of [
      ['location=Home', '6000', 2], ['game=PLO', '-3000', 1], ['weekday=2', '6000', 1], ['month=2026-11', '3000', 2],
      ['from=2026-11-11', '-3000', 2], ['to=2026-11-10', '6000', 1], ['from=2026-11-11&to=2026-11-11', '-3000', 1],
    ] as const) {
      const filtered = (await report(owner, player, `?${query}`)).groups[0]!;
      expect(filtered.sessions_count).toBe(count);
      expect(filtered.metrics.profit_loss_minor.value).toEqual(exact(total));
    }
    expect((await report(owner, player, '?location=home')).groups).toEqual([]);
    for (const query of ['group=invalid', 'weekday=0', 'month=13', 'from=2026-02-30', 'from=2026-12-01&to=2026-11-01']) await rejects(await request(owner, `/players/${player}/report?${query}`), 400);
  });
  it('keeps players, currencies, accounts and viewers isolated', async () => {
    const owner = await account(), b = await account();
    let state = await finalized(owner, undefined, '2026-11-10', '6000', 2, '200');
    const player = state.players[0]!.id;
    await finalized(owner, undefined, '2026-11-10', '90000', 1, '100');
    let yen = await session(owner, { currency: 'JPY' }, player);
    yen = await write(owner, yen, '/timing', { started_at: '2026-11-10T00:00:00Z', ended_at: '2026-11-10T06:00:00Z' }, 'PATCH');
    yen = await entry(owner, yen, 'buy_in', '1000', '2026-11-10T01:00:00Z');
    yen = await close(owner, await entry(owner, yen, 'cash_out', '1500', '2026-11-10T02:00:00Z'));
    const result = await report(owner, player);
    expect(result.groups.map(group => [group.currency, group.metrics.profit_loss_minor.value])).toEqual([['JPY', exact('500')], ['USD', exact('6000')]]);
    expect(result.groups[0]!.metrics.big_blinds_per_hour.value).toBeNull();
    await rejects(await request(b, `/players/${player}/report`), 404, 'not_found');
    await rejects(await request(null, `/players/${player}/report`), 401);
    state = await write(owner, state, '/reopen', { reason: 'Enable viewer' });
    state = await write(owner, state, '/share', { action: 'enable' });
    const token = state.session.share_token!;
    await rejects(await request({ id: '', cookie: `pb_session=${token}` }, `/players/${player}/report`), 401);
    const viewed = await request(null, `/view/${token}`);
    const text = await viewed.text();
    expect(viewed.status).toBe(200);
    expect(text).not.toContain('cumulative');
    expect(text).not.toContain(yen.session.id);
  });
  it('reports zero-length or missing player intervals as unavailable, never table duration', async () => {
    const owner = await account();
    let state = await session(owner);
    state = await write(owner, state, '/timing', { started_at: '2026-11-10T00:00:00Z', ended_at: '2026-11-10T06:00:00Z' }, 'PATCH');
    state = await entry(owner, state, 'buy_in', '1000', '2026-11-10T01:00:00Z');
    state = await entry(owner, state, 'cash_out', '1500', '2026-11-10T01:00:00Z');
    const original = state.entries.find(row => row.kind === 'buy_in')!;
    state = await write(owner, state, `/entries/${original.id}/void`, { replacement_amount_minor: '1200' });
    expect(state.players[0]).toMatchObject({ state: 'cashed_out', duration_ms: '0', result_minor: '300' });
    state = await close(owner, state);
    const metrics = (await report(owner, state.players[0]!.id)).groups[0]!.metrics;
    expect(metrics.profit_loss_minor.value).toEqual(exact('300'));
    expect(metrics.per_hour_minor).toEqual({ value: null, sessions_used: 0, unavailable: 'no_valid_duration' });
    expect(metrics.duration_ms.value).toBeNull();
    expect(metrics.big_blinds_per_hour.value).toBeNull();
    let missing = await session(owner);
    missing = await close(owner, await entry(owner, missing, 'cash_out', '1000', '2026-11-10T01:00:00Z'));
    expect(missing.timing.elapsed_ms).toBeNull();
    expect(missing.players[0]!.duration_ms).toBeNull();
    const untimed = (await report(owner, missing.players[0]!.id)).groups[0]!.metrics;
    expect(untimed.profit_loss_minor.value).toEqual(exact('1000'));
    expect(untimed.per_hour_minor).toEqual({ value: null, sessions_used: 0, unavailable: 'no_valid_duration' });
  });
});
