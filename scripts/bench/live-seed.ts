import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
  assert.equal(result.status, 200, `Public benchmark request ${method} ${path} failed with ${result.status}: ${JSON.stringify(result.body)}`);
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
