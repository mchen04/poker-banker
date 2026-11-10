import { handle } from '@hono/node-server/vercel';
import { createApp } from '../src/server/app';
import { createPool } from '../src/server/db';

const app = createApp(createPool(), { origin: process.env.APP_ORIGIN, onError: error => console.error(error) });
export default handle(app);
