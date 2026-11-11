import { expect, it } from 'vitest';
import { createEntryClock } from '../src/client/clock';
it('advances the last live server clock monotonically and preserves two offline submission hours', () => {
  const clock = createEntryClock();
  const start = Date.parse('2026-11-10T18:00:00.000Z');
  clock.observe(new Date(start).toISOString(), 100);
  const buy = clock.stamp(start, 100), cash = clock.stamp(start + 7200000, 7200100);
  expect(buy).toBe('2026-11-10T18:00:00.000Z'); expect(cash).toBe('2026-11-10T20:00:00.000Z');
});
it('marks missing live clock, backward monotonic time and skew beyond two minutes unavailable', () => {
  const clock = createEntryClock(); const start = Date.parse('2026-11-10T18:00:00.000Z');
  expect(clock.stamp(start, 100)).toBeNull();
  clock.observe(new Date(start).toISOString(), 100);
  expect(clock.stamp(start, 99)).toBeNull();
  expect(clock.stamp(start + 120001, 100)).toBeNull();
  expect(clock.stamp(start - 120001, 100)).toBeNull();
  expect(clock.stamp(start + 120000, 100)).toBe('2026-11-10T18:00:00.000Z');
  expect(createEntryClock().stamp(start + 7200000, 100)).toBeNull();
});
it('calibrates tolerated positive and negative wall skew to the server clock at submission', () => {
  const clock = createEntryClock(); const start = Date.parse('2026-11-10T18:00:00.000Z');
  clock.observe(new Date(start).toISOString(), 100);
  for (const skew of [-60000, 60000]) {
    expect(clock.stamp(start + skew, 100)).toBe('2026-11-10T18:00:00.000Z');
    expect(clock.stamp(start + 7200000 + skew, 7200100)).toBe('2026-11-10T20:00:00.000Z');
  }
});
it('marks an estimate older than a causally known start unavailable without hiding a future timer bound', () => {
  const clock = createEntryClock(); const start = Date.parse('2026-11-10T18:00:00.000Z');
  clock.observe(new Date(start).toISOString(), 500);
  expect(clock.stamp(start + 650, 650, { started_at: new Date(start + 500).toISOString(), server_now: new Date(start + 510).toISOString() })).toBeNull();
  expect(clock.stamp(start + 650, 650, { started_at: new Date(start + 1000).toISOString(), server_now: new Date(start + 510).toISOString() })).toBe('2026-11-10T18:00:00.150Z');
  expect(clock.stamp(start + 650, 650, { started_at: new Date(start + 500).toISOString(), ended_at: new Date(start + 550).toISOString(), server_now: new Date(start + 560).toISOString() })).toBe('2026-11-10T18:00:00.150Z');
  expect(clock.stamp(start + 650, 650)).toBe('2026-11-10T18:00:00.150Z');
});
