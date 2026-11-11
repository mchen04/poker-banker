import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { SessionState } from '../../src/domain/session';
import type { BenchmarkClient, RecordSample } from './types';
import { publicCall, liveHistoryPlan, type LiveFixture } from './live-seed';

export async function liveApi(client: BenchmarkClient, fixture: LiveFixture, record: RecordSample, reverse: boolean, samples: number) {
  const base = `/api/sessions/${fixture.sessionId}`;
  const initial = await publicCall<SessionState>(client, base);
  const cumulative = new Map<string, bigint>();
  for (const session of liveHistoryPlan(fixture.counts.closed_sessions!)) for (const [seat, rosterIndex] of session.players.entries()) {
    const id = fixture.playerIds[rosterIndex]!;
    cumulative.set(id, (cumulative.get(id) ?? 0n) + (seat === 0 ? -1500n : seat === session.players.length - 1 ? 1500n : 0n));
  }
  const requests = [
    { metric: 'api.session', path: base, validate: (body: unknown) => { const state = body as SessionState; assert.equal(state.session.id, fixture.sessionId); assert.equal(state.players.length, 9); assert.equal(state.entries.length, initial.entries.length); return { session_entries: state.entries.length, players: 9 }; } },
    { metric: 'api.since', path: `${base}?since=${initial.revision}`, validate: () => ({ unchanged: true }) },
    { metric: 'api.players', path: '/api/players', validate: (body: unknown) => { const value = body as { players: { id: string; cumulative: { currency: string; result_minor: string }[] }[] }; assert.equal(value.players.length, fixture.playerIds.length); assert.deepEqual(new Set(value.players.map(player => player.id)), new Set(fixture.playerIds)); for (const player of value.players) assert.deepEqual(player.cumulative, cumulative.has(player.id) ? [{ currency: 'USD', result_minor: String(cumulative.get(player.id)) }] : [], `Closed-session cumulative result for ${player.id}`); return { players: value.players.length, cumulative_currencies: cumulative.size, closed_sessions: fixture.counts.closed_sessions! }; } },
    ...['overall', 'location', 'game', 'weekday', 'month'].map(group => ({ metric: `api.report.${group}`, path: `/api/players/${fixture.playerId}/report?group=${group}`, validate: (body: unknown) => { const report = body as { group: string; groups: { sessions_count: number; currency: string }[] }; assert.equal(report.group, group); assert.equal(report.groups.reduce((sum, item) => sum + item.sessions_count, 0), fixture.counts.main_player_report_sessions); assert(report.groups.every(item => item.currency === 'USD')); return { groups: report.groups.length, sessions_used: fixture.counts.main_player_report_sessions! }; } })),
    { metric: 'api.history', path: '/api/sessions', validate: (body: unknown) => { const value = body as { sessions: { id: string }[]; next: string | null }; assert.equal(value.sessions.length, Math.min(30, fixture.counts.closed_sessions! + 1)); assert.equal(value.sessions[0]!.id, fixture.sessionId); if (fixture.counts.closed_sessions! >= 30) assert(value.next); return { rows_returned: value.sessions.length, sessions_available: fixture.counts.closed_sessions! + 1 }; } },
  ];
  for (const item of reverse ? [...requests].reverse() : requests) for (let index = 0; index < samples; index++) {
    const result = await client.request(item.path);
    try {
      assert.equal(result.status, item.metric === 'api.since' ? 304 : 200);
      if (item.metric === 'api.since') assert.equal(result.bytes, 0);
      record({ metric: item.metric, ms: result.ms, status: result.status, bytes: result.bytes, ok: true, work: { ...item.validate(result.body), timing: 'HTTP round trip including response body', sample: index } });
    } catch (error) { record({ metric: item.metric, ms: result.ms, status: result.status, bytes: result.bytes, ok: false, work: { sample: index }, error: String(error) }); throw error; }
  }
}
export async function liveWrites(client: BenchmarkClient, fixture: LiveFixture, record: RecordSample, samples: number) {
  const path = `/api/sessions/${fixture.sessionId}`;
  for (let batch = 0; batch < samples; batch++) {
    const before = await publicCall<SessionState>(client, path);
    const notes = Array.from({ length: 10 }, () => `Live benchmark concurrent ${randomUUID()}`);
    const results = await Promise.allSettled(notes.map(note => client.request(`${path}/entries`, { method: 'POST', body: { op_id: randomUUID(), player_id: fixture.playerId, kind: 'buy_in', amount_minor: '100', paid_now: false, note } })));
    const after = await publicCall<SessionState>(client, path);
    let failure: unknown;
    try {
      assert(results.every(result => result.status === 'fulfilled' && result.value.status === 200));
      assert.equal(after.entries.length - before.entries.length, 10);
      assert.equal(BigInt(after.revision) - BigInt(before.revision), 10n);
      for (const note of notes) assert.equal(after.entries.filter(entry => entry.note === note && entry.kind === 'buy_in').length, 1);
      const revisions = results.map(result => { assert.equal(result.status, 'fulfilled'); return BigInt(((result as PromiseFulfilledResult<{ body: SessionState }>).value.body).revision); }).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
      assert.deepEqual(revisions, Array.from({ length: 10 }, (_, index) => BigInt(before.revision) + BigInt(index + 1)));
    } catch (error) { failure = error; }
    for (const result of results) {
      const value = result.status === 'fulfilled' ? result.value : undefined;
      record({ metric: 'api.write10', ms: value?.ms ?? 0, bytes: value?.bytes, status: value?.status, ok: !failure, work: { concurrency: 10, batch, writes_completed: after.entries.length - before.entries.length, ledger_rows_before: before.entries.length, ledger_rows_after: after.entries.length, timing: 'HTTP round trip including response body' }, ...(failure ? { error: String(failure) } : {}) });
    }
    if (failure) throw failure;
  }
}
