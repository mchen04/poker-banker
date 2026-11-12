import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { expect, it } from 'vitest';
import { closeOwnedServer } from '../scripts/close-server';
import { createApp } from '../src/server/app';
import type { SessionState } from '../src/domain/session';
import { testDatabase } from './database';

it('leaves full financial JSON unencoded for the edge while preserving headers and exactly-once replay', async () => {
  const database = await testDatabase();
  let server: Server | undefined;
  try {
    server = createServer(getRequestListener(createApp(database.pool).fetch));
    const listening = once(server, 'listening', { signal: AbortSignal.timeout(10_000) });
    server.listen(0, '127.0.0.1');
    await listening;
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No owned response test port');
    const origin = `http://127.0.0.1:${address.port}`;
    let cookie = '';
    let banker = '';
    const call = (path: string, body: unknown, encoding = 'identity') => fetch(`${origin}/api${path}`, {
      method: 'POST', signal: AbortSignal.timeout(10_000),
      headers: { origin, 'content-type': 'application/json', 'accept-encoding': encoding,
        ...(cookie ? { cookie, 'X-PB-Expected-Banker-ID': banker } : {}) },
      body: JSON.stringify(body),
    });
    const signup = await call('/auth/signup', { username: `encoding-${randomUUID().slice(0, 12)}`, password: randomUUID() });
    expect(signup.status).toBe(200);
    cookie = signup.headers.getSetCookie()[0]!.split(';')[0]!;
    banker = ((await signup.json()) as { banker: { id: string } }).banker.id;
    const created = await call('/sessions', { op_id: randomUUID(), name: 'Edge encoding fixture', played_on: '2026-11-10', currency: 'USD' });
    expect(created.status).toBe(200);
    let state = await created.json() as SessionState;
    const seated = await call(`/sessions/${state.session.id}/players`, { op_id: randomUUID(), new_player_name: 'Encoding player' });
    expect(seated.status).toBe(200);
    state = await seated.json() as SessionState;
    const path = `/sessions/${state.session.id}/entries`;
    const player = state.players[0]!.id;
    for (let index = 0; index < 60; index++) {
      const response = await call(path, { op_id: randomUUID(), player_id: player, kind: 'buy_in', amount_minor: '100', paid_now: false,
        occurred_at: null, note: `${index}: ${'Ledger history '.repeat(26)}` });
      expect(response.status).toBe(200);
      await response.json();
    }
    const body = { op_id: randomUUID(), player_id: player, kind: 'expense', amount_minor: '100', note: 'Edge-owned compression' };
    let identity: string | undefined;
    for (const encoding of ['identity', 'gzip', 'br', 'br, gzip']) {
      const response = await call(path, body, encoding);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-encoding')).toBeNull();
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-pb-banker-id')).toBe(banker);
      expect(response.headers.getSetCookie()).toEqual([]);
      const text = await response.text();
      expect(Buffer.byteLength(text)).toBeGreaterThan(32_768);
      identity ??= text;
      expect(text).toBe(identity);
      const result = JSON.parse(text) as SessionState;
      expect(result.entries).toHaveLength(61);
      expect(result.totals.total_in_minor).toBe('6000');
      expect(result.players[0]!.balance_minor).toBe('6000');
    }
    const stored = await database.pool.query<{ count: number }>('SELECT count(*)::int AS count FROM ledger_entries WHERE banker_id=$1 AND session_id=$2', [banker, state.session.id]);
    expect(stored.rows[0]!.count).toBe(61);
  } finally {
    try { if (server) await closeOwnedServer(server); }
    finally { await database.stop(); }
  }
});
