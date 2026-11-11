import { expect, it } from 'vitest';
import { summarize, workSummary } from '../scripts/bench/stats';
import { hostPolicy } from '../scripts/bench/host';
import type { Sample } from '../scripts/bench/types';
it('reports nearest-rank p95, median and range without hiding errors', () => {
  const samples: Sample[] = Array.from({ length: 10 }, (_, index) => ({ metric: 'save', ms: index + 1, ok: true, work: { rows: 1 } }));
  samples.push({ metric: 'save', ms: 0, ok: false, error: 'Rejected write', work: { rows: 0 } });
  expect(summarize(samples)[0]).toMatchObject({ metric: 'save', samples: 11, errors: 1, median: 5.5, p95: 10, min: 1, max: 10 });
});
it('keeps a wholly failed metric explicitly unavailable', () => {
  expect(summarize([{ metric: 'load', ms: Number.NaN, ok: false, work: { rows: 0 } }])[0]).toMatchObject({ samples: 1, errors: 1, median: null, p95: null, min: null, max: null });
});

it('counts committed writes once across correlated viewer and writer observations', () => {
  const viewers: Sample[] = Array.from({ length: 250 }, (_, index) => ({ metric: 'viewer.delay.25', ms: 1, ok: true, work: { run: Math.floor(index / 50), batch: Math.floor(index / 25) % 2, ledger_rows_written: 1 } }));
  expect(workSummary('viewer.delay.25', viewers)).toBe('10 committed writes; 250 viewer renders');
  const writers: Sample[] = Array.from({ length: 20 }, (_, index) => ({ metric: 'api.write10', ms: 1, ok: true, work: { run: 1, batch: Math.floor(index / 10), writes_completed: 10 } }));
  expect(workSummary('api.write10', writers)).toBe('20 committed writes; 2 batches of 10');
});

it('marks host load at half the machine capacity as noisy without rejecting it', () => {
  expect(hostPolicy(10, 499)).toMatchObject({ threshold: 500, noisyHost: false });
  expect(hostPolicy(10, 500)).toMatchObject({ threshold: 500, noisyHost: true });
  expect(hostPolicy(10, 800)).toMatchObject({ otherCpu: 800, noisyHost: true });
});
