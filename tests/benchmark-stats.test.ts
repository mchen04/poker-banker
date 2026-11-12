import { expect, it } from 'vitest';
import { summarize, workSummary } from '../scripts/bench/stats';
import { hostPolicy } from '../scripts/bench/host';
import type { Sample } from '../scripts/bench/types';
it('withholds p95 for fewer than twenty successful observations without hiding errors', () => {
  const samples: Sample[] = Array.from({ length: 10 }, (_, index) => ({ metric: 'save', ms: index + 1, ok: true, work: { rows: 1 } }));
  samples.push({ metric: 'save', ms: 0, ok: false, error: 'Rejected write', work: { rows: 0 } });
  expect(summarize(samples)[0]).toMatchObject({ metric: 'save', samples: 11, successfulSamples: 10, errors: 1, median: 5.5, mad: 2.5, p95: null, min: 1, max: 10, p95Reason: expect.any(String) });
});
it('reports nearest-rank p95 only after twenty successful observations', () => {
  const samples: Sample[] = Array.from({ length: 20 }, (_, index) => ({ metric: 'save', ms: index + 1, ok: true, work: { rows: 1 } }));
  expect(summarize(samples.slice(0, 19))[0]).toMatchObject({ successfulSamples: 19, p95: null });
  expect(summarize(samples)[0]).toMatchObject({ successfulSamples: 20, median: 10.5, mad: 5, p95: 19, p95Reason: null });
  samples[0] = { ...samples[0]!, ms: Number.NaN };
  expect(summarize(samples)[0]).toMatchObject({ successfulSamples: 19, errors: 1, p95: null });
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

it('counts repeated standalone viewer journeys by sample without confusing correlated viewer batches', () => {
  const rows: Sample[] = Array.from({ length: 10 }, (_, index) => ({ metric: 'viewer.delay.1', ms: 1, ok: true, work: { run: Math.floor(index / 2), sample: index % 2, concurrency: 1 } }));
  expect(workSummary('viewer.delay.1', rows)).toBe('10 committed writes; 10 viewer renders');
});
