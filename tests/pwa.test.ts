import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { updatePolicyDatabase } from './helpers/update-policy';

const template = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
type Handler = (event: Record<string, unknown>) => void;
type WorkerFetch = (request: Request | string, options?: RequestInit) => Promise<Response>;
type WorkerClient = { id: string; release?: string; updateProtocol?: number | null; unresponsive?: boolean; replyId?: string; messages?: unknown[] };
type WorkerReference = { postMessage?: (data: unknown, ports: { postMessage: (data: unknown) => void }[]) => void };
type SharedWorkerState = { stores?: Map<string, Map<string, Response>>; database?: ReturnType<typeof updatePolicyDatabase>; release?: string; precache?: string[]; locks?: boolean };

function worker(fetcher: WorkerFetch = async () => new Response('asset', { headers: { 'cache-control': 'public, max-age=31536000, immutable' } }), stamp = true, clients: WorkerClient[] = [], shared: SharedWorkerState = {}) {
  const origin = 'https://poker.test';
  const handlers = new Map<string, Handler>();
  const stores = shared.stores ?? new Map<string, Map<string, Response>>();
  const database = shared.database ?? updatePolicyDatabase();
  let claims = 0, activations = 0, fetches = 0;
  const background: Promise<unknown>[] = [];
  const update = vi.fn(async () => {});
  const registration: { update: typeof update; active: WorkerReference | null; installing: WorkerReference | null; waiting: WorkerReference | null } = { update, active: null, installing: null, waiting: null };
  const asClient = (client: WorkerClient) => ({
    id: client.id,
    postMessage(data: { type: string; requestId?: string }) {
      (client.messages ??= []).push(data);
      if (data.type === 'CLIENT_RELEASE_REQUEST' && !client.unresponsive) handlers.get('message')?.({ data: { type: 'CLIENT_RELEASE', requestId: data.requestId, release: client.release, updateProtocol: client.updateProtocol === null ? undefined : client.updateProtocol ?? 1 }, source: { id: client.replyId ?? client.id } });
    },
  });
  const matchAll = vi.fn(async () => clients.map(asClient));
  const key = (request: Request | string) => new URL(typeof request === 'string' ? request : request.url, origin).href;
  const caches = {
    open: async (name: string) => {
      let data = stores.get(name);
      if (!data) { data = new Map(); stores.set(name, data); }
      const contents = data;
      return {
        put: async (request: Request | string, response: Response) => { contents.set(key(request), response.clone()); },
        match: async (request: Request | string) => contents.get(key(request))?.clone(),
        keys: async () => [...contents.keys()].map(url => new Request(url)),
        delete: async (request: Request | string) => contents.delete(key(request)),
      };
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
  };
  const context = createContext({
    self: {
      location: { origin },
      navigator: { locks: shared.locks === false ? undefined : database.locks },
      clients: { claim: async () => { claims++; }, matchAll, get: async (id: string) => { const client = clients.find(client => client.id === id); return client ? asClient(client) : undefined; } },
      registration,
      skipWaiting: async () => { activations++; },
      addEventListener: (name: string, handler: Handler) => handlers.set(name, handler),
    },
    caches, indexedDB: database.indexedDB,
    MessageChannel: class {
      port1 = { onmessage: undefined as ((event: { data: unknown }) => void) | undefined, close() {} };
      port2 = { postMessage: (data: unknown) => queueMicrotask(() => this.port1.onmessage?.({ data })) };
    },
    Request: class extends Request { constructor(input: Request | string, init?: RequestInit) { super(typeof input === 'string' ? new URL(input, origin) : input, init); } },
    Response, URL, AbortController,
    fetch: async (request: Request | string, options?: RequestInit) => { fetches++; return fetcher(request, options); },
    setTimeout: (handler: () => void, delay: number) => setTimeout(handler, Math.min(delay, 10)), clearTimeout,
  });
  const source = stamp ? template.replace('__PB_RELEASE__', JSON.stringify(shared.release ?? 'test-release')).replace('__PB_PRECACHE__', JSON.stringify(shared.precache ?? ['/index.html', '/assets/main-test.js'])) : template;
  runInContext(source, context);
  return {
    stores, clients, database, update, registration, matchAll, background: () => Promise.all(background), fetches: () => fetches, claims: () => claims, activations: () => activations,
    async lifecycle(name: string, extra: Record<string, unknown> = {}) {
      const pending: Promise<unknown>[] = [];
      handlers.get(name)?.({ ...extra, waitUntil: (promise: Promise<unknown>) => pending.push(promise) });
      await Promise.all(pending);
    },
    async request(path: string, method = 'GET', navigate = false, clientId = ''): Promise<Response | undefined> {
      const request = new Request(new URL(path, origin), { method });
      if (navigate) Object.defineProperty(request, 'mode', { value: 'navigate' });
      let response: Promise<Response> | undefined;
      handlers.get('fetch')?.({ request, clientId, waitUntil: (promise: Promise<unknown>) => background.push(promise), respondWith: (value: Promise<Response>) => { response = value; } });
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

it('keeps the navigation deadline active while the HTML body stalls after headers', async () => {
  vi.useFakeTimers();
  let aborted = false;
  let body: ReadableStreamDefaultController<Uint8Array> | undefined;
  const instance = worker(async (_request, options) => {
    if (!options?.signal) return new Response('cached shell');
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      body = controller;
      controller.enqueue(new TextEncoder().encode('<!doctype html><html>'));
      options.signal!.addEventListener('abort', () => { aborted = true; controller.error(new Error('aborted')); });
    } }), { headers: { 'content-type': 'text/html' } });
  });
  try {
    await instance.lifecycle('install');
    let result: string | undefined;
    const pending = instance.request('/', 'GET', true).then(response => response!.text()).then(text => { result = text; });
    await vi.advanceTimersByTimeAsync(11);
    expect(result).toBe('cached shell');
    expect(aborted).toBe(true);
    expect(await instance.stores.get('poker-banker-test-release')!.get('https://poker.test/index.html')!.clone().text()).toBe('cached shell');
    await pending;
  } finally {
    if (!aborted) body?.close();
    vi.useRealTimers();
  }
});

