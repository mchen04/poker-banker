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
  expect(fixture.counts).toMatchObject({ bankers: 22, main_players: 40, main_closed_sessions: 300, main_open_sessions: 1, main_closed_seats: 2400, main_reentry_seats: 60, main_rebuys: 800, other_closed_sessions: 300, companion_closed_sessions: 1000, all_other_closed_sessions: 1300, players: 320, sessions: 1602, closed_sessions: 1600, main_open_entries: 60, main_open_players: 9 });
  expect(fixture.workload).toBe('large');
  expect(fixture.companions).toHaveLength(1);
  expect(fixture.companions![0]).toMatchObject({ workload: 'long', counts: { main_players: 40, main_closed_sessions: 1000, main_open_players: 25, main_open_entries: 400, main_player_report_sessions: 200 } });
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

it.each([
  { workload: 'small' as const, players: 6, closed: 10, openPlayers: 6, openEntries: 20, reportSessions: 10, onTable: '80000', bankers: 1, totalPlayers: 6, totalSessions: 11, totalClosed: 10 },
  { workload: 'long' as const, players: 40, closed: 1000, openPlayers: 25, openEntries: 400, reportSessions: 200, onTable: '1125000', bankers: 22, totalPlayers: 320, totalSessions: 1602, totalClosed: 1600 },
])('seeds the $workload primary with exact counts, bounded timing, balanced histories and isolated accounts', async expected => {
  const owned = await testDatabase();
  try {
    const seeded = await seedBenchmark(owned.pool, { workload: expected.workload });
    expect(seeded.workload).toBe(expected.workload);
    expect(seeded.dataset).toBe(expected.workload === 'small' ? 'small' : 'large');
    expect(seeded.counts).toMatchObject({ bankers: expected.bankers, players: expected.totalPlayers, sessions: expected.totalSessions, closed_sessions: expected.totalClosed, main_players: expected.players, main_closed_sessions: expected.closed, main_open_sessions: 1, main_open_players: expected.openPlayers, main_open_entries: expected.openEntries, main_player_report_sessions: expected.reportSessions });
    const actual = (await owned.pool.query(`SELECT
      (SELECT count(*)::int FROM bankers) AS bankers,
      (SELECT count(*)::int FROM players) AS players,
      (SELECT count(*)::int FROM game_sessions) AS sessions,
      (SELECT count(*)::int FROM game_sessions WHERE status='closed') AS closed_sessions,
      (SELECT count(*)::int FROM game_sessions WHERE banker_id=$1 AND status='closed') AS main_closed_sessions,
      (SELECT count(*)::int FROM ledger_entries WHERE session_id=$2 AND banker_id=$1) AS main_open_entries,
      (SELECT count(*)::int FROM session_players WHERE session_id=$2 AND banker_id=$1) AS main_open_players`, [seeded.bankerId, seeded.sessionId])).rows[0]!;
    expect(seeded.counts).toMatchObject(actual);
    const state = await loadSession(owned.pool, seeded.bankerId, seeded.sessionId);
    expect(state.players).toHaveLength(expected.openPlayers);
    expect(state.entries).toHaveLength(expected.openEntries);
    expect(state.players.every(player => player.state === 'playing')).toBe(true);
    expect(state.totals).toMatchObject({ total_in_minor: expected.onTable, total_out_minor: '0', on_table_minor: expected.onTable, owed_to_banker_minor: '0', owed_by_banker_minor: '0' });
    expect(state.entries.every(entry => entry.occurred_at !== null && entry.occurred_at >= state.session.started_at! && entry.occurred_at <= state.server_now && BigInt(entry.amount_minor) > 0n && BigInt(entry.revision) <= BigInt(state.revision))).toBe(true);
    const invalid = (await owned.pool.query(`SELECT count(*)::int AS count FROM ledger_entries e
      JOIN game_sessions s ON s.id=e.session_id JOIN players p ON p.id=e.player_id
      WHERE e.banker_id<>s.banker_id OR e.banker_id<>p.banker_id OR e.occurred_at<s.started_at
        OR e.occurred_at>coalesce(s.ended_at,clock_timestamp()) OR e.revision>s.revision
        OR e.amount_minor<=0 OR (e.kind IN ('payment_in','payment_out') AND e.method IS NULL)`)).rows[0]!;
    expect(invalid.count).toBe(0);
    const closed = await owned.pool.query(`WITH live AS (
      SELECT e.* FROM ledger_entries e WHERE e.voids_entry_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM ledger_entries v WHERE v.voids_entry_id=e.id)
    ) SELECT s.id,s.closed_balanced,
      coalesce(sum(CASE WHEN e.kind='buy_in' THEN e.amount_minor WHEN e.kind='cash_out' THEN -e.amount_minor ELSE 0 END),0)::text AS discrepancy
      FROM game_sessions s LEFT JOIN live e ON e.session_id=s.id AND e.banker_id=s.banker_id
      WHERE s.status='closed' GROUP BY s.id`);
    expect(closed.rows).toHaveLength(expected.totalClosed);
    expect(closed.rows.every(row => row.closed_balanced === true && row.discrepancy === '0')).toBe(true);
    const first = (await owned.pool.query("SELECT id FROM game_sessions WHERE banker_id=$1 AND status='closed' ORDER BY played_on,id LIMIT 1", [seeded.bankerId])).rows[0]!;
    const firstState = await loadSession(owned.pool, seeded.bankerId, first.id);
    expect(firstState.totals).toMatchObject({ total_in_minor: '73000', total_out_minor: '73000', discrepancy_minor: '0' });
    expect(firstState.players.find(player => player.id === seeded.playerId)).toMatchObject({ state: 'cashed_out', result_minor: '-1500', bought_in_minor: '18000', cashed_out_minor: '16500', expense_minor: '300' });
    const report = await playerHistory(owned.pool, seeded.bankerId, seeded.playerId);
    expect(report.sessions.filter(item => item.session.status === 'closed')).toHaveLength(expected.reportSessions);
    expect(report.sessions.every(item => item.player.id === seeded.playerId)).toBe(true);
    if (expected.workload === 'long') {
      const companion = seeded.companions![0]!;
      expect(seeded.counts).toMatchObject({ other_closed_sessions: 300, companion_closed_sessions: 300, all_other_closed_sessions: 600 });
      expect(companion.workload).toBe('large');
      expect(companion.counts).toMatchObject({ main_closed_sessions: 300, main_open_players: 9, main_open_entries: 60, main_player_report_sessions: 60 });
      await expect(loadSession(owned.pool, seeded.bankerId, companion.sessionId)).rejects.toMatchObject({ status: 404 });
      await expect(playerHistory(owned.pool, seeded.bankerId, companion.playerId)).rejects.toMatchObject({ status: 404 });
      await expect(owned.pool.query('INSERT INTO session_players(session_id,player_id,banker_id) VALUES($1,$2,$3)', [seeded.sessionId, companion.playerId, seeded.bankerId])).rejects.toMatchObject({ code: '23503' });
    } else expect(seeded.companions).toEqual([]);
  } finally { await owned.stop(); }
});
