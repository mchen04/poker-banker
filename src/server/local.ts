import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './app';
import { createPool } from './db';

const pool = createPool();
const app = createApp(pool, { origin: process.env.APP_ORIGIN, onError: error => console.error(error) });
app.use('/assets/*', serveStatic({ root: './dist' }));
app.get('/assets/*', c => { c.header('Cache-Control', 'no-store'); return c.notFound(); });
app.use('*', serveStatic({ root: './dist' }));
app.get('*', serveStatic({ path: './dist/index.html' }));
const server = serve({ fetch: app.fetch, port: Number(process.env.PORT || 3000), hostname: '127.0.0.1' }, info => {
  console.log(`Poker banker ready at http://127.0.0.1:${info.port}`);
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { server.close(() => { void pool.end().then(() => process.exit(0)); }); });
