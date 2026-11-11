import { randomUUID, createHash } from 'node:crypto';
import type { Database, Transaction } from './db.js';
import { transaction } from './db.js';
import { conflict, notFound } from './errors.js';
import { effectiveEntries } from '../domain/timing.js';
import { deriveSession, type LedgerEntry, type PaymentMethod, type SessionEvent, type SessionSettings } from '../domain/session.js';

type SessionRow = SessionSettings & { banker_id: string; revision: string };
type Queryable = Pick<Transaction, 'query'>;

const isoTime = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const sessionColumns = `s.id, s.banker_id, s.name, to_char(s.played_on, 'YYYY-MM-DD') AS played_on, s.currency, s.status,
  s.location, s.game, s.big_blind_minor::text, ${isoTime('s.started_at')} AS started_at, ${isoTime('s.ended_at')} AS ended_at,
  s.closed_balanced, s.closed_at::text, s.share_token, s.revision::text, s.created_at::text, s.updated_at::text`;

export async function serverTime(db: Queryable): Promise<string> {
  const result = await db.query<{ server_now: string }>(`SELECT ${isoTime('clock_timestamp()')} AS server_now`);
  return result.rows[0]!.server_now;
}

export async function sessionRow(db: Queryable, banker: string, session: string, lock = false): Promise<SessionRow> {
  const result = await db.query<SessionRow>(
    `SELECT ${sessionColumns} FROM game_sessions s WHERE s.id = $1 AND s.banker_id = $2${lock ? ' FOR UPDATE' : ''}`, [session, banker]);
  return result.rows[0] ?? notFound();
}

export async function loadSession(db: Queryable, banker: string, session: string) {
  const row = await sessionRow(db, banker, session);
  const players = await db.query<{ id: string; display_name: string }>(
    `SELECT p.id, p.display_name FROM session_players sp JOIN players p ON p.id = sp.player_id AND p.banker_id = sp.banker_id
     WHERE sp.session_id = $1 AND sp.banker_id = $2 ORDER BY sp.added_at, p.id`, [session, banker]);
  const entries = await db.query<LedgerEntry>(
    `SELECT id, player_id, kind, amount_minor::text, note, method, ${isoTime('occurred_at')} AS occurred_at, voids_entry_id, created_at::text, revision::text
     FROM ledger_entries WHERE session_id = $1 AND banker_id = $2 ORDER BY ledger_entries.revision, created_at, id`, [session, banker]);
  const events = await db.query<SessionEvent>(
    `SELECT id, kind, detail, created_at::text, revision::text FROM session_events
     WHERE session_id = $1 AND banker_id = $2 ORDER BY session_events.revision DESC, id`, [session, banker]);
  const { banker_id: _, revision, ...settings } = row;
  return deriveSession(settings, revision, players.rows, entries.rows, events.rows, await serverTime(db));
}

export async function readSnapshot<T>(pool: Database, action: (db: Transaction) => Promise<T>): Promise<T> {
  return transaction(pool, async db => {
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    return action(db);
  });
}

export async function event(db: Transaction, banker: string, session: string, revision: string, kind: string, detail: Record<string, unknown> = {}) {
  await db.query('INSERT INTO session_events(id,banker_id,session_id,kind,detail,revision) VALUES ($1,$2,$3,$4,$5,$6)', [randomUUID(), banker, session, kind, detail, revision]);
}

export async function bump(db: Transaction, banker: string, session: string): Promise<string> {
  const result = await db.query<{ revision: string }>('UPDATE game_sessions SET revision = revision + 1, updated_at = clock_timestamp() WHERE id = $1 AND banker_id = $2 RETURNING revision::text', [session, banker]);
  return result.rows[0]!.revision;
}

export function assertOpen(row: SessionRow) {
  if (row.status !== 'open') conflict('session_closed', 'Reopen this session before writing');
}

export async function insertEntry(db: Transaction, banker: string, session: string, revision: string, entry: {
  player_id: string; kind: LedgerEntry['kind']; amount_minor: string; note?: string | null; voids_entry_id?: string;
  method?: PaymentMethod | null; occurred_at: string | null;
}) {
  await db.query(`INSERT INTO ledger_entries(id,banker_id,session_id,player_id,kind,amount_minor,note,voids_entry_id,revision,method,occurred_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
  [randomUUID(), banker, session, entry.player_id, entry.kind, entry.amount_minor, entry.note ?? null, entry.voids_entry_id ?? null, revision, entry.method ?? null, entry.occurred_at]);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
}

export async function command<T>(pool: Database, banker: string, op: string, request: unknown, write: (db: Transaction) => Promise<T>) {
  const hash = createHash('sha256').update(canonical(request)).digest();
  return transaction(pool, async db => {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${banker}/${op}`]);
    const prior = await db.query<{ request_hash: Buffer; response: T; status: number }>(
      'SELECT request_hash, response, status FROM idempotency_keys WHERE banker_id = $1 AND key = $2', [banker, op]);
    if (prior.rows[0]) {
      if (!prior.rows[0].request_hash.equals(hash)) conflict('idempotency_mismatch', 'This operation ID was already used for another request');
      return { body: prior.rows[0].response, status: prior.rows[0].status };
    }
    const response = await write(db);
    const saved = await db.query<{ response: T; status: number }>('INSERT INTO idempotency_keys(banker_id,key,request_hash,response,status) VALUES ($1,$2,$3,$4,200) RETURNING response, status', [banker, op, hash, JSON.stringify(response)]);
    return { body: saved.rows[0]!.response, status: saved.rows[0]!.status };
  });
}

