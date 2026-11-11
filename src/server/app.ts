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
import { assertOpen, bump, command, event, insertEntry, loadSession, playerHistory, playerRecord, playerSessions, readSnapshot, serverTime, sessionRow } from './store.js';
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
      const found = await db.query<{ id: string; banker_id: string; revision: string }>('SELECT id,banker_id,revision::text FROM game_sessions WHERE share_token = $1', [token]);
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
       WHERE banker_id = $1 AND position(lower($2) in lower(name)) > 0
       AND ($3::date IS NULL OR (played_on,id) < ($3::date,$4::uuid))
       ORDER BY played_on DESC,id DESC LIMIT 31`, [c.get('banker').id, query.q ?? '', before?.[0] ?? null, before?.[1] ?? null]);
    const sessions = result.rows.slice(0, 30);
    const last = sessions.at(-1);
    return c.json({ sessions, next: result.rows.length > 30 && last ? `${last.played_on},${last.id}` : null });
  });
  app.post('/api/sessions', c => mutate(c, pool, v.sessionCreate, async (db, banker, input) => {
    const id = randomUUID();
    await db.query('INSERT INTO game_sessions(id,banker_id,name,played_on,currency,location,game,big_blind_minor) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [id, banker, input.name, input.played_on, input.currency, input.location ?? null, input.game ?? null, input.big_blind_minor ?? null]);
    await sessionRow(db, banker, id, true);
    await event(db, banker, id, '1', 'created');
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
    if ('player_id' in input) await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`player:${banker}/${input.player_id}`]);
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
    if (!inserted.rowCount) conflict('already_seated', 'This player is already seated');
    await bump(db, banker, id);
    return loadSession(db, banker, id);
  }));
  app.post('/api/sessions/:id/entries', c => mutate(c, pool, v.entryCreate, async (db, banker, input) => {
    const id = v.id.parse(c.req.param('id'));
    const row = await sessionRow(db, banker, id, true);
    assertOpen(row);
    const seated = await db.query('SELECT player_id FROM session_players WHERE session_id = $1 AND player_id = $2 AND banker_id = $3', [id, input.player_id, banker]);
    if (!seated.rowCount) notFound();
    const occurredAt = input.occurred_at ?? null;
    if (input.kind === 'buy_in' || input.kind === 'cash_out') assertOccurredAt(row, occurredAt);
    const revision = await bump(db, banker, id);
    if (input.kind === 'buy_in' && row.started_at === null) {
      const timerStart = occurredAt ?? await serverTime(db);
      await db.query('UPDATE game_sessions SET started_at = $3 WHERE id = $1 AND banker_id = $2', [id, banker, timerStart]);
      await event(db, banker, id, revision, 'timer_started', { old: { started_at: null, ended_at: row.ended_at }, new: { started_at: timerStart, ended_at: row.ended_at } });
    }
    const payment = input.kind === 'payment_in' || input.kind === 'payment_out';
    await insertEntry(db, banker, id, revision, { ...input, method: payment ? input.method! : null, occurred_at: occurredAt });
    if (input.amount_minor !== '0' && ((input.kind === 'buy_in' && input.paid_now !== false) || (input.kind === 'cash_out' && input.paid_now === true))) {
      await insertEntry(db, banker, id, revision, { player_id: input.player_id, kind: input.kind === 'buy_in' ? 'payment_in' : 'payment_out', amount_minor: input.amount_minor, method: input.method!, occurred_at: occurredAt });
    }
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
    await insertEntry(db, banker, id, revision, { ...original, voids_entry_id: original.id });
    if (replacing) await insertEntry(db, banker, id, revision, {
      player_id: original.player_id, kind: original.kind, amount_minor: input.replacement_amount_minor ?? original.amount_minor,
      note: original.note, method: input.replacement_method ?? original.method, occurred_at: replacementTime,
    });
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
    if (row.started_at !== null && Date.parse(endedAt) < Date.parse(row.started_at)) conflict('invalid_timing', 'End must be at or after start');
    await assertTimingEntries(db, banker, id, null, endedAt);
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
    const rows = await pool.query<{ location: string | null; game: string | null }>('SELECT DISTINCT location,game FROM game_sessions WHERE banker_id = $1', [c.get('banker').id]);
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
    const result = await readSnapshot(pool, async db => {
      const players = await db.query<{ id: string }>('SELECT id FROM players WHERE banker_id = $1 AND position($2 in name_key) > 0 ORDER BY name_key,id', [banker, recordName(query.q ?? '')]);
      const summaries = [];
      for (const player of players.rows) {
        const history = await playerHistory(db, banker, player.id);
        summaries.push({ ...history.player, cumulative: history.cumulative, outstanding: history.outstanding });
      }
      return summaries;
    });
    return c.json({ players: result });
  });
  app.post('/api/players', c => mutate(c, pool, v.playerCreate, async (db, banker, input) => {
    const id = randomUUID();
    await db.query('INSERT INTO players(id,banker_id,display_name,name_key) VALUES ($1,$2,$3,$4)', [id, banker, input.display_name, recordName(input.display_name)]);
    return { player: await playerRecord(db, banker, id) };
  }));
  app.get('/api/players/:id', async c => {
    const id = v.id.parse(c.req.param('id'));
    return c.json(await readSnapshot(pool, db => playerHistory(db, c.get('banker').id, id)));
  });
  app.patch('/api/players/:id', c => mutate(c, pool, v.playerCreate, async (db, banker, input) => {
    const id = v.id.parse(c.req.param('id'));
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`player:${banker}/${id}`]);
    await playerRecord(db, banker, id);
    const sessions = await db.query<{ session_id: string }>('SELECT session_id FROM session_players WHERE player_id = $1 AND banker_id = $2 ORDER BY session_id', [id, banker]);
    for (const session of sessions.rows) await sessionRow(db, banker, session.session_id, true);
    await db.query('UPDATE players SET display_name = $3, name_key = $4 WHERE id = $1 AND banker_id = $2', [id, banker, input.display_name, recordName(input.display_name)]);
    for (const session of sessions.rows) {
      const revision = await bump(db, banker, session.session_id);
      await event(db, banker, session.session_id, revision, 'renamed', { player_id: id, display_name: input.display_name });
    }
    return { player: await playerRecord(db, banker, id) };
  }));
  app.all('/api/*', c => c.json({ error: { code: 'not_found', message: 'Record not found' } }, 404));
  return app;
}
