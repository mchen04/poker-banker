import https from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { setTimeout as pause } from 'node:timers/promises';
export class ShapedProxy {
  enabled = false;
  private queue: { response: ServerResponse; bytes: Buffer; offset: number; resolve: () => void }[] = [];
  private interval: NodeJS.Timeout;
  private readonly agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });
  readonly counts = { requests: 0, responses: 0, bytes: 0, shapedBytes: 0, upstreamErrors: 0, disconnected: 0 };
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
        const request = https.request(new URL(incoming.url ?? '/', this.backend), { method: incoming.method, headers: incoming.headers, agent: this.agent }, response => {
          const bytes: Buffer[] = []; response.on('data', chunk => bytes.push(Buffer.from(chunk))); response.on('error', reject);
          response.on('end', () => resolve({ status: response.statusCode ?? 502, headers: response.headers, bytes: Buffer.concat(bytes) }));
        });
        request.on('error', reject); request.end(body);
      });
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
  profile() { return { addedResponseLatencyMs: 60, downstreamBitsPerSecond: 2_000_000, upstreamBitsPerSecond: 512_000, downstreamScope: 'Aggregate across active requests in the single profiled browser', cache: 'Real HTTP cache and service worker, no Playwright routing', limitations: 'Synthetic shaping; no radio loss, TCP congestion, DNS or geographic edge latency' }; }
}