export async function playerRecord(db: Queryable, banker: string, player: string) {
  const result = await db.query<{ id: string; display_name: string; created_at: string }>('SELECT id, display_name, created_at::text FROM players WHERE id = $1 AND banker_id = $2', [player, banker]);
  return result.rows[0] ?? notFound();
}

async function playerSessionHistories(db: Queryable, banker: string, players: { id: string; display_name: string }[]) {
  const histories = new Map(players.map(player => [player.id, [] as { session: SessionSettings; revision: string; player: ReturnType<typeof deriveSession>['players'][number]; has_entries: boolean }[]]));
  if (!players.length) return histories;
  const records = new Map(players.map(player => [player.id, player]));
  const rows = await db.query<SessionRow & { owner_player_id: string; entries: LedgerEntry[] }>(`SELECT ${sessionColumns}, sp.player_id AS owner_player_id,
    coalesce(jsonb_agg(jsonb_build_object(
      'id', e.id, 'player_id', e.player_id, 'kind', e.kind, 'amount_minor', e.amount_minor::text,
      'note', e.note, 'method', e.method, 'occurred_at', ${isoTime('e.occurred_at')},
      'voids_entry_id', e.voids_entry_id, 'created_at', e.created_at::text, 'revision', e.revision::text
    )) FILTER (WHERE e.id IS NOT NULL), '[]'::jsonb) AS entries
    FROM session_players sp JOIN game_sessions s ON s.id = sp.session_id AND s.banker_id = sp.banker_id
    LEFT JOIN ledger_entries e ON e.session_id = sp.session_id AND e.player_id = sp.player_id AND e.banker_id = sp.banker_id
    WHERE sp.banker_id = $1 AND sp.player_id = ANY($2::uuid[]) GROUP BY s.id,sp.player_id ORDER BY s.played_on DESC,s.id DESC`, [banker, players.map(player => player.id)]);
  const now = await serverTime(db);
  for (const row of rows.rows) {
    const { banker_id: _, owner_player_id, entries, revision, ...session } = row;
    const player = records.get(owner_player_id)!;
    const state = deriveSession(session, revision, [player], entries, [], now);
    histories.get(player.id)!.push({ session, revision, player: state.players[0]!, has_entries: effectiveEntries(entries).length > 0 });
  }
  return histories;
}

export async function playerSessions(db: Queryable, banker: string, player: { id: string; display_name: string }) {
  return (await playerSessionHistories(db, banker, [player])).get(player.id)!;
}

function summarizeHistory(history: Awaited<ReturnType<typeof playerSessions>>) {
  const cumulative = new Map<string, bigint>();
  const outstanding = new Map<string, { owed_to_banker: bigint; owed_by_banker: bigint }>();
  for (const item of history) {
    const result = item.player;
    if (item.session.status === 'closed' && result.state === 'cashed_out') cumulative.set(item.session.currency, (cumulative.get(item.session.currency) ?? 0n) + BigInt(result.result_minor));
    const amounts = outstanding.get(item.session.currency) ?? { owed_to_banker: 0n, owed_by_banker: 0n };
    const balance = BigInt(result.balance_minor);
    if (balance > 0n) amounts.owed_to_banker += balance;
    if (balance < 0n) amounts.owed_by_banker -= balance;
    outstanding.set(item.session.currency, amounts);
  }
  return {
    cumulative: [...cumulative].sort(([a], [b]) => a.localeCompare(b)).map(([currency, result]) => ({ currency, result_minor: String(result) })),
    outstanding: [...outstanding].sort(([a], [b]) => a.localeCompare(b)).map(([currency, values]) => ({ currency, owed_to_banker_minor: String(values.owed_to_banker), owed_by_banker_minor: String(values.owed_by_banker) })),
  };
}

