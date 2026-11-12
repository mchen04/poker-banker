import { withShutdownDeadline } from './owned-process';
import assert from 'node:assert/strict';
import { mkdir, writeFile, appendFile, access } from 'node:fs/promises';
import { webkit } from '@playwright/test';
import { resolve, join, relative } from 'node:path';
import { cpus, loadavg } from 'node:os';
import { LiveClient } from './bench/live-client';
import { seedLiveBenchmark, readLiveSeedState, writeLiveSeedState, reuseLiveSeed, prepareLiveSeedState } from './bench/live-seed';
import { liveApi, liveWrites } from './bench/live-api';
import { liveBrowser } from './bench/live-browser';
import { summarize, workSummary } from './bench/stats';
import type { Sample } from './bench/types';

async function main() {
  const args = process.argv.slice(2);
  const option = (name: string, fallback: string) => {
    const index = args.indexOf(name);
    if (index === -1) return fallback;
    const value = args[index + 1];
    assert(value && !value.startsWith('--'), `${name} requires a value`);
    return value;
  };
  const baseURL = option('--base', option('--base-url', process.env.PB_BASE_URL ?? ''));
  const reuse = args.includes('--reuse') ? option('--reuse', '') : undefined;
  const seedOnly = args.includes('--seed-only');
  const statePath = args.includes('--state') ? option('--state', '') : undefined;
  const metrics = args.includes('--metrics') ? new Set(option('--metrics', '').split(',')) : undefined;
  assert(!seedOnly || statePath && !reuse, '--seed-only requires --state and cannot reuse an existing seed');
  assert(!statePath || seedOnly, '--state is only supported with --seed-only');
  assert(!metrics || metrics.size > 0 && [...metrics].every(metric => /^api\.(session|since|players|history|report\.(overall|location|game|weekday|month))$/.test(metric)), 'Select known read-only live API metrics');
  const apiOnly = args.includes('--api-only') || Boolean(metrics) || seedOnly;
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
  if (statePath) await prepareLiveSeedState(statePath);
  await mkdir(resolve('evidence/bench/live'), { recursive: true }); await mkdir(directory);
  if (!apiOnly) await access(webkit.executablePath());
  const client = await LiveClient.create(baseURL, allowLoopbackCertificate);
  const collected: Sample[] = [];
  const repetitions: unknown[] = [];
  let error: string | null = null;
  let privateToken = '';
  let journal = Promise.resolve();
  const host = () => ({ logicalCores: cpus().length, loadAverage: loadavg(), remoteHostLoad: 'unavailable through the public API' });
  try {
    await writeFile(join(directory, 'method.json'), JSON.stringify({ target: client.baseURL, label, runs, samples, sessions, apiTiming: 'HTTP round trip including response body, transport and server work', countPolicy: 'Controller HTTP counts exclude browser traffic; UI saves and viewer renders are counted separately in metric work', browserProfile: 'visible unthrottled iPhone 15 WebKit', order: 'Odd repetitions API then browser then writes; even repetitions writes then reversed browser then reversed API', serverHostLoad: 'Unavailable; per-sample client host load is recorded', accountPolicy: reuse ? 'Reuses only the explicitly supplied owned benchmark seed without mutations when metrics are selected' : 'Creates one uniquely named banker using only its own session cookie and IDs', bypass: client.bypassEnabled, browserTransport: client.bypassEnabled ? 'Protected browser requests use Playwright route.fetch and reject redirects' : 'Native browser transport', metrics: metrics ? [...metrics] : 'all', seedOnly, reuse: Boolean(reuse), allowLoopbackCertificate }, null, 2));
    console.log(reuse ? 'Validating the supplied owned benchmark banker' : `Creating a unique benchmark banker and ${sessions} closed sessions through the public API`);
    const fixture = reuse ? await reuseLiveSeed(client, await readLiveSeedState(reuse)) : await seedLiveBenchmark(client, { sessions, progress: count => { if (count % 25 === 0 || count === sessions) console.log(`Seeded ${count}/${sessions} closed sessions; requests=${client.counts.requests}, errors=${client.counts.errors}`); } });
    privateToken = fixture.token;
    client.ownSecret(fixture.token);
    await client.sessionCookie();
    if (statePath) await writeLiveSeedState(statePath, client, fixture);
    await writeFile(join(directory, 'seed.json'), JSON.stringify({ ...fixture, token: 'OWNED_VIEWER_TOKEN_NOT_PERSISTED', requests: client.counts, clientHost: host() }, null, 2));
    for (let index = 0; index < (seedOnly ? 0 : runs); index++) {
      const start = collected.length;
      const runDirectory = join(directory, `run-${String(index + 1).padStart(2, '0')}`); await mkdir(runDirectory);
      const record = (sample: Sample) => {
        const row = { ...sample, ...(sample.error ? { error: client.redact(sample.error) } : {}), recordedAt: new Date().toISOString(), work: { ...sample.work, run: index + 1 }, clientHost: host() };
        collected.push(row); journal = journal.then(() => appendFile(join(directory, 'samples.jsonl'), `${JSON.stringify(row)}\n`)).catch(failure => { error = error ?? client.redact(failure); process.exitCode = 1; });
      };
      const reverse = index % 2 === 1;
      console.log(`Live repetition ${index + 1}/${runs}, ${reverse ? 'reverse' : 'forward'} order`);
      if (reverse && !metrics) await liveWrites(client, fixture, record, samples);
      if (!reverse) await liveApi(client, fixture, record, false, samples, metrics);
      if (!apiOnly) await liveBrowser(client, fixture, record, reverse, samples, runDirectory, allowLoopbackCertificate);
      if (reverse) await liveApi(client, fixture, record, true, samples, metrics);
      if (!reverse && !metrics) await liveWrites(client, fixture, record, samples);
      const rows = collected.slice(start);
      const summary = { run: index + 1, reverse, metrics: summarize(rows), errors: rows.filter(row => !row.ok).length, clientHost: host(), requests: { ...client.counts, statuses: { ...client.counts.statuses } } };
      repetitions.push(summary);
      await writeFile(join(runDirectory, 'samples.json'), JSON.stringify(rows, null, 2)); await writeFile(join(runDirectory, 'summary.json'), JSON.stringify(summary, null, 2));
    }
  } catch (failure) { error = client.redact(failure); if (privateToken) error = error.replaceAll(privateToken, 'OWNED_TOKEN'); process.exitCode = 1; }
  finally {
    try {
      try { await withShutdownDeadline('Live benchmark evidence journal', () => journal); } catch (failure) { error = error ?? client.redact(failure); process.exitCode = 1; }
      const summary = { metrics: summarize(collected), repetitions, errors: collected.filter(row => !row.ok).length, requests: client.counts, error, clientHost: host(), serverHostLoad: 'unavailable through the public API' };
      await withShutdownDeadline('Live benchmark cleanup summary', () => writeFile(join(directory, 'summary.json'), JSON.stringify(summary, null, 2)));
      console.log('Metric | samples | errors | median ms | p95 ms | range ms | completed work');
      for (const row of summary.metrics) console.log(`${row.metric} | ${row.samples} | ${row.errors} | ${row.median?.toFixed(2)} | ${row.p95?.toFixed(2)} | ${row.min?.toFixed(2)}..${row.max?.toFixed(2)} | ${workSummary(row.metric, collected)}`);
      console.log(`Controller HTTP requests=${client.counts.requests}; mutations=${client.counts.mutations}; request errors=${client.counts.errors}; sample errors=${summary.errors}; campaign errors=${error ? 1 : 0}; evidence=${directory}`);
      if (error) console.error(error);
    } finally { await client.close(); }
  }

}
void main().catch(() => { console.error('Live benchmark failed before measurement; verify the supplied options and owned seed state'); process.exitCode = 1; });
