import { randomBytes, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { Hono } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { z } from 'zod';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Database, Transaction } from './db.js';
import type { AppContext, AppEnv } from './context.js';
import { authRoutes, authenticate } from './auth.js';
import { ApiError, conflict, notFound } from './errors.js';
import * as v from './validation.js';
import { assertOpen, bump, command, effectivePlayerEntries, event, insertEntry, loadSession, lockPlayers, playerHistory, playerRecord, playerRoster, playerSessions, readSnapshot, removalEntries, serverTime, sessionRow } from './store.js';
import { playerReport } from '../domain/report.js';
import { viewerState, type SessionSettings } from '../domain/session.js';

type Config = { origin?: string; clientIp?: (c: AppContext) => string; onError?: (error: unknown) => void };
const recordName = (name: string) => name.normalize('NFKC').toLowerCase();

async function mutate<T extends { op_id: string }>(c: AppContext, pool: Database, schema: z.ZodType<T>, write: (db: Transaction, banker: string, input: T) => Promise<unknown>) {
  const body: unknown = await c.req.json();
  const input = schema.parse(body);
  const banker = c.get('banker').id;
  const result = await command(pool, banker, input.op_id, { method: c.req.method, path: c.req.path, body }, db => write(db, banker, input));
  return c.json(result.body, result.status as ContentfulStatusCode);
}

function assertOccurredAt(session: Pick<SessionSettings, 'started_at' | 'ended_at'>, occurredAt: string | null) {
  if (occurredAt === null) return;
  if ((session.started_at !== null && Date.parse(occurredAt) < Date.parse(session.started_at)) ||
      (session.ended_at !== null && Date.parse(occurredAt) > Date.parse(session.ended_at))) {
    throw new ApiError(400, 'outside_timer_bounds', 'Entry time must be inside the session timer');
  }
}

async function assertTimingEntries(db: Transaction, banker: string, id: string, start: string | null, end: string | null) {
  const outside = await db.query(`SELECT e.id FROM ledger_entries e
    WHERE e.session_id = $1 AND e.banker_id = $2 AND e.kind IN ('buy_in', 'cash_out') AND e.voids_entry_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM ledger_entries v WHERE v.voids_entry_id = e.id AND v.session_id = $1 AND v.banker_id = $2)
    AND (($3::timestamptz IS NOT NULL AND e.occurred_at < $3) OR ($4::timestamptz IS NOT NULL AND e.occurred_at > $4)) LIMIT 1`, [id, banker, start, end]);
  if (outside.rowCount) conflict('entries_outside_timing', 'Timing must include the effective entries');
}

