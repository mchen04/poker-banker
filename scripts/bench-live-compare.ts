import { withShutdownDeadline } from './owned-process';
import assert from 'node:assert/strict';
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { cpus, loadavg } from 'node:os';
import { resolve, relative, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LiveClient } from './bench/live-client';
import { liveApi } from './bench/live-api';
import { readLiveSeedState, reuseLiveSeed } from './bench/live-seed';
import type { Sample } from './bench/types';

export type LiveComparisonRow = Sample & { side: 'A' | 'B'; pair: number; leg: number; order: number; clientHost: { logicalCores: number; loadAverage: number[]; remoteHostLoad: string } };
const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2; };
export function summarizeLiveComparison(rows: LiveComparisonRow[], metric: string, errors: number) {
  const pairs = Array.from({ length: 5 }, (_, index) => {
    const values = (side: 'A' | 'B') => rows.filter(row => row.pair === index + 1 && row.side === side && row.ok && Number.isFinite(row.ms)).map(row => row.ms);
    const before = values('A'), after = values('B');
    return { pair: index + 1, beforeMedian: before.length ? median(before) : null, afterMedian: after.length ? median(after) : null, beforeSamples: before.length, afterSamples: after.length };
  });
  const complete = pairs.every(pair => pair.beforeMedian !== null && pair.afterMedian !== null && pair.beforeSamples === pair.afterSamples);
  const before = pairs.flatMap(pair => pair.beforeMedian === null ? [] : [pair.beforeMedian]), after = pairs.flatMap(pair => pair.afterMedian === null ? [] : [pair.afterMedian]);
  const spread = (values: number[]) => values.length ? median(values.map(value => Math.abs(value - median(values)))) : null;
  const beforeMedian = before.length ? median(before) : null, afterMedian = after.length ? median(after) : null;
  const beforeMAD = spread(before), afterMAD = spread(after);
  const improvementMs = beforeMedian !== null && afterMedian !== null ? beforeMedian - afterMedian : null;
  const bodyHashes = [...new Set(rows.map(row => row.sha256))];
  const identicalResponses = rows.length > 0 && bodyHashes.length === 1 && typeof bodyHashes[0] === 'string' && /^[a-f0-9]{64}$/.test(bodyHashes[0]) && rows.every(row => row.status === 200 && row.bytes === rows[0]!.bytes);
  const sampleErrors = rows.filter(row => !row.ok || !Number.isFinite(row.ms)).length;
  const everyPairImproves = complete && pairs.every(pair => pair.afterMedian! < pair.beforeMedian!);
  const clearsBothMAD = improvementMs !== null && beforeMAD !== null && afterMAD !== null && improvementMs > beforeMAD && improvementMs > afterMAD;
  return { metric, pairs, beforeMedian, afterMedian, improvementMs, beforeMAD, afterMAD, everyPairImproves, clearsBothMAD, identicalResponses, bodyHashes, errors: errors + sampleErrors, samples: rows.length, completedWork: rows.filter(row => row.ok).map(row => ({ side: row.side, pair: row.pair, work: row.work })), accepted: complete && everyPairImproves && clearsBothMAD && identicalResponses && errors === 0 && sampleErrors === 0 };
}
export async function runLiveComparison(options: { baselineURL: string; candidateURL: string; reuse: string; metric: string; directory: string; samples?: number; order?: 'alternating' | 'abba'; allowLoopbackCertificate?: boolean }) {
  assert.equal(options.metric, 'api.players', 'Live paired comparison currently selects exactly api.players');
  const sampleCount = options.samples ?? 1;
  assert(Number.isInteger(sampleCount) && sampleCount >= 1 && sampleCount <= 10, 'Comparison samples must be between one and ten');
  assert(!options.order || ['alternating', 'abba'].includes(options.order), 'Comparison order must be alternating or abba');
  const directory = resolve(options.directory), root = resolve('evidence/bench/live');
  const part = relative(root, directory);
  assert(part && !part.startsWith('..') && !part.startsWith('/'), 'Live comparison evidence belongs beneath evidence/bench/live');
  await mkdir(root, { recursive: true }); await mkdir(directory);
  const clients: Partial<Record<'A' | 'B', LiveClient>> = {};
  const rows: LiveComparisonRow[] = [];
  let journal = Promise.resolve(), error: string | null = null;
  try {
    const state = await readLiveSeedState(options.reuse);
    clients.A = await LiveClient.create(options.baselineURL, options.allowLoopbackCertificate);
    clients.B = await LiveClient.create(options.candidateURL, options.allowLoopbackCertificate);
    const fixtures = { A: await reuseLiveSeed(clients.A, state), B: await reuseLiveSeed(clients.B, state) };
    await writeFile(join(directory, 'method.json'), JSON.stringify({ baselineURL: clients.A.baseURL, candidateURL: clients.B.baseURL, bankerId: state.fixture.bankerId, metric: options.metric, pairs: 5, samples: sampleCount, order: options.order ?? 'alternating', bypass: clients.A.bypassEnabled, timing: 'HTTP round trip through response body', hash: 'SHA256 of raw HTTP response body bytes', remoteHostLoad: 'unavailable through the public API', readOnly: true }, null, 2));
    for (let pair = 1; pair <= 5; pair++) {
      const order: ('A' | 'B')[] = options.order === 'abba' ? ['A', 'B', 'B', 'A'] : pair % 2 ? ['A', 'B'] : ['B', 'A'];
      for (const [leg, side] of order.entries()) {
        console.log(`Live comparison pair ${pair}/5 side ${side}`);
        await liveApi(clients[side]!, fixtures[side], sample => {
          const row: LiveComparisonRow = { ...sample, ...(sample.error ? { error: clients[side]!.redact(sample.error) } : {}), side, pair, leg: leg + 1, order: rows.length + 1, recordedAt: new Date().toISOString(), clientHost: { logicalCores: cpus().length, loadAverage: loadavg(), remoteHostLoad: 'unavailable through the public API' } };
          rows.push(row); journal = journal.then(() => appendFile(join(directory, 'samples.jsonl'), `${JSON.stringify(row)}\n`)).catch(failure => {
            error = error ?? (failure instanceof Error ? failure.message : 'Live comparison evidence failed');
            for (const client of Object.values(clients)) error = client.redact(error);
          });
        }, false, sampleCount, new Set([options.metric]));
      }
    }
  } catch (failure) {
    error = failure instanceof Error ? failure.message : 'Live comparison failed';
    for (const client of Object.values(clients)) error = client.redact(error);
  } finally {
    try {
      try { await withShutdownDeadline('Live benchmark evidence journal', () => journal); } catch (failure) {
        error = error ?? (failure instanceof Error ? failure.message : 'Live comparison evidence failed');
        for (const client of Object.values(clients)) error = client.redact(error);
      }
      const requests = Object.fromEntries(Object.entries(clients).map(([side, client]) => [side, client.counts]));
      const requestErrors = Object.values(clients).reduce((sum, client) => sum + client.counts.errors, 0);
      const comparison = { ...summarizeLiveComparison(rows, options.metric, requestErrors + (error ? 1 : 0)), requests, error };
      await withShutdownDeadline('Live comparison cleanup summary', () => writeFile(join(directory, 'comparison.json'), JSON.stringify(comparison, null, 2)));
      return comparison;
    } finally {
      const closed = await Promise.allSettled(Object.values(clients).map(client => client.close()));
      const failures = closed.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : []);
      if (failures.length) throw new AggregateError(failures, 'Live comparison client cleanup failed');
    }
  }
}
async function main() {
  const args = process.argv.slice(2);
  const option = (name: string, fallback = '') => args.includes(name) ? args[args.indexOf(name) + 1]! : fallback;
  const result = await runLiveComparison({ baselineURL: option('--baseline-url', option('--base')), candidateURL: option('--candidate-url'), reuse: option('--reuse'), metric: option('--metrics'), directory: option('--output', `evidence/bench/live/compare-${Date.now()}`), samples: Number(option('--samples', '1')), order: option('--order', 'alternating') as 'alternating' | 'abba', allowLoopbackCertificate: args.includes('--allow-loopback-certificate') });
  console.log(JSON.stringify({ accepted: result.accepted, errors: result.errors, identicalResponses: result.identicalResponses, beforeMedian: result.beforeMedian, afterMedian: result.afterMedian, beforeMAD: result.beforeMAD, afterMAD: result.afterMAD }));
  if (result.error || result.errors) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main().catch(() => { console.error('Live comparison failed; verify the supplied options and owned seed state'); process.exitCode = 1; });
