import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import { createEntryClock } from '../src/client/clock';
import { deriveSession, type LedgerEntry, type SessionState } from '../src/domain/session';
import { testDatabase } from './database';

describe('client submission calibration', () => {
  it('advances the last live server clock monotonically and preserves two offline submission hours', () => {
    const clock = createEntryClock();
    const start = Date.parse('2026-11-10T18:00:00.000Z');
    clock.observe(new Date(start).toISOString(), 100);
    const buy = clock.stamp(start, 100), cash = clock.stamp(start + 7200000, 7200100);
    expect(buy).toBe('2026-11-10T18:00:00.000Z'); expect(cash).toBe('2026-11-10T20:00:00.000Z');
  });
  it('marks missing live clock, backward monotonic time and skew beyond two minutes unavailable', () => {
    const clock = createEntryClock(); const start = Date.parse('2026-11-10T18:00:00.000Z');
    expect(clock.stamp(start, 100)).toBeNull();
    clock.observe(new Date(start).toISOString(), 100);
    expect(clock.stamp(start, 99)).toBeNull();
    expect(clock.stamp(start + 120001, 100)).toBeNull();
    expect(clock.stamp(start - 120001, 100)).toBeNull();
    expect(clock.stamp(start + 120000, 100)).toBe('2026-11-10T18:00:00.000Z');
    expect(createEntryClock().stamp(start + 7200000, 100)).toBeNull();
  });
  it('calibrates tolerated positive and negative wall skew to the server clock at submission', () => {
    const clock = createEntryClock(); const start = Date.parse('2026-11-10T18:00:00.000Z');
    clock.observe(new Date(start).toISOString(), 100);
    for (const skew of [-60000, 60000]) {
      expect(clock.stamp(start + skew, 100)).toBe('2026-11-10T18:00:00.000Z');
      expect(clock.stamp(start + 7200000 + skew, 7200100)).toBe('2026-11-10T20:00:00.000Z');
    }
  });
  it('marks an estimate older than a causally known start unavailable without hiding a future timer bound', () => {
    const clock = createEntryClock(); const start = Date.parse('2026-11-10T18:00:00.000Z');
    clock.observe(new Date(start).toISOString(), 500);
    expect(clock.stamp(start + 650, 650, { started_at: new Date(start + 500).toISOString(), server_now: new Date(start + 510).toISOString() })).toBeNull();
    expect(clock.stamp(start + 650, 650, { started_at: new Date(start + 1000).toISOString(), server_now: new Date(start + 510).toISOString() })).toBe('2026-11-10T18:00:00.150Z');
    expect(clock.stamp(start + 650, 650, { started_at: new Date(start + 500).toISOString(), ended_at: new Date(start + 550).toISOString(), server_now: new Date(start + 560).toISOString() })).toBe('2026-11-10T18:00:00.150Z');
    expect(clock.stamp(start + 650, 650)).toBe('2026-11-10T18:00:00.150Z');
  });
});

