import { withShutdownDeadline } from '../owned-process';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { hash, Algorithm } from '@node-rs/argon2';
import type pg from 'pg';
import { deriveSession, type LedgerEntry, type PaymentMethod, type SessionEvent, type SessionSettings } from '../../src/domain/session';
import { loadSession } from '../../src/server/store';
import type { SeedFixture } from './types';

type SeedEntry = LedgerEntry & { banker_id: string; session_id: string };
type SeedSession = SessionSettings & { banker_id: string; revision: string };
type SeedPlayer = { id: string; banker_id: string; display_name: string; name_key: string; created_at: string };
type Seat = { session_id: string; player_id: string; banker_id: string; added_at: string };
type SeedEvent = SessionEvent & { session_id: string; banker_id: string };
const minute = 60_000;
const day = 86_400_000;
const methods: PaymentMethod[] = ['cash', 'venmo', 'zelle'];
const iso = (time: number) => new Date(time).toISOString();

async function insert(db: pg.PoolClient, table: string, definition: string, rows: object[]) {
  const columns = definition.split(',').map(column => column.trim().split(' ')[0]).join(',');
  for (let offset = 0; offset < rows.length; offset += 1500) await db.query(`INSERT INTO ${table}(${columns}) SELECT ${columns} FROM jsonb_to_recordset($1::jsonb) AS seed_row(${definition})`, [JSON.stringify(rows.slice(offset, offset + 1500))]);
}

export type SeedOptions = { workload?: 'small' | 'large' | 'long' };

