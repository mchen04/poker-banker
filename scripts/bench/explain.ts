import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';
import type { SeedFixture } from './types';

const isoTime = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const sessionColumns = `s.id, s.banker_id, s.name, to_char(s.played_on, 'YYYY-MM-DD') AS played_on, s.currency, s.status,
  s.location, s.game, s.big_blind_minor::text, ${isoTime('s.started_at')} AS started_at, ${isoTime('s.ended_at')} AS ended_at,
  s.closed_balanced, s.closed_at::text, s.share_token, s.revision::text, s.created_at::text, s.updated_at::text`;
export async function explainBenchmark(pool: pg.Pool, fixture: SeedFixture, outputDir: string) {
  await mkdir(outputDir, { recursive: true });
  const queries = [
    { name: 'state-session', source: 'src/server/store.ts sessionRow', sql: `SELECT ${sessionColumns} FROM game_sessions s WHERE s.id = $1 AND s.banker_id = $2`, values: [fixture.sessionId, fixture.bankerId] },
    { name: 'state-roster', source: 'src/server/store.ts loadSession', sql: `SELECT p.id, p.display_name FROM session_players sp JOIN players p ON p.id = sp.player_id AND p.banker_id = sp.banker_id
     WHERE sp.session_id = $1 AND sp.banker_id = $2 ORDER BY sp.added_at, p.id`, values: [fixture.sessionId, fixture.bankerId] },
    { name: 'state-ledger', source: 'src/server/store.ts loadSession', sql: `SELECT id, player_id, kind, amount_minor::text, note, method, ${isoTime('occurred_at')} AS occurred_at, voids_entry_id, created_at::text, revision::text
     FROM ledger_entries WHERE session_id = $1 AND banker_id = $2 ORDER BY ledger_entries.revision, created_at, id`, values: [fixture.sessionId, fixture.bankerId] },
    { name: 'state-events', source: 'src/server/store.ts loadSession', sql: `SELECT id, kind, detail, created_at::text, revision::text FROM session_events
     WHERE session_id = $1 AND banker_id = $2 ORDER BY session_events.revision DESC, id`, values: [fixture.sessionId, fixture.bankerId] },
    { name: 'roster-player-ids', source: 'src/server/app.ts GET /api/players', sql: 'SELECT id FROM players WHERE banker_id = $1 AND position($2 in name_key) > 0 ORDER BY name_key,id', values: [fixture.bankerId, ''] },
    { name: 'player-record', source: 'src/server/store.ts playerRecord', sql: 'SELECT id, display_name, created_at::text FROM players WHERE id = $1 AND banker_id = $2', values: [fixture.playerId, fixture.bankerId] },
    { name: 'player-sessions', source: 'src/server/store.ts playerSessions', sql: `SELECT ${sessionColumns},
    coalesce(jsonb_agg(jsonb_build_object(
      'id', e.id, 'player_id', e.player_id, 'kind', e.kind, 'amount_minor', e.amount_minor::text,
      'note', e.note, 'method', e.method, 'occurred_at', ${isoTime('e.occurred_at')},
      'voids_entry_id', e.voids_entry_id, 'created_at', e.created_at::text, 'revision', e.revision::text
    )) FILTER (WHERE e.id IS NOT NULL), '[]'::jsonb) AS entries
    FROM session_players sp JOIN game_sessions s ON s.id = sp.session_id AND s.banker_id = sp.banker_id
    LEFT JOIN ledger_entries e ON e.session_id = sp.session_id AND e.player_id = sp.player_id AND e.banker_id = sp.banker_id
    WHERE sp.banker_id = $1 AND sp.player_id = $2 GROUP BY s.id ORDER BY s.played_on DESC,s.id DESC`, values: [fixture.bankerId, fixture.playerId] },
    { name: 'history', source: 'src/server/app.ts GET /api/sessions', sql: `SELECT id, name, to_char(played_on,'YYYY-MM-DD') AS played_on, currency, status, revision::text FROM game_sessions
       WHERE banker_id = $1 AND position(lower($2) in lower(name)) > 0
       AND ($3::date IS NULL OR (played_on,id) < ($3::date,$4::uuid))
       ORDER BY played_on DESC,id DESC LIMIT 31`, values: [fixture.bankerId, '', null, null] },
    { name: 'write-session-lock', source: 'src/server/store.ts sessionRow lock=true', sql: `SELECT ${sessionColumns} FROM game_sessions s WHERE s.id = $1 AND s.banker_id = $2 FOR UPDATE`, values: [fixture.sessionId, fixture.bankerId] },
  ];
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
