import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const template = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
type Handler = (event: Record<string, unknown>) => void;
type WorkerFetch = (request: Request | string, options?: RequestInit) => Promise<Response>;

function worker(fetcher: WorkerFetch = async () => new Response('asset', { headers: { 'cache-control': 'public, max-age=31536000, immutable' } }), stamp = true) {
  const origin = 'https://poker.test';
  const handlers = new Map<string, Handler>();
  const stores = new Map<string, Map<string, Response>>();
  let claims = 0, activations = 0, fetches = 0;
  const key = (request: Request | string) => new URL(typeof request === 'string' ? request : request.url, origin).href;
  const caches = {
    open: async (name: string) => {
      let data = stores.get(name);
      if (!data) { data = new Map(); stores.set(name, data); }
      const contents = data;
      return {
        put: async (request: Request | string, response: Response) => { contents.set(key(request), response.clone()); },
        match: async (request: Request | string) => contents.get(key(request))?.clone(),
      };
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
  };
  const context = createContext({
    self: {
      location: { origin },
      clients: { claim: async () => { claims++; } },
      skipWaiting: async () => { activations++; },
      addEventListener: (name: string, handler: Handler) => handlers.set(name, handler),
    },
    caches, Request: class extends Request { constructor(input: Request | string, init?: RequestInit) { super(typeof input === 'string' ? new URL(input, origin) : input, init); } },
    Response, URL, AbortController,
    fetch: async (request: Request | string, options?: RequestInit) => { fetches++; return fetcher(request, options); },
    setTimeout: (handler: () => void, delay: number) => setTimeout(handler, Math.min(delay, 10)), clearTimeout,
  });
  const source = stamp ? template.replace('__PB_RELEASE__', '"test-release"').replace('__PB_PRECACHE__', '["/index.html","/assets/main-test.js"]') : template;
  runInContext(source, context);
  return {
    stores, fetches: () => fetches, claims: () => claims, activations: () => activations,
    async lifecycle(name: string, extra: Record<string, unknown> = {}) {
      const pending: Promise<unknown>[] = [];
      handlers.get(name)?.({ ...extra, waitUntil: (promise: Promise<unknown>) => pending.push(promise) });
      await Promise.all(pending);
    },
    async request(path: string, method = 'GET', navigate = false): Promise<Response | undefined> {
      const request = new Request(new URL(path, origin), { method });
      if (navigate) Object.defineProperty(request, 'mode', { value: 'navigate' });
      let response: Promise<Response> | undefined;
      handlers.get('fetch')?.({ request, respondWith: (value: Promise<Response>) => { response = value; } });
      return response;
    },
  };
}

it('fails to start without release and precache stamps', () => {
  expect(() => worker(undefined, false)).toThrow();
  const source = template.replace('__PB_RELEASE__', '""').replace('__PB_PRECACHE__', '[]');
  expect(() => runInContext(source, createContext({}))).toThrow('Worker release and precache stamps are required');
});

it('precaches the stamped release shell and serves its hashed assets without network', async () => {
  const instance = worker();
  await instance.lifecycle('install');
  expect(instance.fetches()).toBe(2);
  expect(await (await instance.request('/assets/main-test.js'))!.text()).toBe('asset');
  expect(instance.fetches()).toBe(2);
});

it('never intercepts API, cross-origin or non-GET requests', async () => {
  const instance = worker();
  for (const path of ['/api', '/api/sessions', '/api/auth/me', 'https://other.test/assets/main-test.js']) expect(await instance.request(path)).toBeUndefined();
  expect(await instance.request('/assets/main-test.js', 'POST')).toBeUndefined();
  expect(instance.fetches()).toBe(0);
});

describe('response cache restrictions', () => {
  it.each([
    { 'cache-control': 'no-store' },
    { 'cache-control': 'private, max-age=60' },
    { 'set-cookie': 'pb_session=secret' },
  ] as Record<string, string>[])('does not cache a response with %j', async headers => {
    const instance = worker(async () => new Response('private', { headers }));
    await instance.request('/assets/uncached-hash.js');
    await instance.request('/assets/uncached-hash.js');
    expect(instance.fetches()).toBe(2);
    expect(instance.stores.get('poker-banker-test-release')!.size).toBe(0);
    await expect(instance.lifecycle('install')).rejects.toThrow('Cannot precache');
  });
  it('keeps missing hashed assets as uncached 404 responses', async () => {
    const instance = worker(async () => new Response('missing', { status: 404, headers: { 'cache-control': 'no-store' } }));
    expect((await instance.request('/assets/missing-hash.js'))!.status).toBe(404);
    await instance.request('/assets/missing-hash.js');
    expect(instance.fetches()).toBe(2);
  });
});

it('uses network-first navigation and falls back to its release shell when offline', async () => {
  let offline = false;
  const instance = worker(async () => {
    if (offline) throw new TypeError('offline');
    return new Response('release shell', { headers: { 'content-type': 'text/html' } });
  });
  await instance.lifecycle('install');
  expect(await (await instance.request('/players', 'GET', true))!.text()).toBe('release shell');
  offline = true;
  expect(await (await instance.request('/?session=game', 'GET', true))!.text()).toBe('release shell');
});

it('aborts a stalled navigation and serves the precached shell', async () => {
  const instance = worker(async (_request, options) => {
    if (!options?.signal) return new Response('offline shell');
    return new Promise<Response>((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(new Error('timeout'))));
  });
  await instance.lifecycle('install');
  expect(await (await instance.request('/', 'GET', true))!.text()).toBe('offline shell');
});

it('waits for the page activation message, cleans old app caches and reports its version', async () => {
  const instance = worker();
  await instance.lifecycle('install');
  expect(instance.activations()).toBe(0);
  instance.stores.set('poker-banker-old', new Map());
  instance.stores.set('unrelated-cache', new Map());
  let answer: unknown;
  await instance.lifecycle('message', { data: { type: 'VERSION' }, ports: [{ postMessage: (value: unknown) => { answer = value; } }] });
  expect(answer).toEqual({ version: 'test-release' });
  await instance.lifecycle('message', { data: { type: 'ACTIVATE' } });
  expect(instance.activations()).toBe(1);
  await instance.lifecycle('activate');
  expect(instance.claims()).toBe(1);
  expect([...instance.stores.keys()].sort()).toEqual(['poker-banker-test-release', 'unrelated-cache']);
});
