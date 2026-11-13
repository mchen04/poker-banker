import assert from 'node:assert/strict';
import { type ChildProcess } from 'node:child_process';
import { createProcessOwner, spawnOwned, stopOwned, withShutdownDeadline } from './owned-process';
import { mkdir, readFile, cp, writeFile } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { summarize } from './bench/stats';
import type { Sample } from './bench/types';

const [id, beforePath, afterPath, metrics, ...extra] = process.argv.slice(2);
const option = (name: string, fallback: string) => extra.includes(name) ? extra[extra.indexOf(name) + 1]! : fallback;
const count = Number(option('--samples', '1'));
assert(Number.isInteger(count) && count >= 1 && count <= 20);
const workload = option('--workload', 'large');
assert(['small', 'large', 'long'].includes(workload));
const journeys = extra.includes('--journeys');
assert(id && /^[a-z0-9-]+$/.test(id) && beforePath && afterPath && metrics, 'Usage: tsx scripts/bench-compare.ts ID BEFORE_DIRECTORY AFTER_DIRECTORY METRICS');
const root = resolve('.');
const output = resolve(option('--output', `evidence/bench/hillclimb/${id}`));
assert(!relative(resolve('evidence/bench'), output).startsWith('..'));
await mkdir(output, { recursive: true });
const results: { side: string; pair: number; metrics: ReturnType<typeof summarize>; samples: Sample[]; noisyHost: boolean }[] = [];
const owner = createProcessOwner();
let child: ChildProcess | undefined;
let stopping: Promise<void> | undefined;
let interrupted: NodeJS.Signals | undefined;
let signalFailure: unknown;
const aborted = new Promise<never>((_, reject) => owner.signal.addEventListener('abort', () => reject(new Error('Comparison interrupted')), { once: true }));
void aborted.catch(() => {});
const stop = () => child ? stopping ??= stopOwned(child) : Promise.resolve();
const checkInterrupted = () => { if (interrupted) throw new Error(`Comparison interrupted by ${interrupted}`); };
const running = async <T>(action: () => Promise<T>): Promise<T> => {
  checkInterrupted();
  return Promise.race([Promise.resolve().then(() => { checkInterrupted(); return action(); }), aborted]);
};
const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
const handlers = signals.map(signal => {
  const handler = () => {
    if (interrupted) return;
    interrupted = signal;
    process.exitCode = signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 129;
    void owner.stop().catch(error => { signalFailure = error; });
  };
  process.on(signal, handler);
  return { signal, handler };
});
try {
  for (let pair = 1; pair <= 5; pair++) for (const [side, directory] of (pair % 2 ? [['A', beforePath], ['B', afterPath]] as const : [['B', afterPath], ['A', beforePath]] as const)) {
    checkInterrupted();
    const cwd = resolve(directory);
    assert(!relative(root, cwd).startsWith('..'), 'Comparison worktrees must stay in the project');
    const destination = `evidence/bench/comparison-${id}-${side}-${pair}`;
    console.log(`Comparison ${id} pair ${pair}/5 side ${side}`);
    child = spawnOwned(owner, process.execPath, ['--import', 'tsx', 'scripts/bench.ts', '--runs', '1', '--samples', String(count), '--workload', workload, ...(journeys ? ['--journeys'] : []), '--memory-cycles', '0', '--wait-ms', '0', '--skip-build', '--metrics', metrics, '--output', destination], { cwd, detached: true, stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
    stopping = undefined;
    await running(() => new Promise<void>((done, reject) => {
      child!.once('error', reject); child!.once('exit', code => code === 0 ? done() : reject(new Error(`${side}${pair} failed: ${code}`)));
    }));
    await stop();
    child = undefined;
    stopping = undefined;
    checkInterrupted();
    const receipt = join(output, `${side}-${pair}`);
    await running(() => cp(join(cwd, destination), receipt, { recursive: true, errorOnExist: true, force: false }));
    const summary = JSON.parse(await running(() => readFile(join(receipt, 'summary.json'), 'utf8'))) as { noisyHost: boolean };
    const samples = JSON.parse(await running(() => readFile(join(receipt, 'run-01/samples.json'), 'utf8'))) as Sample[];
    assert(samples.length && samples.every(sample => sample.ok), 'Every comparison must complete measured work without errors');
    results.push({ side, pair, metrics: summarize(samples), samples, noisyHost: summary.noisyHost });
    await running(() => writeFile(join(output, 'runs.json'), JSON.stringify(results, null, 2)));
  }
} catch (error) { if (!interrupted) throw error; }
finally {
  try { await owner.stop(); }
  finally { for (const { signal, handler } of handlers) process.removeListener(signal, handler); }
  if (signalFailure) throw signalFailure;
}
if (!interrupted) {
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
  const comparisons = metrics.split(',').map(metric => {
    const values = (side: string) => results.filter(run => run.side === side).map(run => run.metrics.find(row => row.metric === metric)!.median!);
    const before = values('A'), after = values('B');
    const a = median(before), b = median(after);
    const spread = (values: number[]) => median(values.map(value => Math.abs(value - median(values))));
    const wins = after.filter((value, index) => value < before[index]!).length;
    return { metric, before, after, beforeMedian: a, afterMedian: b, deltaPercent: (b - a) / a * 100, beforeRange: [Math.min(...before), Math.max(...before)], afterRange: [Math.min(...after), Math.max(...after)], pairedWins: wins, noiseFloorMs: Math.max(spread(before), spread(after)), clearsNoise: wins === 5 && a - b > Math.max(spread(before), spread(after)) };
  });
  await withShutdownDeadline('Comparison final evidence', () => writeFile(join(output, 'comparison.json'), JSON.stringify({ id, order: 'Five pairs alternating A,B / B,A', samplesPerLeg: count, workload, journeys, comparisons, errors: 0, noisyHost: results.some(run => run.noisyHost), receipts: results.map(run => ({ side: run.side, pair: run.pair, samples: run.samples.length })) }, null, 2)));
  console.log(JSON.stringify(comparisons, null, 2));
  console.log(`Comparison evidence: ${output}`);
}
