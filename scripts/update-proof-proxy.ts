import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, request as upstreamRequest } from 'node:https';
import { resolve } from 'node:path';
import type { Duplex } from 'node:stream';
import { closeOwnedServer } from './close-server';
import { runOwned } from './owned-command';
import type { ProcessOwner } from './owned-process';

export type ForwardedRequest = { id: number; path: string; method: string; navigation: boolean; startedAt: number; status?: number; headers?: Record<string, string | string[] | undefined>; bodySha256?: string; bodyBytes?: number; upstreamFinishedAt?: number; releasedAt?: number; disconnectedAt?: number };
type Match = { path?: string; method?: string; navigation?: boolean; phase?: 'headers' | 'body' | 'request'; limit?: number };
type Gate = { match: Match; records: ForwardedRequest[]; release: () => void; released: Promise<void>; timer: ReturnType<typeof setTimeout> };

export async function createUpdateProofProxy(owner: ProcessOwner, baseURL: string) {
  const upstream = new URL(baseURL);
  if (upstream.protocol !== 'https:' || !['127.0.0.1', 'localhost', '[::1]'].includes(upstream.hostname)) throw new Error('Update proof forwarding requires owned loopback HTTPS');
  await mkdir('.cache', { recursive: true });
  const directory = await mkdtemp(resolve('.cache/update-proxy-'));
  owner.addCleanup('Update proxy TLS files', 'cleanup', () => rm(directory, { recursive: true, force: true }));
  const key = `${directory}/key.pem`, cert = `${directory}/cert.pem`;
  await runOwned(owner, 'openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-keyout', key, '-out', cert]);
  const gates = new Set<Gate>();
  const records: ForwardedRequest[] = [];
  const sockets = new Set<Duplex>();
  let origin = '';
  const server = createServer({ key: await readFile(key), cert: await readFile(cert) }, (request, response) => {
    response.on('error', () => response.destroy());
    const path = request.url ?? '/';
    const method = request.method ?? 'GET';
    const navigation = request.headers['sec-fetch-mode'] === 'navigate' || request.headers['sec-fetch-dest'] === 'document' || (method === 'GET' && !new URL(path, origin).pathname.startsWith('/api/') && /text\/html/i.test(request.headers.accept ?? ''));
    const record: ForwardedRequest = { id: records.length + 1, path, method, navigation, startedAt: Date.now() };
    records.push(record);
    const gate = [...gates].find(candidate => (!candidate.match.path || new URL(path, origin).pathname === candidate.match.path) && (!candidate.match.method || candidate.match.method === record.method) && (candidate.match.navigation === undefined || candidate.match.navigation === record.navigation) && candidate.records.length < (candidate.match.limit ?? Infinity));
    gate?.records.push(record);
    const headers = { ...request.headers, host: upstream.host };
    if (headers.origin === origin) headers.origin = upstream.origin;
    if (headers.referer?.startsWith(`${origin}/`)) headers.referer = `${upstream.origin}${headers.referer.slice(origin.length)}`;
    const forward = () => {
    if (response.destroyed) return;
    const forwarded = upstreamRequest(new URL(path, upstream), { method: record.method, headers, rejectUnauthorized: false, agent: false }, result => {
      const chunks: Buffer[] = [];
      result.on('data', chunk => chunks.push(Buffer.from(chunk)));
      result.on('end', () => {
        const body = Buffer.concat(chunks);
        record.status = result.statusCode ?? 502;
        record.headers = result.headers;
        record.bodyBytes = body.length;
        record.bodySha256 = createHash('sha256').update(body).digest('hex');
        record.upstreamFinishedAt = Date.now();
        const sendHeaders = () => { if (!response.destroyed && !response.headersSent) response.writeHead(record.status!, result.headers); };
        if (gate?.match.phase === 'body') { sendHeaders(); if (!response.destroyed) response.flushHeaders(); }
        void (async () => {
          if (gate && gate.match.phase !== 'request') await gate.released;
          record.releasedAt = Date.now();
          if (response.destroyed || response.writableEnded) return;
          sendHeaders();
          response.end(body);
        })().catch(() => response.destroy());
      });
      result.on('error', () => response.destroy());
    });
    forwarded.on('socket', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    forwarded.setTimeout(180000, () => forwarded.destroy(new Error('Owned update forwarding deadline')));
    forwarded.on('error', () => { if (!response.destroyed) { if (!response.headersSent) response.writeHead(502); response.end(); } });
    response.once('close', () => { record.disconnectedAt = Date.now(); forwarded.destroy(); });
    request.pipe(forwarded);
    };
    if (gate?.match.phase === 'request') void gate.released.then(forward).catch(() => response.destroy());
    else forward();
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  owner.addCleanup('Update proxy held requests', 'pool', async () => {
    for (const gate of gates) gate.release();
    for (const socket of sockets) socket?.destroy();
    await closeOwnedServer(server);
  });
  await owner.launch(() => new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); accept(); }); }));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Update proxy did not bind a loopback port');
  origin = `https://127.0.0.1:${address.port}`;
  return { origin, records, hold(match: Match) {
    let release!: () => void;
    const released = new Promise<void>(accept => { release = accept; });
    const gate: Gate = { match, records: [], released, release: () => { clearTimeout(gate.timer); gates.delete(gate); release(); }, timer: setTimeout(() => gate.release(), 180000) };
    gates.add(gate);
    return gate;
  } };
}
