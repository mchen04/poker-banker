import { randomUUID, createHash } from 'node:crypto';
import type { Database, Transaction } from './db';
import { transaction } from './db';
import { conflict, notFound } from './errors';
import { deriveSession, type LedgerEntry, type SessionEvent, type SessionSettings } from '../domain/session';

type SessionRow = SessionSettings & { banker_id: string; revision: string };
type Queryable = Pick<Transaction, 'query'>;

export async function sessionRow(db: Queryable, banker: string, session: string, lock = false): Promise<SessionRow> {
  const result = await db.query<SessionRow>(
    `SELECT id, banker_id, name, to_char(played_on, 'YYYY-MM-DD') AS played_on, currency, status,
      closed_balanced, closed_at::text, share_token, revision::text, created_at::text, updated_at::text
     FROM game_sessions WHERE id = $1 AND banker_id = $2${lock ? ' FOR UPDATE' : ''}`, [session, banker]);
  return result.rows[0] ?? notFound();
}

export async function loadSession(db: Queryable, banker: string, session: string) {
  const row = await sessionRow(db, banker, session);
  const players = await db.query<{ id: string; display_name: string }>(
    `SELECT p.id, p.display_name FROM session_players sp JOIN players p ON p.id = sp.player_id AND p.banker_id = sp.banker_id
     WHERE sp.session_id = $1 AND sp.banker_id = $2 ORDER BY sp.added_at, p.id`, [session, banker]);
  const entries = await db.query<LedgerEntry>(
    `SELECT id, player_id, kind, amount_minor::text, note, voids_entry_id, created_at::text, revision::text
     FROM ledger_entries WHERE session_id = $1 AND banker_id = $2 ORDER BY ledger_entries.revision, created_at, id`, [session, banker]);
  const events = await db.query<SessionEvent>(
    `SELECT id, kind, detail, created_at::text, revision::text FROM session_events
     WHERE session_id = $1 AND banker_id = $2 ORDER BY session_events.revision DESC, id`, [session, banker]);
  const { banker_id: _, revision, ...settings } = row;
  return deriveSession(settings, revision, players.rows, entries.rows, events.rows);
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
}) {
  await db.query(`INSERT INTO ledger_entries(id,banker_id,session_id,player_id,kind,amount_minor,note,voids_entry_id,revision)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
  [randomUUID(), banker, session, entry.player_id, entry.kind, entry.amount_minor, entry.note ?? null, entry.voids_entry_id ?? null, revision]);
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

export async function playerHistory(db: Queryable, banker: string, player: string) {
  const record = await playerRecord(db, banker, player);
  const sessions = await db.query<{ session_id: string }>('SELECT sp.session_id FROM session_players sp JOIN game_sessions s ON s.id = sp.session_id AND s.banker_id = sp.banker_id WHERE sp.banker_id = $1 AND sp.player_id = $2 ORDER BY s.played_on DESC, s.id DESC', [banker, player]);
  const cumulative = new Map<string, bigint>();
  const outstanding = new Map<string, { owed_to_banker: bigint; owed_by_banker: bigint }>();
  const history = [];
  for (const item of sessions.rows) {
    const state = await loadSession(db, banker, item.session_id);
    const result = state.players.find(item => item.id === player)!;
    if (state.session.status === 'closed' && result.state === 'cashed_out') cumulative.set(state.session.currency, (cumulative.get(state.session.currency) ?? 0n) + BigInt(result.result_minor));
    const amounts = outstanding.get(state.session.currency) ?? { owed_to_banker: 0n, owed_by_banker: 0n };
    const balance = BigInt(result.balance_minor);
    if (balance > 0n) amounts.owed_to_banker += balance;
    if (balance < 0n) amounts.owed_by_banker -= balance;
    outstanding.set(state.session.currency, amounts);
    history.push({ session: state.session, revision: state.revision, player: result });
  }
  return {
    player: record,
    cumulative: [...cumulative].sort(([a], [b]) => a.localeCompare(b)).map(([currency, result]) => ({ currency, result_minor: String(result) })),
    outstanding: [...outstanding].sort(([a], [b]) => a.localeCompare(b)).map(([currency, values]) => ({ currency, owed_to_banker_minor: String(values.owed_to_banker), owed_by_banker_minor: String(values.owed_by_banker) })),
    sessions: history,
  };
}
