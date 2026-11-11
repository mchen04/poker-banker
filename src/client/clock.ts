type EntryTimer = { started_at: string | null; ended_at?: string | null; server_now: string };
export function createEntryClock(toleranceMs = 120000) {
  let anchor: { server: number; monotonic: number } | undefined;
  return {
    observe(serverNow: string, monotonic = performance.now()) {
      const server = Date.parse(serverNow);
      if (Number.isFinite(server) && Number.isFinite(monotonic)) anchor = { server, monotonic };
    },
    stamp(wall = Date.now(), monotonic = performance.now(), timer?: EntryTimer): string | null {
      if (!anchor || monotonic < anchor.monotonic) return null;
      const expected = anchor.server + monotonic - anchor.monotonic;
      const started = timer?.started_at ? Date.parse(timer.started_at) : NaN;
      if (timer && timer.ended_at == null && started <= Date.parse(timer.server_now) && expected < started) return null;
      return Number.isFinite(wall) && Math.abs(wall - expected) <= toleranceMs ? new Date(expected).toISOString() : null;
    },
  };
}
const clock = createEntryClock();
export const observeServerTime = (serverNow: string) => clock.observe(serverNow);
export const submittedAt = (timer?: EntryTimer) => clock.stamp(undefined, undefined, timer);
