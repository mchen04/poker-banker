import { randomUUID } from 'node:crypto';
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { getRequestListener } from '@hono/node-server';
import { expect, it } from 'vitest';
import { seedBenchmark } from '../scripts/bench/seed';
import { closeOwnedServer } from '../scripts/close-server';
import { withShutdownDeadline } from '../scripts/owned-process';
import { createApp } from '../src/server/app';
import { testDatabase } from './database';

type RawResponse = { status: number; headers: IncomingHttpHeaders; bytes: Buffer };
type RequestOptions = { method?: string; body?: unknown; cookie?: string; bankerId?: string; encoding?: string };

function rawRequest(origin: string, path: string, options: RequestOptions = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body));
    const outgoing = request(new URL(path, origin), {
      method: options.method ?? 'GET', agent: false,
      headers: {
        origin, 'Accept-Encoding': options.encoding ?? 'identity',
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': String(body.length) } : {}),
        ...(options.cookie ? { Cookie: options.cookie } : {}),
        ...(options.bankerId ? { 'X-PB-Expected-Banker-ID': options.bankerId } : {}),
      },
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.once('error', error => { clearTimeout(deadline); reject(error); });
      response.once('aborted', () => { clearTimeout(deadline); reject(new Error('Owned player-history response aborted')); });
      response.once('end', () => {
        clearTimeout(deadline);
        resolve({ status: response.statusCode ?? 0, headers: response.headers, bytes: Buffer.concat(chunks) });
      });
    });
    const deadline = setTimeout(() => outgoing.destroy(new Error('Owned player-history request deadline exceeded')), 15_000);
    outgoing.once('error', error => { clearTimeout(deadline); reject(error); });
    outgoing.end(body);
  });
}

function sessionCookie(response: RawResponse): string {
  const cookies = response.headers['set-cookie'];
  expect(cookies).toHaveLength(1);
  expect(cookies![0]).toMatch(/^pb_session=/);
  expect(cookies![0]).toContain('HttpOnly');
  expect(cookies![0]).toContain('Secure');
  expect(cookies![0]).toContain('SameSite=Lax');
  return cookies![0]!.split(';')[0]!;
}

function privateHeaders(response: RawResponse, bankerId: string) {
  expect(response.headers['x-pb-banker-id']).toBe(bankerId);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.headers['set-cookie']).toBeUndefined();
  expect(response.headers['content-type']).toMatch(/^application\/json(?:;|$)/);
}

it('compresses large closed player history without changing bytes, small reports, or account boundaries', async () => {
  const database = await testDatabase();
  let server: Server | undefined;
  const errors: unknown[] = [];
  try {
    const fixture = await seedBenchmark(database.pool, { workload: 'long' });
    const playerId = fixture.playerIds[30]!;
    const membership = await database.pool.query<{ status: string; count: number }>(
      `SELECT s.status, count(*)::int AS count FROM session_players sp
       JOIN game_sessions s ON s.id = sp.session_id AND s.banker_id = sp.banker_id
       WHERE sp.banker_id = $1 AND sp.player_id = $2 GROUP BY s.status`,
      [fixture.bankerId, playerId],
    );
    expect(membership.rows).toEqual([{ status: 'closed', count: 200 }]);
    server = createServer(getRequestListener(createApp(database.pool, { onError: error => errors.push(error) }).fetch));
    await withShutdownDeadline('Owned player-history listener startup', () => new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', () => { server!.removeListener('error', reject); resolve(); });
    }));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No owned player-history test port');
    const origin = `http://127.0.0.1:${address.port}`;
    const login = await rawRequest(origin, '/api/auth/login', {
      method: 'POST', body: { username: fixture.username, password: fixture.password },
    });
    expect(login.status).toBe(200);
    expect(JSON.parse(login.bytes.toString())).toEqual({ banker: { id: fixture.bankerId, username: fixture.username } });
    const cookie = sessionCookie(login);
    const owner = { cookie, bankerId: fixture.bankerId };
    const path = `/api/players/${playerId}`;
    const identity = await rawRequest(origin, path, { ...owner, encoding: 'identity' });
    const gzip = await rawRequest(origin, path, { ...owner, encoding: 'gzip' });
    expect(identity.status).toBe(200);
    expect(gzip.status).toBe(200);
    privateHeaders(identity, fixture.bankerId);
    privateHeaders(gzip, fixture.bankerId);
    expect(identity.headers['content-encoding']).toBeUndefined();
    expect(gzip.headers['content-encoding']).toBe('gzip');
    expect(identity.bytes.length).toBeGreaterThan(32_768);
    expect(gzip.bytes.length).toBeLessThan(identity.bytes.length);
    expect(gunzipSync(gzip.bytes).equals(identity.bytes)).toBe(true);
    const history = JSON.parse(identity.bytes.toString()) as { player: { id: string; display_name: string }; sessions: { session: { status: string } }[] };
    expect(history.player.id).toBe(playerId);
    expect(history.sessions).toHaveLength(200);
    expect(history.sessions.every(item => item.session.status === 'closed')).toBe(true);
    expect(Number(identity.headers['content-length'])).toBe(identity.bytes.length);
    expect(gzip.headers['content-length']).toBeUndefined();
    for (const response of [identity, gzip]) expect(response.headers.vary?.toLowerCase().split(/\s*,\s*/)).toContain('accept-encoding');

    const report = await rawRequest(origin, `${path}/report?group=overall`, { ...owner, encoding: 'gzip' });
    expect(report.status).toBe(200);
    privateHeaders(report, fixture.bankerId);
    expect(report.headers['content-encoding']).toBeUndefined();
    expect(report.bytes.length).toBeLessThan(32_768);
    const reportBody = JSON.parse(report.bytes.toString()) as { group: string; groups: { sessions_count: number }[] };
    expect(reportBody.group).toBe('overall');
    expect(reportBody.groups.reduce((count, group) => count + group.sessions_count, 0)).toBe(200);

    const signup = await rawRequest(origin, '/api/auth/signup', {
      method: 'POST', body: { username: `history-${randomUUID().slice(0, 16)}`, password: randomUUID() },
    });
    expect(signup.status).toBe(200);
    const foreignId = (JSON.parse(signup.bytes.toString()) as { banker: { id: string } }).banker.id;
    const foreignCookie = sessionCookie(signup);
    for (const target of [path, `${path}/report?group=overall`]) {
      const foreign = await rawRequest(origin, target, { cookie: foreignCookie, bankerId: foreignId, encoding: 'gzip' });
      expect(foreign.status).toBe(404);
      privateHeaders(foreign, foreignId);
      expect(foreign.headers['content-encoding']).toBeUndefined();
      expect(JSON.parse(foreign.bytes.toString())).toEqual({ error: { code: 'not_found', message: 'Record not found' } });
      expect(foreign.bytes.includes(Buffer.from(playerId))).toBe(false);
      expect(foreign.bytes.includes(Buffer.from(history.player.display_name))).toBe(false);
    }
    expect(errors).toEqual([]);
  } finally {
    try { if (server) await closeOwnedServer(server); }
    finally { await database.stop(); }
  }
}, 120_000);
