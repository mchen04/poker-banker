import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createApp } from '../src/server/app';
import { testDatabase } from './database';
import { liveHistoryPlan, seedLiveBenchmark } from '../scripts/bench/live-seed';
import { liveApi, liveWrites } from '../scripts/bench/live-api';
import { LiveClient } from '../scripts/bench/live-client';
import type { BenchmarkClient, Sample } from '../scripts/bench/types';

let database: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => { database = await testDatabase(); });
afterAll(async () => { await database?.stop(); });
it('plans 300 sessions over three years with six to ten reusable players and varying blinds', () => {
  const plan = liveHistoryPlan(300, Date.parse('2026-11-11T04:00:00Z'));
  expect(plan).toHaveLength(300);
  expect(new Set(plan.flatMap(session => session.players)).size).toBe(40);
  expect(plan.reduce((sum, session) => sum + session.players.length, 0)).toBe(2400);
  expect(plan.at(-1)!.started - plan[0]!.started).toBe(1095 * 86400000);
  expect(plan.every(session => session.players.length >= 6 && session.players.length <= 10 && session.ended > session.started)).toBe(true);
  expect(new Set(plan.map(session => session.blind))).toEqual(new Set(['100', '200', '500']));
});
it('uses only public routes to seed its own account, corrected history and a sixty-row open table', async () => {
  const other = randomUUID();
  await database.pool.query('INSERT INTO bankers(id,username,password_hash) VALUES($1,$2,$3)', [other, `untouched-${other.slice(0, 8)}`, 'not-used']);
  const app = createApp(database.pool, { origin: 'https://benchmark.test', clientIp: () => 'benchmark-test' });
  let cookie = '';
  const paths: string[] = [];
  const client: BenchmarkClient = { request: async (path, options = {}) => {
    paths.push(path);
    const started = performance.now();
    const response = await app.request(`https://benchmark.test${path}`, { method: options.method ?? 'GET', headers: { origin: 'https://benchmark.test', 'content-type': 'application/json', cookie }, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
    const setCookie = response.headers.get('set-cookie'); if (setCookie) cookie = setCookie.split(';')[0]!;
    const raw = await response.text();
    return { status: response.status, body: raw ? JSON.parse(raw) : null, ms: performance.now() - started, serverMs: null, bytes: Buffer.byteLength(raw) };
  } };
  const fixture = await seedLiveBenchmark(client, { sessions: 3, concurrency: 2 });
  expect(fixture.username).toMatch(/^pbbench-[a-z0-9]{23}$/);
  expect(fixture.counts).toMatchObject({ bankers_created: 1, reusable_players: 40, closed_sessions: 3, closed_seats: 21, reentries: 1, corrections: 1, open_players: 9, open_entries: 60 });
  expect(fixture.playerIds).toHaveLength(40);
  const sessions = (await database.pool.query('SELECT status,count(*)::int AS count FROM game_sessions WHERE banker_id=$1 GROUP BY status ORDER BY status', [fixture.bankerId])).rows;
  expect(sessions).toEqual([{ status: 'closed', count: 3 }, { status: 'open', count: 1 }]);
  expect((await database.pool.query('SELECT count(*)::int AS count FROM game_sessions WHERE banker_id=$1', [other])).rows[0]!.count).toBe(0);
  expect((await database.pool.query('SELECT username,password_hash FROM bankers WHERE id=$1', [other])).rows[0]).toEqual({ username: `untouched-${other.slice(0, 8)}`, password_hash: 'not-used' });
  expect(paths.every(path => path.startsWith('/api/'))).toBe(true);
  expect(paths[0]).toBe('/api/auth/signup');
  const roster = (await client.request('/api/players')).body as { players: { id: string; cumulative?: { currency: string; result_minor: string }[] }[] };
  const expectedResults = new Map([[0, '-1500'], [5, '1500'], [7, '-1500'], [13, '1500'], [14, '-1500'], [21, '1500'], [1, '0']]);
  for (const [index, result] of expectedResults) expect(roster.players.find(player => player.id === fixture.playerIds[index])!.cumulative).toEqual([{ currency: 'USD', result_minor: result }]);
  for (const index of [6, 22, 39]) expect(roster.players.find(player => player.id === fixture.playerIds[index])!.cumulative).toEqual([]);
  for (const fault of ['missing', 'wrong']) {
    const invalid: BenchmarkClient = { request: async (path, options) => {
      const response = await client.request(path, options);
      if (path !== '/api/players') return response;
      const body = structuredClone(response.body) as typeof roster;
      const player = body.players.find(player => player.id === fixture.playerId)!;
      if (fault === 'missing') delete player.cumulative; else player.cumulative = [{ currency: 'USD', result_minor: '999' }];
      return { ...response, body };
    } };
    const rejected: Sample[] = [];
    await expect(liveApi(invalid, fixture, sample => rejected.push(sample), false, 1)).rejects.toThrow('Closed-session cumulative result');
    expect(rejected.at(-1)).toMatchObject({ metric: 'api.players', ok: false });
  }
  const samples: Sample[] = [];
  await liveApi(client, fixture, sample => samples.push(sample), false, 1);
  await liveWrites(client, fixture, sample => samples.push(sample), 1);
  await liveApi(client, fixture, sample => samples.push(sample), true, 1);
  expect(samples).toHaveLength(28); expect(samples.every(sample => sample.ok)).toBe(true);
  expect(new Set(samples.map(sample => sample.metric)).size).toBe(10);
  const receipts = JSON.stringify({ ...fixture, token: 'REDACTED', samples });
  expect(receipts).not.toContain(cookie); expect(receipts).not.toContain(fixture.token); expect(receipts).not.toContain('bench-only-');
}, 30000);
it('rejects non-origin targets, non-HTTPS remote targets and remote certificate exceptions before making requests', async () => {
  await expect(LiveClient.create('http://example.com')).rejects.toThrow('HTTPS');
  await expect(LiveClient.create('https://example.com', true)).rejects.toThrow('loopback');
  await expect(LiveClient.create('https://example.com/path')).rejects.toThrow();
  await expect(LiveClient.create('https://user:password@example.com')).rejects.toThrow('origin');
});
it('counts failed transport work without persisting cookies, viewer tokens or Playwright request logs', async () => {
  const client = await LiveClient.create('https://127.0.0.1:1', true);
  try {
    await client.context.addCookies([{ name: 'pb_session', value: 'synthetic-private-cookie', url: client.baseURL, secure: true, httpOnly: true }]);
    await expect(client.request('/api/view/synthetic-owned-viewer-token')).rejects.toThrow('Controller GET /api/view/OWNED_TOKEN failed (Error)');
    expect(client.counts).toMatchObject({ requests: 1, mutations: 0, errors: 1 });
  } finally { await client.close(); }
});
it('counts a non-JSON HTTP failure once and keeps its body out of diagnostics', async () => {
  const server = createServer((_request, response) => { response.writeHead(400, { 'content-type': 'text/html' }); response.end('<p>synthetic-sensitive-body</p>'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No owned HTTP test port');
  const client = await LiveClient.create(`http://127.0.0.1:${address.port}`);
  try {
    await expect(client.request('/api/view/synthetic-owned-viewer-token')).rejects.toThrow('Controller GET /api/view/OWNED_TOKEN failed (SyntaxError)');
    expect(client.counts).toEqual({ requests: 1, mutations: 0, errors: 1, statuses: { '400': 1 } });
  } finally { await client.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
