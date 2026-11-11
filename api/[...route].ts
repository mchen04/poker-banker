import { createApp } from '../src/server/app.js';
import { createPool } from '../src/server/db.js';

const app = createApp(createPool(), { origin: process.env.APP_ORIGIN, onError: error => console.error(error) });
export const GET = app.fetch;
export const POST = app.fetch;
export const PUT = app.fetch;
export const PATCH = app.fetch;
export const DELETE = app.fetch;
export const OPTIONS = app.fetch;
export const HEAD = app.fetch;