it.each([200, 404, 204, 304])('preserves a complete navigation response with status %s without caching it', async status => {
  const bytes = new TextEncoder().encode('<!doctype html><title>Fresh bank €</title>');
  const empty = status === 204 || status === 304;
  const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-navigation': 'unchanged' };
  let signal: AbortSignal | undefined;
  const instance = worker(async (_request, options) => {
    if (!options?.signal) return new Response('cached shell');
    signal = options.signal;
    return new Response(empty ? null : bytes, { status, statusText: 'Navigation outcome', headers });
  });
  await instance.lifecycle('install');
  const response = (await instance.request('/players', 'GET', true))!;
  expect(response.status).toBe(status);
  expect(response.statusText).toBe('Navigation outcome');
  expect(Object.fromEntries(response.headers)).toEqual(headers);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(empty ? new Uint8Array() : bytes);
  expect(signal?.aborted).toBe(false);
  const cache = instance.stores.get('poker-banker-test-release')!;
  expect([...cache.keys()].sort()).toEqual(['https://poker.test/assets/main-test.js', 'https://poker.test/index.html']);
  expect(await cache.get('https://poker.test/index.html')!.clone().text()).toBe('cached shell');
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
  await instance.lifecycle('message', { data: { type: 'ACTIVATE', updateProtocol: 1 } });
  expect(instance.activations()).toBe(1);
  await instance.lifecycle('activate');
  expect(instance.claims()).toBe(1);
  expect([...instance.stores.keys()].sort()).toEqual(['poker-banker-test-release', 'unrelated-cache']);
});

it('retains the releases of every live page and serves an older cached lazy asset after another page activates', async () => {
  const instance = worker(async () => { throw new TypeError('offline'); }, true, [{ id: 'held-old-page', release: 'old' }, { id: 'new-page', release: 'test-release' }]);
  instance.stores.set('poker-banker-test-release', new Map());
  instance.stores.set('poker-banker-old', new Map([['https://poker.test/assets/lazy-old.js', new Response('old lazy module')]]));
  instance.stores.set('poker-banker-unused', new Map());
  await instance.lifecycle('activate');
  expect([...instance.stores.keys()].sort()).toEqual(['poker-banker-old', 'poker-banker-test-release']);
  expect(await (await instance.request('/assets/lazy-old.js', 'GET', false, 'held-old-page'))!.text()).toBe('old lazy module');
  expect(instance.fetches()).toBe(0);
  await instance.background();
  expect(instance.clients[0]!.messages).toContainEqual({ type: 'ASSET_ACCESSED' });
  expect(instance.update).toHaveBeenCalledOnce();
  instance.clients[0]!.release = 'test-release';
  await instance.lifecycle('message', { data: { type: 'CLIENT_RELEASE', release: 'test-release' }, source: { id: 'held-old-page' } });
  expect([...instance.stores.keys()]).toEqual(['poker-banker-test-release']);
});

it.each(['legacy', 'unresponsive', 'unknown-release', 'wrong-client'] as const)('conservatively retains old caches for a %s page', async kind => {
  const instance = worker(undefined, true, [{ id: 'page', release: kind === 'legacy' ? undefined : kind === 'unknown-release' ? 'not-cached' : 'test-release', unresponsive: kind === 'unresponsive', replyId: kind === 'wrong-client' ? 'another-page' : undefined }]);
  instance.stores.set('poker-banker-old', new Map());
  await instance.lifecycle('install');
  await instance.lifecycle('activate');
  expect(instance.stores.has('poker-banker-old')).toBe(true);
  expect(instance.claims()).toBe(1);
});

it('retains caches if a new unqueried page appears before deletion', async () => {
  const instance = worker();
  await instance.lifecycle('install');
  instance.stores.set('poker-banker-old', new Map());
  const matchAll = instance.matchAll.getMockImplementation()!;
  instance.matchAll.mockResolvedValueOnce([]).mockImplementationOnce(async () => {
    instance.clients.push({ id: 'just-opened', unresponsive: true });
    return matchAll();
  });
  await instance.lifecycle('activate');
  expect(instance.stores.has('poker-banker-old')).toBe(true);
});

