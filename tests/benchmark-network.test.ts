import { once } from 'node:events';
import https, { type Server } from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { brotliDecompressSync, gunzipSync, gzipSync } from 'node:zlib';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ShapedProxy } from '../scripts/bench/network';
import { createProcessOwner } from '../scripts/owned-process';
import { runOwned } from '../scripts/owned-command';
import { closeOwnedServer } from '../scripts/close-server';

const owner = createProcessOwner();
const text = JSON.stringify({ amount_minor: '123456789012345678', entries: 'Ledger entry '.repeat(5000) });
let proxy: ShapedProxy;
let address: string;
let upstreamEncoding: string | undefined;

async function listen(server: Server) {
  owner.addCleanup('Owned proxy test server close', 'pool', () => closeOwnedServer(server));
  const ready = once(server, 'listening', { signal: AbortSignal.timeout(10000) });
  server.listen(0, '127.0.0.1');
  await ready;
  const value = server.address();
  if (!value || typeof value === 'string') throw new Error('Missing owned proxy test address');
  return `https://127.0.0.1:${value.port}`;
}

beforeAll(async () => {
  await mkdir('.cache', { recursive: true });
  const directory = await mkdtemp(resolve('.cache/benchmark-proxy-'));
  owner.addCleanup('Owned proxy TLS cleanup', 'cleanup', () => rm(directory, { recursive: true, force: true }));
  const keyPath = join(directory, 'key.pem'), certPath = join(directory, 'cert.pem');
  await runOwned(owner, 'openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-keyout', keyPath, '-out', certPath], { stdio: 'ignore' });
  const tls = { key: await readFile(keyPath), cert: await readFile(certPath) };
  const backend = await listen(https.createServer(tls, (request, response) => {
    upstreamEncoding = request.headers['accept-encoding'];
    const path = request.url;
    response.setHeader('Content-Type', path === '/asset' ? 'text/javascript' : path === '/image' ? 'image/png' : 'application/json');
    response.setHeader('X-PB-Banker-ID', 'banker-fixture');
    response.setHeader('Cache-Control', path === '/no-transform' ? 'no-store, no-transform' : 'no-store');
    response.setHeader('Set-Cookie', ['fixture=one; HttpOnly', 'another=two; HttpOnly']);
    response.setHeader('Server-Timing', 'db;dur=3.5;desc="queries:6"');
    response.setHeader('Vary', 'Origin');
    if (path === '/304' || path === '/204') { response.statusCode = Number(path.slice(1)); response.end(); return; }
    if (path === '/range') { response.statusCode = 206; response.setHeader('Content-Range', `bytes 0-${text.length - 1}/${text.length}`); }
    if (path === '/encoded') { response.setHeader('Content-Encoding', 'gzip'); response.end(gzipSync(text)); return; }
    response.end(text);
  }));
  proxy = new ShapedProxy(backend);
  owner.addCleanup('Owned shaping proxy close', 'pool', () => proxy.close());
  address = await listen(https.createServer(tls, proxy.handle));
});
afterAll(() => owner.stop());

function request(path: string, encoding?: string, method = 'GET') {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; bytes: Buffer }>((resolve, reject) => {
    const controller = https.request(`${address}${path}`, { rejectUnauthorized: false, agent: false, method, signal: AbortSignal.timeout(10000), headers: encoding === undefined ? {} : { 'Accept-Encoding': encoding } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, bytes: Buffer.concat(chunks) }));
    });
    controller.on('error', reject);
    controller.end();
  });
}

it.each([
  ['br, gzip', 'br'], ['gzip', 'gzip'], ['br;q=0, gzip;q=1', 'gzip'],
  ['br;q=0.5, gzip;q=0.9', 'gzip'], ['br;q=0.8, gzip;q=0.8', 'br'],
  ['gzip;q=0, br;q=0', undefined], ['identity', undefined], [undefined, undefined],
  ['*;q=0.7', 'br'], ['br;q=0.5, identity;q=1', undefined],
] as const)('negotiates %s as %s and preserves the exact financial body and ownership', async (accept, selected) => {
  const result = await request('/api/session', accept);
  expect(result.status).toBe(200);
  expect(result.headers['content-encoding']).toBe(selected);
  expect(upstreamEncoding).toBe('identity');
  expect(result.headers['x-pb-banker-id']).toBe('banker-fixture');
  expect(result.headers['cache-control']).toBe('no-store');
  expect(result.headers['set-cookie']).toEqual(['fixture=one; HttpOnly', 'another=two; HttpOnly']);
  expect(result.headers['server-timing']).toBe('db;dur=3.5;desc="queries:6"');
  expect(result.headers.vary).toBe('Origin, Accept-Encoding');
  const decoded = selected === 'br' ? brotliDecompressSync(result.bytes) : selected === 'gzip' ? gunzipSync(result.bytes) : result.bytes;
  expect(decoded.toString()).toBe(text);
  if (selected) expect(Number(result.headers['content-length'])).toBe(result.bytes.length);
});

it('negotiates static assets at the same boundary and shapes encoded bytes', async () => {
  proxy.enabled = true;
  const before = { ...proxy.counts };
  try {
    const result = await request('/asset', 'br, gzip');
    expect(result.headers['content-encoding']).toBe('br');
    expect(brotliDecompressSync(result.bytes).toString()).toBe(text);
    expect(result.bytes.length).toBeLessThan(Buffer.byteLength(text));
    expect(proxy.counts.shapedBytes - before.shapedBytes).toBe(result.bytes.length);
    expect(proxy.counts.bytes - before.bytes).toBe(result.bytes.length);
    expect(proxy.counts.upstreamBytes - before.upstreamBytes).toBe(Buffer.byteLength(text));
    expect(proxy.counts.brotliResponses - before.brotliResponses).toBe(1);
  } finally { proxy.enabled = false; }
});

it.each(['/no-transform', '/image', '/range'])('does not transform %s', async path => {
  const result = await request(path, 'br, gzip');
  expect(result.headers['content-encoding']).toBeUndefined();
  expect(result.bytes.toString()).toBe(text);
  expect(result.headers.vary).toBe('Origin');
});

it('does not double-compress preencoded responses', async () => {
  const result = await request('/encoded', 'br, gzip');
  expect(result.headers['content-encoding']).toBe('gzip');
  expect(gunzipSync(result.bytes).toString()).toBe(text);
});

it.each([['/304', 'GET', 304], ['/204', 'GET', 204], ['/api/session', 'HEAD', 200]] as const)('keeps %s %s bodiless', async (path, method, status) => {
  const result = await request(path, 'br, gzip', method);
  expect(result.status).toBe(status);
  expect(result.headers['content-encoding']).toBeUndefined();
  expect(result.bytes.length).toBe(0);
  expect(result.headers['x-pb-banker-id']).toBe('banker-fixture');
});
