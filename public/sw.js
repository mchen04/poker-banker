const RELEASE = __PB_RELEASE__;
const PRECACHE = __PB_PRECACHE__;
if (typeof RELEASE !== 'string' || !RELEASE || !Array.isArray(PRECACHE) || !PRECACHE.includes('/index.html')) throw new Error('Worker release and precache stamps are required');
const CACHE = `poker-banker-${RELEASE}`;

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
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith('poker-banker-') && key !== CACHE).map(key => caches.delete(key)));
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
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (cacheable(response)) await cache.put(request, response.clone());
      return response;
    })());
  }
});
