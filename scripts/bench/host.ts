import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as pause } from 'node:timers/promises';
function processes() {
  return execFileSync('ps', ['-Ao', 'pid=,ppid=,pgid=,%cpu=,rss=,comm='], { encoding: 'utf8' }).split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/);
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]), cpu: Number(match[4]), rssKiB: Number(match[5]), executable: match[6]! }] : [];
  });
}
export async function quietHost(holdSeconds = 10) {
  const cores = Number(execFileSync('sysctl', ['-n', 'hw.ncpu'], { encoding: 'utf8' }).trim());
  let consecutive = 0;
  for (let attempt = 0; attempt < 120; attempt++) {
    const rows = processes();
    const heavy = rows.filter(row => row.pid !== process.pid && row.cpu >= 100);
    const aggregate = rows.filter(row => row.pid !== process.pid).reduce((sum, row) => sum + row.cpu, 0);
    consecutive = heavy.length || aggregate > cores * 20 ? 0 : consecutive + 1;
    if (consecutive >= Math.ceil(holdSeconds / 5) + 1) return { cores, uptime: execFileSync('uptime', { encoding: 'utf8' }).trim(), observedOtherCpu: rows.filter(row => row.pid !== process.pid).reduce((sum, row) => sum + row.cpu, 0), heavyProcesses: [] };
    if (!heavy.length && aggregate > cores * 20) console.log(`Waiting for a quiet mini: other CPU ${aggregate.toFixed(1)}% exceeds ${cores * 20}%`);
    if (heavy.length) console.log(`Waiting for a quiet mini: ${heavy.map(row => `${basename(row.executable)} ${row.cpu}%`).join(', ')}`);
    await pause(5000);
  }
  throw new Error('Mini still has another heavy workload; no baseline sample collected');
}
export function hostMonitor(serverGroup: number, postgres: number, engine: string, phase: () => string) {
  const lag = monitorEventLoopDelay({ resolution: 20 }); lag.enable();
  const samples: { elapsedMs: number; phase: string; serverCpu: number; browserCpu: number; databaseCpu: number; controllerCpu: number | null; browserMemoryKiB: number; browserProcesses: number; otherCpu: number; otherHeavy: { executable: string; cpu: number }[] }[] = [];
  const started = performance.now();
  const interval = setInterval(() => {
    const rows = processes();
    const server = rows.filter(row => row.group === serverGroup);
    const browser = rows.filter(row => row.executable.startsWith(`${engine}/`));
    const database = rows.filter(row => row.pid === postgres || row.parent === postgres);
    const controller = rows.find(row => row.pid === process.pid);
    const own = new Set([...server, ...browser, ...database, ...(controller ? [controller] : [])].map(row => row.pid));
    samples.push({ phase: phase(), elapsedMs: performance.now() - started, serverCpu: server.reduce((sum, row) => sum + row.cpu, 0), browserCpu: browser.reduce((sum, row) => sum + row.cpu, 0), databaseCpu: database.reduce((sum, row) => sum + row.cpu, 0), controllerCpu: controller?.cpu ?? null, browserMemoryKiB: browser.reduce((sum, row) => sum + row.rssKiB, 0), browserProcesses: browser.length, otherCpu: rows.filter(row => !own.has(row.pid)).reduce((sum, row) => sum + row.cpu, 0), otherHeavy: rows.filter(row => !own.has(row.pid) && row.cpu >= 100).map(row => ({ executable: basename(row.executable), cpu: row.cpu })) });
  }, 500);
  return () => {
    clearInterval(interval); lag.disable();
    return { samples, eventLoopDelayMs: { median: lag.percentile(50) / 1e6, p95: lag.percentile(95) / 1e6, max: lag.max / 1e6 }, cpuPercentMeaning: '100% is one core; process lifetime-decayed ps readings, sampled every 500 ms' };
  };
}
