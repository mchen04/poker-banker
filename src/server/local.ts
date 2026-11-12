import { readFile } from 'node:fs/promises';
import { createServer as createHttpsServer } from 'node:https';
import { serve } from '@hono/node-server';
import { compress } from 'hono/compress';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './app.js';
import { createPool } from './db.js';
import { emulateEdgeHeaders } from './local-edge.js';
import { createProcessOwner } from '../../scripts/owned-process.js';
import { closeOwnedServer } from '../../scripts/close-server.js';
import { createBenchmarkTiming } from './benchmark.js';

const owner = createProcessOwner();
let stopping: Promise<void> | undefined;
let exitCode = 0;
function finish(code: number) {
  exitCode ||= code;
  stopping ??= owner.stop();
  void stopping.then(() => process.exit(exitCode), () => {
    exitCode ||= 1;
    try { console.error('Local server shutdown failed'); } catch {}
    process.exit(exitCode);
  });
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => finish(0));
if (typeof process.send === 'function') {
  process.on('disconnect', () => finish(1));
  if (!process.connected) finish(1);
}

async function initialize() {
  const tlsKey = process.env.LOCAL_TLS_KEY;
  const tlsCert = process.env.LOCAL_TLS_CERT;
  if (!!tlsKey !== !!tlsCert) throw new Error('LOCAL_TLS_KEY and LOCAL_TLS_CERT must be provided together');
  const tls = tlsKey && tlsCert ? { createServer: createHttpsServer, serverOptions: { key: await owner.launch(() => readFile(tlsKey)), cert: await owner.launch(() => readFile(tlsCert)) } } : {};
  owner.checkpoint();
  const pool = createPool();
  owner.addCleanup('Local database pool shutdown', 'pool', () => pool.end());
  const benchmarkTiming = process.env.PB_BENCHMARK_TIMING === '1' ? createBenchmarkTiming(pool) : undefined;
  const app = createApp(pool, { origin: process.env.APP_ORIGIN, onError: error => console.error(error) });
  app.use('/assets/*', compress());
  app.use('/assets/*', async (c, next) => {
    c.header('Cache-Control', 'public, max-age=31536000, immutable');
    await next();
  });
  app.use('/assets/*', serveStatic({ root: './dist' }));
  app.get('/assets/*', c => { c.header('Cache-Control', 'no-store'); return c.notFound(); });
  app.use('*', async (c, next) => {
    if (!c.req.path.startsWith('/api/')) c.header('Cache-Control', 'no-cache');
    await next();
  });
  app.use('*', serveStatic({ root: './dist' }));
  app.get('*', async (c, next) => {
    if (/^\/(?:|players(?:\/[^/]+)?|sessions\/[^/]+|v\/[^/]+|login|signup|recover)\/?$/.test(c.req.path)) return serveStatic({ path: './dist/index.html' })(c, next);
    c.header('Cache-Control', 'no-store');
    return c.notFound();
  });
  const fetchApp = benchmarkTiming ? (request: Request) => benchmarkTiming.fetch(request, app.fetch) : app.fetch;
  const fetch = process.env.PB_TEST_EDGE_HEADERS === '1' ? async (request: Request) => emulateEdgeHeaders(await fetchApp(request)) : fetchApp;
  await owner.launch(() => {
    const server = serve({ ...tls, fetch, port: Number(process.env.PORT || 3000), hostname: '127.0.0.1' }, info => {
      console.log(`Poker banker ready at ${tlsKey ? 'https' : 'http'}://127.0.0.1:${info.port}`);
    });
    owner.addCleanup('Local HTTP server shutdown', 'pool', () => closeOwnedServer(server));
    return server;
  });
}
void initialize().catch(() => finish(owner.signal.aborted ? 0 : 1));