it.each(['installing', 'waiting'] as const)('does not prune the cache of an %s update', async state => {
  const instance = worker(undefined, true, [{ id: 'page', release: 'test-release' }]);
  await instance.lifecycle('install');
  instance.stores.set('poker-banker-next', new Map());
  instance.registration[state] = {};
  await instance.lifecycle('message', { data: { type: 'CLIENT_RELEASE', release: 'test-release' }, source: { id: 'page' } });
  expect(instance.stores.has('poker-banker-next')).toBe(true);
});

it('checks for a deployment on a precached hashed asset hit and coalesces concurrent asset checks', async () => {
  const instance = worker(undefined, true, [{ id: 'page', release: 'test-release' }]);
  await instance.lifecycle('install');
  let release!: () => void;
  instance.update.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  try {
    const first = instance.request('/assets/main-test.js', 'GET', false, 'page');
    const second = instance.request('/assets/main-test.js', 'GET', false, 'page');
    expect(await (await first)!.text()).toBe('asset');
    expect(await (await second)!.text()).toBe('asset');
    expect(instance.fetches()).toBe(2);
    expect(instance.update).toHaveBeenCalledOnce();
    release();
    await instance.background();
    await instance.request('/assets/main-test.js', 'GET', false, 'page');
    await instance.background();
    expect(instance.update).toHaveBeenCalledTimes(2);
  } finally { release?.(); }
});

it('does not use retained release caches for API data or unhashed files', async () => {
  const instance = worker();
  instance.stores.set('poker-banker-old', new Map([
    ['https://poker.test/api/sessions', new Response('private')],
    ['https://poker.test/notes.txt', new Response('notes')],
  ]));
  expect(await instance.request('/api/sessions')).toBeUndefined();
  expect(await instance.request('/notes.txt')).toBeUndefined();
  expect(instance.update).not.toHaveBeenCalled();
});

const reference = (release: string): WorkerReference => ({ postMessage: (_data, ports) => ports[0]!.postMessage({ version: release }) });

it('bounds fixed unknown-client pins across many waiting deployments and worker restarts', async () => {
  const stores = new Map<string, Map<string, Response>>([
    ['poker-banker-legacy302', new Map()], ['poker-banker-unrelated-old', new Map()], ['poker-banker-unrelated-newer', new Map()],
  ]);
  const database = updatePolicyDatabase();
  const clients: WorkerClient[] = [{ id: 'permanently-suspended', unresponsive: true }];
  let prior: string | null = null;
  let pins: string[] | undefined;
  for (const release of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']) {
    const instance = worker(undefined, true, clients, { stores, database, release });
    instance.registration.active = reference('legacy302');
    instance.registration.waiting = prior ? reference(prior) : null;
    await instance.lifecycle('install');
    pins ??= database.state().clients['permanently-suspended']!.pins;
    expect(database.state().clients['permanently-suspended']!.pins).toEqual(pins);
    expect(pins).toHaveLength(2);
    expect(pins![0]).toBe('poker-banker-legacy302');
    expect(stores.has('poker-banker-legacy302')).toBe(true);
    expect(stores.has(`poker-banker-${release}`)).toBe(true);
    if (prior) expect(stores.has(`poker-banker-${prior}`)).toBe(true);
    expect(stores.size).toBeLessThanOrEqual(4);
    expect(stores.has('poker-banker-unrelated-old')).toBe(false);
    prior = release;
  }
  expect(stores.has('poker-banker-B')).toBe(false);
  expect(stores.has('poker-banker-C')).toBe(false);
  expect(stores.has('poker-banker-D')).toBe(false);
});

