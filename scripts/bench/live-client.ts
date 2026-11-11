import assert from 'node:assert/strict';
import { request, type APIRequestContext } from '@playwright/test';
import type { BenchmarkClient, HttpResult } from './types';

export class LiveClient implements BenchmarkClient {
  readonly counts = { requests: 0, mutations: 0, errors: 0, statuses: {} as Record<string, number> };
  private constructor(readonly baseURL: string, readonly context: APIRequestContext) {}
  static async create(baseURL: string, allowLoopbackCertificate = false) {
    const url = new URL(baseURL);
    assert(!url.username && !url.password && !url.search && !url.hash, 'PB_BASE_URL must contain only an origin');
    assert.equal(url.pathname, '/');
    assert(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)), 'Live targets require HTTPS; HTTP is permitted only for an owned loopback server');
    assert(!allowLoopbackCertificate || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Certificate exceptions are restricted to an owned loopback server');
    const context = await request.newContext({ baseURL: url.origin, ignoreHTTPSErrors: allowLoopbackCertificate, extraHTTPHeaders: { origin: url.origin, 'content-type': 'application/json' }, timeout: 30000 });
    return new LiveClient(url.origin, context);
  }
  async request(path: string, options: { method?: string; body?: unknown } = {}): Promise<HttpResult> {
    assert.equal(new URL(path, this.baseURL).origin, this.baseURL, 'A benchmark request cannot leave its target origin');
    const started = performance.now();
    this.counts.requests++; if (options.method && options.method !== 'GET') this.counts.mutations++;
    try {
      const response = await this.context.fetch(path, { method: options.method ?? 'GET', ...(options.body === undefined ? {} : { data: options.body }), maxRedirects: 0 });
      const bytes = await response.body();
      const ms = performance.now() - started, status = response.status();
      const timing = response.headers()['server-timing']?.match(/app;dur=([\d.]+)/);
      await response.dispose();
      this.counts.statuses[status] = (this.counts.statuses[status] ?? 0) + 1;
      const body: unknown = bytes.length ? JSON.parse(bytes.toString('utf8')) : null;
      if (status >= 400) this.counts.errors++;
      return { status, body, ms, serverMs: timing ? Number(timing[1]) : null, bytes: bytes.length };
    } catch (error) { this.counts.errors++; throw new Error(`Controller ${options.method ?? 'GET'} ${new URL(path, this.baseURL).pathname.replace(/\/api\/view\/[^/]+/, '/api/view/OWNED_TOKEN')} failed (${error instanceof Error ? error.name : 'transport error'})`); }
  }
  async close() { await this.context.dispose(); }
}
