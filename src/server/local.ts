import { readFile } from 'node:fs/promises';
import { createServer as createHttpsServer } from 'node:https';
import { serve } from '@hono/node-server';
import { compress } from 'hono/compress';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './app.js';
import { createPool } from './db.js';

const tlsKey = process.env.LOCAL_TLS_KEY;
const tlsCert = process.env.LOCAL_TLS_CERT;
if (!!tlsKey !== !!tlsCert) throw new Error('LOCAL_TLS_KEY and LOCAL_TLS_CERT must be provided together');
const tls = tlsKey && tlsCert ? { createServer: createHttpsServer, serverOptions: { key: await readFile(tlsKey), cert: await readFile(tlsCert) } } : {};
const pool = createPool();
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
const fetch = process.env.PB_BENCHMARK_TIMING === '1' ? async (request: Request) => {
  const started = performance.now();
  const response = await app.fetch(request);
  response.headers.set('Server-Timing', `app;dur=${(performance.now() - started).toFixed(3)}`);
  return response;
} : app.fetch;
const server = serve({ ...tls, fetch, port: Number(process.env.PORT || 3000), hostname: '127.0.0.1' }, info => {
  console.log(`Poker banker ready at ${tlsKey ? 'https' : 'http'}://127.0.0.1:${info.port}`);
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { server.close(() => { void pool.end().then(() => process.exit(0)); }); });
