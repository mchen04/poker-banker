import { afterAll, beforeAll, expect, it } from 'vitest';
import { seedBenchmark } from '../scripts/bench/seed';
import { testDatabase } from './database';
import { loadSession, playerHistory } from '../src/server/store';
import { effectiveEntries } from '../src/domain/timing';
import { createApp } from '../src/server/app';
import { randomUUID } from 'node:crypto';
import type { SeedFixture } from '../scripts/bench/types';

let database: Awaited<ReturnType<typeof testDatabase>>;
let fixture: SeedFixture;
beforeAll(async () => { database = await testDatabase(); fixture = await seedBenchmark(database.pool); });
afterAll(async () => { await database?.stop(); });

it('seeds the requested history scale, reusable seats and balanced closed sessions', async () => {
  expect(fixture.counts).toMatchObject({ bankers: 21, main_players: 40, main_closed_sessions: 300, main_open_sessions: 1, main_closed_seats: 2400, main_reentry_seats: 60, main_rebuys: 800, other_closed_sessions: 300, players: 280, sessions: 601, closed_sessions: 600, main_open_entries: 60, main_open_players: 9 });
  const distribution = await database.pool.query('SELECT count(*)::int AS players FROM session_players sp JOIN game_sessions s ON s.id=sp.session_id AND s.banker_id=sp.banker_id WHERE s.banker_id=$1 AND s.status=\'closed\' GROUP BY s.id', [fixture.bankerId]);
  expect(distribution.rows).toHaveLength(300);
  expect(distribution.rows.every(row => row.players >= 6 && row.players <= 10)).toBe(true);
  const dates = (await database.pool.query('SELECT max(played_on)-min(played_on) AS span FROM game_sessions WHERE banker_id=$1 AND status=\'closed\'', [fixture.bankerId])).rows[0]!;
  expect(dates.span).toBe(1095);
  const first = (await database.pool.query('SELECT id FROM game_sessions WHERE banker_id=$1 AND status=\'closed\' ORDER BY played_on,id LIMIT 1', [fixture.bankerId])).rows[0]!;
  const state = await loadSession(database.pool, fixture.bankerId, first.id);
  expect(state.players).toHaveLength(6);
  expect(state.totals).toMatchObject({ total_in_minor: '73000', total_out_minor: '73000', discrepancy_minor: '0' });
  const justin = state.players.find(player => player.id === fixture.playerId)!;
  expect(justin).toMatchObject({ state: 'cashed_out', result_minor: '-1500', bought_in_minor: '18000', cashed_out_minor: '16500', expense_minor: '300' });
  expect(justin.intervals).toHaveLength(2);
  expect(state.players.every(player => player.state === 'cashed_out')).toBe(true);
});

it('stores methods, later payments, void replacements and timer-bounded entries without cross-account references', async () => {
  const methods = await database.pool.query('SELECT DISTINCT method FROM ledger_entries WHERE banker_id=$1 AND method IS NOT NULL ORDER BY method', [fixture.bankerId]);
  expect(methods.rows.map(row => row.method)).toEqual(['cash', 'venmo', 'zelle']);
  expect(fixture.counts.main_voids).toBe(24);
  expect(fixture.counts.main_expenses).toBeGreaterThan(0);
  const invalid = await database.pool.query(`SELECT count(*)::int AS count FROM ledger_entries e JOIN game_sessions s ON s.id=e.session_id WHERE e.banker_id<>s.banker_id OR e.occurred_at<s.started_at OR e.occurred_at>coalesce(s.ended_at,clock_timestamp())`);
  expect(invalid.rows[0]!.count).toBe(0);
  const unpaid = await database.pool.query("SELECT count(*)::int AS count FROM ledger_entries WHERE banker_id=$1 AND note='Unpaid buy-in settled later'", [fixture.bankerId]);
  expect(unpaid.rows[0]!.count).toBeGreaterThan(0);
  const history = await playerHistory(database.pool, fixture.bankerId, fixture.playerId);
  expect(history.sessions.filter(item => item.session.status === 'closed')).toHaveLength(fixture.counts.main_player_report_sessions!);
  expect(history.sessions.some(item => item.player.intervals.length === 2)).toBe(true);
  const other = (await database.pool.query('SELECT id FROM players WHERE banker_id<>$1 LIMIT 1', [fixture.bankerId])).rows[0]!.id as string;
  await expect(database.pool.query('INSERT INTO session_players(session_id,player_id,banker_id) VALUES($1,$2,$3)', [fixture.sessionId, other, fixture.bankerId])).rejects.toMatchObject({ code: '23503' });
});

it('opens a nine-player sixty-row session with independently checkable buy-in and cash totals', async () => {
  const state = await loadSession(database.pool, fixture.bankerId, fixture.sessionId);
  expect(state.players).toHaveLength(9); expect(state.entries).toHaveLength(60);
  expect(state.players.every(player => player.state === 'playing')).toBe(true);
  expect(state.totals).toMatchObject({ total_in_minor: '195000', total_out_minor: '0', on_table_minor: '195000', owed_to_banker_minor: '0', owed_by_banker_minor: '0' });
  expect(effectiveEntries(state.entries)).toHaveLength(60);
  expect(state.entries.filter(entry => entry.kind === 'payment_in').reduce((sum, entry) => sum + BigInt(entry.amount_minor), 0n)).toBe(195000n);
  expect(state.session.share_token).toBe(fixture.token);
  expect(fixture.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
  const viewer = await createApp(database.pool).request(`/api/view/${fixture.token}`);
  expect(viewer.status).toBe(200);
  expect(await viewer.json()).toMatchObject({ session: { id: fixture.sessionId }, players: expect.arrayContaining([expect.objectContaining({ id: fixture.playerId })]) });
  await expect(database.pool.query("INSERT INTO ledger_entries(id,banker_id,session_id,player_id,kind,amount_minor,method,revision) VALUES($1,$2,$3,$4,'payment_in',100,NULL,99)", [randomUUID(), fixture.bankerId, fixture.sessionId, fixture.playerId])).rejects.toMatchObject({ code: '23514' });
});
