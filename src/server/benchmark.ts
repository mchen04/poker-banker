import { AsyncLocalStorage } from 'node:async_hooks';
import type pg from 'pg';
import type { Database } from './db.js';

type RequestTiming = { queryCount: number; dbMs: number };
type FetchApp = (request: Request) => Response | Promise<Response>;
type BenchmarkTiming = { fetch: (request: Request, app: FetchApp) => Promise<Response> };
const installed = new WeakMap<Database, BenchmarkTiming>();

export function createBenchmarkTiming(pool: Database): BenchmarkTiming {
  const existing = installed.get(pool);
  if (existing) return existing;
  const requests = new AsyncLocalStorage<RequestTiming>();
  const clients = new WeakSet<pg.PoolClient>();
  const connect = pool.connect;
  pool.connect = function (this: Database, ...args: unknown[]) {
    if (typeof args[0] === 'function') args[0] = AsyncLocalStorage.bind(args[0] as (...values: unknown[]) => unknown);
    return Reflect.apply(connect, this, args);
  } as Database['connect'];
  pool.on('connect', client => {
    if (clients.has(client)) return;
    clients.add(client);
    const query = client.query;
    client.query = function (this: pg.PoolClient, ...args: unknown[]) {
      const timing = requests.getStore();
      if (!timing) return Reflect.apply(query, this, args);
      timing.queryCount++;
      const started = performance.now();
      let completed = false;
      const finish = () => {
        if (completed) return;
        completed = true;
        timing.dbMs += performance.now() - started;
      };
      const callbackIndex = typeof args[2] === 'function' ? 2 : typeof args[1] === 'function' ? 1 : -1;
      const config = args[0] as { callback?: unknown; submit?: unknown } | undefined;
      const callback = callbackIndex >= 0 ? args[callbackIndex] : config?.callback;
      if (typeof callback === 'function') {
        const timedCallback = AsyncLocalStorage.bind(function (this: unknown, ...values: unknown[]) {
          finish();
          return Reflect.apply(callback, this, values);
        });
        if (callbackIndex >= 0) args[callbackIndex] = timedCallback;
        else if (config && typeof config.submit === 'function') config.callback = timedCallback;
        else args[0] = { ...config, callback: timedCallback };
      }
      try {
        const result: unknown = Reflect.apply(query, this, args);
        if (result && typeof (result as Promise<unknown>).then === 'function') {
          return (result as Promise<unknown>).then(value => { finish(); return value; }, error => { finish(); throw error; });
        }
        return result;
      } catch (error) {
        finish();
        throw error;
      }
    } as pg.PoolClient['query'];
  });
  const timing: BenchmarkTiming = {
    fetch: (request, app) => requests.run({ queryCount: 0, dbMs: 0 }, async () => {
      const current = requests.getStore()!;
      const started = performance.now();
      const response = await app(request);
      response.headers.set('Server-Timing', `app;dur=${(performance.now() - started).toFixed(3)}, db;dur=${current.dbMs.toFixed(3)}, db_count;desc="${current.queryCount}"`);
      return response;
    }),
  };
  installed.set(pool, timing);
  return timing;
}
