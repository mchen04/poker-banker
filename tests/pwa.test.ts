import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { updatePolicyDatabase } from './helpers/update-policy';

const template = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
type Handler = (event: Record<string, unknown>) => void;
type WorkerFetch = (request: Request | string, options?: RequestInit) => Promise<Response>;
type WorkerClient = { id: string; release?: string; updateProtocol?: number | null; unresponsive?: boolean; replyId?: string; messages?: unknown[] };
type WorkerReference = { postMessage?: (data: unknown, ports: { postMessage: (data: unknown) => void }[]) => void };
type SharedWorkerState = { stores?: Map<string, Map<string, Response>>; database?: ReturnType<typeof updatePolicyDatabase>; release?: string; locks?: boolean };

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
  const source = stamp ? template.replace('__PB_RELEASE__', JSON.stringify(shared.release ?? 'test-release')).replace('__PB_PRECACHE__', '["/index.html","/assets/main-test.js"]') : template;
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
  instance.matchAll.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'just-opened', postMessage() {} }]);
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
