import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { Session } from 'node:inspector';
import { cpus, loadavg } from 'node:os';
import { join, relative, resolve } from 'node:path';
import type pg from 'pg';
import { createApp } from '../../src/server/app';
import { playerRoster } from '../../src/server/store';
import { boundedHost, hostMonitor } from './host';
import { benchmarkStack } from './stack';
import { createProcessOwner, withShutdownDeadline } from '../owned-process';

type QueryCapture = { sql: string; parameters: unknown[]; rows: unknown[]; driverAwaitMs: number; pgSocketBytes: number };
type QuerySample = { sql: string; fingerprint: string; rows: number; decodedRowsJsonBytes: number; driverAwaitMs: number; pgSocketBytes: number };
type DirectSample = { wallMs: number; processCpuMs: number; players: number; responseJsonBytes: number; queries: QuerySample[]; driverAwaitMs: number | null; jsResidualMs: number | null; pgSocketBytes: number | null };
type FullRequestSample = { appHandlerWallMs: number; processCpuMs: number; players: number; responseJsonBytes: number; queries: QuerySample[]; driverAwaitMs: number; jsResidualMs: number; pgSocketBytes: number };
type Stack = Awaited<ReturnType<typeof benchmarkStack>>;

function option(name: string, fallback: string) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  assert(process.argv[index + 1], `${name} requires a value`);
  return process.argv[index + 1]!;
}

function distribution(values: number[]) {
  assert(values.length > 0);
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return { samples: values.length, median: sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2, min: sorted[0]!, max: sorted.at(-1)! };
}

function querySamples(captures: QueryCapture[]): QuerySample[] {
  return captures.map(capture => ({ sql: capture.sql, fingerprint: createHash('sha256').update(capture.sql).digest('hex').slice(0, 12), rows: capture.rows.length, decodedRowsJsonBytes: Buffer.byteLength(JSON.stringify(capture.rows)), driverAwaitMs: capture.driverAwaitMs, pgSocketBytes: capture.pgSocketBytes }));
}

function summarizeQueries(samples: { queries: QuerySample[] }[]) {
  return samples[0]!.queries.map((query, index) => {
    assert(samples.every(sample => sample.queries[index]?.fingerprint === query.fingerprint && sample.queries.length === samples[0]!.queries.length), 'Repeated samples must capture the same SQL query sequence');
    return { sql: query.sql, fingerprint: query.fingerprint, rows: distribution(samples.map(sample => sample.queries[index]!.rows)), decodedRowsJsonBytes: distribution(samples.map(sample => sample.queries[index]!.decodedRowsJsonBytes)), driverAwaitMs: distribution(samples.map(sample => sample.queries[index]!.driverAwaitMs)), pgSocketBytes: distribution(samples.map(sample => sample.queries[index]!.pgSocketBytes)) };
  });
}

function clientSocketBytes(client: pg.PoolClient) {
  const bytes: unknown = (client as unknown as { connection?: { stream?: { bytesRead?: unknown } } }).connection?.stream?.bytesRead;
  assert(typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes >= 0, 'A connected pg client must expose a finite nonnegative connection.stream.bytesRead counter');
  return bytes;
}

function socketCounter(db: pg.Pool | pg.PoolClient) {
  if (!('_clients' in db)) return () => clientSocketBytes(db as pg.PoolClient);
  const pool = db as unknown as { _clients: unknown };
  assert(Array.isArray(pool._clients) && pool._clients.length > 0, 'The warmed pg pool must expose its existing connected _clients');
  const clients = [...pool._clients] as pg.PoolClient[];
  return () => {
    assert(Array.isArray(pool._clients) && pool._clients.length === clients.length && clients.every(client => (pool._clients as pg.PoolClient[]).includes(client)), 'The pg pool client set must remain stable during each serial query byte measurement');
    return clients.reduce((sum, client) => sum + clientSocketBytes(client), 0);
  };
}

