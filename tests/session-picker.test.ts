import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import { testDatabase } from './database';

let database: Awaited<ReturnType<typeof testDatabase>>;
let app: ReturnType<typeof createApp>;
let cookie: string;
const origin = 'https://picker.test';
const oldId = randomUUID(), currentId = randomUUID();
type Page = { sessions: { id: string; name: string; status: string }[]; next: string | null };

beforeAll(async () => {
  database = await testDatabase(); app = createApp(database.pool, { origin });
  const response = await app.request(`${origin}/api/auth/signup`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ username: `picker-${randomUUID().slice(0, 12)}`, password: randomUUID() }) });
  expect(response.status).toBe(200); cookie = response.headers.get('set-cookie')!.split(';')[0]!;
  const banker = (await response.json() as { banker: { id: string } }).banker.id;
  const otherResponse = await app.request(`${origin}/api/auth/signup`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ username: `other-${randomUUID().slice(0, 12)}`, password: randomUUID() }) });
  expect(otherResponse.status).toBe(200);
  const otherId = (await otherResponse.json() as { banker: { id: string } }).banker.id;
  for (let i = 0; i < 31; i++) await database.pool.query("INSERT INTO game_sessions(id,banker_id,name,played_on,currency,status,closed_at,closed_balanced,ended_at) VALUES($1,$2,$3,'2026-11-10','USD','closed',now(),true,now())", [randomUUID(), banker, `Recent closed ${i}`]);
  for (const [id, owner, name, date] of [[oldId, banker, 'Old open', '2024-01-01'], [currentId, banker, 'Current open', '2026-11-12'], [randomUUID(), otherId, 'Other banker open', '2026-11-12']]) await database.pool.query("INSERT INTO game_sessions(id,banker_id,name,played_on,currency) VALUES($1,$2,$3,$4,'USD')", [id, owner, name, date]);
});
afterAll(async () => { await database?.stop(); });
const request = (query: string) => app.request(`${origin}/api/sessions${query}`, { headers: { origin, cookie } });

it('finds every owned open session independently of the first history page', async () => {
  const unfiltered = await (await request('')).json() as Page;
  expect(unfiltered.sessions).toHaveLength(30); expect(unfiltered.next).not.toBeNull();
  expect(unfiltered.sessions.some(row => row.id === oldId)).toBe(false);
  const response = await request('?status=open'); expect(response.status).toBe(200);
  const open = await response.json() as Page;
  expect(open.sessions.map(row => row.id)).toEqual([currentId, oldId]); expect(open.next).toBeNull();
  const search = await (await request('?status=open&q=old')).json() as Page;
  expect(search.sessions.map(row => row.id)).toEqual([oldId]);
});

it('retains cursor pagination for closed history and rejects unknown status filters', async () => {
  const first = await (await request('?status=closed')).json() as Page;
  expect(first.sessions).toHaveLength(30); expect(first.sessions.every(row => row.status === 'closed')).toBe(true);
  const second = await (await request(`?status=closed&before=${encodeURIComponent(first.next!)}`)).json() as Page;
  expect(second.sessions).toHaveLength(1); expect(second.next).toBeNull();
  expect(new Set([...first.sessions, ...second.sessions].map(row => row.id)).size).toBe(31);
  expect((await request('?status=all')).status).toBe(400);
});