export async function seedBenchmark(pool: pg.Pool, options: SeedOptions = {}): Promise<SeedFixture> {
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM bankers')).rows[0]!.count, 0, 'Benchmark seed requires its fresh empty database');
  const now = Date.now();
  const midnight = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  const historyEnd = midnight - 2 * day;
  const historyStart = historyEnd - 1095 * day;
  const bankers: { id: string; username: string; password_hash: string; created_at: string; password_changed_at: string }[] = [];
  const auth: { id: string; banker_id: string; token_hash: string; created_at: string; last_seen_at: string; expires_at: string }[] = [];
  const players: SeedPlayer[] = [];
  const sessions: SeedSession[] = [];
  const seats: Seat[] = [];
  const entries: SeedEntry[] = [];
  const events: SeedEvent[] = [];
  const workload = options.workload ?? 'large';
  const dimensions = workload === 'small'
    ? [{ workload: 'small' as const, players: 6, closed: 10, openPlayers: 6, openEntries: 20 }]
    : [{ workload: 'large' as const, players: 40, closed: 300, openPlayers: 9, openEntries: 60 }, { workload: 'long' as const, players: 40, closed: 1000, openPlayers: 25, openEntries: 400 }];
  const fixtures: SeedFixture[] = [];
  function buildSession(banker: string, roster: SeedPlayer[], index: number, profile?: typeof dimensions[number], counts?: Record<string, number>, viewerToken?: string, open = false) {
    const main = profile !== undefined;
    const start = open ? now - 3 * 60 * minute : (profile ? historyStart + Math.floor(index * 1095 / (profile.closed - 1)) * day : historyEnd - (45 - index * 3) * day) + 18 * 60 * minute;
    const length = (240 + index % 3 * 30) * minute;
    const end = start + length;
    const sessionId = randomUUID();
    const selected = open ? roster.slice(0, profile!.openPlayers) : Array.from({ length: Math.min(roster.length, main ? 6 + index % 5 : 6 + index % 3) }, (_, seat) => roster[(index * 7 + seat) % roster.length]!);
    let revision = selected.length + 2;
    const sessionEntries: SeedEntry[] = [];
    const sessionEvents: SeedEvent[] = [];
    const session: SeedSession = {
      id: sessionId, banker_id: banker, name: open ? 'Benchmark open table' : `${main ? 'Home' : 'Other'} game ${String(index + 1).padStart(3, '0')}`,
      played_on: iso(start).slice(0, 10), currency: 'USD', status: open ? 'open' : 'closed',
      location: ['Justin’s home', 'Mike’s place', 'Club room'][index % 3]!, game: index % 4 === 0 ? 'PLO' : 'NLH', big_blind_minor: String([100, 200, 500][index % 3]),
      started_at: iso(start), ended_at: open ? null : iso(end), closed_balanced: open ? null : true, closed_at: open ? null : iso(end + minute),
      share_token: open ? viewerToken! : null, created_at: iso(start - 60 * minute), updated_at: iso(open ? now : end + minute), revision: '1',
    };
    for (const [seat, player] of selected.entries()) seats.push({ session_id: sessionId, banker_id: banker, player_id: player.id, added_at: iso(start - (30 - seat) * minute) });
    function emit(player: SeedPlayer, at: number, records: { kind: LedgerEntry['kind']; amount: bigint; method?: PaymentMethod; note?: string; voids?: string }[]) {
      revision++;
      const result = records.map(record => {
        assert(record.amount > 0n);
        const row: SeedEntry = { id: randomUUID(), banker_id: banker, session_id: sessionId, player_id: player.id, kind: record.kind, amount_minor: String(record.amount), method: record.method ?? null, note: record.note ?? null, occurred_at: iso(at), voids_entry_id: record.voids ?? null, created_at: iso(at), revision: String(revision) };
        sessionEntries.push(row); return row;
      });
      return result;
    }
    function payIn(player: SeedPlayer, at: number, amount: bigint, method: PaymentMethod, note?: string) { return emit(player, at, [{ kind: 'payment_in', amount, method, note }])[0]!; }
    sessionEvents.push({ id: randomUUID(), session_id: sessionId, banker_id: banker, kind: 'created', detail: {}, created_at: session.created_at, revision: '1' });
    sessionEvents.push({ id: randomUUID(), session_id: sessionId, banker_id: banker, kind: 'timer_started', detail: { old: { started_at: null, ended_at: null }, new: { started_at: session.started_at, ended_at: null } }, created_at: iso(start), revision: String(selected.length + 2) });
    if (open) {
      for (const [seat, player] of selected.entries()) emit(player, start + seat * minute, [{ kind: 'buy_in', amount: 10000n }, { kind: 'payment_in', amount: 10000n, method: methods[seat % 3]! }]);
      const rebuys = profile!.openEntries / 2 - selected.length;
      for (let index = 0; index < rebuys; index++) {
        const player = selected[index % selected.length]!;
        emit(player, start + (30 + index * Math.min(3, 140 / Math.max(1, rebuys - 1))) * minute, [{ kind: 'buy_in', amount: 5000n }, { kind: 'payment_in', amount: 5000n, method: methods[index % 3]!, note: 'Rebuy paid now' }]);
      }
      assert.equal(sessionEntries.length, profile!.openEntries);
    } else {
      let priorResults = 0n;
      for (const [seat, player] of selected.entries()) {
        const result = seat === selected.length - 1 ? -priorResults : BigInt((index + seat) % 7 - 3) * 500n;
        priorResults += result;
        const arrival = start + (seat % 4 * 10 + 1) * minute;
        const method = methods[(index + seat) % 3]!;
        const latePayment = (index + seat) % 4 === 0;
        const partial = index % 17 === 0 && seat === selected.length - 1;
        emit(player, arrival, [{ kind: 'buy_in', amount: 10000n }]);
        const payment = payIn(player, arrival + (latePayment ? 20 * minute : 0), partial ? 7000n : 10000n, method, latePayment ? 'Unpaid buy-in settled later' : 'Paid with buy-in');
        if (main && index % 25 === 0 && seat === 0) {
          emit(player, arrival + 21 * minute, [
            { kind: 'payment_in', amount: BigInt(payment.amount_minor), method, voids: payment.id, note: 'Voided method' },
            { kind: 'payment_in', amount: BigInt(payment.amount_minor), method: methods[(index + seat + 1) % 3]!, note: 'Corrected payment method' },
          ]);
          counts!.main_voids!++;
        }
        let bought = 10000n;
        if ((index + seat) % 3 === 0) {
          emit(player, start + 75 * minute, [{ kind: 'buy_in', amount: 5000n }, { kind: 'payment_in', amount: 5000n, method }]); bought += 5000n;
          if (main) counts!.main_rebuys!++;
        }
        let remainingOut = bought + result;
        if (index % 5 === 0 && seat === 0) {
          emit(player, start + 120 * minute, [{ kind: 'cash_out', amount: bought + 1000n }, { kind: 'payment_out', amount: bought + 1000n, method }]);
          emit(player, start + 150 * minute, [{ kind: 'buy_in', amount: 3000n }]);
          payIn(player, start + 165 * minute, 3000n, methods[(index + 1) % 3]!, 'Re-entry settled later');
          bought += 3000n; remainingOut = 2000n + result;
          if (main) counts!.main_reentry_seats!++;
        }
        if ((index + seat) % 4 === 0) {
          emit(player, start + 100 * minute, [{ kind: 'expense', amount: seat % 2 === 0 ? 300n : 500n, note: seat % 2 === 0 ? 'Tip' : 'Meal' }]);
          if (main) counts!.main_expenses!++;
        }
        const cashTime = end - (seat % 3 * 10 + 1) * minute;
        if (main && index % 25 === 0 && seat === 0) {
          const original = emit(player, cashTime, [{ kind: 'cash_out', amount: remainingOut + 100n }])[0]!;
          emit(player, cashTime, [{ kind: 'cash_out', amount: remainingOut + 100n, voids: original.id, note: 'Voided amount typo' }, { kind: 'cash_out', amount: remainingOut, note: 'Corrected amount' }]);
          counts!.main_voids!++;
        } else emit(player, cashTime, [{ kind: 'cash_out', amount: remainingOut }]);
        emit(player, cashTime, [{ kind: 'payment_out', amount: remainingOut, method }]);
      }
      if (index % 17 === 0) {
        revision++;
        sessionEvents.push({ id: randomUUID(), banker_id: banker, session_id: sessionId, kind: 'timing_corrected', detail: { old: { started_at: iso(start - 15 * minute), ended_at: iso(end) }, new: { started_at: iso(start), ended_at: iso(end) } }, created_at: iso(end), revision: String(revision) });
      }
      revision++;
      sessionEvents.push({ id: randomUUID(), banker_id: banker, session_id: sessionId, kind: 'closed', detail: { balanced: true, discrepancy_minor: '0' }, created_at: iso(end + minute), revision: String(revision) });
      if (main) counts!.main_closed_seats! += selected.length;
    }
    session.revision = String(revision);
    const state = deriveSession(session, session.revision, selected, sessionEntries, sessionEvents, iso(now));
    if (open) assert(state.players.every(player => player.state === 'playing'));
    else { assert(state.players.every(player => player.state === 'cashed_out')); assert.equal(state.totals.discrepancy_minor, '0'); }
    sessions.push(session); entries.push(...sessionEntries); events.push(...sessionEvents);
    return session;
  }
  const backgroundCount = workload === 'small' ? 0 : 20;
  for (let bankerIndex = 0; bankerIndex < dimensions.length + backgroundCount; bankerIndex++) {
    const profile = dimensions[bankerIndex];
    const main = profile !== undefined;
    const banker = randomUUID();
    const password = `bench-only-${randomUUID()}`;
    const viewerToken = randomBytes(16).toString('base64url');
    const username = `bench-${profile?.workload ?? bankerIndex}-${randomBytes(5).toString('hex')}`;
    bankers.push({ id: banker, username, password_hash: await hash(password, { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 }), created_at: iso(historyStart), password_changed_at: iso(historyStart) });
    auth.push({ id: randomUUID(), banker_id: banker, token_hash: `\\x${createHash('sha256').update(randomBytes(32)).digest('hex')}`, created_at: iso(now - day), last_seen_at: iso(now), expires_at: iso(now + 180 * day) });
    const roster = Array.from({ length: profile?.players ?? 12 }, (_, index) => ({ id: randomUUID(), banker_id: banker, display_name: main ? `Player ${String(index + 1).padStart(2, '0')}` : `Other ${bankerIndex} player ${index + 1}`, name_key: main ? `player ${String(index + 1).padStart(2, '0')}` : `other ${bankerIndex} player ${index + 1}`, created_at: iso(historyStart) }));
    players.push(...roster);
    const counts: Record<string, number> = { main_players: roster.length, main_closed_sessions: profile?.closed ?? 15, main_open_sessions: main ? 1 : 0, main_closed_seats: 0, main_reentry_seats: 0, main_rebuys: 0, main_expenses: 0, main_voids: 0, main_open_entries: profile?.openEntries ?? 0, main_open_players: profile?.openPlayers ?? 0 };
    for (let index = 0; index < (profile?.closed ?? 15); index++) buildSession(banker, roster, index, profile, counts);
    if (profile) {
      const openSession = buildSession(banker, roster, 0, profile, counts, viewerToken, true);
      fixtures.push({ bankerId: banker, username, password, sessionId: openSession.id, playerId: roster[0]!.id, playerIds: roster.map(player => player.id), token: viewerToken, counts, dataset: profile.workload === 'small' ? 'small' : 'large', workload: profile.workload });
    }
  }
  const db = await pool.connect();
  let discard = false;
  try {
    await db.query('BEGIN');
    await insert(db, 'bankers', 'id uuid,username text,password_hash text,created_at timestamptz,password_changed_at timestamptz', bankers);
    await insert(db, 'auth_sessions', 'id uuid,banker_id uuid,token_hash bytea,created_at timestamptz,last_seen_at timestamptz,expires_at timestamptz', auth);
    await insert(db, 'players', 'id uuid,banker_id uuid,display_name text,name_key text,created_at timestamptz', players);
    await insert(db, 'game_sessions', 'id uuid,banker_id uuid,name text,played_on date,currency text,status text,location text,game text,big_blind_minor bigint,started_at timestamptz,ended_at timestamptz,closed_balanced boolean,closed_at timestamptz,share_token text,created_at timestamptz,updated_at timestamptz,revision bigint', sessions);
    await insert(db, 'session_players', 'session_id uuid,player_id uuid,banker_id uuid,added_at timestamptz', seats);
    await insert(db, 'ledger_entries', 'id uuid,banker_id uuid,session_id uuid,player_id uuid,kind text,amount_minor bigint,method text,note text,occurred_at timestamptz,voids_entry_id uuid,created_at timestamptz,revision bigint', entries);
    await insert(db, 'session_events', 'id uuid,banker_id uuid,session_id uuid,kind text,detail jsonb,created_at timestamptz,revision bigint', events);
    await db.query('COMMIT');
  } catch (error) {
    try { await withShutdownDeadline('Benchmark seed rollback', () => db.query('ROLLBACK')); }
    catch (cleanup) { discard = true; throw new AggregateError([error, cleanup], 'Benchmark seed and rollback failed'); }
    throw error;
  } finally { db.release(discard); }
  await pool.query('ANALYZE');
  for (const fixture of fixtures) {
    const state = await loadSession(pool, fixture.bankerId, fixture.sessionId);
    assert.equal(state.entries.length, fixture.counts.main_open_entries); assert.equal(state.players.length, fixture.counts.main_open_players);
    Object.assign(fixture.counts, { bankers: bankers.length, players: players.length, sessions: sessions.length, closed_sessions: sessions.filter(session => session.status === 'closed').length, open_sessions: fixtures.length, seats: seats.length, entries: entries.length, events: events.length, other_closed_sessions: backgroundCount * 15, companion_closed_sessions: fixtures.filter(companion => companion !== fixture).reduce((sum, companion) => sum + companion.counts.main_closed_sessions!, 0), all_other_closed_sessions: sessions.filter(session => session.status === 'closed' && session.banker_id !== fixture.bankerId).length });
    fixture.counts.main_player_report_sessions = (await pool.query('SELECT count(*)::int AS count FROM session_players sp JOIN game_sessions s ON s.id=sp.session_id AND s.banker_id=sp.banker_id WHERE sp.banker_id=$1 AND sp.player_id=$2 AND s.status=\'closed\'', [fixture.bankerId, fixture.playerId])).rows[0]!.count;
  }
  const primary = fixtures.find(fixture => fixture.workload === workload)!;
  primary.companions = fixtures.filter(fixture => fixture !== primary);
  return primary;
}
