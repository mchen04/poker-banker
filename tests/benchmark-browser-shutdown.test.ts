import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';
import { SHUTDOWN_GRACE_MS } from '../scripts/owned-process';

type Phase = 'none' | 'budget' | 'browser' | 'server';
const strip = async (path: string) => stripTypeScriptTypes(await readFile(new URL(path, import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '').replace(/^export /gm, '');

afterEach(() => { vi.useRealTimers(); });

async function setup(phase: Phase) {
  const helper = await strip('../scripts/owned-process.ts');
  const { withShutdownDeadline, stopOwnedProcess } = new Function(`${helper};return {withShutdownDeadline,stopOwnedProcess};`)();
  const source = await strip('../scripts/bench/stack.ts');
  const start = source.indexOf('  let database');
  const end = source.indexOf('\n  try {\n    database =');
  if (start < 0 || end < 0) throw new Error('Benchmark lifecycle source was not found');
  const events: string[] = [];
  const stack = new Function('withShutdownDeadline', 'stopOwnedProcess', 'fixtures', `${source.slice(start, end)};database=fixtures.database;return {own,stop};`)(withShutdownDeadline, stopOwnedProcess, { database: { stop: async () => { events.push('database-stop'); } } });
  stack.fixture = { sessionId: 'fixture' };
  stack.client = { request: async () => { throw new Error('initial request failed'); } };
  const hang = () => new Promise<void>(() => {});
  const browser = { close: () => { events.push('browser-close'); return phase === 'browser' ? hang() : Promise.resolve(); } };
  const server = { wsEndpoint: () => 'fixture', close: () => { events.push('browser-server-close'); return phase === 'server' ? hang() : Promise.resolve(); } };
  class CpuBudget { async pause() { events.push('budget-pause'); if (phase === 'budget') await hang(); } }
  const webkit = { launchServer: async () => server, connect: async () => browser };
  const browserSource = await strip('../scripts/bench/browser.ts');
  const benchmarkBrowser = new Function('webkit', 'CpuBudget', `${browserSource};return benchmarkBrowser;`)(webkit, CpuBudget);
  return { stack, events, benchmarkBrowser };
}

for (const phase of ['none', 'budget', 'browser', 'server'] as const) it(`settles benchmark main and signal cleanup when ${phase} close ${phase === 'none' ? 'completes' : 'never settles'}`, async () => {
  const { stack, events, benchmarkBrowser } = await setup(phase);
  vi.useFakeTimers();
  let mainSettled = false;
  let mainFailure: unknown;
  const main = (async () => {
    try { await benchmarkBrowser(stack, {}, 'fixture', () => {}, { samples: 1, reverse: false, phase() {} }); }
    finally { await stack.stop(); }
  })().then(() => { mainSettled = true; }, error => { mainSettled = true; mainFailure = error; });
  await vi.advanceTimersByTimeAsync(20);
  let signalSettled = false;
  const signal = stack.stop().then(() => { signalSettled = true; }, () => { signalSettled = true; });
  await vi.advanceTimersByTimeAsync(SHUTDOWN_GRACE_MS + 100);
  expect(mainSettled).toBe(true);
  expect(signalSettled).toBe(true);
  expect(mainFailure).toBeInstanceOf(Error);
  expect(events.filter(event => event === 'browser-close')).toHaveLength(1);
  expect(events.filter(event => event === 'browser-server-close')).toHaveLength(1);
  expect(events.filter(event => event === 'database-stop')).toHaveLength(1);
  await Promise.all([main, signal]);
});