export async function playerHistory(db: Queryable, banker: string, player: string) {
  const record = await playerRecord(db, banker, player);
  const history = await playerSessions(db, banker, record);
  return { player: record, ...summarizeHistory(history), sessions: history.map(({ has_entries: _, ...item }) => item) };
}

export async function playerRoster(db: Queryable, banker: string, search: string) {
  const players = await db.query<{ id: string; display_name: string; created_at: string }>(
    'SELECT id,display_name,created_at::text FROM players WHERE banker_id=$1 AND position($2 in name_key)>0 ORDER BY name_key,id', [banker, search]);
  if (!players.rows.length) return [];
  const summaries = await db.query<{
    player_id: string; currency: string; result_minor: string | null;
    owed_to_banker_minor: string; owed_by_banker_minor: string;
  }>(`WITH RECURSIVE entries AS MATERIALIZED (
    SELECT id, session_id, player_id, kind, amount_minor::numeric AS amount_minor,
      occurred_at, voids_entry_id, revision
    FROM ledger_entries WHERE banker_id = $1 AND player_id = ANY($2::uuid[])
  ), live AS (
    SELECT e.* FROM entries e WHERE e.voids_entry_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM entries v WHERE v.voids_entry_id = e.id)
  ), ancestry AS (
    SELECT id, session_id, player_id, kind, revision AS original_revision
    FROM live WHERE kind IN ('buy_in', 'cash_out')
    UNION ALL
    SELECT a.id, a.session_id, a.player_id, a.kind, original.revision
    FROM ancestry a JOIN entries correction ON correction.session_id = a.session_id
      AND correction.player_id = a.player_id AND correction.kind = a.kind
      AND correction.revision = a.original_revision AND correction.voids_entry_id IS NOT NULL
    JOIN entries original ON original.id = correction.voids_entry_id AND original.revision < a.original_revision
  ), chip_order AS (
    SELECT e.*, min(a.original_revision) AS original_revision,
      bool_or(e.occurred_at IS NULL) OVER (PARTITION BY e.session_id, e.player_id) AS unknown_time
    FROM live e JOIN ancestry a ON a.id = e.id
    GROUP BY e.id, e.session_id, e.player_id, e.kind, e.amount_minor, e.occurred_at, e.voids_entry_id, e.revision
  ), last_chip AS (
    SELECT DISTINCT ON (session_id, player_id) session_id, player_id, kind
    FROM chip_order ORDER BY session_id, player_id,
      CASE WHEN NOT unknown_time THEN date_trunc('milliseconds', occurred_at) END DESC NULLS LAST,
      original_revision DESC, id DESC
  ), amounts AS (
    SELECT session_id, player_id,
      coalesce(sum(CASE WHEN kind = 'cash_out' THEN amount_minor ELSE -amount_minor END)
        FILTER (WHERE kind IN ('buy_in', 'cash_out')), 0) AS result_minor,
      sum(CASE WHEN kind IN ('buy_in', 'payment_out') THEN amount_minor
        WHEN kind IN ('cash_out', 'payment_in') THEN -amount_minor ELSE 0 END) AS balance_minor
    FROM live GROUP BY session_id, player_id
  )
  SELECT sp.player_id, s.currency,
    sum(a.result_minor) FILTER (WHERE s.status = 'closed' AND chip.kind = 'cash_out')::text AS result_minor,
    sum(greatest(coalesce(a.balance_minor, 0), 0))::text AS owed_to_banker_minor,
    sum(greatest(-coalesce(a.balance_minor, 0), 0))::text AS owed_by_banker_minor
  FROM session_players sp JOIN game_sessions s ON s.id = sp.session_id AND s.banker_id = sp.banker_id
    LEFT JOIN amounts a ON a.session_id = sp.session_id AND a.player_id = sp.player_id
    LEFT JOIN last_chip chip ON chip.session_id = sp.session_id AND chip.player_id = sp.player_id
  WHERE sp.banker_id = $1 AND sp.player_id = ANY($2::uuid[])
  GROUP BY sp.player_id, s.currency`, [banker, players.rows.map(player => player.id)]);
  const byPlayer = new Map(players.rows.map(player => [player.id, [] as typeof summaries.rows]));
  for (const summary of summaries.rows) byPlayer.get(summary.player_id)!.push(summary);
  return players.rows.map(player => {
    const currencies = byPlayer.get(player.id)!.sort((a, b) => a.currency.localeCompare(b.currency));
    return { ...player,
      cumulative: currencies.filter(row => row.result_minor !== null).map(row => ({ currency: row.currency, result_minor: row.result_minor! })),
      outstanding: currencies.map(row => ({ currency: row.currency, owed_to_banker_minor: row.owed_to_banker_minor, owed_by_banker_minor: row.owed_by_banker_minor })),
    };
  });
}
