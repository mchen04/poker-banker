import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request, type APIRequestContext } from '@playwright/test';
import type { BenchmarkClient, HttpResult } from './types';

export function liveOrigin(baseURL: string, allowLoopbackCertificate = false) {
  const url = new URL(baseURL);
  assert(!url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'Live base must contain only an origin');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  assert(url.protocol === 'https:' || (url.protocol === 'http:' && loopback), 'Live targets require HTTPS; HTTP is permitted only for an owned loopback server');
  assert(!allowLoopbackCertificate || loopback, 'Certificate exceptions are restricted to an owned loopback server');
  return url.origin;
}
export class LiveClient implements BenchmarkClient {
  readonly counts = { requests: 0, mutations: 0, errors: 0, statuses: {} as Record<string, number> };
  private readonly secrets = new Set<string>();
  private constructor(readonly baseURL: string, readonly context: APIRequestContext, private readonly bypass: string | undefined) { if (bypass) this.secrets.add(bypass); }
  get bypassEnabled() { return Boolean(this.bypass); }
  ownSecret(value: string) { if (value) this.secrets.add(value); }
  redact(value: unknown) {
    let text = value instanceof Error ? value.message : String(value);
    for (const secret of this.secrets) text = text.replaceAll(secret, 'OWNED_SECRET');
    return text;
  }
  scopedHeaders(url: string, headers: Record<string, string>) {
    const result = Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'x-vercel-protection-bypass'));
    if (new URL(url).origin === this.baseURL && this.bypass) result['x-vercel-protection-bypass'] = this.bypass;
    return result;
  }
  static async create(baseURL: string, allowLoopbackCertificate = false) {
    const origin = liveOrigin(baseURL, allowLoopbackCertificate);
    const context = await request.newContext({ baseURL: origin, ignoreHTTPSErrors: allowLoopbackCertificate, extraHTTPHeaders: { origin, 'content-type': 'application/json' }, timeout: 30000 });
    return new LiveClient(origin, context, process.env.PB_VERCEL_BYPASS || undefined);
  }
  async sessionCookie() {
    const cookies = (await this.context.storageState()).cookies.filter(cookie => cookie.name === 'pb_session' && cookie.domain === new URL(this.baseURL).hostname && cookie.path === '/');
    assert.equal(cookies.length, 1, 'Expected exactly one owned session cookie');
    this.ownSecret(cookies[0]!.value);
    return cookies[0]!.value;
  }
  async restoreSession(cookie: string) {
    this.ownSecret(cookie);
    await this.context.clearCookies();
    await this.context.addCookies([{ name: 'pb_session', value: cookie, url: this.baseURL, secure: new URL(this.baseURL).protocol === 'https:', httpOnly: true, sameSite: 'Lax' }]);
  }
  async request(path: string, options: { method?: string; body?: unknown } = {}): Promise<HttpResult> {
    const url = new URL(path, this.baseURL);
    assert.equal(url.origin, this.baseURL, 'A benchmark request cannot leave its target origin');
    assert(!url.username && !url.password, 'A benchmark request cannot contain credentials');
    const started = performance.now();
    this.counts.requests++; if (options.method && options.method !== 'GET') this.counts.mutations++;
    try {
      const response = await this.context.fetch(url.href, { method: options.method ?? 'GET', headers: this.scopedHeaders(url.href, {}), ...(options.body === undefined ? {} : { data: options.body }), maxRedirects: 0 });
      const bytes = await response.body();
      const ms = performance.now() - started, status = response.status();
      const timing = response.headers()['server-timing']?.match(/app;dur=([\d.]+)/);
      await response.dispose();
      this.counts.statuses[status] = (this.counts.statuses[status] ?? 0) + 1;
      const body: unknown = bytes.length ? JSON.parse(bytes.toString('utf8')) : null;
      if (status === 200 && url.pathname === '/api/auth/signup' && url.protocol === 'http:') await this.restoreSession(await this.sessionCookie());
      if (status >= 400 || status >= 300 && status !== 304) this.counts.errors++;
      return { status, body, ms, serverMs: timing ? Number(timing[1]) : null, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    } catch (error) { this.counts.errors++; throw new Error(`Controller ${options.method ?? 'GET'} ${url.pathname.replace(/\/api\/view\/[^/]+/, '/api/view/OWNED_TOKEN')} failed (${error instanceof Error ? error.name : 'transport error'})`); }
  }
  async close() { await this.context.dispose(); }
}
