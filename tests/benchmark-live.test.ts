import { closeOwnedServer } from '../scripts/close-server';
import { cleanupLeaves } from './teardown';
import { stopOwnedProcess, withShutdownDeadline } from '../scripts/owned-process';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, stat, rm, chmod, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { webkit } from '@playwright/test';
import { scopeLiveBrowserRequests } from '../scripts/bench/live-browser';
import { handle } from '@hono/node-server/vercel';
import { runLiveComparison, summarizeLiveComparison, type LiveComparisonRow } from '../scripts/bench-live-compare';
import { createServer } from 'node:http';
import { createApp } from '../src/server/app';
import { testDatabase } from './database';
import { liveHistoryPlan, seedLiveBenchmark, writeLiveSeedState, readLiveSeedState, reuseLiveSeed } from '../scripts/bench/live-seed';
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
  } finally { await cleanupLeaves(() => client.close(), () => closeOwnedServer(server)); }
});

it('scopes the bypass header to every controller request and never follows a redirect with credentials', async () => {
  const previous = process.env.PB_VERCEL_BYPASS;
  const sentinel = `synthetic-bypass-${randomUUID()}`;
  process.env.PB_VERCEL_BYPASS = sentinel;
  let externalHits = 0;
  const external = createServer((_request, response) => { externalHits++; response.end('{}'); });
  await new Promise<void>(resolve => external.listen(0, '127.0.0.1', resolve));
  const externalAddress = external.address();
  if (!externalAddress || typeof externalAddress === 'string') throw new Error('No external test port');
  const received: string[] = [];
  const server = createServer((request, response) => {
    received.push(String(request.headers['x-vercel-protection-bypass']));
    if (request.url === '/redirect') { response.writeHead(302, { location: `http://127.0.0.1:${externalAddress.port}/destination` }); response.end(); }
    else { response.setHeader('content-type', 'application/json'); response.end('{ "ok": true }'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No controller test port');
  const client = await LiveClient.create(`http://127.0.0.1:${address.port}`);
  try {
    const result = await client.request('/ok');
    expect(result.sha256).toBe(createHash('sha256').update('{ "ok": true }').digest('hex'));
    expect((await client.request('/redirect')).status).toBe(302);
    expect(received).toEqual([sentinel, sentinel]);
    expect(externalHits).toBe(0);
    expect(client.scopedHeaders(`http://127.0.0.1:${externalAddress.port}/`, { 'X-Vercel-Protection-Bypass': sentinel })).toEqual({});
    expect(client.scopedHeaders(`${client.baseURL}/asset.js`, {})).toEqual({ 'x-vercel-protection-bypass': sentinel });
    expect(JSON.stringify({ counts: client.counts, bypassEnabled: client.bypassEnabled, error: client.redact(`request failed ${sentinel}`) })).not.toContain(sentinel);
    await expect(client.request(`http://127.0.0.1:${externalAddress.port}/`)).rejects.toThrow('origin');
  } finally {
    if (previous === undefined) delete process.env.PB_VERCEL_BYPASS; else process.env.PB_VERCEL_BYPASS = previous;
    await cleanupLeaves(() => client.close(), ...[server, external].map(owned => () => closeOwnedServer(owned)));
  }
});
it('persists a private owned seed, reuses its banker across loopback origins without mutations, and compares raw bodies', async () => {
  const previous = process.env.PB_VERCEL_BYPASS;
  const sentinel = `synthetic-bypass-${randomUUID()}`;
  process.env.PB_VERCEL_BYPASS = sentinel;
  const identifier = randomUUID(), cache = join('.cache', `live-test-${identifier}`), evidence = join('evidence/bench/live', `test-${identifier}`);
  const path = join(cache, 'seed.json'), seedEvidence = `${evidence}-seed`, reuseEvidence = `${evidence}-reuse`, compareEvidence = `${evidence}-compare-cli`, invalidEvidence = `${evidence}-existing-state`, missingReuseEvidence = `${evidence}-missing-reuse`;
  const seen: { method: string; header: string | undefined }[] = [];
  const servers = Array.from({ length: 2 }, () => createServer((request, response) => {
    seen.push({ method: request.method ?? '', header: request.headers['x-vercel-protection-bypass'] as string | undefined });
    void handle(createApp(database.pool))(request, response);
  }));
  for (const [index, server] of servers.entries()) await new Promise<void>(resolve => server.listen(0, index === 0 ? 'localhost' : '127.0.0.1', resolve));
  const urls = servers.map((server, index) => { const address = server.address(); if (!address || typeof address === 'string') throw new Error('No owned test port'); return `http://${index === 0 ? 'localhost' : '127.0.0.1'}:${address.port}`; });
  const client = await LiveClient.create(urls[0]!);
  const reused = await LiveClient.create(urls[1]!);
  try {
    const seeded = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/bench-live.ts', '--base', urls[0]!, '--seed-only', '--state', path, '--sessions', '1', '--output', seedEvidence]);
    const fixture = (await readLiveSeedState(path)).fixture;
    await client.restoreSession((await readLiveSeedState(path)).sessionCookie);
    expect(JSON.parse(await readFile(join(seedEvidence, 'summary.json'), 'utf8')).metrics).toEqual([]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const state = await readLiveSeedState(path);
    expect(state.baseURL).toBe(urls[0]);
    expect(state.fixture.bankerId).toBe(fixture.bankerId);
    expect(await readFile(path, 'utf8')).not.toContain(sentinel);
    const beforeExistingState = seen.length;
    await expect(promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/bench-live.ts', '--base', urls[0]!, '--seed-only', '--state', path, '--sessions', '1', '--output', invalidEvidence])).rejects.toThrow();
    expect(seen).toHaveLength(beforeExistingState);
    await expect(promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/bench-live.ts', '--base', urls[0]!, '--sessions', '1', '--api-only', '--runs', '1', '--output', missingReuseEvidence, '--reuse'])).rejects.toThrow();
    expect(seen).toHaveLength(beforeExistingState);
    await expect(writeLiveSeedState(path, client, fixture)).rejects.toThrow();
    await expect(writeLiveSeedState('evidence/not-a-private-state.json', client, fixture)).rejects.toThrow('.cache');
    await symlink('seed.json', join(cache, 'linked.json'));
    await expect(readLiveSeedState(join(cache, 'linked.json'))).rejects.toThrow('0600');
    await chmod(path, 0o644);
    await expect(readLiveSeedState(path)).rejects.toThrow('0600');
    await chmod(path, 0o600);
    const start = seen.length;
    await expect(reuseLiveSeed(reused, { ...state, fixture: { ...fixture, bankerId: randomUUID() } })).rejects.toThrow('banker');
    expect(seen.slice(start)).toHaveLength(1);
    await expect(reuseLiveSeed(reused, { ...state, sessionCookie: 'synthetic-stale-cookie' })).rejects.toThrow('banker');
    await reuseLiveSeed(reused, state);
    const samples: Sample[] = [];
    await liveApi(reused, fixture, sample => samples.push(sample), false, 2, new Set(['api.players']));
    expect(samples).toHaveLength(2);
    expect(samples.every(sample => sample.metric === 'api.players' && sample.ok && sample.sha256?.length === 64)).toBe(true);
    expect(reused.counts.mutations).toBe(0);
    const comparison = await runLiveComparison({ baselineURL: urls[0]!, candidateURL: urls[1]!, reuse: path, metric: 'api.players', directory: evidence });
    expect(comparison.errors).toBe(0);
    expect(comparison.identicalResponses).toBe(true);
    expect(comparison.pairs).toHaveLength(5);
    expect(comparison.samples).toBe(10);
    expect(Object.values(comparison.requests).every(counts => counts.mutations === 0)).toBe(true);
    const raw = await readFile(join(evidence, 'samples.jsonl'), 'utf8');
    const rows = raw.trim().split('\n').map(line => JSON.parse(line) as LiveComparisonRow);
    expect(rows.map(row => row.side).join('')).toBe('ABBAABBAAB');
    const reusedCLI = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/bench-live.ts', '--base', urls[1]!, '--reuse', path, '--metrics', 'api.players', '--runs', '1', '--output', reuseEvidence]);
    const reusedSummary = JSON.parse(await readFile(join(reuseEvidence, 'summary.json'), 'utf8'));
    expect(reusedSummary.requests.mutations).toBe(0);
    expect(reusedSummary.metrics.map((metric: { metric: string }) => metric.metric)).toEqual(['api.players']);
    const comparedCLI = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/bench-live-compare.ts', '--baseline-url', urls[0]!, '--candidate-url', urls[1]!, '--reuse', path, '--metrics', 'api.players', '--order', 'abba', '--output', compareEvidence]);
    const compared = JSON.parse(await readFile(join(compareEvidence, 'comparison.json'), 'utf8'));
    expect(compared).toMatchObject({ errors: 0, samples: 20, identicalResponses: true });
    expect(compared.pairs).toHaveLength(5);
    expect(Object.values(compared.requests).every(counts => (counts as { mutations: number }).mutations === 0)).toBe(true);
    const comparedRaw = await readFile(join(compareEvidence, 'samples.jsonl'), 'utf8');
    expect(comparedRaw.trim().split('\n').map(line => JSON.parse(line).side).join('')).toBe('ABBA'.repeat(5));
    expect(JSON.parse(await readFile(join(compareEvidence, 'method.json'), 'utf8')).bypass).toBe(true);
    const receipts = seeded.stdout + seeded.stderr + reusedCLI.stdout + reusedCLI.stderr + comparedCLI.stdout + comparedCLI.stderr + comparedRaw + raw + await readFile(join(evidence, 'method.json'), 'utf8') + await readFile(join(evidence, 'comparison.json'), 'utf8') + await readFile(join(compareEvidence, 'method.json'), 'utf8') + await readFile(join(compareEvidence, 'comparison.json'), 'utf8');
    expect(receipts).not.toContain(sentinel);
    expect(receipts).not.toContain(state.sessionCookie);
    expect(receipts).not.toContain(fixture.token);
    expect(seen.every(request => request.header === sentinel)).toBe(true);
    expect(seen.slice(start).every(request => request.method === 'GET')).toBe(true);
    const cookies = (await reused.context.storageState()).cookies;
    expect(cookies).toHaveLength(1);
    expect(cookies[0]!.domain).toBe('127.0.0.1');
    expect(cookies[0]!.path).toBe('/');
  } finally {
    if (previous === undefined) delete process.env.PB_VERCEL_BYPASS; else process.env.PB_VERCEL_BYPASS = previous;
    await cleanupLeaves(() => client.close(), () => reused.close(), ...servers.map(server => () => closeOwnedServer(server)),
      ...[cache, evidence, seedEvidence, reuseEvidence, compareEvidence, invalidEvidence, missingReuseEvidence].map(directory => () => rm(directory, { recursive: true, force: true })));
  }
}, 60000);
it('accepts only five complete wins above both MADs with matching raw responses and zero errors', () => {
  const rows = Array.from({ length: 5 }, (_, index) => (['A', 'B'] as const).map((side, leg): LiveComparisonRow => ({ metric: 'api.players', pair: index + 1, side, leg: leg + 1, order: index * 2 + leg + 1, ms: side === 'A' ? 20 + index : 10 + index, bytes: 10, status: 200, sha256: 'a'.repeat(64), ok: true, work: { players: 40 }, clientHost: { logicalCores: 1, loadAverage: [0, 0, 0], remoteHostLoad: 'unavailable' } }))).flat();
  expect(summarizeLiveComparison(rows, 'api.players', 0).accepted).toBe(true);
  expect(summarizeLiveComparison(rows, 'api.players', 1).accepted).toBe(false);
  expect(summarizeLiveComparison(rows.slice(1), 'api.players', 0).accepted).toBe(false);
  expect(summarizeLiveComparison(rows.map((row, index) => index === 1 ? { ...row, ms: 21 } : row), 'api.players', 0).accepted).toBe(false);
  expect(summarizeLiveComparison(rows.map((row, index) => index === 1 ? { ...row, sha256: 'b'.repeat(64) } : row), 'api.players', 0).accepted).toBe(false);
  expect(summarizeLiveComparison(rows.map(row => ({ ...row, ms: row.ms + row.pair * 100 })), 'api.players', 0).accepted).toBe(false);
});

it('adds browser bypass headers only to the exact target origin including assets and API calls', async () => {
  const previous = process.env.PB_VERCEL_BYPASS;
  const sentinel = `synthetic-bypass-${randomUUID()}`;
  process.env.PB_VERCEL_BYPASS = sentinel;
  const foreignHeaders: (string | undefined)[] = [];
  const external = createServer((request, response) => { foreignHeaders.push(request.headers['x-vercel-protection-bypass'] as string | undefined); response.setHeader('content-type', 'text/html'); response.end('<p>Foreign destination</p>'); });
  await new Promise<void>(resolve => external.listen(0, '127.0.0.1', resolve));
  const externalAddress = external.address();
  if (!externalAddress || typeof externalAddress === 'string') throw new Error('No foreign test port');
  const received: { path: string; header: string | undefined }[] = [];
  const server = createServer((request, response) => {
    received.push({ path: request.url!, header: request.headers['x-vercel-protection-bypass'] as string | undefined });
    if (request.url === '/') { response.setHeader('content-type', 'text/html'); response.end('<script src="/asset.js"></script><p>Owned page</p>'); }
    else if (request.url === '/asset.js') { response.setHeader('content-type', 'application/javascript'); response.end('fetch("/api/auth/me").then(response => response.json()).then(() => document.body.dataset.loaded = "yes")'); }
    else if (request.url === '/redirect') { response.writeHead(302, { location: `http://127.0.0.1:${externalAddress.port}/destination` }); response.end(); }
    else void handle(createApp(database.pool))(request, response);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No browser test port');
  const client = await LiveClient.create(`http://127.0.0.1:${address.port}`);
  let browser: Awaited<ReturnType<typeof webkit.launch>> | undefined;
  let browserServer: Awaited<ReturnType<typeof webkit.launchServer>> | undefined;
  try {
    await client.request('/api/auth/signup', { method: 'POST', body: { username: `browser-${randomUUID().slice(0, 12)}`, password: `test-only-${randomUUID()}` } });
    browserServer = await webkit.launchServer();
    browser = await webkit.connect(browserServer.wsEndpoint());
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.addCookies((await client.context.storageState()).cookies);
    await scopeLiveBrowserRequests(context, client);
    const page = await context.newPage();
    await page.goto(client.baseURL);
    await page.waitForFunction(() => document.body.dataset.loaded === 'yes');
    expect(await page.content()).not.toContain(sentinel);
    await expect(page.goto(`${client.baseURL}/redirect`)).rejects.toThrow();
    expect(foreignHeaders).toEqual([]);
    await page.goto(`http://127.0.0.1:${externalAddress.port}/destination`);
    expect(foreignHeaders.length).toBeGreaterThan(0);
    expect(foreignHeaders.every(header => header === undefined)).toBe(true);
    expect(received.some(request => request.path === '/asset.js')).toBe(true);
    expect(received.some(request => request.path === '/api/auth/me')).toBe(true);
    expect(received.every(request => request.header === sentinel)).toBe(true);
    await withShutdownDeadline('Test browser context close', () => context.close());
  } finally {
    if (previous === undefined) delete process.env.PB_VERCEL_BYPASS; else process.env.PB_VERCEL_BYPASS = previous;
    try { await cleanupLeaves(() => browser?.close(), () => browserServer?.close(), () => client.close(), ...[server, external].map(owned => () => closeOwnedServer(owned))); }
    finally { if (browserServer) await stopOwnedProcess(browserServer.process(), 'signal', true); }
  }
}, 30000);
