import { mkdir, writeFile, readFile, access, cp, rm, readdir } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { hostname, cpus, platform, arch } from 'node:os';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { benchmarkStack } from './bench/stack';
import { isolatedEngine, primeEngine } from './bench/profile';
import { benchmarkBrowser } from './bench/browser';
import { benchmarkReads, benchmarkWrites } from './bench/api';
import { explainBenchmark } from './bench/explain';
import { summarize, workSummary } from './bench/stats';
import { boundedHost, hostMonitor, hostPolicy } from './bench/host';
import type { Sample } from './bench/types';
import { createProcessOwner, withShutdownDeadline } from './owned-process';
import { runOwned } from './owned-command';
const args = process.argv.slice(2);
const option = (name: string, fallback: string) => args.includes(name) ? args[args.indexOf(name) + 1]! : fallback;
const smoke = args.includes('--smoke');
const journeys = args.includes('--journeys');
const workload = option('--workload', 'large') as 'small' | 'large' | 'long';
assert(['small', 'large', 'long'].includes(workload));
const memoryCycles = Number(option('--memory-cycles', '0'));
assert(Number.isInteger(memoryCycles) && memoryCycles >= 0 && memoryCycles <= 50);
const runs = Number(option('--runs', smoke ? '1' : '5'));
const count = Number(option('--samples', smoke ? '1' : journeys ? '4' : '2'));
assert(Number.isInteger(runs) && runs >= 1 && runs <= 50);
assert(Number.isInteger(count) && count >= 1 && count <= 20);
assert.equal(process.platform, 'darwin', 'This synthetic WebKit CPU profile is verified on the mini macOS runner');
const stamp = new Date().toISOString().replace(/[-:.]/g, '');
const output = resolve(option('--output', `evidence/bench/${smoke ? `smoke-${stamp}` : 'baseline'}`));
assert(!relative(resolve('evidence/bench'), output).startsWith('..'), 'Benchmark evidence must stay inside this repository');
await mkdir(output, { recursive: true });
try { await access(join(output, 'run-01')); throw new Error('Output already contains a run; keep it and choose a fresh --output directory'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
const waitMs = Number(option('--wait-ms', '120000'));
assert(Number.isFinite(waitMs) && waitMs >= 0 && waitMs <= 120000);
const metrics = args.includes('--metrics') ? new Set(option('--metrics', '').split(',')) : undefined;
const wantsBrowser = !metrics || [...metrics].some(metric => !metric.startsWith('api.'));
const owner = createProcessOwner();
let engine: Awaited<ReturnType<typeof isolatedEngine>> | undefined;
let interrupted: NodeJS.Signals | undefined;
let signalStop: Promise<void> = Promise.resolve();
let signalCleanupError: unknown;
const interruptionController = new AbortController();
const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
const stopForSignal = (signal: NodeJS.Signals) => {
  if (interrupted) return;
  interrupted = signal; process.exitCode = signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 129;
  interruptionController.abort(new Error(`Benchmark interrupted by ${signal}`));
  signalStop = owner.stop().catch(error => { signalCleanupError = error; });
};
const checkInterrupted = () => { if (interrupted) throw new Error(`Benchmark interrupted by ${interrupted}`); };
function running<T>(action: () => Promise<T>): Promise<T> {
  checkInterrupted();
  return owner.launch(action);
}
const handlers = signals.map(signal => { const handler = () => stopForSignal(signal); process.on(signal, handler); return { signal, handler }; });
const ownedMessage = (message: unknown) => { if (message && typeof message === 'object' && 'type' in message && message.type === 'pb-shutdown') stopForSignal('SIGTERM'); };
const ownedDisconnect = () => stopForSignal('SIGTERM');
if (typeof process.send === 'function') {
  process.on('message', ownedMessage); process.on('disconnect', ownedDisconnect);
  if (!process.connected) ownedDisconnect();
}
try {
const preflight = await running(() => boundedHost(waitMs));
const release = args.includes('--skip-build') ? (await readFile('dist/index.html', 'utf8')).match(/name="pb-release" content="([^"]+)"/)?.[1] : `bench-${stamp}`;
assert(release, 'Prebuilt assets must have a release stamp');
if (!args.includes('--skip-build')) await runOwned(owner, 'pnpm', ['build'], { stdio: 'inherit', env: { ...process.env, RELEASE_VERSION: release } });
let updateReleases: { beforePath: string; afterPath: string; beforeRelease: string; afterRelease: string } | undefined;
if (journeys && (!metrics || metrics.has('update.adoption'))) {
  const beforePath = join(output, 'release-A'), afterPath = join(output, 'release-B');
  await running(() => cp('dist', beforePath, { recursive: true }));
  const afterRelease = `${release}-next`;
  await runOwned(owner, 'pnpm', ['build'], { stdio: 'inherit', env: { ...process.env, RELEASE_VERSION: afterRelease } });
  await running(() => cp('dist', afterPath, { recursive: true }));
  await running(() => rm('dist', { recursive: true, force: true }));
  await running(() => cp(beforePath, 'dist', { recursive: true }));
  updateReleases = { beforePath, afterPath, beforeRelease: release, afterRelease };
}
const bundleAssets = await Promise.all((await readdir('dist/assets')).filter(name => /\.(js|css)$/.test(name)).map(async name => {
  const body = await readFile(join('dist/assets', name));
  return { path: `/assets/${name}`, rawBytes: body.length, gzipBytes: gzipSync(body).length, brotliBytes: brotliCompressSync(body).length, sha256: createHash('sha256').update(body).digest('hex') };
}));
const harnessFiles = ['scripts/bench.ts', 'scripts/bench-compare.ts', 'pnpm-lock.yaml', ...(await readdir('scripts/bench', { recursive: true })).filter(name => name.endsWith('.ts')).map(name => `scripts/bench/${name}`)].sort();
const harnessSha256 = createHash('sha256').update((await Promise.all(harnessFiles.map(async name => `${name}\0${await readFile(name, 'utf8')}`))).join('\0')).digest('hex');
const machine = { hostname: hostname(), platform: platform(), architecture: arch(), logicalCores: cpus().length, cpuModel: cpus()[0]?.model };
const versions = { node: process.versions.node, postgres: '', react: (JSON.parse(await readFile('node_modules/react/package.json', 'utf8')) as { version: string }).version, vite: (JSON.parse(await readFile('node_modules/vite/package.json', 'utf8')) as { version: string }).version, playwright: (JSON.parse(await readFile('node_modules/@playwright/test/package.json', 'utf8')) as { version: string }).version, release };
await writeFile(join(output, 'method.json'), JSON.stringify({ preflight, versions, machine, harnessSha256, harnessFiles, workload, dataset: workload === 'small' ? 'small' : 'large', journeys, memoryCycles, bundleAssets, updateReleases, runs, repeatedSamples: count, reported: !smoke, profile: 'Synthetic 25ms/100ms owned WebKit CPU budget;60ms latency;2Mbps aggregate down;512Kbps up', order: journeys ? 'Sign-in precedes disposable session creation. Odd runs forward other journey/API order; even reverse. Within a run, successive samples reverse journey order.' : 'Odd runs workspace/viewer,cold/warm,1/10/25; even reverse and reverse API reads', output }, null, 2));
const allSamples: Sample[] = [];
const runSummaries: unknown[] = [];
  if (wantsBrowser) {
    engine = await running(async () => engine = await isolatedEngine(owner));
    checkInterrupted();
    await owner.launch(() => primeEngine(engine!, interruptionController.signal));
  }
  for (let index = 0; index < runs; index++) {
    checkInterrupted();
    if (index > 0) await running(() => pause(5000));
    checkInterrupted();
    const host = await running(() => boundedHost(0));
    checkInterrupted();
    const directory = join(output, `run-${String(index + 1).padStart(2, '0')}`); await running(() => mkdir(directory));
    console.log(`Benchmark run ${index + 1}/${runs}, ${index % 2 ? 'reverse' : 'forward'} order; production ${release}`);
    const samples: Sample[] = [];
    const stack = await running(() => benchmarkStack(directory, interruptionController.signal, { workload }));
    let phase = 'prepare';
    let monitorRun: Awaited<ReturnType<typeof hostMonitor>> | undefined;
    let failure: string | undefined;
    try {
      checkInterrupted();
      const ownBackend = Number((await running(() => stack.database.pool.query('SELECT pg_backend_pid() AS pid'))).rows[0]!.pid);
      const postmaster = Number((await runOwned(owner, 'ps', ['-p', String(ownBackend), '-o', 'ppid='])).trim());
      monitorRun = await hostMonitor(stack.serverPid, postmaster, engine?.engine ?? resolve('.cache/nonexistent-benchmark-engine'), () => phase, stack.owner);
      versions.postgres = String((await running(() => stack.database.pool.query('SELECT version() AS version'))).rows[0]!.version);
      await running(() => writeFile(join(directory, 'seed.json'), JSON.stringify({ counts: stack.fixture.counts, versions, host, order: index % 2 ? 'reverse' : 'forward', startingOpenEntries: stack.fixture.counts.main_open_entries }, null, 2)));
      const record = (sample: Sample) => { if (!Number.isFinite(sample.ms) || sample.ms < 0) throw new Error(`Invalid timing for ${sample.metric}`); const load = monitorRun!.snapshot(Number(sample.work.renderedEpoch ?? sample.work.confirmedEpoch ?? Date.now())); samples.push({ ...sample, host: { ...hostPolicy(host.cores, load.otherCpu), serverCpu: load.serverCpu, browserCpu: load.browserCpu, controllerCpu: load.controllerCpu }, evidence: { ...sample.evidence, machine, build: release, harnessSha256, dataset: stack.fixture.dataset, workload, bundleAssets }, work: { ...sample.work, run: index + 1, dataset: stack.fixture.dataset ?? (workload === 'small' ? 'small' : 'large'), workload }, recordedAt: new Date().toISOString() }); };
      phase = 'api.reads';
      await running(() => benchmarkReads(stack.client, stack.database.pool, stack.fixture, record, { samples: count, reverse: index % 2 === 1, metrics }));
      console.log(`Run ${index + 1}: API reads complete; measuring WebKit user paths`);
      if (wantsBrowser) await running(() => benchmarkBrowser(stack, engine!, directory, record, { samples: count, reverse: index % 2 === 1, phase: value => { phase = value; }, metrics, journeys, memoryCycles, updateReleases }));
      phase = 'api.write10';
      if (!metrics || metrics.has('api.write10')) await running(() => benchmarkWrites(stack.client, stack.database.pool, stack.fixture, record, { samples: count }));
      await running(() => explainBenchmark(stack.database.pool, stack.fixture, directory));
      assert.equal(stack.proxy.counts.upstreamErrors, 0, 'No unexplained proxy errors');
      assert(samples.every(sample => sample.ok), 'All reported samples must validate completed work');
    } catch (error) { failure = (error instanceof Error ? error.stack : String(error))?.replaceAll(stack.fixture.password, 'OWNED_SECRET').replaceAll(stack.fixture.token, 'OWNED_TOKEN'); console.error(`Run ${index + 1} failed: ${failure}`); throw error; }
    finally {
      try {
        let monitorError: unknown;
        const monitor = await monitorRun?.stop().catch(error => { monitorError = error; return undefined; });
        const noise = monitor?.samples.filter(sample => sample.otherCpu >= host.cores * 50) ?? [];
        const measured = monitor?.samples.filter(sample => !sample.phase.startsWith('prepare')) ?? [];
        const saturated = !!monitor && monitor.eventLoopDelayMs.p95 > 100 && measured.some(sample => sample.browserCpu >= host.cores * 85 || (sample.controllerCpu ?? 0) >= 90);
        const noisyHost = preflight.noisyHost || host.noisyHost || noise.length > 0;
        if (noisyHost) console.log(`Run ${index + 1}: noisy host; timings retained with host observations`);
        await withShutdownDeadline('Benchmark sample evidence', () => writeFile(join(directory, 'samples.json'), JSON.stringify(samples, null, 2)));
        await withShutdownDeadline('Benchmark host evidence', () => writeFile(join(directory, 'host.json'), JSON.stringify({ ...(monitor ?? { unavailable: 'Interrupted before host monitor started' }), unrelatedHeavyObservations: noise.length, loadGeneratorSaturated: saturated }, null, 2)));
        const summary = { run: index + 1, order: index % 2 ? 'reverse' : 'forward', metrics: summarize(samples), noisyHost, loadGeneratorSaturated: saturated, host, error: failure ?? (monitorError ? String(monitorError) : null), proxy: stack.proxy.counts };
        await withShutdownDeadline('Benchmark run summary', () => writeFile(join(directory, 'summary.json'), JSON.stringify(summary, null, 2)));
        allSamples.push(...samples); runSummaries.push(summary);
        if (monitorError) throw monitorError;
      } finally {
        await stack.stop();
        await withShutdownDeadline('Benchmark cleanup evidence', () => writeFile(join(directory, 'cleanup.json'), JSON.stringify({ stoppedOwnedServerPid: stack.serverPid, databaseStopped: true, retainedEvidence: directory, finished: new Date().toISOString() }, null, 2)));
      }
    }
    console.log(`Run ${index + 1} complete: ${samples.length} samples, ${samples.filter(sample => !sample.ok).length} errors`);
  }
  const summary = { versions, machine, harnessSha256, workload, bundleAssets, runs: runSummaries, metrics: summarize(allSamples), hostPolicy: 'bounded120s, below50% core capacity; noisy samples retained', noisyHost: runSummaries.some(run => (run as { noisyHost: boolean }).noisyHost), errors: allSamples.filter(sample => !sample.ok).length };
  await running(() => writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2)));
  console.log('Metric | samples | errors | median ms | p95 ms | range ms | completed work');
  for (const row of summary.metrics) console.log(`${row.metric} | ${row.samples} | ${row.errors} | ${row.median?.toFixed(2) ?? 'unavailable'} | ${row.p95?.toFixed(2) ?? 'unavailable'} | ${row.min?.toFixed(2) ?? 'n/a'}..${row.max?.toFixed(2) ?? 'n/a'} | ${workSummary(row.metric, allSamples)}`);
  console.log(`Evidence ${output}`);
} catch (error) { if (!interrupted) throw error; console.error(`Benchmark interrupted by ${interrupted}`); }
finally {
  try { await signalStop; } finally {
    try { await owner.stop(); }
    finally {
      for (const { signal, handler } of handlers) process.removeListener(signal, handler);
      process.removeListener('message', ownedMessage);
      process.removeListener('disconnect', ownedDisconnect);
    }
  }
  if (signalCleanupError) throw signalCleanupError;
}
