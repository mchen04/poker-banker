import type { LedgerEntry } from './session.js';

export type PlayingInterval = { started_at: string; ended_at: string | null };

export function effectiveEntries(entries: LedgerEntry[]): LedgerEntry[] {
  const voided = new Set(entries.flatMap(entry => entry.voids_entry_id ? [entry.voids_entry_id] : []));
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const corrected = new Map(entries.filter(entry => entry.voids_entry_id !== null)
    .map(entry => [`${entry.revision}/${entry.player_id}/${entry.kind}`, entry.voids_entry_id!]));
  const originalRevision = (entry: LedgerEntry): bigint => {
    let current = entry;
    while (true) {
      const originalId = corrected.get(`${current.revision}/${current.player_id}/${current.kind}`);
      const original = originalId ? byId.get(originalId) : undefined;
      if (!original || BigInt(original.revision) >= BigInt(current.revision)) return BigInt(current.revision);
      current = original;
    }
  };
  return entries.filter(entry => !entry.voids_entry_id && !voided.has(entry.id)).sort((a, b) => {
    const time = Date.parse(a.occurred_at) - Date.parse(b.occurred_at);
    if (time) return time;
    const left = originalRevision(a), right = originalRevision(b);
    return left < right ? -1 : left > right ? 1 : a.id.localeCompare(b.id);
  });
}

export function playingTime(entries: LedgerEntry[], endedAt: string | null, serverNow: string) {
  const intervals: PlayingInterval[] = [];
  let start: string | null = null;
  for (const entry of entries) {
    if (entry.kind === 'buy_in' && start === null) start = entry.occurred_at;
    if (entry.kind === 'cash_out' && start !== null) {
      intervals.push({ started_at: start, ended_at: entry.occurred_at });
      start = null;
    }
  }
  if (start !== null) intervals.push({ started_at: start, ended_at: endedAt });
  let duration = 0n;
  for (const interval of intervals) {
    const elapsed = Date.parse(interval.ended_at ?? serverNow) - Date.parse(interval.started_at);
    if (!Number.isSafeInteger(elapsed) || elapsed < 0) return { intervals, duration_ms: null };
    duration += BigInt(elapsed);
  }
  return { intervals, duration_ms: intervals.length ? String(duration) : null };
}
