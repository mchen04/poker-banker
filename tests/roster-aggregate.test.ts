import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { LedgerEntry } from '../src/domain/session';
import { playerHistory, playerRoster } from '../src/server/store';
import { testDatabase } from './database';

type Entry = Pick<LedgerEntry, 'kind' | 'amount_minor'> & Partial<Pick<LedgerEntry, 'id' | 'revision' | 'occurred_at' | 'voids_entry_id'>>;
let database: Awaited<ReturnType<typeof testDatabase>>;
const banker = randomUUID();
const time = '2026-11-10T01:00:00.000Z';
const chip = (kind: LedgerEntry['kind'], amount: string, extra: Omit<Entry, 'kind' | 'amount_minor'> = {}): Entry => ({ kind, amount_minor: amount, ...extra });

beforeAll(async () => {
  database = await testDatabase();
  await database.pool.query("INSERT INTO bankers(id,username,password_hash) VALUES ($1,$2,'test-only')", [banker, `aggregate-${randomUUID().slice(0, 8)}`]);
});
afterAll(async () => { await database?.stop(); });

async function player() {
  const id = randomUUID();
  await database.pool.query('INSERT INTO players(id,banker_id,display_name,name_key) VALUES ($1,$2,$3,$3)', [id, banker, id]);
  return id;
}
async function session(playerId: string, entries: Entry[], currency = 'USD', closed = true) {
  const id = randomUUID();
  await database.pool.query(`INSERT INTO game_sessions(id,banker_id,name,played_on,currency,status,closed_at,closed_balanced)
    VALUES ($1,$2,'Summary game','2026-11-10',$3,$4,$5,$6)`, [id, banker, currency, closed ? 'closed' : 'open', closed ? time : null, closed ? false : null]);
  await database.pool.query('INSERT INTO session_players(session_id,player_id,banker_id) VALUES ($1,$2,$3)', [id, playerId, banker]);
  for (const [index, entry] of entries.entries()) await database.pool.query(`INSERT INTO ledger_entries
    (id,banker_id,session_id,player_id,kind,amount_minor,method,occurred_at,voids_entry_id,revision)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [entry.id ?? randomUUID(), banker, id, playerId, entry.kind, entry.amount_minor,
    entry.kind.startsWith('payment') ? 'cash' : null, entry.occurred_at === undefined ? time : entry.occurred_at,
    entry.voids_entry_id ?? null, entry.revision ?? String(index + 1)]);
  return id;
}
async function summary(playerId: string) {
  const actual = (await playerRoster(database.pool, banker, playerId))[0]!;
  const reference = await playerHistory(database.pool, banker, playerId);
  expect(JSON.stringify(actual)).toBe(JSON.stringify({ ...reference.player, cumulative: reference.cumulative, outstanding: reference.outstanding }));
  return { cumulative: actual.cumulative, outstanding: actual.outstanding };
}

it('separates currencies and session debt directions while excluding expenses and unfinished results', async () => {
  const id = await player();
  await session(id, [chip('buy_in', '100'), chip('cash_out', '130'), chip('payment_in', '20'), chip('payment_out', '10'), chip('expense', '900')]);
  await session(id, [chip('buy_in', '200'), chip('cash_out', '0'), chip('payment_in', '50'), chip('payment_out', '10')]);
  await session(id, [chip('buy_in', '50'), chip('cash_out', '70')], 'USD', false);
  await session(id, [chip('buy_in', '100'), chip('cash_out', '150'), chip('buy_in', '70')]);
  await session(id, [chip('buy_in', '40'), chip('cash_out', '50'), chip('payment_in', '10')], 'EUR');
  await session(id, [], 'JPY');
  expect(await summary(id)).toEqual({
    cumulative: [{ currency: 'EUR', result_minor: '10' }, { currency: 'USD', result_minor: '-170' }],
    outstanding: [
      { currency: 'EUR', owed_to_banker_minor: '0', owed_by_banker_minor: '20' },
      { currency: 'JPY', owed_to_banker_minor: '0', owed_by_banker_minor: '0' },
      { currency: 'USD', owed_to_banker_minor: '180', owed_by_banker_minor: '60' },
    ],
  });
});

it('sums money beyond int64 without rounding or cancelling opposite session debts', async () => {
  const id = await player();
  await session(id, [chip('buy_in', '9000000000000000000'), chip('buy_in', '9000000000000000000'), chip('cash_out', '0')]);
  await session(id, [chip('cash_out', '9000000000000000000'), chip('cash_out', '9000000000000000000')]);
  expect(await summary(id)).toEqual({ cumulative: [{ currency: 'USD', result_minor: '0' }], outstanding: [
    { currency: 'USD', owed_to_banker_minor: '18000000000000000000', owed_by_banker_minor: '18000000000000000000' },
  ] });
});

it('keeps empty summaries without seats and zero currency balances for empty, void-only and expense-only seats', async () => {
  const absent = await player();
  expect(await summary(absent)).toEqual({ cumulative: [], outstanding: [] });
  const id = await player();
  const original = randomUUID();
  await session(id, [], 'EUR');
  await session(id, [chip('buy_in', '10', { id: original }), chip('buy_in', '10', { voids_entry_id: original })], 'USD');
  await session(id, [chip('expense', '500')], 'JPY');
  expect(await summary(id)).toEqual({ cumulative: [], outstanding: ['EUR', 'JPY', 'USD'].map(currency => ({
    currency, owed_to_banker_minor: '0', owed_by_banker_minor: '0',
  })) });
});

it('uses occurrence order when known and limits unknown-time revision order to one player session', async () => {
  const id = await player();
  await session(id, [chip('buy_in', '100', { revision: '3' }), chip('cash_out', '125', { revision: '2', occurred_at: '2026-11-10T02:00:00.000Z' })]);
  await session(id, [chip('buy_in', '100', { revision: '3' }), chip('cash_out', '125', { revision: '2', occurred_at: null })]);
  expect(await summary(id)).toEqual({ cumulative: [{ currency: 'USD', result_minor: '25' }], outstanding: [
    { currency: 'USD', owed_to_banker_minor: '0', owed_by_banker_minor: '50' },
  ] });
});

it('does not let another player with unknown chip time change known occurrence order', async () => {
  const id = await player();
  const other = await player();
  const sessionId = await session(id, [chip('buy_in', '100', { revision: '3' }), chip('cash_out', '125', { revision: '2', occurred_at: '2026-11-10T02:00:00.000Z' })]);
  await database.pool.query('INSERT INTO session_players(session_id,player_id,banker_id) VALUES ($1,$2,$3)', [sessionId, other, banker]);
  await database.pool.query("INSERT INTO ledger_entries(id,banker_id,session_id,player_id,kind,amount_minor,revision) VALUES ($1,$2,$3,$4,'buy_in',100,4)", [randomUUID(), banker, sessionId, other]);
  const roster = await playerRoster(database.pool, banker, '');
  expect(roster.find(row => row.id === id)!.cumulative).toEqual([{ currency: 'USD', result_minor: '25' }]);
});

it('follows repeated correction ancestry for timestamp ties and unknown chip times', async () => {
  for (const occurred_at of [time, null]) {
    const id = await player();
    const first = randomUUID(), replacement = randomUUID();
    await session(id, [
      chip('buy_in', '100', { id: first, revision: '1', occurred_at }),
      chip('cash_out', '150', { revision: '2', occurred_at }),
      chip('buy_in', '100', { voids_entry_id: first, revision: '3', occurred_at }),
      chip('buy_in', '110', { id: replacement, revision: '3', occurred_at }),
      chip('buy_in', '110', { voids_entry_id: replacement, revision: '4', occurred_at }),
      chip('buy_in', '120', { revision: '4', occurred_at }),
    ]);
    expect((await summary(id)).cumulative).toEqual([{ currency: 'USD', result_minor: '30' }]);
  }
});

it('uses corrected occurrence time ahead of ancestry and ignores voided unknown chip times', async () => {
  const id = await player();
  const first = randomUUID();
  await session(id, [
    chip('buy_in', '100', { id: first, revision: '1', occurred_at: null }),
    chip('cash_out', '150', { revision: '2', occurred_at: '2026-11-10T02:00:00.000Z' }),
    chip('buy_in', '100', { voids_entry_id: first, revision: '3', occurred_at: null }),
    chip('buy_in', '120', { revision: '3', occurred_at: '2026-11-10T00:00:00.000Z' }),
  ]);
  expect((await summary(id)).cumulative).toEqual([{ currency: 'USD', result_minor: '30' }]);
  const changed = await player();
  const old = randomUUID();
  await session(changed, [
    chip('buy_in', '100', { id: old }),
    chip('cash_out', '150', { occurred_at: '2026-11-10T02:00:00.000Z' }),
    chip('buy_in', '100', { voids_entry_id: old, revision: '3' }),
    chip('buy_in', '120', { revision: '3', occurred_at: '2026-11-10T03:00:00.000Z' }),
  ]);
  expect((await summary(changed)).cumulative).toEqual([]);
});

it('truncates occurrence times to milliseconds before revision and UUID tie breakers', async () => {
  const id = await player();
  await session(id, [
    chip('buy_in', '100', { revision: '2', occurred_at: '2026-11-10T01:00:00.000100Z' }),
    chip('cash_out', '150', { revision: '1', occurred_at: '2026-11-10T01:00:00.000900Z' }),
  ]);
  expect((await summary(id)).cumulative).toEqual([]);
  const tied = await player();
  await session(tied, [
    chip('buy_in', '100', { id: 'ffffffff-ffff-4fff-bfff-ffffffffffff', revision: '1' }),
    chip('cash_out', '150', { id: '00000000-0000-4000-8000-000000000001', revision: '1' }),
  ]);
  expect((await summary(tied)).cumulative).toEqual([]);
});
