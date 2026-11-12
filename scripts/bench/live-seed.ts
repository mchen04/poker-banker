import { withShutdownDeadline } from '../owned-process';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, open, realpath, lstat } from 'node:fs/promises';
import { resolve, relative, dirname, join, sep } from 'node:path';
import { constants } from 'node:fs';
import { z } from 'zod';
import { LiveClient, liveOrigin } from './live-client';
import type { SessionState, PaymentMethod } from '../../src/domain/session';
import type { BenchmarkClient } from './types';

const day = 86400000, minute = 60000;
const iso = (time: number) => new Date(time).toISOString();
const methods: PaymentMethod[] = ['cash', 'venmo', 'zelle'];
export type LiveFixture = { bankerId: string; username: string; playerIds: string[]; sessionId: string; playerId: string; token: string; counts: Record<string, number> };
export function liveHistoryPlan(count = 300, now = Date.now()) {
  assert(Number.isInteger(count) && count >= 1 && count <= 300);
  const latest = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate()) - 2 * day;
  return Array.from({ length: count }, (_, index) => {
    const started = latest - 1095 * day + Math.floor(index * 1095 / Math.max(1, count - 1)) * day + 18 * 60 * minute;
    return { index, started, ended: started + (240 + index % 3 * 30) * minute, players: Array.from({ length: 6 + index % 5 }, (_, seat) => (index * 7 + seat) % 40), location: ['Home', 'Mike’s place', 'Club room'][index % 3]!, game: index % 4 === 0 ? 'PLO' : 'NLH', blind: String([100, 200, 500][index % 3]) };
  });
}
export async function publicCall<T>(client: BenchmarkClient, path: string, method = 'GET', body?: unknown): Promise<T> {
  const result = await client.request(path, { method, body });
  assert.equal(result.status, 200, `Public benchmark request ${method} failed with status ${result.status}`);
  return result.body as T;
}
export async function seedLiveBenchmark(client: BenchmarkClient, options: { sessions?: number; concurrency?: number; progress?: (completed: number) => void } = {}): Promise<LiveFixture> {
  const username = `pbbench-${randomUUID().replaceAll('-', '').slice(0, 23)}`;
  const account = await publicCall<{ banker: { id: string; username: string } }>(client, '/api/auth/signup', 'POST', { username, password: `bench-only-${randomUUID()}` });
  const playerIds: string[] = [];
  for (let index = 0; index < 40; index++) playerIds.push((await publicCall<{ player: { id: string } }>(client, '/api/players', 'POST', { op_id: randomUUID(), display_name: `Benchmark Player ${String(index + 1).padStart(2, '0')}` })).player.id);
  const plan = liveHistoryPlan(options.sessions ?? 300);
  const counts = { bankers_created: 1, reusable_players: 40, closed_sessions: plan.length, closed_seats: 0, rebuys: 0, reentries: 0, expenses: 0, corrections: 0, main_player_report_sessions: plan.filter(session => session.players.includes(0)).length };
  let next = 0, completed = 0;
  async function historical() {
    while (next < plan.length) {
      const item = plan[next++]!;
      let state = await publicCall<SessionState>(client, '/api/sessions', 'POST', { op_id: randomUUID(), name: `Benchmark history ${String(item.index + 1).padStart(3, '0')}`, played_on: iso(item.started).slice(0, 10), currency: 'USD', location: item.location, game: item.game, big_blind_minor: item.blind });
      const path = `/api/sessions/${state.session.id}`;
      state = await publicCall(client, `${path}/timing`, 'PATCH', { op_id: randomUUID(), started_at: iso(item.started), ended_at: iso(item.ended) });
      for (const [seat, rosterIndex] of item.players.entries()) {
        const player_id = playerIds[rosterIndex]!;
        state = await publicCall(client, `${path}/players`, 'POST', { op_id: randomUUID(), player_id }); counts.closed_seats++;
        const emit = async (kind: string, amount: number, offset: number, extra: object = {}) => {
          state = await publicCall(client, `${path}/entries`, 'POST', { op_id: randomUUID(), player_id, kind, amount_minor: String(amount), occurred_at: iso(item.started + offset * minute), ...extra });
        };
        const method = methods[(item.index + seat) % 3]!;
        const later = seat % 4 === 0;
        await emit('buy_in', 10000, seat * 4, later ? { paid_now: false, note: 'Unpaid buy-in settled later' } : { paid_now: true, method });
        if (later) await emit('payment_in', 10000, seat * 4 + 2, { method });
        let bought = 10000, earlyOut = 0;
        if (seat % 3 === 0) { await emit('buy_in', 3000, 60, { paid_now: true, method }); bought += 3000; counts.rebuys++; }
        if (seat === 0 && item.index % 5 === 0) { await emit('cash_out', 5000, 90, { paid_now: true, method }); await emit('buy_in', 5000, 120, { paid_now: true, method }); bought += 5000; earlyOut = 5000; counts.reentries++; }
        if (seat % 3 === 0) { await emit('expense', 300, 150, { note: item.index % 2 ? 'Meal' : 'Tip' }); counts.expenses++; }
        if (seat === 0 && item.index % 13 === 0) {
          const original = state.entries.find(entry => entry.player_id === player_id && entry.kind === 'payment_in' && !entry.voids_entry_id)!;
          state = await publicCall(client, `${path}/entries/${original.id}/void`, 'POST', { op_id: randomUUID(), replacement_method: original.method === 'zelle' ? 'cash' : 'zelle' }); counts.corrections++;
        }
        const result = seat === 0 ? -1500 : seat === item.players.length - 1 ? 1500 : 0;
        await emit('cash_out', bought - earlyOut + result, (item.ended - item.started) / minute - seat, { paid_now: true, method });
      }
      assert.equal(state.totals.discrepancy_minor, '0');
      state = await publicCall(client, `${path}/close`, 'POST', { op_id: randomUUID(), expected_revision: state.revision });
      assert.equal(state.session.status, 'closed'); assert(state.players.every(player => player.state === 'cashed_out'));
      options.progress?.(++completed);
    }
  }
  const concurrency = options.concurrency ?? 4;
  assert(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 8);
  await Promise.all(Array.from({ length: Math.min(concurrency, plan.length) }, historical));
  const started = Date.now() - 180 * minute;
  let state = await publicCall<SessionState>(client, '/api/sessions', 'POST', { op_id: randomUUID(), name: 'Benchmark open table', played_on: iso(Date.now()).slice(0, 10), currency: 'USD', location: 'Home', game: 'NLH', big_blind_minor: '200' });
  const path = `/api/sessions/${state.session.id}`;
  state = await publicCall(client, `${path}/timing`, 'PATCH', { op_id: randomUUID(), started_at: iso(started), ended_at: null });
  for (const player_id of playerIds.slice(0, 9)) state = await publicCall(client, `${path}/players`, 'POST', { op_id: randomUUID(), player_id });
  for (let index = 0; index < 30; index++) state = await publicCall(client, `${path}/entries`, 'POST', { op_id: randomUUID(), player_id: playerIds[index % 9], kind: 'buy_in', amount_minor: index < 9 ? '10000' : '5000', paid_now: true, method: methods[index % 3], occurred_at: iso(started + (index + 1) * minute) });
  state = await publicCall(client, `${path}/share`, 'POST', { op_id: randomUUID(), action: 'enable' });
  assert.equal(state.entries.length, 60); assert.equal(state.players.length, 9); assert.equal(state.totals.total_in_minor, '195000');

  assert(state.session.share_token);
  return { bankerId: account.banker.id, username, playerIds, playerId: playerIds[0]!, sessionId: state.session.id, token: state.session.share_token, counts: { ...counts, open_players: state.players.length, open_entries: state.entries.length } };
}