it('bounds entries and bytes inside a pinned legacy cache while preserving original and live release assets', async () => {
  const original = ['https://poker.test/index.html', 'https://poker.test/assets/main-legacy.js', 'https://poker.test/assets/lazy-legacy.js', 'https://poker.test/unknown-before-migration.bin'];
  const legacy = new Map(original.map(url => [url, new Response('legacy bytes')]));
  const stores = new Map([['poker-banker-legacy302', legacy]]);
  const database = updatePolicyDatabase({ clients: {}, releases: { legacy302: 1 }, generation: 1 });
  const clients: WorkerClient[] = [{ id: 'legacy', unresponsive: true }, { id: 'live-B', release: 'B' }];
  let prior: string | null = null;
  let latest!: ReturnType<typeof worker>;
  let inventory: string[] | undefined;
  for (const release of ['B', 'C', 'D', 'E', 'F', 'G', 'H']) {
    const precache = ['/index.html', `/assets/main-${release}.js`, `/assets/lazy-${release}.js`];
    latest = worker(undefined, true, clients, { stores, database, release, precache });
    latest.registration.active = reference('legacy302');
    latest.registration.waiting = prior ? reference(prior) : null;
    await latest.lifecycle('install');
    inventory ??= database.state().inventories?.['poker-banker-legacy302'];
    expect(database.state().inventories?.['poker-banker-legacy302']).toEqual(inventory);
    expect(inventory?.slice().sort()).toEqual(original.slice().sort());
    for (const path of precache.filter(path => path.startsWith('/assets/'))) legacy.set(`https://poker.test${path}`, new Response('asset'));
    for (const url of original) expect(await legacy.get(url)?.clone().text()).toBe('legacy bytes');
    expect(legacy.has('https://poker.test/assets/lazy-B.js')).toBe(true);
    expect(legacy.size).toBeLessThanOrEqual(original.length + 6);
    const bytes = await Promise.all([...legacy.values()].map(async response => (await response.clone().arrayBuffer()).byteLength));
    expect(bytes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(original.length * 12 + 6 * 5);
    prior = release;
  }
  expect([...legacy.keys()].sort()).toEqual([...original, ...['B', 'G', 'H'].flatMap(release => [`https://poker.test/assets/main-${release}.js`, `https://poker.test/assets/lazy-${release}.js`])].sort());
  expect(Object.keys(database.state().manifests ?? {}).sort()).toEqual(['B', 'G', 'H']);
  legacy.set('https://poker.test/assets/lazy-C.js', new Response('late obsolete write'));
  await latest.lifecycle('message', { data: { type: 'CLIENT_RELEASE' }, source: { id: 'live-B' } });
  expect(legacy.has('https://poker.test/assets/lazy-C.js')).toBe(false);
  expect(database.state().inventories?.['poker-banker-legacy302']).toEqual(inventory);
  expect(await (await latest.request('/assets/lazy-legacy.js'))!.text()).toBe('legacy bytes');
  clients.splice(0, clients.length);
  latest.registration.active = reference('H');
  latest.registration.waiting = null;
  await latest.lifecycle('activate');
  expect([...stores.keys()]).toEqual(['poker-banker-H']);
  expect(database.state().inventories).toEqual({});
  expect(Object.keys(database.state().manifests ?? {})).toEqual(['H']);
  expect(Object.keys(database.state().releases)).toEqual(['H']);
});

it('does not cache another release’s network assets or queried variants into its own cache', async () => {
  const instance = worker();
  await instance.lifecycle('install');
  for (const path of ['/assets/main-next.js', '/assets/main-test.js?variant=1']) {
    await instance.request(path);
    await instance.request(path);
  }
  expect(instance.fetches()).toBe(6);
  expect([...instance.stores.get('poker-banker-test-release')!.keys()].sort()).toEqual(['https://poker.test/assets/main-test.js', 'https://poker.test/index.html']);
  instance.stores.get('poker-banker-test-release')!.delete('https://poker.test/assets/main-test.js');
  await instance.request('/assets/main-test.js');
  await instance.request('/assets/main-test.js');
  expect(instance.fetches()).toBe(7);
});

it('clears fallback pins only after an identified document release has a cache', async () => {
  const clients: WorkerClient[] = [{ id: 'initially-unknown', unresponsive: true }];
  const first = worker(undefined, true, clients, { release: 'B' });
  first.stores.set('poker-banker-legacy302', new Map([['https://poker.test/assets/lazy-legacy.js', new Response('legacy')]]));
  first.registration.active = reference('legacy302');
  await first.lifecycle('install');
  expect(first.database.state().clients['initially-unknown']!.pins).toContain('poker-banker-legacy302');
  clients[0]!.unresponsive = false;
  clients[0]!.release = 'C';
  await first.lifecycle('message', { data: { type: 'CLIENT_RELEASE' }, source: { id: 'initially-unknown' } });
  expect(first.database.state().clients['initially-unknown']!.pins).toContain('poker-banker-legacy302');
  const second = worker(undefined, true, clients, { stores: first.stores, database: first.database, release: 'C' });
  second.registration.active = reference('B');
  await second.lifecycle('install');
  expect(first.database.state().clients['initially-unknown']!.pins).toBeUndefined();
  expect(first.database.state().clients['initially-unknown']!.fallback).toBeUndefined();
  expect(first.stores.has('poker-banker-legacy302')).toBe(false);
  expect(first.database.state().inventories?.['poker-banker-legacy302']).toBeUndefined();
});

it.each(['before-install', 'after-failure'] as const)('preserves a failed installation manifest independently of caches for a document arriving %s', async arrival => {
  const origin = 'https://poker.test';
  const original = ['/index.html', '/assets/main-legacy.js', '/assets/lazy-legacy.js', '/original.bin'].map(path => `${origin}${path}`);
  const legacy = new Map(original.map(url => [url, new Response('legacy bytes')]));
  const stores = new Map([['poker-banker-legacy302', legacy]]);
  const database = updatePolicyDatabase();
  const clients: WorkerClient[] = [{ id: 'legacy', unresponsive: true }];
  const seed = worker(undefined, true, clients, { stores, database, release: 'seed' });
  seed.registration.active = reference('legacy302');
  await seed.lifecycle('install');
  const manifest = ['/index.html', '/assets/main-B.js', '/assets/lazy-B.js', '/assets/fail-B.js'];
  const liveB = { id: 'live-B', release: 'B' };
  if (arrival === 'before-install') clients.push(liveB);
  const failed = worker(async request => {
    expect(database.state().manifests?.B).toEqual(manifest);
    if (new URL(typeof request === 'string' ? request : request.url, origin).pathname === '/assets/fail-B.js') throw new Error('B precache failed');
    return new Response('asset');
  }, true, clients, { stores, database, release: 'B', precache: manifest });
  failed.registration.active = reference('legacy302');
  await expect(failed.lifecycle('install')).rejects.toThrow('B precache failed');
  expect(stores.has('poker-banker-B')).toBe(false);
  expect(database.state().manifests?.B).toEqual(manifest);
  if (arrival === 'after-failure') clients.push(liveB);
  for (const path of manifest.slice(1, 3)) legacy.set(`${origin}${path}`, new Response('B document bytes'));
  let prior = 'seed';
  let latest = seed;
  const measurements: { keys: string[]; bytes: number }[] = [];
  for (const release of ['C', 'D', 'E', 'F', 'G', 'H', 'I']) {
    const precache = ['/index.html', `/assets/main-${release}.js`, `/assets/lazy-${release}.js`];
    for (const path of precache.slice(1)) legacy.set(`${origin}${path}`, new Response('asset'));
    latest = worker(undefined, true, clients, { stores, database, release, precache });
    latest.registration.active = reference('legacy302');
    latest.registration.waiting = reference(prior);
    await latest.lifecycle('install');
    const retainedAssets = ['B', ...(prior === 'seed' ? [] : [prior]), release].flatMap(version => [`${origin}/assets/main-${version}.js`, `${origin}/assets/lazy-${version}.js`]);
    const expected = [...original, ...retainedAssets].sort();
    expect([...legacy.keys()].sort()).toEqual(expected);
    for (const [name, cache] of stores) {
      const keys = [...cache.keys()].sort();
      const bytes = (await Promise.all([...cache.values()].map(async response => (await response.clone().arrayBuffer()).byteLength))).reduce((sum, size) => sum + size, 0);
      if (name === 'poker-banker-legacy302') {
        measurements.push({ keys, bytes });
        expect(bytes).toBe(original.length * 12 + 2 * 16 + (prior === 'seed' ? 2 : 4) * 5);
      } else {
        const cacheManifest = database.state().manifests?.[name.slice(13)]!;
        expect(keys).toEqual(cacheManifest.map(path => `${origin}${path}`).sort());
        expect(bytes).toBe(cacheManifest.length * 5);
      }
    }
    for (const url of original) expect(await legacy.get(url)!.clone().text()).toBe('legacy bytes');
    for (const path of manifest.slice(1, 3)) expect(await legacy.get(`${origin}${path}`)!.clone().text()).toBe('B document bytes');
    expect(database.state().manifests?.B).toEqual(manifest);
    expect(stores.has('poker-banker-B')).toBe(false);
    expect(Object.keys(database.state().manifests ?? {}).length).toBeLessThanOrEqual(4);
    expect(stores.size).toBeLessThanOrEqual(4);
    prior = release;
  }
  expect(new Set(measurements.slice(1).map(value => value.bytes)).size).toBe(1);
  expect(new Set(measurements.slice(1).map(value => value.keys.length)).size).toBe(1);
  expect(await (await latest.request('/assets/lazy-B.js'))!.text()).toBe('B document bytes');
  clients.splice(clients.findIndex(client => client.id === 'live-B'), 1);
  await latest.lifecycle('message', { data: { type: 'CLIENT_RELEASE' }, source: { id: 'legacy' } });
  expect(database.state().manifests?.B).toBeUndefined();
  expect(legacy.has(`${origin}/assets/main-B.js`)).toBe(false);
  expect(legacy.has(`${origin}/assets/lazy-B.js`)).toBe(false);
  for (const url of original) expect(await legacy.get(url)!.clone().text()).toBe('legacy bytes');
});

it('bounds legacy entries, bytes and manifest metadata when every later installation also fails', async () => {
  const origin = 'https://poker.test';
  const original = `${origin}/assets/lazy-legacy.js`;
  const legacy = new Map([[original, new Response('legacy bytes')]]);
  const stores = new Map([['poker-banker-legacy302', legacy]]);
  const database = updatePolicyDatabase();
  const clients: WorkerClient[] = [{ id: 'legacy', unresponsive: true }];
  const seed = worker(undefined, true, clients, { stores, database, release: 'seed' });
  seed.registration.active = reference('legacy302');
  await seed.lifecycle('install');
  clients.push({ id: 'live-B', release: 'B' });
  for (const release of ['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']) {
    const precache = ['/index.html', `/assets/main-${release}.js`, `/assets/lazy-${release}.js`, `/assets/fail-${release}.js`];
    for (const path of precache.slice(1, 3)) legacy.set(`${origin}${path}`, new Response(release === 'B' ? 'B document bytes' : 'asset'));
    const instance = worker(async request => {
      if (new URL(typeof request === 'string' ? request : request.url, origin).pathname === `/assets/fail-${release}.js`) throw new Error(`precache ${release} failed`);
      return new Response('asset');
    }, true, clients, { stores, database, release, precache });
    instance.registration.active = reference('legacy302');
    instance.registration.waiting = reference('seed');
    await expect(instance.lifecycle('install')).rejects.toThrow(`precache ${release} failed`);
    expect([...stores.keys()].sort()).toEqual(['poker-banker-legacy302', 'poker-banker-seed']);
    const allowed = [original, ...[...new Set(['B', release])].flatMap(version => [`${origin}/assets/main-${version}.js`, `${origin}/assets/lazy-${version}.js`])].sort();
    expect([...legacy.keys()].sort()).toEqual(allowed);
    const bytes = (await Promise.all([...legacy.values()].map(async response => (await response.clone().arrayBuffer()).byteLength))).reduce((sum, size) => sum + size, 0);
    expect(bytes).toBe(12 + 2 * 16 + (release === 'B' ? 0 : 2 * 5));
    expect(Object.keys(database.state().manifests ?? {}).sort()).toEqual([...new Set(['seed', 'B', release])].sort());
    expect(Object.keys(database.state().releases).sort()).toEqual([...new Set(['seed', 'B', release])].sort());
    expect(database.state().manifests?.B).toEqual(['/index.html', '/assets/main-B.js', '/assets/lazy-B.js', '/assets/fail-B.js']);
    expect(await legacy.get(original)!.clone().text()).toBe('legacy bytes');
    expect(await legacy.get(`${origin}/assets/lazy-B.js`)!.clone().text()).toBe('B document bytes');
  }
});

it('preserves the original installation failure if its cleanup also fails', async () => {
  const instance = worker(async () => { throw new Error('original precache failure'); });
  instance.matchAll.mockRejectedValueOnce(new Error('cleanup client listing failed'));
  await expect(instance.lifecycle('install')).rejects.toThrow('original precache failure');
  expect(instance.stores.has('poker-banker-test-release')).toBe(false);
  expect(instance.database.state().manifests?.['test-release']).toEqual(['/index.html', '/assets/main-test.js']);
});

it('preserves an absent-cache manifest when its document first appears in the second client snapshot', async () => {
  const original = 'https://poker.test/assets/main-legacy.js';
  const lazyB = 'https://poker.test/assets/lazy-B.js';
  const manifest = ['/index.html', '/assets/lazy-B.js'];
  const legacy = new Map([[original, new Response('original')], [lazyB, new Response('live B lazy module')]]);
  const stores = new Map([['poker-banker-legacy302', legacy]]);
  const database = updatePolicyDatabase({ clients: {}, releases: { B: 1 }, generation: 1, manifests: { B: manifest }, inventories: { 'poker-banker-legacy302': [original] } });
  const clients: WorkerClient[] = [{ id: 'legacy', unresponsive: true }];
  const instance = worker(undefined, true, clients, { stores, database, release: 'C' });
  instance.registration.active = reference('legacy302');
  const matchAll = instance.matchAll.getMockImplementation()!;
  instance.matchAll.mockImplementationOnce(async () => {
    const queried = await matchAll();
    clients.push({ id: 'new-B', release: 'B' });
    return queried;
  });
  await instance.lifecycle('install');
  expect(database.state().clients['new-B']!.release).toBe('B');
  expect(database.state().manifests?.B).toEqual(manifest);
  expect(stores.has('poker-banker-B')).toBe(false);
  expect(await legacy.get(original)!.clone().text()).toBe('original');
  expect(await legacy.get(lazyB)!.clone().text()).toBe('live B lazy module');
  clients.splice(1, 1);
  await instance.lifecycle('activate');
  expect(database.state().manifests?.B).toBeUndefined();
  expect(legacy.has(lazyB)).toBe(false);
});

it('gives clients arriving during the newcomer query a fixed fallback without stopping entry pruning', async () => {
  const original = 'https://poker.test/assets/main-legacy.js';
  const lazyB = 'https://poker.test/assets/lazy-B.js';
  const obsolete = 'https://poker.test/assets/obsolete-extra.js';
  const legacy = new Map([[original, new Response('original')], [lazyB, new Response('live B lazy module')]]);
  const stores = new Map([['poker-banker-legacy302', legacy]]);
  const database = updatePolicyDatabase({ clients: {}, releases: {}, generation: 0, inventories: { 'poker-banker-legacy302': [original] } });
  const instance = worker(undefined, true, [], { stores, database, release: 'C' });
  instance.registration.active = reference('legacy302');
  const matchAll = instance.matchAll.getMockImplementation()!;
  instance.matchAll.mockResolvedValueOnce([]).mockImplementationOnce(async () => {
    instance.clients.push({ id: 'first-newcomer', unresponsive: true });
    return matchAll();
  }).mockImplementationOnce(async () => {
    instance.clients.push({ id: 'later-B', release: 'B' });
    return matchAll();
  });
  await instance.lifecycle('install');
  const fallback = database.state().clients['later-B']!.fallback;
  expect(fallback).toContain(lazyB);
  legacy.set(obsolete, new Response('obsolete'));
  await instance.lifecycle('activate');
  expect(database.state().clients['later-B']!.release).toBe('B');
  expect(database.state().clients['later-B']!.fallback).toEqual(fallback);
  expect(legacy.has(obsolete)).toBe(false);
  expect(await legacy.get(lazyB)!.clone().text()).toBe('live B lazy module');
});

it('bounds missing-manifest fallback assets without disabling pruning or expanding the first snapshot', async () => {
  const original = 'https://poker.test/assets/main-legacy.js';
  const liveAsset = 'https://poker.test/assets/lazy-B.js';
  const firstUnknown = 'https://poker.test/assets/first-unknown.js';
  const legacy = new Map([[original, new Response('original')], [liveAsset, new Response('live B lazy module')], [firstUnknown, new Response('first unknown')]]);
  const stores = new Map([['poker-banker-legacy302', legacy]]);
  const database = updatePolicyDatabase({ clients: {}, releases: {}, generation: 0, inventories: { 'poker-banker-legacy302': [original] } });
  const clients: WorkerClient[] = [{ id: 'missing-B', release: 'B' }];
  let prior: string | null = null;
  let latest!: ReturnType<typeof worker>;
  let fallback: string[] | undefined;
  let plateau: number | undefined;
  for (const release of ['C', 'D', 'E', 'F', 'G', 'H', 'I']) {
    const precache = ['/index.html', `/assets/main-${release}.js`];
    latest = worker(undefined, true, clients, { stores, database, release, precache });
    latest.registration.active = reference('legacy302');
    latest.registration.waiting = prior ? reference(prior) : null;
    await latest.lifecycle('install');
    fallback ??= database.state().clients['missing-B']!.fallback;
    expect(fallback).toEqual(expect.arrayContaining([original, liveAsset, firstUnknown]));
    expect(database.state().clients['missing-B']!.fallback).toEqual(fallback);
    expect(database.state().inventories?.['poker-banker-legacy302']).toEqual([original]);
    const obsolete = `https://poker.test/assets/obsolete-${release}.js`;
    legacy.set(obsolete, new Response('must be collected'));
    await latest.lifecycle('message', { data: { type: 'CLIENT_RELEASE' }, source: { id: 'missing-B' } });
    expect(legacy.has(obsolete)).toBe(false);
    expect([...legacy.keys()].sort()).toEqual([original, liveAsset, firstUnknown].sort());
    const bytes = (await Promise.all([...legacy.values()].map(async response => (await response.clone().arrayBuffer()).byteLength))).reduce((sum, size) => sum + size, 0);
    plateau ??= bytes;
    expect(bytes).toBe(plateau);
    expect(await legacy.get(original)!.clone().text()).toBe('original');
    expect(await legacy.get(liveAsset)!.clone().text()).toBe('live B lazy module');
    expect(stores.has('poker-banker-B')).toBe(false);
    expect(stores.size).toBeLessThanOrEqual(4);
    expect(Object.keys(database.state().manifests ?? {}).length).toBeLessThanOrEqual(3);
    prior = release;
  }
  clients.splice(0, 1);
  latest.registration.waiting = null;
  await latest.lifecycle('activate');
  expect(database.state().clients).toEqual({});
  expect([...legacy.keys()]).toEqual([original]);
  expect(Object.keys(database.state().manifests ?? {})).toEqual(['I']);
});

it('preserves a shared chunk from any retained manifest after its original release closes', async () => {
  const stores = new Map([['poker-banker-legacy302', new Map([['https://poker.test/assets/main-legacy.js', new Response('legacy')]])]]);
  const database = updatePolicyDatabase();
  const clients: WorkerClient[] = [{ id: 'legacy', release: 'legacy302', updateProtocol: null }, { id: 'shared-reader', release: 'B' }];
  const first = worker(undefined, true, clients, { stores, database, release: 'B', precache: ['/index.html', '/assets/shared-chunk.js'] });
  first.registration.active = reference('legacy302');
  await first.lifecycle('install');
  stores.get('poker-banker-legacy302')!.set('https://poker.test/assets/shared-chunk.js', new Response('shared'));
  clients[1]!.release = 'C';
  const second = worker(undefined, true, clients, { stores, database, release: 'C', precache: ['/index.html', '/assets/shared-chunk.js'] });
  second.registration.active = reference('legacy302');
  await second.lifecycle('install');
  expect(stores.has('poker-banker-B')).toBe(false);
  expect(await stores.get('poker-banker-legacy302')!.get('https://poker.test/assets/shared-chunk.js')!.clone().text()).toBe('shared');
  clients.splice(0, 1);
  second.registration.active = reference('C');
  await second.lifecycle('activate');
  expect(stores.has('poker-banker-B')).toBe(false);
  expect(await (await second.request('/assets/shared-chunk.js'))!.text()).toBe('asset');
  expect(Object.keys(database.state().manifests ?? {})).toEqual(['C']);
});

it('preserves every known open document release and releases its cache and metadata after it closes', async () => {
  const clients: WorkerClient[] = ['A', 'B', 'C'].map(release => ({ id: `page-${release}`, release }));
  const instance = worker(undefined, true, clients, { release: 'D' });
  for (const release of ['A', 'B', 'C', 'unrelated']) instance.stores.set(`poker-banker-${release}`, new Map());
  await instance.lifecycle('install');
  expect([...instance.stores.keys()].sort()).toEqual(['poker-banker-A', 'poker-banker-B', 'poker-banker-C', 'poker-banker-D']);
  clients.splice(1, 1);
  await instance.lifecycle('message', { data: { type: 'CLIENT_RELEASE' }, source: { id: 'page-A' } });
  expect([...instance.stores.keys()].sort()).toEqual(['poker-banker-A', 'poker-banker-C', 'poker-banker-D']);
  expect(databaseClientIds(instance)).toEqual(['page-A', 'page-C']);
});

function databaseClientIds(instance: ReturnType<typeof worker>) { return Object.keys(instance.database.state().clients).sort(); }

it('retains active and waiting worker releases while pruning an abandoned install candidate', async () => {
  const instance = worker(undefined, true, [], { release: 'current-install' });
  for (const release of ['active', 'waiting', 'abandoned']) instance.stores.set(`poker-banker-${release}`, new Map());
  instance.registration.active = reference('active');
  instance.registration.waiting = reference('waiting');
  await instance.lifecycle('install');
  expect([...instance.stores.keys()].sort()).toEqual(['poker-banker-active', 'poker-banker-current-install', 'poker-banker-waiting']);
});

it('serializes simultaneous installers and keeps the first unknown pins immutable', async () => {
  const stores = new Map<string, Map<string, Response>>([['poker-banker-active', new Map()]]);
  const database = updatePolicyDatabase();
  const clients: WorkerClient[] = [{ id: 'unknown', unresponsive: true }];
  const first = worker(undefined, true, clients, { stores, database, release: 'B' });
  const second = worker(undefined, true, clients, { stores, database, release: 'C' });
  first.registration.active = second.registration.active = reference('active');
  second.registration.waiting = reference('B');
  await Promise.all([first.lifecycle('install'), second.lifecycle('install')]);
  expect(database.state().clients.unknown!.pins).toEqual(['poker-banker-active', 'poker-banker-B']);
  expect([...stores.keys()].sort()).toEqual(['poker-banker-B', 'poker-banker-C', 'poker-banker-active']);
});

it('fails a new candidate closed when update policy cannot be persisted', async () => {
  const database = updatePolicyDatabase();
  database.fail();
  const instance = worker(undefined, true, [], { database });
  instance.stores.set('poker-banker-active', new Map());
  await expect(instance.lifecycle('install')).rejects.toThrow('Update policy unavailable');
  expect([...instance.stores.keys()]).toEqual(['poker-banker-active']);
});

it('fails installation and activation closed without cross-worker locking', async () => {
  const instance = worker(undefined, true, [], { locks: false });
  instance.stores.set('poker-banker-active', new Map());
  await expect(instance.lifecycle('install')).rejects.toThrow();
  await expect(instance.lifecycle('message', { data: { type: 'ACTIVATE', updateProtocol: 1 } })).rejects.toThrow();
  expect(instance.activations()).toBe(0);
  expect([...instance.stores.keys()]).toEqual(['poker-banker-active']);
});

it.each([undefined, 1])('denies legacy-client activation even when ACTIVATE claims protocol %s', async updateProtocol => {
  const instance = worker(undefined, true, [{ id: 'legacy302', release: 'old', updateProtocol: null }, { id: 'new-page', release: 'test-release' }]);
  instance.stores.set('poker-banker-old', new Map());
  await instance.lifecycle('install');
  await instance.lifecycle('message', { data: { type: 'ACTIVATE', updateProtocol }, source: { id: 'legacy302' } });
  expect(instance.activations()).toBe(0);
  instance.clients.splice(0, 1);
  await instance.lifecycle('message', { data: { type: 'ACTIVATE', updateProtocol: 1 }, source: { id: 'new-page' } });
  expect(instance.activations()).toBe(1);
});

it('does not trust an unsolicited capability announcement or another client’s correlated reply', async () => {
  const instance = worker(undefined, true, [{ id: 'unknown', release: 'test-release', unresponsive: true }, { id: 'wrong-source', release: 'test-release', replyId: 'unknown' }]);
  await instance.lifecycle('install');
  await instance.lifecycle('message', { data: { type: 'CLIENT_RELEASE', release: 'test-release', updateProtocol: 1 }, source: { id: 'unknown' } });
  await instance.lifecycle('message', { data: { type: 'ACTIVATE', updateProtocol: 1 }, source: { id: 'unknown' } });
  expect(instance.activations()).toBe(0);
  expect(instance.database.state().clients.unknown!.updateProtocol).toBeUndefined();
});

it('keeps authenticated protocol capability across suspension and worker restarts', async () => {
  const clients: WorkerClient[] = [{ id: 'guarded-page', release: 'A' }];
  const first = worker(undefined, true, clients, { release: 'A' });
  await first.lifecycle('install');
  clients[0]!.unresponsive = true;
  const second = worker(undefined, true, clients, { release: 'B', stores: first.stores, database: first.database });
  second.registration.active = reference('A');
  await second.lifecycle('install');
  await second.lifecycle('message', { data: { type: 'ACTIVATE', updateProtocol: 1 } });
  expect(second.activations()).toBe(1);
  expect(second.stores.has('poker-banker-A')).toBe(true);
});

it('preserves bootstrap release but denies activation until the app has attached its protocol guard', async () => {
  const instance = worker(undefined, true, [{ id: 'bootstrap-before-main-bundle', release: 'old', updateProtocol: 0 }]);
  instance.stores.set('poker-banker-old', new Map());
  await instance.lifecycle('install');
  await instance.lifecycle('message', { data: { type: 'ACTIVATE', updateProtocol: 1 } });
  expect(instance.activations()).toBe(0);
  expect(instance.stores.has('poker-banker-old')).toBe(true);
  expect(instance.database.state().clients['bootstrap-before-main-bundle']!.updateProtocol).toBeUndefined();
  instance.clients[0]!.updateProtocol = 1;
  await instance.lifecycle('message', { data: { type: 'ACTIVATE', updateProtocol: 1 } });
  expect(instance.activations()).toBe(1);
});
