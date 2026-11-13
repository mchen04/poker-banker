import { cpus } from 'node:os';
import { createProcessOwner, withShutdownDeadline, type ProcessOwner } from '../owned-process';
import { runOwned } from '../owned-command';
import { basename } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as pause } from 'node:timers/promises';
async function processes(owner: ProcessOwner) {
  return (await runOwned(owner, 'ps', ['-Ao', 'pid=,ppid=,pgid=,%cpu=,rss=,comm='])).split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/);
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]), cpu: Number(match[4]), rssKiB: Number(match[5]), executable: match[6]! }] : [];
  });
}
export function hostPolicy(cores: number, otherCpu: number) {
  const threshold = cores * 50;
  return { cores, otherCpu, threshold, noisyHost: otherCpu >= threshold };
}
export async function boundedHost(waitMs = 120000) {
  const owner = createProcessOwner();
  const cores = cpus().length;
  try {
    const started = performance.now();
    while (true) {
      const rows = await processes(owner);
      const policy = hostPolicy(cores, rows.filter(row => row.pid !== process.pid).reduce((sum, row) => sum + row.cpu, 0));
      const waitedMs = performance.now() - started;
      if (!policy.noisyHost || waitedMs >= waitMs) return { ...policy, waitedMs, uptime: (await runOwned(owner, 'uptime')).trim() };
      console.log(`Host wait: other CPU ${policy.otherCpu.toFixed(1)}%, target below ${policy.threshold}%; proceeding within ${Math.ceil((waitMs - waitedMs) / 1000)}s`);
      await pause(Math.min(5000, waitMs - waitedMs));
    }
  } finally { await owner.stop(); }
}
export async function hostMonitor(serverGroup: number, postgres: number, engine: string, phase: () => string, parent?: ProcessOwner) {
  const owner = createProcessOwner({ parent });
  const lag = monitorEventLoopDelay({ resolution: 20 }); lag.enable();
  const samples: { epochMs: number; elapsedMs: number; phase: string; serverCpu: number; browserCpu: number; databaseCpu: number; controllerCpu: number | null; browserMemoryKiB: number; browserProcesses: number; otherCpu: number; otherHeavy: { executable: string; cpu: number }[] }[] = [];
  const started = performance.now();
  const capture = async () => {
    const rows = await processes(owner);
    const server = rows.filter(row => row.group === serverGroup);
    const browser = rows.filter(row => row.executable.startsWith(`${engine}/`));
    const database = rows.filter(row => row.pid === postgres || row.parent === postgres);
    const controller = rows.find(row => row.pid === process.pid);
    const own = new Set([...server, ...browser, ...database, ...(controller ? [controller] : [])].map(row => row.pid));
    const load = { epochMs: Date.now(), phase: phase(), elapsedMs: performance.now() - started, serverCpu: server.reduce((sum, row) => sum + row.cpu, 0), browserCpu: browser.reduce((sum, row) => sum + row.cpu, 0), databaseCpu: database.reduce((sum, row) => sum + row.cpu, 0), controllerCpu: controller?.cpu ?? null, browserMemoryKiB: browser.reduce((sum, row) => sum + row.rssKiB, 0), browserProcesses: browser.length, otherCpu: rows.filter(row => !own.has(row.pid)).reduce((sum, row) => sum + row.cpu, 0), otherHeavy: rows.filter(row => !own.has(row.pid) && row.cpu >= 100).map(row => ({ executable: basename(row.executable), cpu: row.cpu })) };
    samples.push(load);
    return load;
  };
  await capture();
  let pending: Promise<unknown> | undefined;
  let captureFailure: unknown;
  const interval = setInterval(() => { if (!pending) { pending = capture().catch(error => { if (!owner.signal.aborted) captureFailure ??= error; throw error; }).finally(() => { pending = undefined; }); void pending.catch(() => {}); } }, 500);
  owner.addCleanup('Benchmark host sampling stop', 'cleanup', () => { clearInterval(interval); lag.disable(); });
  const summary = () => ({ samples, eventLoopDelayMs: { median: lag.percentile(50) / 1e6, p95: lag.percentile(95) / 1e6, max: lag.max / 1e6 }, cpuPercentMeaning: '100% is one core; process lifetime-decayed ps readings, sampled every 500 ms' });
  let stopping: Promise<ReturnType<typeof summary>> | undefined;
  return { snapshot: (epoch = Date.now()) => samples.reduce((best, row) => Math.abs(row.epochMs - epoch) < Math.abs(best.epochMs - epoch) ? row : best), stop: () => stopping ??= (async () => {
    clearInterval(interval); lag.disable();
    const capture = pending;
    const errors: unknown[] = [];
    try { await withShutdownDeadline('Benchmark host capture shutdown', () => Promise.allSettled(capture ? [capture] : [])); } catch (error) { errors.push(error); }
    try { await owner.stop(); } catch (error) { errors.push(error); }
    if (captureFailure) errors.push(captureFailure);
    if (errors.length) throw new AggregateError(errors, 'Benchmark host sampling cleanup failed');
    return summary();
  })() };
}