const fixtureSchema = z.object({ bankerId: z.uuid(), username: z.string().regex(/^pbbench-[a-z0-9]{23}$/), playerIds: z.array(z.uuid()).length(40), sessionId: z.uuid(), playerId: z.uuid(), token: z.string().min(1), counts: z.object({ closed_sessions: z.number().int().min(1).max(300), main_player_report_sessions: z.number().int().nonnegative() }).catchall(z.number().int().nonnegative()) });
const seedStateSchema = z.object({ format: z.literal('poker-banker-live-seed-v1'), baseURL: z.string(), sessionCookie: z.string().min(1), fixture: fixtureSchema }).strict();
export type LiveSeedState = z.infer<typeof seedStateSchema>;
async function statePath(path: string, writing: boolean) {
  const cache = resolve('.cache');
  const target = resolve(path);
  const inside = (root: string, candidate: string) => { const part = relative(root, candidate); return part !== '' && !part.startsWith('..') && !part.startsWith('/'); };
  assert(inside(cache, target), 'Owned live seed state must be beneath .cache');
  if (writing) {
    const directories = [cache, ...relative(cache, dirname(target)).split(sep).filter(Boolean).map((_, index, parts) => join(cache, ...parts.slice(0, index + 1)))];
    for (const directory of directories) {
      try { await mkdir(directory); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
      const info = await lstat(directory);
      assert(info.isDirectory() && !info.isSymbolicLink(), 'Owned seed state cannot use symlink directories');
    }
  }
  const root = await realpath(cache), parent = await realpath(dirname(target));
  assert(root === cache && (parent === root || inside(root, parent)), 'Owned seed state cannot use symlink directories');
  return target;
}
export async function prepareLiveSeedState(path: string) {
  const target = await statePath(path, true);
  try { await lstat(target); } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error('Owned live seed state destination already exists');
}
export async function writeLiveSeedState(path: string, client: LiveClient, fixture: LiveFixture) {
  const target = await statePath(path, true);
  const parsed = seedStateSchema.safeParse({ format: 'poker-banker-live-seed-v1', baseURL: client.baseURL, sessionCookie: await client.sessionCookie(), fixture });
  assert(parsed.success, 'Invalid owned live seed state');
  const file = await open(target, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(parsed.data)); } finally { await withShutdownDeadline('Owned benchmark seed file close', () => file.close()); }
}
export async function readLiveSeedState(path: string): Promise<LiveSeedState> {
  const target = await statePath(path, false);
  const info = await lstat(target);
  assert(info.isFile() && !info.isSymbolicLink() && (info.mode & 0o777) === 0o600, 'Owned seed state must be a regular 0600 file');
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    let value: unknown;
    try { value = JSON.parse(await file.readFile('utf8')); } catch { throw new Error('Invalid owned live seed state'); }
    const parsed = seedStateSchema.safeParse(value);
    assert(parsed.success, 'Invalid owned live seed state');
    liveOrigin(parsed.data.baseURL);
    assert(parsed.data.fixture.playerIds.includes(parsed.data.fixture.playerId), 'Invalid owned seed player');
    return parsed.data;
  } finally { await withShutdownDeadline('Owned benchmark seed file close', () => file.close()); }
}
export async function reuseLiveSeed(client: LiveClient, state: LiveSeedState) {
  client.ownSecret(state.fixture.token);
  await client.restoreSession(state.sessionCookie);
  const me = await client.request('/api/auth/me');
  assert(me.status === 200 && (me.body as { banker?: { id?: string } })?.banker?.id === state.fixture.bankerId, 'Stored benchmark banker is not visible or does not match the selected target');
  const session = await client.request(`/api/sessions/${state.fixture.sessionId}`);
  assert(session.status === 200 && (session.body as SessionState)?.session?.id === state.fixture.sessionId, 'Stored benchmark fixture is not visible or does not match the selected banker');
  return state.fixture;
}