export function createApp(pool: Database, config: Config = {}) {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      const url = new URL(c.req.url);
      if (process.env.VERCEL === '1') url.protocol = 'https:';
      if (c.req.header('origin') !== (config.origin ?? url.origin)) throw new ApiError(403, 'invalid_origin', 'Request origin is not allowed');
      if (c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new ApiError(415, 'json_required', 'Send application/json');
    }
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof ApiError) return c.json({ error: { code: error.code, message: error.message } }, error.status);
    if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ error: { code: 'invalid_request', message: 'Request validation failed' } }, 400);
    config.onError?.(error);
    return c.json({ error: { code: 'internal_error', message: 'Something went wrong' } }, 500);
  });
  app.notFound(c => c.json({ error: { code: 'not_found', message: 'Record not found' } }, 404));
  const clientIp = config.clientIp ?? ((c: AppContext) => {
    if (process.env.VERCEL === '1') {
      const address = c.req.header('x-vercel-forwarded-for')?.split(',')[0]?.trim();
      return address && isIP(address) ? address : 'unknown';
    }
    try { return getConnInfo(c).remote.address ?? 'unknown'; } catch { return 'unknown'; }
  });
  app.route('/api/auth', authRoutes(pool, clientIp));
  app.get('/api/view/:token', async c => {
    const token = c.req.param('token');
    if (!/^[A-Za-z0-9_-]{22}$/.test(token)) notFound();
    const query = v.sinceQuery.parse(c.req.query());
    const result = await readSnapshot(pool, async db => {
      const found = await db.query<{ id: string; banker_id: string; revision: string }>('SELECT id,banker_id,revision::text FROM game_sessions WHERE share_token = $1 AND deleted_at IS NULL', [token]);
      const session = found.rows[0] ?? notFound();
      if (query.since === session.revision) return null;
      return viewerState(await loadSession(db, session.banker_id, session.id));
    });
    return result ? c.json(result) : c.body(null, 304);
  });
  app.use('/api/*', async (c, next) => { await authenticate(pool, c); await next(); });
  app.get('/api/sessions', async c => {
    const query = v.listQuery.parse(c.req.query());
    const before = query.before ? v.cursor.parse(query.before.split(',')) : undefined;
    const result = await pool.query<{ id: string; name: string; played_on: string; currency: string; status: string; revision: string }>(
      `SELECT id, name, to_char(played_on,'YYYY-MM-DD') AS played_on, currency, status, revision::text FROM game_sessions
       WHERE banker_id = $1 AND deleted_at IS NULL AND position(lower($2) in lower(name)) > 0
       AND ($5::text IS NULL OR status = $5)
       AND ($3::date IS NULL OR (played_on,id) < ($3::date,$4::uuid))
       ORDER BY played_on DESC,id DESC LIMIT 31`, [c.get('banker').id, query.q ?? '', before?.[0] ?? null, before?.[1] ?? null, query.status ?? null]);
    const sessions = result.rows.slice(0, 30);
    const last = sessions.at(-1);
    return c.json({ sessions, next: result.rows.length > 30 && last ? `${last.played_on},${last.id}` : null });
  });
  app.get('/api/sessions/deleted', async c => {
    const query = v.deletedQuery.parse(c.req.query());
    const before = query.before ? v.deletedCursor.parse(query.before.split(',')) : undefined;
    const result = await pool.query<{ id: string; name: string; played_on: string; currency: string; status: string; deleted_at: string; revision: string }>(
      `SELECT id, name, to_char(played_on,'YYYY-MM-DD') AS played_on, currency, status,
       to_char(deleted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS deleted_at, revision::text
       FROM game_sessions WHERE banker_id = $1 AND deleted_at IS NOT NULL
       AND ($2::timestamptz IS NULL OR (deleted_at,id) < ($2::timestamptz,$3::uuid))
       ORDER BY deleted_at DESC, id DESC LIMIT 31`, [c.get('banker').id, before?.[0] ?? null, before?.[1] ?? null]);
    const sessions = result.rows.slice(0, 30);
    const last = sessions.at(-1);
    return c.json({ sessions, next: result.rows.length > 30 && last ? `${last.deleted_at},${last.id}` : null });
  });
  app.post('/api/sessions', c => mutate(c, pool, v.sessionCreate, async (db, banker, input) => {
    const id = randomUUID();
    await db.query('INSERT INTO game_sessions(id,banker_id,name,played_on,currency,location,game,big_blind_minor) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [id, banker, input.name, input.played_on, input.currency, input.location ?? null, input.game ?? null, input.big_blind_minor ?? null]);
    await sessionRow(db, banker, id, true);
    await event(db, banker, id, '1', 'created');
    return loadSession(db, banker, id);
  }));
  app.post('/api/sessions/:id/delete', c => mutate(c, pool, v.commandOnly, async (db, banker) => {
    const id = v.id.parse(c.req.param('id'));
    const row = await sessionRow(db, banker, id, true, true);
    if (row.deleted_at != null) conflict('already_deleted', 'This session is already deleted');
    await db.query('UPDATE game_sessions SET deleted_at = clock_timestamp(), share_token = NULL WHERE id = $1 AND banker_id = $2', [id, banker]);
    await bump(db, banker, id);
    return loadSession(db, banker, id, true);
  }));
  app.post('/api/sessions/:id/restore', c => mutate(c, pool, v.commandOnly, async (db, banker) => {
    const id = v.id.parse(c.req.param('id'));
    const seated = () => db.query<{ player_id: string }>('SELECT player_id FROM session_players WHERE session_id = $1 AND banker_id = $2 AND removed_at IS NULL', [id, banker]);
    await lockPlayers(db, banker, (await seated()).rows.map(row => row.player_id));
    const row = await sessionRow(db, banker, id, true, true);
    if (row.deleted_at == null) conflict('session_active', 'This session is not deleted');
    await lockPlayers(db, banker, (await seated()).rows.map(row => row.player_id));
    await db.query('UPDATE game_sessions SET deleted_at = NULL, share_token = NULL WHERE id = $1 AND banker_id = $2', [id, banker]);
    await db.query(`UPDATE players SET deleted_at = NULL WHERE banker_id = $1 AND deleted_at IS NOT NULL
      AND id IN (SELECT player_id FROM session_players WHERE session_id = $2 AND banker_id = $1 AND removed_at IS NULL)`, [banker, id]);
    await bump(db, banker, id);
    return loadSession(db, banker, id);
  }));
  app.get('/api/sessions/:id', async c => {
    const id = v.id.parse(c.req.param('id'));
    const query = v.sinceQuery.parse(c.req.query());
    const result = await readSnapshot(pool, async db => {
      const row = await sessionRow(db, c.get('banker').id, id);
      return row.revision === query.since ? null : loadSession(db, c.get('banker').id, id);
    });
    return result ? c.json(result) : c.body(null, 304);
  });
  app.patch('/api/sessions/:id', c => mutate(c, pool, v.sessionPatch, async (db, banker, input) => {
    const id = v.id.parse(c.req.param('id'));
    const row = await sessionRow(db, banker, id, true);
    assertOpen(row);
    const old = { name: row.name, played_on: row.played_on, location: row.location, game: row.game, big_blind_minor: row.big_blind_minor };
    const next = {
      name: input.name ?? row.name, played_on: input.played_on ?? row.played_on,
      location: input.location === undefined ? row.location : input.location,
      game: input.game === undefined ? row.game : input.game,
      big_blind_minor: input.big_blind_minor === undefined ? row.big_blind_minor : input.big_blind_minor,
    };
    await db.query('UPDATE game_sessions SET name = $3, played_on = $4, location = $5, game = $6, big_blind_minor = $7 WHERE id = $1 AND banker_id = $2', [id, banker, next.name, next.played_on, next.location, next.game, next.big_blind_minor]);
    const revision = await bump(db, banker, id);
    const details = input.location !== undefined || input.game !== undefined || input.big_blind_minor !== undefined;
    await event(db, banker, id, revision, details ? 'details_changed' : 'renamed', { old, new: next });
    return loadSession(db, banker, id);
  }));
  app.post('/api/sessions/:id/start', c => mutate(c, pool, v.startTimer, async (db, banker) => {
    const id = v.id.parse(c.req.param('id'));
    const row = await sessionRow(db, banker, id, true);
    assertOpen(row);
    if (row.started_at !== null) conflict('timer_started', 'Correct timing to change a started timer');
    const startedAt = await serverTime(db);
    await assertTimingEntries(db, banker, id, startedAt, null);
    await db.query('UPDATE game_sessions SET started_at = $3, ended_at = NULL WHERE id = $1 AND banker_id = $2', [id, banker, startedAt]);
    const revision = await bump(db, banker, id);
    await event(db, banker, id, revision, 'timer_started', { old: { started_at: row.started_at, ended_at: row.ended_at }, new: { started_at: startedAt, ended_at: null } });
    return loadSession(db, banker, id);
  }));
  app.patch('/api/sessions/:id/timing', c => mutate(c, pool, v.timingPatch, async (db, banker, input) => {
    const id = v.id.parse(c.req.param('id'));
    const row = await sessionRow(db, banker, id, true);
    assertOpen(row);
    await assertTimingEntries(db, banker, id, input.started_at, input.ended_at);
    await db.query('UPDATE game_sessions SET started_at = $3, ended_at = $4 WHERE id = $1 AND banker_id = $2', [id, banker, input.started_at, input.ended_at]);
    const revision = await bump(db, banker, id);
    await event(db, banker, id, revision, 'timing_corrected', {
      old: { started_at: row.started_at, ended_at: row.ended_at }, new: { started_at: input.started_at, ended_at: input.ended_at },
    });
    return loadSession(db, banker, id);
  }));
  app.post('/api/sessions/:id/players', c => mutate(c, pool, v.seatPlayer, async (db, banker, input) => {
    const id = v.id.parse(c.req.param('id'));
    if ('player_id' in input) await lockPlayers(db, banker, [input.player_id]);
    assertOpen(await sessionRow(db, banker, id, true));
    let player: string;
    if ('player_id' in input) {
      await playerRecord(db, banker, input.player_id);
      player = input.player_id;
    } else {
      player = randomUUID();
      await db.query('INSERT INTO players(id,banker_id,display_name,name_key) VALUES ($1,$2,$3,$4)', [player, banker, input.new_player_name, recordName(input.new_player_name)]);
    }
    const inserted = await db.query('INSERT INTO session_players(session_id,player_id,banker_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING player_id', [id, player, banker]);
    if (!inserted.rowCount) {
      const existing = await db.query<{ removed_at: string | null }>('SELECT removed_at::text FROM session_players WHERE session_id = $1 AND player_id = $2 AND banker_id = $3', [id, player, banker]);
      if (existing.rows[0]?.removed_at) conflict('player_removed', 'Restore this player to seat them again');
      conflict('already_seated', 'This player is already seated');
    }
    await bump(db, banker, id);
    return loadSession(db, banker, id);
  }));
  app.post('/api/sessions/:id/players/:player_id/remove', c => mutate(c, pool, v.commandOnly, async (db, banker) => {
    const id = v.id.parse(c.req.param('id'));
    const playerId = v.id.parse(c.req.param('player_id'));
    assertOpen(await sessionRow(db, banker, id, true));
    const seated = await db.query<{ removed_at: string | null }>('SELECT removed_at::text FROM session_players WHERE session_id = $1 AND player_id = $2 AND banker_id = $3', [id, playerId, banker]);
    if (!seated.rowCount) notFound();
    if (seated.rows[0]!.removed_at !== null) conflict('not_seated', 'This player is not seated');
    const removal = randomUUID();
    await db.query('INSERT INTO session_player_removals(id,session_id,player_id,banker_id) VALUES ($1,$2,$3,$4)', [removal, id, playerId, banker]);
    await db.query('UPDATE session_players SET removed_at = clock_timestamp() WHERE session_id = $1 AND player_id = $2 AND banker_id = $3', [id, playerId, banker]);
    const entries = await effectivePlayerEntries(db, banker, id, playerId);
    const revision = await bump(db, banker, id);
    for (const entry of entries) await insertEntry(db, banker, id, revision, { ...entry, voids_entry_id: entry.id, restores_entry_id: null, removal_id: removal });
    return loadSession(db, banker, id);
  }));
  app.post('/api/sessions/:id/players/:player_id/restore', c => mutate(c, pool, v.commandOnly, async (db, banker) => {
    const id = v.id.parse(c.req.param('id'));
    const playerId = v.id.parse(c.req.param('player_id'));
    await lockPlayers(db, banker, [playerId]);
    assertOpen(await sessionRow(db, banker, id, true));
    const seated = await db.query<{ removed_at: string | null }>('SELECT removed_at::text FROM session_players WHERE session_id = $1 AND player_id = $2 AND banker_id = $3', [id, playerId, banker]);
    if (!seated.rowCount) notFound();
    if (seated.rows[0]!.removed_at === null) conflict('already_seated', 'This player is already seated');
    const removal = await db.query<{ id: string }>('SELECT id FROM session_player_removals WHERE session_id = $1 AND player_id = $2 AND banker_id = $3 AND restored_at IS NULL', [id, playerId, banker]);
    if (!removal.rowCount) conflict('not_removed', 'This player was not removed from this game');
    const entries = await removalEntries(db, banker, id, removal.rows[0]!.id);
    await db.query('UPDATE session_players SET removed_at = NULL WHERE session_id = $1 AND player_id = $2 AND banker_id = $3', [id, playerId, banker]);
    await db.query('UPDATE session_player_removals SET restored_at = clock_timestamp() WHERE id = $1 AND banker_id = $2', [removal.rows[0]!.id, banker]);
    await db.query('UPDATE players SET deleted_at = NULL WHERE id = $1 AND banker_id = $2 AND deleted_at IS NOT NULL', [playerId, banker]);
    const revision = await bump(db, banker, id);
    for (const entry of entries) await insertEntry(db, banker, id, revision, { ...entry, voids_entry_id: null, restores_entry_id: entry.id, removal_id: null });
    return loadSession(db, banker, id);
  }));
  app.post('/api/sessions/:id/entries', c => mutate(c, pool, v.entryCreate, async (db, banker, input) => {
    const id = v.id.parse(c.req.param('id'));
    const row = await sessionRow(db, banker, id, true);
    assertOpen(row);
    const seated = await db.query<{ removed_at: string | null }>('SELECT removed_at::text FROM session_players WHERE session_id = $1 AND player_id = $2 AND banker_id = $3', [id, input.player_id, banker]);
    if (!seated.rowCount) notFound();
    if (seated.rows[0]!.removed_at !== null) conflict('player_removed', 'Restore this player before adding entries');
    const occurredAt = input.occurred_at ?? null;
    if (input.kind === 'buy_in' || input.kind === 'cash_out') assertOccurredAt(row, occurredAt);
    const revision = await bump(db, banker, id);
    if (input.kind === 'buy_in' && row.started_at === null && occurredAt !== null) {
      const started = await db.query(`UPDATE game_sessions SET started_at = $3 WHERE id = $1 AND banker_id = $2
        AND NOT EXISTS (SELECT 1 FROM ledger_entries e WHERE e.session_id = $1 AND e.banker_id = $2
          AND e.kind = 'buy_in' AND e.voids_entry_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM ledger_entries v WHERE v.voids_entry_id = e.id AND v.session_id = $1 AND v.banker_id = $2))`, [id, banker, occurredAt]);
      if (started.rowCount) {
        await assertTimingEntries(db, banker, id, occurredAt, row.ended_at);
        await event(db, banker, id, revision, 'timer_started', { old: { started_at: null, ended_at: row.ended_at }, new: { started_at: occurredAt, ended_at: row.ended_at } });
      }
    }
    const payment = input.kind === 'payment_in' || input.kind === 'payment_out';
    await insertEntry(db, banker, id, revision, { ...input, method: payment ? input.method! : null, occurred_at: occurredAt });
    if (input.amount_minor !== '0' && ((input.kind === 'buy_in' && input.paid_now !== false) || (input.kind === 'cash_out' && input.paid_now === true))) {
      await insertEntry(db, banker, id, revision, { player_id: input.player_id, kind: input.kind === 'buy_in' ? 'payment_in' : 'payment_out', amount_minor: input.amount_minor, method: input.method!, occurred_at: occurredAt });
    }
    return loadSession(db, banker, id);
  }));
  app.post('/api/sessions/:id/entries/:entry_id/undo', c => mutate(c, pool, v.undoEntry, async (db, banker, input) => {
    const id = v.id.parse(c.req.param('id'));
    const entryId = v.id.parse(c.req.param('entry_id'));
    const row = await sessionRow(db, banker, id, true);
    assertOpen(row);
    if (row.revision !== input.expected_revision) conflict('revision_mismatch', 'Session changed. Review it before undoing');
    const state = await loadSession(db, banker, id);
    const original = state.entries.find(entry => entry.id === entryId) ?? notFound();
    if (original.voids_entry_id || state.entries.some(entry => entry.voids_entry_id === original.id)) conflict('already_voided', 'This entry cannot be undone');
    if (original.revision !== input.expected_revision) conflict('revision_mismatch', 'Only the latest saved entry can be undone');
    const targets = state.entries.filter(entry => entry.revision === original.revision && entry.player_id === original.player_id);
    const paymentKind = original.kind === 'buy_in' ? 'payment_in' : original.kind === 'cash_out' ? 'payment_out' : null;
    const paired = targets.filter(entry => entry.id !== original.id);
    if (targets.some(entry => entry.voids_entry_id !== null) || paired.length > 1 || (paired.length === 1 &&
      (paymentKind === null || original.amount_minor === '0' || paired[0]!.kind !== paymentKind || paired[0]!.amount_minor !== original.amount_minor || paired[0]!.occurred_at !== original.occurred_at || paired[0]!.note !== null))) {
      conflict('undo_unavailable', 'This command cannot be undone');
    }
    if (targets.some(target => state.entries.some(entry => entry.voids_entry_id === target.id))) conflict('already_voided', 'This command cannot be undone');
    const revision = await bump(db, banker, id);
    for (const target of targets) await insertEntry(db, banker, id, revision, { ...target, voids_entry_id: target.id, restores_entry_id: null, removal_id: null });
    return loadSession(db, banker, id);
  }));
  app.post('/api/sessions/:id/entries/:entry_id/void', c => mutate(c, pool, v.voidEntry, async (db, banker, input) => {
    const id = v.id.parse(c.req.param('id'));
    const entryId = v.id.parse(c.req.param('entry_id'));
    const row = await sessionRow(db, banker, id, true);
    assertOpen(row);
    const state = await loadSession(db, banker, id);
    const original = state.entries.find(entry => entry.id === entryId) ?? notFound();
    if (original.voids_entry_id || state.entries.some(entry => entry.voids_entry_id === original.id)) conflict('already_voided', 'This entry cannot be voided again');
    if (input.replacement_amount_minor === '0' && original.kind !== 'cash_out') throw new ApiError(400, 'invalid_request', 'Only a cash-out may be zero');
    const payment = original.kind === 'payment_in' || original.kind === 'payment_out';
    if (input.replacement_method !== undefined && !payment) throw new ApiError(400, 'invalid_request', 'Only a payment has a method');
    const replacing = input.replacement_amount_minor !== undefined || input.replacement_method !== undefined || input.replacement_occurred_at !== undefined;
    const replacementTime = input.replacement_occurred_at === undefined ? original.occurred_at : input.replacement_occurred_at;
    if (replacing && (original.kind === 'buy_in' || original.kind === 'cash_out')) assertOccurredAt(row, replacementTime);
    const revision = await bump(db, banker, id);
    await insertEntry(db, banker, id, revision, { ...original, voids_entry_id: original.id, restores_entry_id: null, removal_id: null });
    if (replacing) await insertEntry(db, banker, id, revision, {
      player_id: original.player_id, kind: original.kind, amount_minor: input.replacement_amount_minor ?? original.amount_minor,
      note: original.note, method: input.replacement_method ?? original.method, occurred_at: replacementTime,
    });
    return loadSession(db, banker, id);
  }));
  app.post('/api/sessions/:id/entries/:entry_id/restore', c => mutate(c, pool, v.commandOnly, async (db, banker) => {
    const id = v.id.parse(c.req.param('id'));
    const entryId = v.id.parse(c.req.param('entry_id'));
    assertOpen(await sessionRow(db, banker, id, true));
    const state = await loadSession(db, banker, id);
    const original = state.entries.find(entry => entry.id === entryId) ?? notFound();
    if (original.voids_entry_id) conflict('not_voided', 'Only a voided entry can be restored');
    const voidRow = state.entries.find(entry => entry.voids_entry_id === original.id);
    if (!voidRow) conflict('not_voided', 'Only a voided entry can be restored');
    if (voidRow.removal_id) conflict('player_removed', 'Restore the player to bring back their entries');
    if (state.entries.some(entry => entry.restores_entry_id === original.id)) conflict('already_restored', 'This entry is already restored');
    if (state.entries.some(entry => entry.revision === voidRow.revision && entry.player_id === original.player_id && entry.kind === original.kind && entry.voids_entry_id === null && entry.id !== voidRow.id)) conflict('replaced_entry', 'This entry was replaced. Correct the replacement instead');
    const seated = await db.query<{ removed_at: string | null }>('SELECT removed_at::text FROM session_players WHERE session_id = $1 AND player_id = $2 AND banker_id = $3', [id, original.player_id, banker]);
    if (!seated.rowCount || seated.rows[0]!.removed_at !== null) conflict('player_removed', 'Restore the player to bring back their entries');
    const revision = await bump(db, banker, id);
    await insertEntry(db, banker, id, revision, { ...original, voids_entry_id: null, restores_entry_id: original.id, removal_id: null });
    return loadSession(db, banker, id);
  }));
  app.post('/api/sessions/:id/close', c => mutate(c, pool, v.closeSession, async (db, banker, input) => {
    const id = v.id.parse(c.req.param('id'));
    const row = await sessionRow(db, banker, id, true);
    assertOpen(row);
    if (row.revision !== input.expected_revision) conflict('revision_mismatch', 'Session changed. Review it before closing');
    const state = await loadSession(db, banker, id);
    if (state.players.some(player => player.state === 'playing' || (player.state === 'seated' && (player.payment_in_minor !== '0' || player.payment_out_minor !== '0' || player.expense_minor !== '0')))) conflict('players_active', 'Cash out every player with entries before closing');
    const discrepancy = state.totals.discrepancy_minor!;
    if (discrepancy !== '0' && input.accept_discrepancy_minor !== discrepancy) conflict('discrepancy_unaccepted', 'Accept the exact discrepancy before closing');
    const endedAt = row.ended_at ?? await serverTime(db);
    await assertTimingEntries(db, banker, id, row.started_at, endedAt);
    if (row.started_at !== null && Date.parse(endedAt) < Date.parse(row.started_at)) conflict('invalid_timing', 'End must be at or after start');
    await db.query("UPDATE game_sessions SET status = 'closed', closed_at = now(), closed_balanced = $3, ended_at = $4 WHERE id = $1 AND banker_id = $2", [id, banker, discrepancy === '0', endedAt]);
    const revision = await bump(db, banker, id);
    await event(db, banker, id, revision, 'closed', { discrepancy_minor: discrepancy, old: { ended_at: row.ended_at }, new: { ended_at: endedAt } });
    return loadSession(db, banker, id);
  }));
  app.post('/api/sessions/:id/reopen', c => mutate(c, pool, v.reopenSession, async (db, banker, input) => {
    const id = v.id.parse(c.req.param('id'));
    const row = await sessionRow(db, banker, id, true);
    if (row.status !== 'closed') conflict('session_open', 'This session is already open');
    await db.query("UPDATE game_sessions SET status = 'open', closed_at = NULL, closed_balanced = NULL WHERE id = $1 AND banker_id = $2", [id, banker]);
    const revision = await bump(db, banker, id);
    await event(db, banker, id, revision, 'reopened', { reason: input.reason });
    return loadSession(db, banker, id);
  }));
  app.post('/api/sessions/:id/share', c => mutate(c, pool, v.shareSession, async (db, banker, input) => {
    const id = v.id.parse(c.req.param('id'));
    const row = await sessionRow(db, banker, id, true);
    assertOpen(row);
    const token = input.action === 'disable' ? null : input.action === 'enable' && row.share_token ? row.share_token : randomBytes(16).toString('base64url');
    await db.query('UPDATE game_sessions SET share_token = $3 WHERE id = $1 AND banker_id = $2', [id, banker, token]);
    const revision = await bump(db, banker, id);
    await event(db, banker, id, revision, `share_${input.action === 'enable' ? 'enabled' : input.action === 'rotate' ? 'rotated' : 'disabled'}`);
    return loadSession(db, banker, id);
  }));
  app.get('/api/suggestions', async c => {
    z.strictObject({}).parse(c.req.query());
    const rows = await pool.query<{ location: string | null; game: string | null }>('SELECT DISTINCT location,game FROM game_sessions WHERE banker_id = $1 AND deleted_at IS NULL', [c.get('banker').id]);
    return c.json({
      locations: [...new Set(rows.rows.flatMap(row => row.location === null ? [] : [row.location]))].sort(),
      games: [...new Set(rows.rows.flatMap(row => row.game === null ? [] : [row.game]))].sort(),
    });
  });
  app.get('/api/players/:id/report', async c => {
    const id = v.id.parse(c.req.param('id'));
    const query = v.reportQuery.parse(c.req.query());
    const report = await readSnapshot(pool, async db => {
      const record = await playerRecord(db, c.get('banker').id, id);
      const sessions = await playerSessions(db, c.get('banker').id, record);
      return playerReport(sessions.map(item => ({
        ...item.session, result_minor: String(BigInt(item.player.cashed_out_minor) - BigInt(item.player.bought_in_minor)),
        expense_minor: item.player.expense_minor, duration_ms: item.player.duration_ms, has_entries: item.has_entries,
      })), query);
    });
    return c.json(report);
  });
  app.get('/api/players', async c => {
    const query = v.searchQuery.parse(c.req.query());
    const banker = c.get('banker').id;
    const result = await readSnapshot(pool, db => playerRoster(db, banker, recordName(query.q ?? '')));
    return c.json({ players: result });
  });
  app.post('/api/players', c => mutate(c, pool, v.playerCreate, async (db, banker, input) => {
    const id = randomUUID();
    await db.query('INSERT INTO players(id,banker_id,display_name,name_key) VALUES ($1,$2,$3,$4)', [id, banker, input.display_name, recordName(input.display_name)]);
    return { player: await playerRecord(db, banker, id) };
  }));
  app.get('/api/players/deleted', async c => {
    const query = v.deletedQuery.parse(c.req.query());
    const before = query.before ? v.deletedCursor.parse(query.before.split(',')) : undefined;
    const result = await pool.query<{ id: string; display_name: string; deleted_at: string }>(
      `SELECT id, display_name, to_char(deleted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS deleted_at
       FROM players WHERE banker_id = $1 AND deleted_at IS NOT NULL
       AND ($2::timestamptz IS NULL OR (deleted_at,id) < ($2::timestamptz,$3::uuid))
       ORDER BY deleted_at DESC, id DESC LIMIT 31`, [c.get('banker').id, before?.[0] ?? null, before?.[1] ?? null]);
    const players = result.rows.slice(0, 30);
    const last = players.at(-1);
    return c.json({ players, next: result.rows.length > 30 && last ? `${last.deleted_at},${last.id}` : null });
  });
  app.get('/api/players/:id', async c => {
    const id = v.id.parse(c.req.param('id'));
    return c.json(await readSnapshot(pool, db => playerHistory(db, c.get('banker').id, id)));
  });
  app.patch('/api/players/:id', c => mutate(c, pool, v.playerCreate, async (db, banker, input) => {
    const id = v.id.parse(c.req.param('id'));
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`player:${banker}/${id}`]);
    await playerRecord(db, banker, id);
    const sessions = await db.query<{ session_id: string }>(`SELECT sp.session_id FROM session_players sp JOIN game_sessions s ON s.id = sp.session_id AND s.banker_id = sp.banker_id
      WHERE sp.player_id = $1 AND sp.banker_id = $2 AND s.deleted_at IS NULL ORDER BY sp.session_id`, [id, banker]);
    for (const session of sessions.rows) await sessionRow(db, banker, session.session_id, true);
    await db.query('UPDATE players SET display_name = $3, name_key = $4 WHERE id = $1 AND banker_id = $2', [id, banker, input.display_name, recordName(input.display_name)]);
    for (const session of sessions.rows) {
      const revision = await bump(db, banker, session.session_id);
      await event(db, banker, session.session_id, revision, 'renamed', { player_id: id, display_name: input.display_name });
    }
    return { player: await playerRecord(db, banker, id) };
  }));
  app.post('/api/players/:id/delete', c => mutate(c, pool, v.commandOnly, async (db, banker) => {
    const id = v.id.parse(c.req.param('id'));
    await lockPlayers(db, banker, [id]);
    const player = await playerRecord(db, banker, id, true);
    if (player.deleted_at != null) conflict('already_deleted', 'This player is already deleted');
    const seated = await db.query(`SELECT 1 FROM session_players sp JOIN game_sessions s ON s.id = sp.session_id AND s.banker_id = sp.banker_id
      WHERE sp.player_id = $1 AND sp.banker_id = $2 AND sp.removed_at IS NULL AND s.deleted_at IS NULL LIMIT 1`, [id, banker]);
    if (seated.rowCount) conflict('player_seated', 'Remove this player from their game before deleting them');
    await db.query('UPDATE players SET deleted_at = clock_timestamp() WHERE id = $1 AND banker_id = $2', [id, banker]);
    return { player: await playerRecord(db, banker, id, true) };
  }));
  app.post('/api/players/:id/restore', c => mutate(c, pool, v.commandOnly, async (db, banker) => {
    const id = v.id.parse(c.req.param('id'));
    await lockPlayers(db, banker, [id]);
    const player = await playerRecord(db, banker, id, true);
    if (player.deleted_at == null) conflict('player_active', 'This player is already active');
    await db.query('UPDATE players SET deleted_at = NULL WHERE id = $1 AND banker_id = $2', [id, banker]);
    return { player: await playerRecord(db, banker, id) };
  }));
  app.all('/api/*', c => c.json({ error: { code: 'not_found', message: 'Record not found' } }, 404));
  return app;
}