function tracedQuery(db: pg.Pool | pg.PoolClient, captures: QueryCapture[]): pg.PoolClient['query'] {
  return (async (sql: string, parameters: unknown[] = []) => {
    const incomingBytes = socketCounter(db);
    const beforeBytes = incomingBytes();
    const started = performance.now();
    const result = await db.query(sql, parameters);
    const driverAwaitMs = performance.now() - started;
    const pgSocketBytes = incomingBytes() - beforeBytes;
    assert(Number.isSafeInteger(pgSocketBytes) && pgSocketBytes >= 0, 'Incoming PostgreSQL socket bytes must not reset during a measured query');
    captures.push({ sql, parameters, rows: result.rows, driverAwaitMs, pgSocketBytes });
    return result;
  }) as pg.PoolClient['query'];
}

function tracedPool(pool: pg.Pool, captures: QueryCapture[]) {
  return new Proxy(pool, {
    get(target, property) {
      if (property === 'query') return tracedQuery(target, captures);
      if (property === 'connect') return async () => {
        const client = await target.connect();
        return new Proxy(client, {
          get(original, key) {
            if (key === 'query') return tracedQuery(original, captures);
            const value: unknown = Reflect.get(original, key, original);
            return typeof value === 'function' ? value.bind(original) : value;
          },
        });
      };
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function fullRequestSamples(stack: Stack, count: number) {
  const expected = await direct(stack.database.pool, stack.fixture.bankerId, false);
  const expectedText = JSON.stringify({ players: expected.players });
  const captures: QueryCapture[] = [];
  const app = createApp(tracedPool(stack.database.pool, captures), { origin: stack.origin });
  const samples: FullRequestSample[] = [];
  const warm = await app.request(`${stack.origin}/api/players`, { headers: { cookie: stack.client.cookie() } });
  assert.equal(warm.status, 200);
  assert.equal(await warm.text(), expectedText);
  for (let index = 0; index < count; index++) {
    checkInterrupted();
    captures.length = 0;
    const beforeCpu = process.cpuUsage();
    const started = performance.now();
    const response = await app.request(`${stack.origin}/api/players`, { headers: { cookie: stack.client.cookie() } });
    const appHandlerWallMs = performance.now() - started;
    const cpu = process.cpuUsage(beforeCpu);
    assert.equal(response.status, 200, 'The instrumented real application request must succeed');
    const text = await response.text();
    assert.equal(text, expectedText, 'The instrumented real application request must return byte-identical roster JSON');
    assert(captures.length >= 6 && captures.length <= 7, 'The real request must capture auth, transaction, and domain queries');
    assert(captures[0]!.sql.includes('UPDATE auth_sessions'), 'The first captured query must be real authentication');
    assert.equal(captures[1]!.sql, 'BEGIN');
    assert.equal(captures[2]!.sql, 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    assert.equal(captures.at(-1)!.sql, 'COMMIT');
    const queries = querySamples(captures);
    const driverAwaitMs = queries.reduce((sum, query) => sum + query.driverAwaitMs, 0);
    samples.push({ appHandlerWallMs, processCpuMs: (cpu.user + cpu.system) / 1000, players: expected.players.length, responseJsonBytes: Buffer.byteLength(text), queries, driverAwaitMs, jsResidualMs: appHandlerWallMs - driverAwaitMs, pgSocketBytes: queries.reduce((sum, query) => sum + query.pgSocketBytes, 0) });
  }
  return samples;
}

async function direct(pool: pg.Pool, banker: string, instrument: boolean) {
  const client = await pool.connect();
  const captures: QueryCapture[] = [];
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const query = tracedQuery(client, captures);
    const beforeCpu = process.cpuUsage();
    const started = performance.now();
    const players = await playerRoster(instrument ? { query } : client, banker, '');
    const wallMs = performance.now() - started;
    const cpu = process.cpuUsage(beforeCpu);
    await client.query('COMMIT');
    assert.equal(players.length, 40, 'The completed roster must contain all forty owner players');
    const queries = querySamples(captures);
    const driverAwaitMs = instrument ? queries.reduce((sum, query) => sum + query.driverAwaitMs, 0) : null;
    const sample: DirectSample = { wallMs, processCpuMs: (cpu.user + cpu.system) / 1000, players: players.length, responseJsonBytes: Buffer.byteLength(JSON.stringify({ players })), queries, driverAwaitMs, jsResidualMs: driverAwaitMs === null ? null : wallMs - driverAwaitMs, pgSocketBytes: instrument ? queries.reduce((sum, query) => sum + query.pgSocketBytes, 0) : null };
    return { sample, players, captures };
  } catch (error) {
    await withShutdownDeadline('Players profile transaction rollback', () => client.query('ROLLBACK'));
    throw error;
  } finally {
    client.release();
  }
}

async function retainClosedSessions(stack: Stack, count: number) {
  const db = await stack.database.pool.connect();
  try {
    await db.query('BEGIN');
    const removed = await db.query<{ id: string }>('SELECT id FROM game_sessions WHERE banker_id=$1 AND status=\'closed\' ORDER BY played_on,id OFFSET $2', [stack.fixture.bankerId, count]);
    const ids = removed.rows.map(row => row.id);
    if (ids.length) {
      await db.query('ALTER TABLE ledger_entries DISABLE TRIGGER ledger_append_only');
      for (const table of ['ledger_entries', 'session_events', 'session_players']) await db.query(`DELETE FROM ${table} WHERE banker_id=$1 AND session_id=ANY($2::uuid[])`, [stack.fixture.bankerId, ids]);
      await db.query('DELETE FROM game_sessions WHERE banker_id=$1 AND id=ANY($2::uuid[])', [stack.fixture.bankerId, ids]);
      await db.query('ALTER TABLE ledger_entries ENABLE TRIGGER ledger_append_only');
    }
    await db.query('COMMIT');
    await db.query('VACUUM ANALYZE');
  } catch (error) {
    await withShutdownDeadline('Players profile fixture rollback', () => db.query('ROLLBACK'));
    throw error;
  } finally {
    db.release();
  }
}

async function counts(stack: Stack, closed: number) {
  const result = await stack.database.pool.query<Record<string, number>>(`SELECT
    (SELECT count(*)::int FROM bankers) AS bankers,
    (SELECT count(*)::int FROM players WHERE banker_id=$1) AS main_players,
    (SELECT count(*)::int FROM game_sessions WHERE banker_id=$1 AND status='closed') AS main_closed_sessions,
    (SELECT count(*)::int FROM game_sessions WHERE banker_id=$1 AND status='open') AS main_open_sessions,
    (SELECT count(*)::int FROM game_sessions WHERE banker_id<>$1 AND status='closed') AS other_closed_sessions,
    (SELECT count(*)::int FROM session_players WHERE banker_id=$1) AS main_seats,
    (SELECT count(*)::int FROM ledger_entries WHERE banker_id=$1) AS main_entries,
    (SELECT count(*)::int FROM ledger_entries WHERE banker_id=$1 AND session_id=$2) AS main_open_entries,
    (SELECT count(*)::int FROM session_players WHERE banker_id=$1 AND session_id=$2) AS main_open_players`, [stack.fixture.bankerId, stack.fixture.sessionId]);
  const row = result.rows[0]!;
  assert.equal(row.bankers, 21);
  assert.equal(row.main_players, 40);
  assert.equal(row.main_closed_sessions, closed);
  assert.equal(row.main_open_sessions, 1);
  assert.equal(row.other_closed_sessions, 300);
  assert.equal(row.main_open_players, 9);
  assert.equal(row.main_open_entries, 60);
  return row;
}

function redact(value: unknown) {
  return JSON.stringify(value, null, 2).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '[synthetic-uuid]');
}

async function cpuProfile(stack: Stack, output: string) {
  const inspector = new Session();
  inspector.connect();
  const post = (method: string) => new Promise<Record<string, unknown>>((resolve, reject) => inspector.post(method, (error, result) => error ? reject(error) : resolve(result as Record<string, unknown>)));
  try {
    await post('Profiler.enable');
    await post('Profiler.start');
    for (let index = 0; index < 5; index++) await direct(stack.database.pool, stack.fixture.bankerId, false);
    const { profile } = await withShutdownDeadline('Players profiler stop', () => post('Profiler.stop'));
    await writeFile(join(output, 'direct-300.cpuprofile'), JSON.stringify(profile));
    const data = profile as { nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number } }[]; samples?: number[]; timeDeltas?: number[] };
    const selfMicros = new Map<number, number>();
    for (const [index, id] of (data.samples ?? []).entries()) selfMicros.set(id, (selfMicros.get(id) ?? 0) + (data.timeDeltas?.[index] ?? 0));
    return data.nodes.map(node => ({ function: node.callFrame.functionName, url: node.callFrame.url, line: node.callFrame.lineNumber + 1, selfMs: (selfMicros.get(node.id) ?? 0) / 1000 })).sort((a, b) => b.selfMs - a.selfMs).slice(0, 25);
  } finally {
    inspector.disconnect();
  }
}

const output = resolve(option('--output', 'evidence/bench/players-r12/diagnosis'));
assert(!relative(resolve('evidence/bench'), output).startsWith('..'), 'Profile output must stay inside repository benchmark evidence');
const samples = Number(option('--samples', '5'));
assert(Number.isInteger(samples) && samples >= 5, 'At least five repeated samples are required');
await mkdir(output, { recursive: true });
try {
  await access(join(output, 'summary.json'));
  throw new Error('Profile evidence already exists; choose a fresh --output directory');
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
const owner = createProcessOwner();
const stackController = new AbortController();
let host: Awaited<ReturnType<typeof boundedHost>> | undefined;
let stackTask: Promise<Awaited<ReturnType<typeof benchmarkStack>>> | undefined;
let phase = 'prepare';
let monitor: Awaited<ReturnType<typeof hostMonitor>> | undefined;
let interrupted: NodeJS.Signals | undefined;
let signalStop: Promise<void> = Promise.resolve();
let signalCleanupError: unknown;
let cancel!: (error: Error) => void;
const interruption = new Promise<never>((_, reject) => { cancel = reject; });
void interruption.catch(() => {});
const handlers = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map(signal => {
  const handler = () => {
    if (interrupted) return;
    interrupted = signal;
    const error = new Error(`Players profile interrupted by ${signal}`);
    stackController.abort(error);
    cancel(error);
    process.exitCode = signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 129;
    signalStop = owner.stop().catch(error => { signalCleanupError = error; });
  };
  process.on(signal, handler);
  return { signal, handler };
});
function checkInterrupted() {
  if (interrupted) throw new Error(`Players profile interrupted by ${interrupted}`);
}
async function measure() {
  const stack = await Promise.race([stackTask!, interruption]);
  checkInterrupted();
  const postgres = Number((await readFile(join(stack.database.directory, 'postmaster.pid'), 'utf8')).split('\n')[0]);
  monitor = await hostMonitor(stack.serverPid, postgres, 'no-browser', () => phase, stack.owner);
  const method = {
    claim: 'Diagnose the existing /api/players workload at 30, 100, and 300 closed sessions without changing application code.',
    samplesPerScale: samples,
    order: '300,100,30; warmed instrumented and uninstrumented direct samples alternate order; HTTPS follows each direct pair.',
    scale: 'One fresh embedded PostgreSQL benchmark seed. Keep the earliest N main closed sessions after pruning only owned fixture rows, then VACUUM ANALYZE. Forty owner players, one open table, and twenty background bankers remain constant.',
    directWindow: 'playerRoster only, inside a repeatable-read read-only transaction; excludes connection acquisition, BEGIN, COMMIT, assertions, and JSON byte counting.',
    queryWindow: 'Await of the real pg pool/client query. Includes PostgreSQL execution, loopback transfer, driver JSON decoding, scheduling, and pool acquisition for pool.query authentication. It is not PostgreSQL-only execution time.',
    byteMeaning: 'decodedRowsJsonBytes is UTF-8 JSON.stringify(result.rows), computed after the measured window. It is a decoded-payload proxy, not PostgreSQL wire bytes.',
    socketByteMeaning: 'pgSocketBytes is the increase in connection.stream.bytesRead across an awaited real query. It measures incoming PostgreSQL connection bytes including protocol framing over owned loopback plain TCP, not row payload alone, TLS bytes, or network packet/header bytes. Authentication pool.query sums existing pool._clients counters and asserts their identities remain stable; all probes in this process are serial. Connected-client queries read their own socket counter. BEGIN/SET/COMMIT protocol bytes are included in the full-request trace. Counter reads and validation run outside query timers and add small overhead to the residual; no socket contents or parameters are persisted.',
    residualMeaning: 'jsResidualMs is direct wall time minus serial query awaits. It includes derivation/reduction, allocation, scheduling, GC, and small probe overhead. It is not a pure CPU measurement.',
    httpWindow: 'Existing production local HTTPS server and LocalClient. No query instrumentation in the server. Server-Timing app includes request handling/auth/snapshot/serialization; round trip includes response body read and client JSON parse.',
    fullRequestWindow: 'At 300 sessions only, separate createApp.request diagnostics trace pool.query and connect-client.query through forwarding proxies to the real database. App-handler wall time ends before response body read, assertions, or decoded-row byte counting. It includes authentication, BEGIN/SET/COMMIT, validation, derivation, and response serialization. Residual is handler wall minus serial real query awaits, including connection acquisition outside pool.query, scheduling, GC, and probe overhead. The owned fake-account cookie and all parameters remain only in memory. These samples are separate from production HTTPS timings.',
    explain: 'Separate diagnostic EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON), outside reported timing windows, reruns the dominant captured query with its original in-memory synthetic parameters. UUID literals are redacted in persisted plans.',
    cpuProfile: 'Separate five direct calls at 300 sessions with the Node inspector CPU profiler. Samples from the profiler are excluded from latency distributions.',
    errors: 0,
    host,
    cores: cpus().length,
    loadAverage: loadavg(),
    versions: { node: process.version, postgres: (await stack.database.pool.query<{ version: string }>('SELECT version()')).rows[0]!.version },
    storeSourceSha256: createHash('sha256').update(await readFile('src/server/store.ts')).digest('hex'),
  };
  await writeFile(join(output, 'method.json'), JSON.stringify(method, null, 2));
  const scales = [];
  for (const closed of [300, 100, 30]) {
    checkInterrupted();
    phase = `prepare-${closed}`;
    await retainClosedSessions(stack, closed);
    const work = await counts(stack, closed);
    await direct(stack.database.pool, stack.fixture.bankerId, false);
    const warmHttp = await stack.client.request('/api/players');
    assert.equal(warmHttp.status, 200);
    const instrumented: DirectSample[] = [];
    const uninstrumented: DirectSample[] = [];
    const http: { serverMs: number; roundtripMs: number; responseBytes: number; players: number; status: number }[] = [];
    let explainCapture: QueryCapture | undefined;
    for (let index = 0; index < samples; index++) {
      checkInterrupted();
      phase = `direct-${closed}-${index + 1}`;
      let expected: Awaited<ReturnType<typeof playerRoster>> | undefined;
      for (const instrument of index % 2 === 0 ? [false, true] : [true, false]) {
        const result = await direct(stack.database.pool, stack.fixture.bankerId, instrument);
        if (expected) assert.deepEqual(result.players, expected, 'Probe and plain calls must complete identical work');
        expected = result.players;
        (instrument ? instrumented : uninstrumented).push(result.sample);
        if (instrument) {
          assert(result.captures.length >= 2 && result.captures.length <= 3, 'The roster must execute two or three real domain queries');
          explainCapture = result.captures.reduce((best, query) => query.driverAwaitMs > best.driverAwaitMs ? query : best);
        }
      }
      phase = `http-${closed}-${index + 1}`;
      const response = await stack.client.request('/api/players');
      assert.equal(response.status, 200);
      assert(response.serverMs !== null && Number.isFinite(response.serverMs), 'Production local server must expose Server-Timing');
      const body = response.body as { players: Awaited<ReturnType<typeof playerRoster>> };
      assert.deepEqual(body.players, expected, 'HTTPS and direct roster must have identical completed results');
      http.push({ serverMs: response.serverMs, roundtripMs: response.ms, responseBytes: response.bytes, players: body.players.length, status: response.status });
      monitor.snapshot();
    }
    phase = `full-request-${closed}`;
    const fullRequest = closed === 300 ? await fullRequestSamples(stack, samples) : [];
    if (fullRequest.length) {
      monitor.snapshot();
      await writeFile(join(output, 'full-request-300.json'), JSON.stringify({ samples: fullRequest, queries: summarizeQueries(fullRequest) }, null, 2));
    }
    phase = `explain-${closed}`;
    assert(explainCapture);
    const plan = await stack.database.pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${explainCapture.sql}`, explainCapture.parameters);
    const planPath = `explain-${closed}.json`;
    await writeFile(join(output, planPath), redact({ sql: explainCapture.sql, plan: plan.rows }));
    const querySummary = summarizeQueries(instrumented);
    const scale = {
      closedSessions: closed, work, errors: 0,
      directInstrumentedMs: distribution(instrumented.map(sample => sample.wallMs)),
      directUninstrumentedMs: distribution(uninstrumented.map(sample => sample.wallMs)),
      directProcessCpuMs: distribution(instrumented.map(sample => sample.processCpuMs)),
      driverAwaitMs: distribution(instrumented.map(sample => sample.driverAwaitMs!)),
      pgSocketBytes: distribution(instrumented.map(sample => sample.pgSocketBytes!)),
      jsResidualMs: distribution(instrumented.map(sample => sample.jsResidualMs!)),
      responseJsonBytes: distribution(instrumented.map(sample => sample.responseJsonBytes)),
      httpServerMs: distribution(http.map(sample => sample.serverMs)),
      httpRoundtripMs: distribution(http.map(sample => sample.roundtripMs)),
      httpResponseBytes: distribution(http.map(sample => sample.responseBytes)),
      fullRequest: fullRequest.length ? { appHandlerWallMs: distribution(fullRequest.map(sample => sample.appHandlerWallMs)), processCpuMs: distribution(fullRequest.map(sample => sample.processCpuMs)), driverAwaitMs: distribution(fullRequest.map(sample => sample.driverAwaitMs)), pgSocketBytes: distribution(fullRequest.map(sample => sample.pgSocketBytes)), jsResidualMs: distribution(fullRequest.map(sample => sample.jsResidualMs)), responseJsonBytes: distribution(fullRequest.map(sample => sample.responseJsonBytes)), queries: summarizeQueries(fullRequest) } : null,
      queries: querySummary, explain: planPath,
    };
    scales.push(scale);
    await writeFile(join(output, `samples-${closed}.json`), JSON.stringify({ instrumented, uninstrumented, http, fullRequest }, null, 2));
    await writeFile(join(output, 'summary.json'), JSON.stringify({ method: 'method.json', complete: scales.length === 3, errors: 0, scales }, null, 2));
    console.log(JSON.stringify(scale));
    if (closed === 300) {
      phase = 'cpu-profile-300';
      const hotspots = await cpuProfile(stack, output);
      await writeFile(join(output, 'cpu-hotspots-300.json'), JSON.stringify(hotspots, null, 2));
    }
  }
}
try {
  host = await owner.launch(() => boundedHost(0));
  checkInterrupted();
  stackTask = owner.launch(() => benchmarkStack(output, stackController.signal)).then(async stack => {
    if (interrupted) { await stack.stop(); throw new Error(`Players profile interrupted by ${interrupted}`); }
    return stack;
  });
  void stackTask.catch(() => {});
  await Promise.race([measure(), interruption]);
} catch (error) {
  await withShutdownDeadline('Players profile failure evidence', () => writeFile(join(output, 'failure.json'), JSON.stringify({ phase, errors: 1, message: error instanceof Error ? error.message : String(error) }, null, 2)));
  throw error;
} finally {
  try {
    await withShutdownDeadline('Players profile host evidence', async () => writeFile(join(output, 'host.json'), JSON.stringify(await monitor?.stop() ?? { unavailable: 'Profile interrupted before host monitoring started' }, null, 2)));
  } finally {
    try {
      await signalStop;
      await owner.stop();
      if (signalCleanupError) throw signalCleanupError;
      await withShutdownDeadline('Players profile cleanup evidence', () => writeFile(join(output, 'cleanup.json'), JSON.stringify({ stoppedOwnedStack: true, finished: new Date().toISOString() }, null, 2)));
    } finally {
      for (const { signal, handler } of handlers) process.removeListener(signal, handler);
    }
  }
}
