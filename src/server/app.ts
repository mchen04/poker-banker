import { randomBytes, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { Hono } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { z } from 'zod';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Database, Transaction } from './db';
import type { AppContext, AppEnv } from './context';
import { authRoutes, authenticate } from './auth';
import { ApiError, conflict, notFound } from './errors';
import * as v from './validation';
import { assertOpen, bump, command, event, insertEntry, loadSession, playerHistory, playerRecord, readSnapshot, sessionRow } from './store';
import { viewerState, type LedgerEntry } from '../domain/session';

type Config = { origin?: string; clientIp?: (c: AppContext) => string; onError?: (error: unknown) => void };
const recordName = (name: string) => name.normalize('NFKC').toLowerCase();

async function mutate<T extends { op_id: string }>(c: AppContext, pool: Database, schema: z.ZodType<T>, write: (db: Transaction, banker: string, input: T) => Promise<unknown>) {
  const body: unknown = await c.req.json();
  const input = schema.parse(body);
  const banker = c.get('banker').id;
  const result = await command(pool, banker, input.op_id, { method: c.req.method, path: c.req.path, body }, db => write(db, banker, input));
  return c.json(result.body, result.status as ContentfulStatusCode);
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
    await db.query('INSERT INTO game_sessions(id,banker_id,name,played_on,currency) VALUES ($1,$2,$3,$4,$5)', [id, banker, input.name, input.played_on, input.currency]);
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
    await db.query('UPDATE game_sessions SET name = coalesce($3,name), played_on = coalesce($4::date,played_on) WHERE id = $1 AND banker_id = $2', [id, banker, input.name ?? null, input.played_on ?? null]);
    const revision = await bump(db, banker, id);
    await event(db, banker, id, revision, 'renamed', { name: input.name ?? row.name, played_on: input.played_on ?? row.played_on });
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
    assertOpen(await sessionRow(db, banker, id, true));
    const seated = await db.query('SELECT player_id FROM session_players WHERE session_id = $1 AND player_id = $2 AND banker_id = $3', [id, input.player_id, banker]);
    if (!seated.rowCount) notFound();
    const revision = await bump(db, banker, id);
    await insertEntry(db, banker, id, revision, input);
    if ((input.kind === 'buy_in' && input.paid_now !== false) || (input.kind === 'cash_out' && input.paid_now === true)) {
      await insertEntry(db, banker, id, revision, { player_id: input.player_id, kind: input.kind === 'buy_in' ? 'payment_in' : 'payment_out', amount_minor: input.amount_minor });
    }
    return loadSession(db, banker, id);
  }));
  app.post('/api/sessions/:id/entries/:entry_id/void', c => mutate(c, pool, v.voidEntry, async (db, banker, input) => {
    const id = v.id.parse(c.req.param('id'));
    const entryId = v.id.parse(c.req.param('entry_id'));
    assertOpen(await sessionRow(db, banker, id, true));
    const found = await db.query<LedgerEntry>('SELECT id,player_id,kind,amount_minor::text,note,voids_entry_id FROM ledger_entries WHERE id = $1 AND session_id = $2 AND banker_id = $3', [entryId, id, banker]);
    const original = found.rows[0] ?? notFound();
    const existing = await db.query('SELECT id FROM ledger_entries WHERE voids_entry_id = $1 AND session_id = $2 AND banker_id = $3', [entryId, id, banker]);
    if (original.voids_entry_id || existing.rowCount) conflict('already_voided', 'This entry cannot be voided again');
    const revision = await bump(db, banker, id);
    await insertEntry(db, banker, id, revision, { ...original, voids_entry_id: original.id });
    if (input.replacement_amount_minor) await insertEntry(db, banker, id, revision, { player_id: original.player_id, kind: original.kind, amount_minor: input.replacement_amount_minor, note: original.note });
    return loadSession(db, banker, id);
  }));
  app.post('/api/sessions/:id/close', c => mutate(c, pool, v.closeSession, async (db, banker, input) => {
    const id = v.id.parse(c.req.param('id'));
    const row = await sessionRow(db, banker, id, true);
    assertOpen(row);
    if (row.revision !== input.expected_revision) conflict('revision_mismatch', 'Session changed. Review it before closing');
    const state = await loadSession(db, banker, id);
    if (state.players.some(player => player.state === 'playing' || (player.state === 'seated' && (player.payment_in_minor !== '0' || player.payment_out_minor !== '0')))) conflict('players_active', 'Cash out every player with entries before closing');
    const discrepancy = state.totals.discrepancy_minor!;
    if (discrepancy !== '0' && input.accept_discrepancy_minor !== discrepancy) conflict('discrepancy_unaccepted', 'Accept the exact discrepancy before closing');
    await db.query("UPDATE game_sessions SET status = 'closed', closed_at = now(), closed_balanced = $3 WHERE id = $1 AND banker_id = $2", [id, banker, discrepancy === '0']);
    const revision = await bump(db, banker, id);
    await event(db, banker, id, revision, 'closed', { discrepancy_minor: discrepancy });
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
