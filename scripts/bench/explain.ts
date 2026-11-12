import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';
import type { SeedFixture } from './types';
import { playerHistory, playerRoster } from '../../src/server/store';

const isoTime = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const sessionColumns = `s.id, s.banker_id, s.name, to_char(s.played_on, 'YYYY-MM-DD') AS played_on, s.currency, s.status,
  s.location, s.game, s.big_blind_minor::text, ${isoTime('s.started_at')} AS started_at, ${isoTime('s.ended_at')} AS ended_at,
  s.closed_balanced, s.closed_at::text, s.share_token, s.revision::text, s.created_at::text, s.updated_at::text`;
export async function explainBenchmark(pool: pg.Pool, fixture: SeedFixture, outputDir: string) {
  await mkdir(outputDir, { recursive: true });
  type Query = { name: string; source: string; sql: string; values: unknown[] };
  const observed: Query[] = [];
  async function capture(names: string[], source: string, action: (db: Parameters<typeof playerRoster>[0]) => Promise<unknown>) {
    let call = 0;
    const db = { query: async (sql: string, values: unknown[] = []) => {
      observed.push({ name: names[call++]!, source, sql, values });
      return pool.query(sql, values);
    } } as unknown as Parameters<typeof playerRoster>[0];
    await action(db);
    if (call !== names.length) throw new Error(`Benchmark query capture changed for ${source}`);
  }
  await capture(['roster-players', 'roster-summary'], 'src/server/store.ts playerRoster', db => playerRoster(db, fixture.bankerId, ''));
  await capture(['player-record', 'player-sessions', 'player-history-server-time'], 'src/server/store.ts playerHistory', db => playerHistory(db, fixture.bankerId, fixture.playerId));
  const queries: Query[] = [
    { name: 'state-session', source: 'src/server/store.ts sessionRow', sql: `SELECT ${sessionColumns} FROM game_sessions s WHERE s.id = $1 AND s.banker_id = $2`, values: [fixture.sessionId, fixture.bankerId] },
    { name: 'state-roster', source: 'src/server/store.ts loadSession', sql: `SELECT p.id, p.display_name FROM session_players sp JOIN players p ON p.id = sp.player_id AND p.banker_id = sp.banker_id
     WHERE sp.session_id = $1 AND sp.banker_id = $2 ORDER BY sp.added_at, p.id`, values: [fixture.sessionId, fixture.bankerId] },
    { name: 'state-ledger', source: 'src/server/store.ts loadSession', sql: `SELECT id, player_id, kind, amount_minor::text, note, method, ${isoTime('occurred_at')} AS occurred_at, voids_entry_id, created_at::text, revision::text
     FROM ledger_entries WHERE session_id = $1 AND banker_id = $2 ORDER BY ledger_entries.revision, created_at, id`, values: [fixture.sessionId, fixture.bankerId] },
    { name: 'state-events', source: 'src/server/store.ts loadSession', sql: `SELECT id, kind, detail, created_at::text, revision::text FROM session_events
     WHERE session_id = $1 AND banker_id = $2 ORDER BY session_events.revision DESC, id`, values: [fixture.sessionId, fixture.bankerId] },
    { name: 'history', source: 'src/server/app.ts GET /api/sessions', sql: `SELECT id, name, to_char(played_on,'YYYY-MM-DD') AS played_on, currency, status, revision::text FROM game_sessions
       WHERE banker_id = $1 AND position(lower($2) in lower(name)) > 0
       AND ($5::text IS NULL OR status = $5)
       AND ($3::date IS NULL OR (played_on,id) < ($3::date,$4::uuid))
       ORDER BY played_on DESC,id DESC LIMIT 31`, values: [fixture.bankerId, '', null, null, null] },
    { name: 'write-session-lock', source: 'src/server/store.ts sessionRow lock=true', sql: `SELECT ${sessionColumns} FROM game_sessions s WHERE s.id = $1 AND s.banker_id = $2 FOR UPDATE`, values: [fixture.sessionId, fixture.bankerId] },
  ];
  queries.push(...observed);
  const index = [];
  for (const query of queries) {
    const result = await pool.query<{ 'QUERY PLAN': string }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${query.sql}`, query.values);
    const plan = result.rows.map(row => row['QUERY PLAN']).join('\n');
    await writeFile(join(outputDir, `${query.name}.txt`), `${query.source}\n\n${query.sql}\n\nParameters ${JSON.stringify(query.values)}\n\n${plan}\n`);
    index.push({ name: query.name, source: query.source, file: `${query.name}.txt`, plan_lines: result.rows.length, execution_ms: Number(plan.match(/Execution Time: ([\d.]+) ms/)?.[1] ?? NaN) });
  }
  await writeFile(join(outputDir, 'index.json'), JSON.stringify(index, null, 2));
  return index;
}
