const RELEASE = __PB_RELEASE__;
const PRECACHE = __PB_PRECACHE__;
if (typeof RELEASE !== 'string' || !RELEASE || !Array.isArray(PRECACHE) || !PRECACHE.includes('/index.html')) throw new Error('Worker release and precache stamps are required');
const CACHE = `poker-banker-${RELEASE}`;
const releaseRequests = new Map();
let releaseRequest = 0;
let cleaning = Promise.resolve();
let checking;

function clientRelease(client) {
  return new Promise(resolve => {
    const requestId = `${RELEASE}:${++releaseRequest}`;
    const finish = release => {
      clearTimeout(timeout);
      releaseRequests.delete(requestId);
      resolve(release);
    };
    const timeout = setTimeout(() => finish(null), 1000);
    releaseRequests.set(requestId, { clientId: client.id, finish });
    try { client.postMessage({ type: 'CLIENT_RELEASE_REQUEST', requestId }); }
    catch { finish(null); }
  });
}

function cleanCaches() {
  cleaning = cleaning.catch(() => {}).then(async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const releases = await Promise.all(clients.map(clientRelease));
    const keys = await caches.keys();
    if (releases.some(release => typeof release !== 'string' || !keys.includes(`poker-banker-${release}`))) return;
    const live = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (live.some(client => !clients.some(known => known.id === client.id))) return;
    if (self.registration.installing || self.registration.waiting) return;
    const retained = new Set([CACHE, ...releases.map(release => `poker-banker-${release}`)]);
    await Promise.all(keys.filter(key => key.startsWith('poker-banker-') && !retained.has(key)).map(key => caches.delete(key)));
  });
  return cleaning;
}

function checkUpdate(clientId) {
  if (checking) return checking;
  checking = Promise.resolve().then(async () => {
    try {
      const client = clientId ? await self.clients.get(clientId) : null;
      client?.postMessage({ type: 'ASSET_ACCESSED' });
      await self.registration.update();
    } catch {}
  }).finally(() => { checking = undefined; });
  return checking;
}

function cacheable(response) {
  const control = response.headers.get('cache-control') || '';
  return response.ok && !response.headers.has('set-cookie') && !/no-store|private/i.test(control);
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    for (const path of PRECACHE) {
      const response = await fetch(new Request(path, { cache: 'reload', credentials: 'omit' }));
      if (!cacheable(response)) throw new Error(`Cannot precache ${path}`);
      await cache.put(path, response);
    }
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    await self.clients.claim();
    await cleanCaches();
  })());
});

self.addEventListener('message', event => {
  const data = event.data;
  if (!data || typeof data.type !== 'string') return;
  if (data.type === 'VERSION' || data.type === 'GET_VERSION') {
    event.ports[0]?.postMessage({ version: RELEASE });
    return;
  }
  if (data.type === 'ACTIVATE') event.waitUntil(self.skipWaiting());
  if (data.type === 'CLIENT_RELEASE' && event.source?.id) {
    if (data.requestId) {
      const pending = releaseRequests.get(data.requestId);
      if (pending?.clientId === event.source.id) pending.finish(data.release);
    } else event.waitUntil(cleanCaches());
  }
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname === '/api' || url.pathname.startsWith('/api/')) return;
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      try {
        const response = await fetch(request, { signal: controller.signal });
        await response.clone().arrayBuffer();
        clearTimeout(timeout);
        return response;
      } catch {
        clearTimeout(timeout);
        return (await cache.match('/index.html')) || Response.error();
      }
    })());
    return;
  }
  if (/^\/assets\/[^/]+-[^/]+\.(?:js|css)$/.test(url.pathname)) {
    event.waitUntil(checkUpdate(event.clientId));
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(request);
      if (cached) return cached;
      for (const key of await caches.keys()) {
        if (!key.startsWith('poker-banker-') || key === CACHE) continue;
        const retained = await (await caches.open(key)).match(request);
        if (retained) return retained;
      }
      const response = await fetch(request);
      if (cacheable(response)) await cache.put(request, response.clone());
      return response;
    })());
  }
});
