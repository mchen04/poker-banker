import type { SessionState } from '../domain/session';
import { effectiveEntries } from '../domain/timing';

export function autoStartedTimer(receipt: SessionState, entryId: string): string | null {
  const entry = effectiveEntries(receipt.entries).find(entry => entry.id === entryId);
  if (entry?.kind !== 'buy_in') return null;
  const event = receipt.events.find(event => event.kind === 'timer_started' && event.revision === entry.revision);
  const before = event?.detail.old as { started_at?: unknown } | undefined;
  const after = event?.detail.new as { started_at?: unknown } | undefined;
  return before?.started_at === null && typeof after?.started_at === 'string' && receipt.session.started_at !== null && Date.parse(after.started_at) === Date.parse(receipt.session.started_at) ? receipt.session.started_at : null;
}

export function retainedTimerAfterUndo(state: SessionState, startedAt: string | null): string | null {
  return startedAt !== null && state.session.started_at === startedAt && state.session.ended_at === null && !effectiveEntries(state.entries).some(entry => entry.kind === 'buy_in') ? startedAt : null;
}
