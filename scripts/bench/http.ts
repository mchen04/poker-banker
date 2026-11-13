import https from 'node:https';
import type { BenchmarkClient, HttpResult } from './types';
export class LocalClient implements BenchmarkClient {
  private sessionCookie = '';
  private readonly agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });
  constructor(readonly baseURL: string, readonly origin: string) {
    if (new URL(baseURL).hostname !== '127.0.0.1' || new URL(origin).hostname !== '127.0.0.1') throw new Error('Benchmarks only use their owned loopback server');
  }
  cookie() { if (!this.sessionCookie) throw new Error('Benchmark login missing'); return this.sessionCookie; }
  close() { this.agent.destroy(); }
  async request(path: string, options: { method?: string; body?: unknown } = {}): Promise<HttpResult> {
    const url = new URL(path, this.baseURL);
    if (url.origin !== this.baseURL) throw new Error('Benchmark request escaped the owned loopback origin');
    const content = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body));
    const started = performance.now();
    return new Promise((resolve, reject) => {
      const request = https.request(url, { agent: this.agent, method: options.method ?? 'GET', headers: { origin: this.origin, 'content-type': 'application/json', ...(content ? { 'content-length': String(content.length) } : {}), ...(this.sessionCookie ? { cookie: this.sessionCookie } : {}) } }, response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.on('error', reject);
        response.on('end', () => {
          const bytes = Buffer.concat(chunks);
          const cookie = response.headers['set-cookie']?.find(value => value.startsWith('pb_session='));
          if (cookie) this.sessionCookie = cookie.split(';')[0]!;
          let body: unknown = null;
          try { if (bytes.length) body = JSON.parse(bytes.toString('utf8')); } catch { body = bytes.toString('utf8'); }
          const timing = String(response.headers['server-timing'] ?? '');
          const app = timing.match(/(?:^|,\s*)app;dur=([\d.]+)/);
          const db = timing.match(/(?:^|,\s*)db;dur=([\d.]+)/);
          const count = timing.match(/(?:^|,\s*)db_count;desc="(\d+)"/);
          resolve({ status: response.statusCode ?? 0, body, ms: performance.now() - started, serverMs: app ? Number(app[1]) : null, dbMs: db ? Number(db[1]) : null, queryCount: count ? Number(count[1]) : null, bytes: bytes.length });
        });
      });
      request.setTimeout(15000, () => request.destroy(new Error('Owned benchmark request timed out')));
      request.on('error', reject); request.end(content);
    });
  }
}
