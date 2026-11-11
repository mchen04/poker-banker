import assert from 'node:assert/strict';
import { mkdir, writeFile, appendFile, access } from 'node:fs/promises';
import { webkit } from '@playwright/test';
import { resolve, join, relative } from 'node:path';
import { cpus, loadavg } from 'node:os';
import { LiveClient } from './bench/live-client';
import { seedLiveBenchmark } from './bench/live-seed';
import { liveApi, liveWrites } from './bench/live-api';
import { liveBrowser } from './bench/live-browser';
import { summarize, workSummary } from './bench/stats';
import type { Sample } from './bench/types';

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => args.includes(name) ? args[args.indexOf(name) + 1]! : fallback;
const baseURL = process.env.PB_BASE_URL;
assert(baseURL, 'Set PB_BASE_URL to the app origin; bench:live creates only its own uniquely named benchmark banker');
const label = option('--label', new Date().toISOString().replace(/[-:.]/g, ''));
assert(/^[a-zA-Z0-9._-]{1,100}$/.test(label) && label !== '.' && label !== '..');
const runs = Number(option('--runs', '5')), samples = Number(option('--samples', '1'));
assert(Number.isInteger(runs) && runs >= 1 && runs <= 10); assert(Number.isInteger(samples) && samples >= 1 && samples <= 10);
const sessions = Number(option('--sessions', '300'));
assert(Number.isInteger(sessions) && sessions >= 1 && sessions <= 300);
const allowLoopbackCertificate = args.includes('--allow-loopback-certificate');
const directory = resolve(option('--output', join('evidence/bench/live', label)));
assert(!relative(resolve('evidence/bench/live'), directory).startsWith('..') && directory !== resolve('evidence/bench/live'), 'Live evidence belongs under evidence/bench/live/<label>');
await mkdir(resolve('evidence/bench/live'), { recursive: true }); await mkdir(directory);
if (!args.includes('--api-only')) await access(webkit.executablePath());
const client = await LiveClient.create(baseURL, allowLoopbackCertificate);
const collected: Sample[] = [];
const repetitions: unknown[] = [];
let error: string | null = null;
let privateToken = '';
let journal = Promise.resolve();
const host = () => ({ logicalCores: cpus().length, loadAverage: loadavg(), remoteHostLoad: 'unavailable through the public API' });
await writeFile(join(directory, 'method.json'), JSON.stringify({ target: client.baseURL, label, runs, samples, sessions, apiTiming: 'HTTP round trip including response body, transport and server work', countPolicy: 'Controller HTTP counts exclude browser traffic; UI saves and viewer renders are counted separately in metric work', browserProfile: 'visible unthrottled iPhone 15 WebKit', order: 'Odd repetitions API then browser then writes; even repetitions writes then reversed browser then reversed API', serverHostLoad: 'Unavailable; per-sample client host load is recorded', accountPolicy: 'Creates one uniquely named banker; all seeding and measurement use only its session cookie and IDs. No existing account is read or changed. The test account remains for inspection.', allowLoopbackCertificate }, null, 2));
try {
  console.log(`Creating a unique benchmark banker and ${sessions} closed sessions through the public API`);
  const fixture = await seedLiveBenchmark(client, { sessions, progress: count => { if (count % 25 === 0 || count === sessions) console.log(`Seeded ${count}/${sessions} closed sessions; requests=${client.counts.requests}, errors=${client.counts.errors}`); } });
  privateToken = fixture.token;
  await writeFile(join(directory, 'seed.json'), JSON.stringify({ ...fixture, token: 'OWNED_VIEWER_TOKEN_NOT_PERSISTED', requests: client.counts, clientHost: host() }, null, 2));
  for (let index = 0; index < runs; index++) {
    const start = collected.length;
    const runDirectory = join(directory, `run-${String(index + 1).padStart(2, '0')}`); await mkdir(runDirectory);
    const record = (sample: Sample) => {
      const row = { ...sample, recordedAt: new Date().toISOString(), work: { ...sample.work, run: index + 1 }, clientHost: host() };
      collected.push(row); journal = journal.then(() => appendFile(join(directory, 'samples.jsonl'), `${JSON.stringify(row)}\n`));
    };
    const reverse = index % 2 === 1;
    console.log(`Live repetition ${index + 1}/${runs}, ${reverse ? 'reverse' : 'forward'} order`);
    if (reverse) await liveWrites(client, fixture, record, samples);
    if (!reverse) await liveApi(client, fixture, record, false, samples);
    if (!args.includes('--api-only')) await liveBrowser(client, fixture, record, reverse, samples, runDirectory, allowLoopbackCertificate);
    if (reverse) await liveApi(client, fixture, record, true, samples);
    if (!reverse) await liveWrites(client, fixture, record, samples);
    const rows = collected.slice(start);
    const summary = { run: index + 1, reverse, metrics: summarize(rows), errors: rows.filter(row => !row.ok).length, clientHost: host(), requests: { ...client.counts, statuses: { ...client.counts.statuses } } };
    repetitions.push(summary);
    await writeFile(join(runDirectory, 'samples.json'), JSON.stringify(rows, null, 2)); await writeFile(join(runDirectory, 'summary.json'), JSON.stringify(summary, null, 2));
  }
} catch (failure) { error = failure instanceof Error ? failure.stack ?? failure.message : String(failure); if (privateToken) error = error.replaceAll(privateToken, 'OWNED_TOKEN'); process.exitCode = 1; }
finally {
  await journal;
  const summary = { metrics: summarize(collected), repetitions, errors: collected.filter(row => !row.ok).length, requests: client.counts, error, clientHost: host(), serverHostLoad: 'unavailable through the public API' };
  await writeFile(join(directory, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log('Metric | samples | errors | median ms | p95 ms | range ms | completed work');
  for (const row of summary.metrics) console.log(`${row.metric} | ${row.samples} | ${row.errors} | ${row.median?.toFixed(2)} | ${row.p95?.toFixed(2)} | ${row.min?.toFixed(2)}..${row.max?.toFixed(2)} | ${workSummary(row.metric, collected)}`);
  console.log(`Controller HTTP requests=${client.counts.requests}; mutations=${client.counts.mutations}; request errors=${client.counts.errors}; sample errors=${summary.errors}; campaign errors=${error ? 1 : 0}; evidence=${directory}`);
  if (error) console.error(error);
  await client.close();
}