describe('occurrence availability', () => {
  let database: Awaited<ReturnType<typeof testDatabase>>;
  let app: ReturnType<typeof createApp>;
  const origin = 'https://occurrence.test';
  let cookie = '';
  beforeAll(async () => { database = await testDatabase(); app = createApp(database.pool, { origin }); });
  afterAll(async () => { await database.stop(); });
  async function request(path: string, body?: unknown, method = body ? 'POST' : 'GET') {
    const response = await app.request(`${origin}/api${path}`, { method, headers: { origin, 'content-type': 'application/json', cookie }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const session = response.headers.get('set-cookie'); if (session) cookie = session.split(';')[0]!;
    const value = await response.json(); expect(response.status, JSON.stringify(value)).toBe(200); return value as SessionState;
  }
  it('keeps missing occurrence time explicitly unavailable while preserving money and cash-out state', async () => {
    await request('/auth/signup', { username: `occurrence-${randomUUID().slice(0, 8)}`, password: randomUUID() });
    let state = await request('/sessions', { op_id: randomUUID(), name: 'Unknown timing', played_on: '2026-11-10', currency: 'USD' });
    state = await request(`/sessions/${state.session.id}/players`, { op_id: randomUUID(), new_player_name: 'Justin' });
    for (const [kind, amount] of [['buy_in', '10000'], ['cash_out', '15000']]) state = await request(`/sessions/${state.session.id}/entries`, { op_id: randomUUID(), player_id: state.players[0]!.id, kind, amount_minor: amount, paid_now: false, ...(kind === 'cash_out' ? { occurred_at: null } : {}) });
    expect(state.entries.every(entry => entry.occurred_at === null)).toBe(true);
    expect(state.players[0]).toMatchObject({ state: 'cashed_out', result_minor: '5000', duration_ms: null, performance: { per_hour: null } });
    expect((await database.pool.query('SELECT count(*)::int AS n FROM ledger_entries WHERE occurred_at IS NULL')).rows[0]!.n).toBe(2);
    await request(`/sessions/${state.session.id}/close`, { op_id: randomUUID(), expected_revision: state.revision, accept_discrepancy_minor: '5000' });
    const response = await app.request(`${origin}/api/players/${state.players[0]!.id}/report`, { headers: { cookie } });
    expect(response.status).toBe(200);
    const report = await response.json();
    expect(report.groups[0].metrics.profit_loss_minor).toMatchObject({ value: { numerator: '5000', denominator: '1' }, sessions_used: 1 });
    expect(report.groups[0].metrics.per_hour_minor).toMatchObject({ value: null, sessions_used: 0, unavailable: 'no_valid_duration' });
  });
  it('does not turn an unknown chip endpoint into an invented open interval', () => {
    const session = { id: 's', name: 'Game', played_on: '2026-11-10', currency: 'USD', status: 'open' as const, location: null, game: null, big_blind_minor: '200', started_at: '2026-11-10T18:00:00.000Z', ended_at: null, closed_at: null, closed_balanced: null, share_token: null, created_at: '', updated_at: '' };
    const entry = (kind: LedgerEntry['kind'], revision: string, occurred_at: string | null, player_id = 'p') => ({ id: `${player_id}${revision}`, player_id, kind, amount_minor: '10000', note: null, method: null, voids_entry_id: null, created_at: '', revision, occurred_at }) as LedgerEntry;
    const result = deriveSession(session, '5', [{ id: 'p', display_name: 'Unknown' }, { id: 'q', display_name: 'Known' }], [entry('buy_in', '1', '2026-11-10T18:00:00.000Z'), entry('cash_out', '2', null), entry('buy_in', '3', '2026-11-10T20:00:00.000Z'), entry('buy_in', '4', '2026-11-10T18:00:00.000Z', 'q'), entry('cash_out', '5', '2026-11-10T20:00:00.000Z', 'q')], [], '2026-11-10T21:00:00.000Z');
    expect(result.players[0]).toMatchObject({ state: 'playing', duration_ms: null, intervals: [] });
    expect(result.players[1]!.duration_ms).toBe('7200000');
  });

  it('does not discard known participation because an unrelated expense has no occurrence time', () => {
    const settings = { id: 's', name: 'Game', played_on: '2026-11-10', currency: 'USD', status: 'closed' as const, location: null, game: null, big_blind_minor: '200', started_at: '2026-11-10T18:00:00.000Z', ended_at: '2026-11-10T20:00:00.000Z', closed_at: '', closed_balanced: true, share_token: null, created_at: '', updated_at: '' };
    const row = (kind: LedgerEntry['kind'], revision: string, occurred_at: string | null): LedgerEntry => ({ id: revision, player_id: 'p', kind, amount_minor: '10000', method: null, note: null, voids_entry_id: null, created_at: '', revision, occurred_at });
    const result = deriveSession(settings, '3', [{ id: 'p', display_name: 'Justin' }], [row('buy_in', '1', settings.started_at), row('expense', '2', null), row('cash_out', '3', settings.ended_at)]);
    expect(result.players[0]!.duration_ms).toBe('7200000');
  });
});

describe('clock estimates and persisted bounds', () => {
  let database: Awaited<ReturnType<typeof testDatabase>>;
  beforeAll(async () => { database = await testDatabase(); });
  afterAll(async () => { await database.stop(); });
  it('keeps both signs of tolerated wall skew inside a started timer and a normal close', async () => {
    const origin = 'https://skew.test'; const app = createApp(database.pool, { origin }); let cookie = '';
    const call = async (path: string, body?: unknown) => {
      const response = await app.request(`${origin}/api${path}`, { method: body ? 'POST' : 'GET', headers: { origin, cookie, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const set = response.headers.get('set-cookie'); if (set) cookie = set.split(';')[0]!;
      const value = await response.json(); expect(response.status, JSON.stringify(value)).toBe(200); return value as SessionState;
    };
    await call('/auth/signup', { username: `skew-${randomUUID().slice(0, 8)}`, password: randomUUID() });
    let state = await call('/sessions', { op_id: randomUUID(), name: 'Skew bounds', played_on: '2026-11-10', currency: 'USD' });
    const path = `/sessions/${state.session.id}`;
    state = await call(`${path}/players`, { op_id: randomUUID(), new_player_name: 'Justin' });
    state = await call(`${path}/start`, { op_id: randomUUID() });
    state = await call(path);
    const clock = createEntryClock(); clock.observe(state.server_now, 100);
    const stamps = [-60000, 60000].map(skew => clock.stamp(Date.parse(state.server_now) + skew, 100));
    expect(stamps).toEqual([state.server_now, state.server_now]);
    const stamp = stamps[0]!;
    for (const kind of ['buy_in', 'cash_out']) state = await call(`${path}/entries`, { op_id: randomUUID(), player_id: state.players[0]!.id, kind, amount_minor: '10000', paid_now: false, occurred_at: stamp });
    state = await call(`${path}/close`, { op_id: randomUUID(), expected_revision: state.revision });
    expect(state.session.status).toBe('closed'); expect(Date.parse(stamp!)).toBeLessThanOrEqual(Date.parse(state.session.ended_at!));
  });
  it('records money with unavailable personal timing when a delayed clock sample predates a known start', async () => {
    const origin = 'https://delay.test'; const app = createApp(database.pool, { origin }); let cookie = '';
    const call = async (path: string, body?: unknown, status = 200) => {
      const response = await app.request(`${origin}/api${path}`, { method: body ? 'POST' : 'GET', headers: { origin, cookie, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const set = response.headers.get('set-cookie'); if (set) cookie = set.split(';')[0]!;
      const value = await response.json(); expect(response.status, JSON.stringify(value)).toBe(status); return value as SessionState;
    };
    await call('/auth/signup', { username: `delay-${randomUUID().slice(0, 8)}`, password: randomUUID() });
    let state = await call('/sessions', { op_id: randomUUID(), name: 'Delayed clock', played_on: '2026-11-10', currency: 'USD' });
    const path = `/sessions/${state.session.id}`;
    state = await call(`${path}/players`, { op_id: randomUUID(), new_player_name: 'Justin' });
    state = await call(`${path}/start`, { op_id: randomUUID() });
    const start = Date.parse(state.session.started_at!); const clock = createEntryClock();
    clock.observe(new Date(start - 500).toISOString(), 500);
    const stamp = clock.stamp(start + 150, 650, { started_at: state.session.started_at, server_now: new Date(start + 10).toISOString() });
    state = await call(`${path}/entries`, { op_id: randomUUID(), player_id: state.players[0]!.id, kind: 'buy_in', amount_minor: '10000', paid_now: false, occurred_at: stamp });
    expect(state.entries[0]!.occurred_at).toBeNull();
    expect(state.players[0]).toMatchObject({ state: 'playing', bought_in_minor: '10000', duration_ms: null, performance: { per_hour: null } });
    await call(`${path}/entries`, { op_id: randomUUID(), player_id: state.players[0]!.id, kind: 'buy_in', amount_minor: '100', paid_now: false, occurred_at: new Date(start - 1).toISOString() }, 400);
  });
});
