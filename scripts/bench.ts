import { spawnSync, execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { benchmarkStack } from './bench/stack';
import { isolatedEngine, primeEngine } from './bench/profile';
import { benchmarkBrowser } from './bench/browser';
import { benchmarkReads, benchmarkWrites } from './bench/api';
import { explainBenchmark } from './bench/explain';
import { summarize, workSummary } from './bench/stats';
import { quietHost, hostMonitor } from './bench/host';
import type { Sample } from './bench/types';
const args = process.argv.slice(2);
const option = (name: string, fallback: string) => args.includes(name) ? args[args.indexOf(name) + 1]! : fallback;
const smoke = args.includes('--smoke'), profileOnly = args.includes('--profile-only');
const runs = Number(option('--runs', smoke || profileOnly ? '1' : '5'));
const count = Number(option('--samples', smoke ? '1' : '2'));
assert(Number.isInteger(runs) && runs >= 1 && runs <= 10);
assert(Number.isInteger(count) && count >= 1 && count <= 20);
assert.equal(process.platform, 'darwin', 'This synthetic WebKit CPU profile is verified on the mini macOS runner');
const stamp = new Date().toISOString().replace(/[-:.]/g, '');
const output = resolve(option('--output', `evidence/bench/${smoke ? `smoke-${stamp}` : profileOnly ? `diagnostic-${stamp}` : 'baseline'}`));
assert(!relative(resolve('evidence/bench'), output).startsWith('..'), 'Benchmark evidence must stay inside this repository');
await mkdir(output, { recursive: true });
try { await access(join(output, 'run-01')); throw new Error('Output already contains a run; keep it and choose a fresh --output directory'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
const preflight = await quietHost(smoke || profileOnly ? 10 : 60);
const release = `bench-${stamp}`;
const build = spawnSync('pnpm', ['build'], { stdio: 'inherit', env: { ...process.env, RELEASE_VERSION: release } });
assert.equal(build.status, 0, 'Production benchmark build must pass');
const versions = { node: process.versions.node, postgres: '', react: (JSON.parse(await readFile('node_modules/react/package.json', 'utf8')) as { version: string }).version, vite: (JSON.parse(await readFile('node_modules/vite/package.json', 'utf8')) as { version: string }).version, playwright: (JSON.parse(await readFile('node_modules/@playwright/test/package.json', 'utf8')) as { version: string }).version, release };
await writeFile(join(output, 'method.json'), JSON.stringify({ preflight, versions, runs, repeatedSamples: count, reported: !smoke && !profileOnly, claim: 'Baseline measurement only; no optimization or faster/slower comparison', profile: 'Synthetic 25ms/100ms owned WebKit CPU budget;60ms latency;2Mbps aggregate down;512Kbps up', order: 'Odd runs workspace/viewer,cold/warm,1/10/25; even runs reverse these orders and API read order', output }, null, 2));
const allSamples: Sample[] = [];
const runSummaries: unknown[] = [];
let engine: Awaited<ReturnType<typeof isolatedEngine>> | undefined;
try {
  if (!profileOnly) { engine = await isolatedEngine(); await primeEngine(engine); }
  for (let index = 0; index < runs; index++) {
    if (index > 0) await pause(5000);
    const host = await quietHost();
    const directory = join(output, `run-${String(index + 1).padStart(2, '0')}`); await mkdir(directory);
    console.log(`Benchmark run ${index + 1}/${runs}, ${index % 2 ? 'reverse' : 'forward'} order; production ${release}`);
    const samples: Sample[] = [];
    const stack = await benchmarkStack(directory, profileOnly);
    const ownBackend = Number((await stack.database.pool.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid);
    const postmaster = Number(execFileSync('ps', ['-p', String(ownBackend), '-o', 'ppid='], { encoding: 'utf8' }).trim());
    let phase = 'prepare';
    const stopMonitor = hostMonitor(stack.serverPid, postmaster, engine?.engine ?? resolve('.cache/nonexistent-benchmark-engine'), () => phase);
    let failure: string | undefined;
    try {
      versions.postgres = String((await stack.database.pool.query('SELECT version() AS version')).rows[0]!.version);
      await writeFile(join(directory, 'seed.json'), JSON.stringify({ counts: stack.fixture.counts, versions, host, order: index % 2 ? 'reverse' : 'forward', startingOpenEntries: 60 }, null, 2));
      const record = (sample: Sample) => { if (!Number.isFinite(sample.ms) || sample.ms < 0) throw new Error(`Invalid timing for ${sample.metric}`); samples.push({ ...sample, work: { ...sample.work, run: index + 1 }, recordedAt: new Date().toISOString() }); };
      phase = 'api.reads';
      if (profileOnly) {
        await benchmarkReads(stack.client, stack.database.pool, stack.fixture, record, { samples: count });
        for (let repeat = 0; repeat < 20; repeat++) assert.equal((await stack.client.request('/api/players')).status, 200);
        await explainBenchmark(stack.database.pool, stack.fixture, directory);
      } else {
        await benchmarkReads(stack.client, stack.database.pool, stack.fixture, record, { samples: count, reverse: index % 2 === 1 });
        console.log(`Run ${index + 1}: API reads complete; measuring WebKit user paths`);
        await benchmarkBrowser(stack, engine!, directory, record, { samples: count, reverse: index % 2 === 1, phase: value => { phase = value; } });
        phase = 'api.write10';
        await benchmarkWrites(stack.client, stack.database.pool, stack.fixture, record, { samples: count });
        await explainBenchmark(stack.database.pool, stack.fixture, directory);
        assert.equal(stack.proxy.counts.upstreamErrors, 0, 'No unexplained proxy errors');
        assert(samples.every(sample => sample.ok), 'All reported samples must validate completed work');
      }
    } catch (error) { failure = error instanceof Error ? error.stack : String(error); throw error; }
    finally {
      const monitor = stopMonitor();
      const noise = monitor.samples.filter(sample => sample.otherHeavy.length > 0 || sample.otherCpu > host.cores * 20);
      const measured = monitor.samples.filter(sample => !sample.phase.startsWith('prepare'));
      const saturated = monitor.eventLoopDelayMs.p95 > 100 && measured.some(sample => sample.browserCpu >= host.cores * 85 || (sample.controllerCpu ?? 0) >= 90);
      const invalidHost = noise.length > 0 || saturated;
      if (invalidHost && !failure) failure = `Host invalid for baseline: ${noise.length} unrelated-heavy observations, load-generator saturation=${saturated}`;
      try {
        await writeFile(join(directory, 'samples.json'), JSON.stringify(samples, null, 2));
        await writeFile(join(directory, 'host.json'), JSON.stringify({ ...monitor, unrelatedHeavyObservations: noise.length, loadGeneratorSaturated: saturated }, null, 2));
        const summary = { run: index + 1, order: index % 2 ? 'reverse' : 'forward', metrics: summarize(samples), error: failure ?? null, proxy: stack.proxy.counts };
        await writeFile(join(directory, 'summary.json'), JSON.stringify(summary, null, 2));
        allSamples.push(...samples); runSummaries.push(summary);
      } finally {
        await stack.stop();
        await writeFile(join(directory, 'cleanup.json'), JSON.stringify({ stoppedOwnedServerPid: stack.serverPid, databaseStopped: true, retainedEvidence: directory, finished: new Date().toISOString() }, null, 2));
      }
      if (invalidHost) throw new Error(failure);
    }
    console.log(`Run ${index + 1} complete: ${samples.length} samples, ${samples.filter(sample => !sample.ok).length} errors`);
  }
  const summary = { versions, runs: runSummaries, metrics: summarize(allSamples), errors: allSamples.filter(sample => !sample.ok).length };
  await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log('Metric | samples | errors | median ms | p95 ms | range ms | completed work');
  for (const row of summary.metrics) console.log(`${row.metric} | ${row.samples} | ${row.errors} | ${row.median?.toFixed(2) ?? 'unavailable'} | ${row.p95?.toFixed(2) ?? 'unavailable'} | ${row.min?.toFixed(2) ?? 'n/a'}..${row.max?.toFixed(2) ?? 'n/a'} | ${workSummary(row.metric, allSamples)}`);
  console.log(`Evidence ${output}`);
} finally { await engine?.cleanup(); }
