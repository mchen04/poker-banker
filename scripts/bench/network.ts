import https from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { setTimeout as pause } from 'node:timers/promises';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';
const brotli = promisify(brotliCompress);
const gzipped = promisify(gzip);

function encoding(header: string | undefined): 'br' | 'gzip' | undefined {
  if (!header) return;
  const values = new Map(header.toLowerCase().split(',').map(part => {
    const [name, ...parameters] = part.trim().split(';');
    const quality = parameters.find(value => value.trim().startsWith('q='))?.trim().slice(2);
    const weight = quality === undefined ? 1 : Number(quality);
    return [name!.trim(), Number.isFinite(weight) && weight >= 0 && weight <= 1 ? weight : 0];
  }));
  const quality = (name: string) => values.get(name) ?? values.get('*') ?? 0;
  const selected = quality('br') >= quality('gzip') ? 'br' : 'gzip';
  if (quality(selected) > 0 && quality(selected) >= (values.get('identity') ?? 0)) return selected;
}

function compressible(headers: IncomingMessage['headers']) {
  const type = headers['content-type']?.split(';')[0]?.trim().toLowerCase() ?? '';
  return type.startsWith('text/') || /^(application\/(?:json|javascript|x-javascript|xml|wasm|manifest\+json)|image\/svg\+xml)$/.test(type) || /^application\/[\w.-]+\+(?:json|xml)$/.test(type);
}
export class ShapedProxy {
  enabled = false;
  private queue: { response: ServerResponse; bytes: Buffer; offset: number; resolve: () => void }[] = [];
  private interval: NodeJS.Timeout;
  private readonly agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });
  readonly counts = { requests: 0, responses: 0, bytes: 0, shapedBytes: 0, upstreamBytes: 0, brotliResponses: 0, gzipResponses: 0, upstreamErrors: 0, disconnected: 0 };
  constructor(readonly backend: string) {
    if (new URL(backend).hostname !== '127.0.0.1') throw new Error('Shaping proxy only forwards to the owned loopback server');
    this.interval = setInterval(() => this.drain(), 20);
  }
  private drain() {
    let budget = 5000;
    while (budget > 0 && this.queue.length) {
      const item = this.queue.shift()!;
      if (item.response.destroyed) { this.counts.disconnected++; item.resolve(); continue; }
      const size = Math.min(budget, item.bytes.length - item.offset);
      item.response.write(item.bytes.subarray(item.offset, item.offset + size)); item.offset += size; budget -= size;
      this.counts.bytes += size; this.counts.shapedBytes += size;
      if (item.offset === item.bytes.length) { item.response.end(); item.resolve(); }
      else this.queue.push(item);
    }
  }
  handle = async (incoming: IncomingMessage, outgoing: ServerResponse) => {
    this.counts.requests++;
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const shaped = this.enabled;
      if (shaped) await pause(body.length / 64000 * 1000);
      const result = await new Promise<{ status: number; headers: IncomingMessage['headers']; bytes: Buffer }>((resolve, reject) => {
        const request = https.request(new URL(incoming.url ?? '/', this.backend), { method: incoming.method, headers: { ...incoming.headers, 'accept-encoding': 'identity' }, agent: this.agent }, response => {
          const bytes: Buffer[] = []; response.on('data', chunk => bytes.push(Buffer.from(chunk))); response.on('error', reject);
          response.on('end', () => resolve({ status: response.statusCode ?? 502, headers: response.headers, bytes: Buffer.concat(bytes) }));
        });
        request.on('error', reject); request.end(body);
      });
      this.counts.upstreamBytes += result.bytes.length;
      delete result.headers['transfer-encoding'];
      const hasBody = incoming.method !== 'HEAD' && result.status !== 204 && result.status !== 304 && result.status >= 200;
      const eligible = hasBody && result.bytes.length > 0 && !result.headers['content-encoding'] && !result.headers['content-range'] && !/\bno-transform\b/i.test(String(result.headers['cache-control'] ?? '')) && compressible(result.headers);
      if (eligible) {
        const vary = result.headers.vary?.split(',').map(value => value.trim()) ?? [];
        if (!vary.some(value => value.toLowerCase() === 'accept-encoding') && !vary.includes('*')) vary.push('Accept-Encoding');
        result.headers.vary = vary.join(', ');
        const selected = encoding(incoming.headers['accept-encoding']);
        if (selected) {
          result.bytes = selected === 'br' ? await brotli(result.bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } }) : await gzipped(result.bytes);
          result.headers['content-encoding'] = selected;
          result.headers['content-length'] = String(result.bytes.length);
          if (selected === 'br') this.counts.brotliResponses++; else this.counts.gzipResponses++;
        }
      }
      if (shaped) await pause(60);
      if (outgoing.destroyed) { this.counts.disconnected++; return; }
      outgoing.writeHead(result.status, result.headers);
      if (shaped && result.bytes.length) await new Promise<void>(resolve => { this.queue.push({ response: outgoing, bytes: result.bytes, offset: 0, resolve }); });
      else { this.counts.bytes += result.bytes.length; outgoing.end(result.bytes); }
      this.counts.responses++;
    } catch (error) {
      if (incoming.aborted || outgoing.destroyed) { this.counts.disconnected++; return; }
      this.counts.upstreamErrors++;
      if (!outgoing.headersSent) outgoing.writeHead(502, { 'content-type': 'text/plain' });
      outgoing.end(error instanceof Error ? error.message : 'Owned proxy failed');
    }
  };
  close() { clearInterval(this.interval); this.agent.destroy(); for (const item of this.queue) { item.response.destroy(); item.resolve(); } this.queue = []; }
  profile() { return { addedResponseLatencyMs: 60, downstreamBitsPerSecond: 2_000_000, upstreamBitsPerSecond: 512_000, downstreamScope: 'Aggregate across active requests in the single profiled browser', cache: 'Real HTTP cache and service worker, no Playwright routing', edgeCompression: { eligible: 'Nonempty text, JSON, JavaScript, XML, SVG, WASM; no existing Content-Encoding, range or no-transform; no HEAD/204/304 body', negotiation: 'Accept-Encoding quality; Brotli wins ties, gzip fallback, identity upstream; compress before bandwidth shaping', brotliQuality: 4, gzipLevel: 'Node default 6', cache: 'No proxy CDN cache' }, limitations: 'Synthetic shaping and edge encoding, not Vercel infrastructure; buffered responses, local codec CPU, no radio loss, TCP congestion, DNS, geographic edge latency, streaming or exact CDN codec/threshold fidelity' }; }
}
