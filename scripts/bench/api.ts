import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { SessionState } from '../../src/domain/session';
import type { playerReport } from '../../src/domain/report';
import type { ApiOptions, BenchmarkClient, HttpResult, RecordSample, SeedFixture } from './types';

type Report = ReturnType<typeof playerReport>;
function success(result: HttpResult, expected = 200) {
  assert.equal(result.status, expected, `Expected HTTP ${expected}, got ${result.status}`);
  assert(result.serverMs !== null && Number.isFinite(result.serverMs) && result.serverMs >= 0, 'Benchmark server must return app duration in Server-Timing');
}
async function measured(client: BenchmarkClient, path: string, metric: string, record: RecordSample, validate: (result: HttpResult) => Record<string, string | number | boolean>) {
  let result: HttpResult | undefined;
  try {
    result = await client.request(path);
    const work = validate(result);
    record({ metric, ms: result.serverMs!, roundtripMs: result.ms, bytes: result.bytes, status: result.status, ok: true, work });
  } catch (error) {
    record({ metric, ms: result?.serverMs ?? result?.ms ?? 0, roundtripMs: result?.ms, bytes: result?.bytes, status: result?.status, ok: false, work: {}, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}
export async function benchmarkReads(client: BenchmarkClient, pool: pg.Pool, fixture: SeedFixture, record: RecordSample, options: ApiOptions) {
  const initial = await client.request(`/api/sessions/${fixture.sessionId}`); success(initial);
  const state = initial.body as SessionState;
  assert.equal(state.session.id, fixture.sessionId); assert.equal(state.entries.length, 60); assert.equal(state.players.length, 9);
  const reportSessions = fixture.counts.main_player_report_sessions!;
  const paths: { metric: string; path: string; validate: (result: HttpResult) => Record<string, string | number | boolean> }[] = [
    { metric: 'api.session', path: `/api/sessions/${fixture.sessionId}`, validate: result => {
      success(result); const body = result.body as SessionState;
      assert.equal(body.session.id, fixture.sessionId); assert.equal(body.entries.length, 60); assert.equal(body.players.length, 9);
      return { session_entries: body.entries.length, players: body.players.length, revision: body.revision };
    } },
    { metric: 'api.since', path: `/api/sessions/${fixture.sessionId}?since=${state.revision}`, validate: result => {
      success(result, 304); assert.equal(result.bytes, 0); return { unchanged: true, revision: state.revision };
    } },
    { metric: 'api.players', path: '/api/players', validate: result => {
      success(result); const body = result.body as { players: { id: string; cumulative: { currency: string; result_minor: string }[] }[] };
      assert.equal(body.players.length, 40); assert.deepEqual(new Set(body.players.map(player => player.id)), new Set(fixture.playerIds));
      assert(body.players.every(player => player.cumulative.length === 1 && player.cumulative[0]!.currency === 'USD'));
      return { players: body.players.length, cumulative_currencies: body.players.reduce((count, player) => count + player.cumulative.length, 0), closed_sessions: 300 };
    } },
    ...(['overall', 'location', 'game', 'weekday', 'month'] as const).map(group => ({ metric: `api.report.${group}`, path: `/api/players/${fixture.playerId}/report?group=${group}`, validate: (result: HttpResult) => {
      success(result); const body = result.body as Report;
      assert.equal(body.group, group); assert(body.groups.length > 0);
      assert.equal(body.groups.reduce((count, item) => count + item.sessions_count, 0), reportSessions);
      assert(body.groups.every(item => item.currency === 'USD' && item.metrics.profit_loss_minor.sessions_used === item.sessions_count));
      return { groups: body.groups.length, sessions_used: reportSessions, currencies: 1 };
    } })),
    { metric: 'api.history', path: '/api/sessions', validate: result => {
      success(result); const body = result.body as { sessions: { id: string }[]; next: string | null };
      assert.equal(body.sessions.length, 30); assert(body.next); assert.equal(body.sessions[0]!.id, fixture.sessionId);
      return { rows_returned: body.sessions.length, rows_selected: 31, has_next: true, sessions_available: 301 };
    } },
  ];
  for (const request of (options.reverse ? [...paths].reverse() : paths).filter(item => !options.metrics || options.metrics.has(item.metric))) {
    request.validate(await client.request(request.path));
    for (let index = 0; index < options.samples; index++) await measured(client, request.path, request.metric, record, request.validate);
  }
  const count = (await pool.query('SELECT count(*)::int AS count FROM ledger_entries WHERE banker_id=$1 AND session_id=$2', [fixture.bankerId, fixture.sessionId])).rows[0]!.count;
  assert.equal(count, 60);
}

export async function benchmarkWrites(client: BenchmarkClient, pool: pg.Pool, fixture: SeedFixture, record: RecordSample, options: ApiOptions) {
  for (let batch = 0; batch < options.samples; batch++) {
    const before = (await pool.query('SELECT s.revision::text, (SELECT count(*)::int FROM ledger_entries e WHERE e.banker_id=s.banker_id AND e.session_id=s.id) AS count FROM game_sessions s WHERE s.id=$1 AND s.banker_id=$2', [fixture.sessionId, fixture.bankerId])).rows[0]!;
    const ids = Array.from({ length: 10 }, () => randomUUID());
    const notes = ids.map(id => `Benchmark concurrent ${id}`);
    const results = await Promise.allSettled(ids.map((op_id, index) => client.request(`/api/sessions/${fixture.sessionId}/entries`, { method: 'POST', body: { op_id, player_id: fixture.playerId, kind: 'buy_in', amount_minor: '100', paid_now: false, note: notes[index] } })));
    const errors: string[] = [];
    const revisions: bigint[] = [];
    const entryIds = new Set<string>();
    for (const [index, result] of results.entries()) {
      try {
        if (result.status === 'rejected') throw result.reason;
        success(result.value);
        const state = result.value.body as SessionState;
        assert.equal(state.session.id, fixture.sessionId);
        const written = state.entries.find(entry => entry.note === notes[index]); assert(written);
        assert.equal(written.amount_minor, '100'); assert.equal(written.kind, 'buy_in');
        revisions.push(BigInt(state.revision)); entryIds.add(written.id);
      } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
    }
    const after = (await pool.query('SELECT s.revision::text, (SELECT count(*)::int FROM ledger_entries e WHERE e.banker_id=s.banker_id AND e.session_id=s.id) AS count FROM game_sessions s WHERE s.id=$1 AND s.banker_id=$2', [fixture.sessionId, fixture.bankerId])).rows[0]!;
    const writtenCount = (await pool.query('SELECT count(*)::int AS count FROM ledger_entries WHERE banker_id=$1 AND session_id=$2 AND note=ANY($3::text[])', [fixture.bankerId, fixture.sessionId, notes])).rows[0]!.count as number;
    try {
      assert.equal(after.count - before.count, 10); assert.equal(BigInt(after.revision) - BigInt(before.revision), 10n);
      assert.equal(writtenCount, 10); assert.equal(entryIds.size, 10);
      assert.deepEqual(revisions.sort((a, b) => a < b ? -1 : a > b ? 1 : 0), Array.from({ length: 10 }, (_, index) => BigInt(before.revision) + BigInt(index + 1)));
    } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
    for (const result of results) {
      const value = result.status === 'fulfilled' ? result.value : undefined;
      record({ metric: 'api.write10', ms: value?.serverMs ?? value?.ms ?? 0, roundtripMs: value?.ms, bytes: value?.bytes, status: value?.status, ok: errors.length === 0, work: { concurrency: 10, batch, writes_completed: writtenCount, revision_delta: String(BigInt(after.revision) - BigInt(before.revision)), ledger_rows_before: before.count, ledger_rows_after: after.count }, ...(errors.length ? { error: errors.join('; ') } : {}) });
    }
    assert.equal(errors.length, 0, errors.join('; '));
  }
}
