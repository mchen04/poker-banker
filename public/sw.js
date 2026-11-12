const RELEASE = __PB_RELEASE__;
const PRECACHE = __PB_PRECACHE__;
if (typeof RELEASE !== 'string' || !RELEASE || !Array.isArray(PRECACHE) || !PRECACHE.includes('/index.html')) throw new Error('Worker release and precache stamps are required');
const CACHE = `poker-banker-${RELEASE}`;
const RELEASE_URLS = new Set(PRECACHE.map(path => new URL(path, self.location.origin).href));
const UPDATE_PROTOCOL = 1;
const MAX_UNKNOWN_RELEASES = 2;
const releaseRequests = new Map();
let releaseRequest = 0;
let cleaning = Promise.resolve();
let checking;
let policyDatabase;

function policy(change) {
  policyDatabase ||= new Promise((resolve, reject) => {
    const request = indexedDB.open('poker-banker-updates', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('policy');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return policyDatabase.then(database => new Promise((resolve, reject) => {
    const transaction = database.transaction('policy', 'readwrite');
    const store = transaction.objectStore('policy');
    const request = store.get('state');
    let result;
    request.onsuccess = () => {
      const state = request.result || { clients: {}, releases: {}, generation: 0 };
      result = change(state);
      store.put(state, 'state');
    };
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('Update policy transaction aborted'));
  }));
}

function workerRelease(worker) {
  if (!worker) return Promise.resolve(null);
  return new Promise(resolve => {
    const channel = new MessageChannel();
    const finish = release => {
      clearTimeout(timeout);
      channel.port1.close();
      resolve(typeof release === 'string' && release ? release : null);
    };
    const timeout = setTimeout(() => finish(null), 1000);
    channel.port1.onmessage = event => finish(event.data?.version);
    try { worker.postMessage({ type: 'GET_VERSION' }, [channel.port2]); }
    catch { finish(null); }
  });
}

function clientRelease(client) {
  return new Promise(resolve => {
    const requestId = `${RELEASE}:${++releaseRequest}`;
    const finish = reply => {
      clearTimeout(timeout);
      releaseRequests.delete(requestId);
      resolve(reply);
    };
    const timeout = setTimeout(() => finish(null), 1000);
    releaseRequests.set(requestId, { clientId: client.id, finish });
    try { client.postMessage({ type: 'CLIENT_RELEASE_REQUEST', requestId }); }
    catch { finish(null); }
  });
}

async function pruneCaches(installing = false) {
  const generation = await policy(state => state.generation);
  const workers = [self.registration.active, self.registration.waiting, self.registration.installing];
  const versions = await Promise.all(workers.map((worker, index) => installing && index === 2 && worker ? RELEASE : workerRelease(worker)));
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const replies = await Promise.all(clients.map(clientRelease));
  const keys = (await caches.keys()).filter(key => key.startsWith('poker-banker-'));
  const known = await policy(state => ({ manifests: state.manifests || {}, inventories: state.inventories || {} }));
  const observed = await Promise.all(keys.filter(key => !known.manifests[key.slice(13)] && !known.inventories[key]).map(async key => [key, (await (await caches.open(key)).keys()).map(request => request.url)]));
  const live = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const state = await policy(state => {
    state.manifests ||= {};
    state.inventories ||= {};
    for (const [key, urls] of observed) if (!state.manifests[key.slice(13)]) state.inventories[key] ||= urls;
    const candidates = keys.filter(key => key !== CACHE).sort((a, b) => (state.releases[b.slice(13)] || 0) - (state.releases[a.slice(13)] || 0) || keys.indexOf(b) - keys.indexOf(a));
    const active = versions[0] && `poker-banker-${versions[0]}`;
    const pins = [...new Set([active, ...candidates, CACHE].filter(key => key && keys.includes(key)))].slice(0, MAX_UNKNOWN_RELEASES);
    for (const id of Object.keys(state.clients)) if (!live.some(client => client.id === id)) delete state.clients[id];
    for (const client of live) {
      const reply = replies[clients.findIndex(queried => queried.id === client.id)];
      const record = state.clients[client.id] ||= {};
      if (typeof reply?.release === 'string' && reply.release) record.release = reply.release;
      if (reply?.updateProtocol === UPDATE_PROTOCOL) record.updateProtocol = UPDATE_PROTOCOL;
      if (!record.release || !keys.includes(`poker-banker-${record.release}`)) record.pins ||= pins;
      else delete record.pins;
    }
    for (const release of Object.keys(state.releases)) if (!keys.includes(`poker-banker-${release}`) && state.releases[release] <= generation) delete state.releases[release];
    return state;
  });
  if (workers.some((worker, index) => worker && !versions[index])) return state;
  if (workers.some((worker, index) => worker !== [self.registration.active, self.registration.waiting, self.registration.installing][index])) return state;
  const retained = new Set([CACHE, ...versions.filter(Boolean).map(release => `poker-banker-${release}`)]);
  for (const record of Object.values(state.clients)) {
    if (record.release) retained.add(`poker-banker-${record.release}`);
    for (const key of record.pins || []) retained.add(key);
  }
  for (const [release, order] of Object.entries(state.releases)) if (order > generation) retained.add(`poker-banker-${release}`);
  await Promise.all(keys.filter(key => !retained.has(key)).map(key => caches.delete(key)));
  const allowed = new Set();
  for (const key of retained) {
    for (const path of state.manifests[key.slice(13)] || []) allowed.add(new URL(path, self.location.origin).href);
    for (const url of state.inventories[key] || []) allowed.add(url);
  }
  if (Object.values(state.clients).every(record => !record.release || state.manifests[record.release] || state.inventories[`poker-banker-${record.release}`])) {
    for (const key of keys.filter(key => retained.has(key))) {
      const cache = await caches.open(key);
      await Promise.all((await cache.keys()).filter(request => !allowed.has(request.url)).map(request => cache.delete(request)));
    }
  }
  const remaining = await caches.keys();
  await policy(current => {
    for (const key of Object.keys(current.inventories || {})) if (!remaining.includes(key)) delete current.inventories[key];
    for (const release of Object.keys(current.manifests || {})) if (!remaining.includes(`poker-banker-${release}`) && (current.releases[release] || 0) <= generation) delete current.manifests[release];
    for (const [release, order] of Object.entries(current.releases)) if (!remaining.includes(`poker-banker-${release}`) && order <= generation) delete current.releases[release];
  });
  return state;
}

function cleanCaches() {
  cleaning = cleaning.catch(() => {}).then(() => self.navigator.locks.request('poker-banker-updates', () => pruneCaches()));
  return cleaning;
}

async function activate(data) {
  if (data.updateProtocol !== UPDATE_PROTOCOL) return;
  const state = await cleanCaches();
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (clients.every(client => state.clients[client.id]?.updateProtocol === UPDATE_PROTOCOL)) await self.skipWaiting();
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
  event.waitUntil(self.navigator.locks.request('poker-banker-updates', async () => {
    const existed = (await caches.keys()).includes(CACHE);
    try {
      await policy(state => {
        state.releases[RELEASE] ||= ++state.generation;
        state.manifests ||= {};
        state.manifests[RELEASE] ||= PRECACHE;
      });
      const cache = await caches.open(CACHE);
      for (const path of PRECACHE) {
        const response = await fetch(new Request(path, { cache: 'reload', credentials: 'omit' }));
        if (!cacheable(response)) throw new Error(`Cannot precache ${path}`);
        await cache.put(path, response);
      }
      await pruneCaches(true);
    } catch (error) {
      if (!existed) {
        await caches.delete(CACHE);
        await policy(state => {
          delete state.releases[RELEASE];
          if (state.manifests) delete state.manifests[RELEASE];
          if (state.inventories) delete state.inventories[CACHE];
        });
      }
      throw error;
    }
  }));
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
  if (data.type === 'ACTIVATE') event.waitUntil(activate(data));
  if (data.type === 'CLIENT_RELEASE' && event.source?.id) {
    if (data.requestId) {
      const pending = releaseRequests.get(data.requestId);
      if (pending?.clientId === event.source.id) pending.finish({ release: data.release, updateProtocol: data.updateProtocol });
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
      if (RELEASE_URLS.has(url.href) && cacheable(response)) await cache.put(request, response.clone());
      return response;
    })());
  }
});
