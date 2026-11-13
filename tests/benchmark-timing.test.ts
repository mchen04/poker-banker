import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createBenchmarkTiming } from '../src/server/benchmark';
import { testDatabase } from './database';
import { createPool } from '../src/server/db';

let database: Awaited<ReturnType<typeof testDatabase>>;
let pool: pg.Pool;
let timing: ReturnType<typeof createBenchmarkTiming>;
beforeAll(async () => {
  database = await testDatabase();
  pool = createPool(database.pool.options.connectionString, 1);
  database.owner.addCleanup('Benchmark timing pool shutdown', 'pool', () => pool.end());
  timing = createBenchmarkTiming(pool);
});
afterAll(async () => { await database?.stop(); });

function queryCount(response: Response) {
  const header = response.headers.get('Server-Timing')!;
  expect(header).toMatch(/^app;dur=\d+\.\d{3}, db;dur=\d+\.\d{3}, db_count;desc="\d+"$/);
  return Number(header.match(/db_count;desc="(\d+)"/)![1]);
}

it('counts each driver call once across pool, transaction, callback and promise overloads', async () => {
  expect(createBenchmarkTiming(pool)).toBe(timing);
  const response = await timing.fetch(new Request('http://127.0.0.1/overloads'), async () => {
    expect((await pool.query('SELECT 1 AS value')).rows[0].value).toBe(1);
    expect((await pool.query({ text: 'SELECT $1::int AS value', values: [2] })).rows[0].value).toBe(2);
    const textCallback = await new Promise<pg.QueryResult>((resolve, reject) => {
      const result = pool.query('SELECT 3 AS value', (error, result) => {
        if (error) return reject(error);
        resolve(result);
      });
      expect(result).toBeUndefined();
    });
    expect(textCallback.rows[0].value).toBe(3);
    const valuesCallback = await new Promise<pg.QueryResult>((resolve, reject) => {
      pool.query('SELECT $1::int AS value', [4], (error, result) => {
        if (error) return reject(error);
        resolve(result);
      });
    });
    expect(valuesCallback.rows[0].value).toBe(4);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const clientCallback = await new Promise<pg.QueryResult>((resolve, reject) => {
        client.query('SELECT $1::int AS value', [5], (error, result) => {
          if (error) return reject(error);
          resolve(result);
        });
      });
      expect(clientCallback.rows[0].value).toBe(5);
      const configCallback = await new Promise<pg.QueryResult>((resolve, reject) => {
        const config = { text: 'SELECT 6 AS value', callback: (error: Error | null, result: pg.QueryResult) => {
          if (error) return reject(error);
          resolve(result);
        } };
        expect(client.query(config)).toBeUndefined();
      });
      expect(configCallback.rows[0].value).toBe(6);
      await client.query('COMMIT');
    } finally { client.release(); }
    return new Response('ok');
  });
  expect(queryCount(response)).toBe(8);
  const header = response.headers.get('Server-Timing')!;
  expect(Number(header.match(/\bdb;dur=([\d.]+)/)![1])).toBeGreaterThan(0);
});

it('attributes queued concurrent requests independently and excludes outside queries', async () => {
  await pool.query('SELECT 1');
  const responses = await Promise.all([
    timing.fetch(new Request('http://127.0.0.1/one'), async () => {
      await pool.query('SELECT pg_sleep(0.02)');
      return new Response('one');
    }),
    timing.fetch(new Request('http://127.0.0.1/three'), async () => {
      await pool.query('SELECT 1');
      await pool.query('SELECT 2');
      await pool.query('SELECT 3');
      return new Response('three');
    }),
  ]);
  expect(responses.map(queryCount)).toEqual([1, 3]);
  const empty = await timing.fetch(new Request('http://127.0.0.1/zero'), () => new Response('zero'));
  expect(queryCount(empty)).toBe(0);
});

it('preserves rejected promises and callback errors without losing their timing', async () => {
  const response = await timing.fetch(new Request('http://127.0.0.1/errors'), async () => {
    await expect(pool.query('SELECT missing_benchmark_column')).rejects.toMatchObject({ code: '42703' });
    const callbackError = await new Promise<Error>((resolve, reject) => {
      pool.query('SELECT missing_benchmark_column', error => {
        if (!error) return reject(new Error('Expected a database error'));
        resolve(error);
      });
    });
    expect(callbackError).toMatchObject({ code: '42703' });
    return new Response('handled');
  });
  expect(queryCount(response)).toBe(2);
});
