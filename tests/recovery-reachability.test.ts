import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DraftRequest } from '../src/client/data';

const owner = 'banker';
const session = 'session';
const source = readFileSync(new URL('./draft-versions.test.ts', import.meta.url), 'utf8');
function storage() {
  const code = ts.transpileModule(source.slice(source.indexOf('type Row'), source.indexOf('const owner =')) + '\nreturn sharedStorage();', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return Function('vi', code)(vi) as { draft: (key: string) => unknown };
}
const kinds = [
  ...['buy_in', 'cash_out', 'payment_in', 'payment_out', 'expense'].map(kind => ({ kind, path: `/api/sessions/${session}/entries`, method: 'POST', body: { kind, player_id: 'player', amount_minor: '5000', method: 'cash', occurred_at: null } })),
  { kind: 'add-player', path: `/api/sessions/${session}/players`, method: 'POST', body: { new_player_name: 'Recovered player' } },
  { kind: 'new-session', path: '/api/sessions', method: 'POST', body: { name: 'Recovered game', currency: 'USD', played_on: '2026-11-11' } },
  { kind: 'settings', path: `/api/sessions/${session}`, method: 'PATCH', body: { location: 'Recovered location' } },
  { kind: 'timing', path: `/api/sessions/${session}/timing`, method: 'PATCH', body: { started_at: '2026-11-11T12:00:00.000Z', ended_at: null } },
  { kind: 'close', path: `/api/sessions/${session}/close`, method: 'POST', body: { expected_revision: '7', accept_discrepancy_minor: '0' } },
  { kind: 'reopen', path: `/api/sessions/${session}/reopen`, method: 'POST', body: { reason: 'Recovered reason' } },
  { kind: 'share', path: `/api/sessions/${session}/share`, method: 'POST', body: { action: 'rotate' } },
  { kind: 'start', path: `/api/sessions/${session}/start`, method: 'POST', body: {} },
  { kind: 'correction', path: `/api/sessions/${session}/entries/entry/void`, method: 'POST', body: { reason: 'Pure void' } },
  { kind: 'rename', path: '/api/players/player', method: 'PATCH', body: { display_name: 'Recovered name' } },
  { kind: 'legacy-command', path: `/api/sessions/${session}/legacy-command`, method: 'POST', body: { detail: 'Recovered legacy value' } },
] as const;

beforeEach(() => {
  vi.resetModules();
  storage();
  const events = new EventTarget();
  vi.stubGlobal('window', { setTimeout, clearTimeout, setInterval, clearInterval, dispatchEvent: events.dispatchEvent.bind(events), addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) });
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('fetch', vi.fn(async (path: string) => path === '/api/auth/me'
    ? Response.json({ banker: { id: owner, username: owner } }, { headers: { 'X-PB-Banker-ID': owner } })
    : Response.json({ error: { code: 'idempotency_mismatch', message: 'Review the saved operation' } }, { status: 409, headers: { 'X-PB-Banker-ID': owner } })));
});
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it.each(kinds)('makes a source-less recovered $kind visible with its complete request', async operation => {
  const data = await import('../src/client/data');
  const body = { ...operation.body, op_id: crypto.randomUUID() };
  await data.enqueue({ banker_id: owner, session_id: session, path: operation.path, method: operation.method, label: operation.kind, body });
  const stop = data.syncOutbox(owner, () => {}, () => {});
  try { await vi.waitFor(async () => expect(await data.listOutbox(owner)).toEqual([])); }
  finally { stop(); }
  const recovered = await data.listRecoveredDrafts(owner);
  expect(recovered).toHaveLength(1);
  expect(recovered[0]).toMatchObject({ request: { path: operation.path, method: operation.method, body: operation.body } });
  expect(await data.listRecoveredDrafts('other-account')).toEqual([]);
});

it('keeps a mismatched ordinary form reachable after reload', async () => {
  const data = await import('../src/client/data');
  const key = data.draftKey(owner, session, 'reopen');
  const value = { op_id: crypto.randomUUID(), reason: 'Continue the game' };
  const request: DraftRequest = { path: `/api/sessions/${session}/reopen`, method: 'POST', body: value };
  await data.writeDraft(key, value);
  await data.prepareDraftSubmission(key, value, request);
  await expect(data.replaySubmittedDraft(key)).rejects.toMatchObject({ code: 'idempotency_mismatch' });
  vi.resetModules();
  const reopened = await import('../src/client/data');
  expect(await reopened.listRecoveredDrafts(owner)).toEqual([expect.objectContaining({ key, value: expect.objectContaining({ reason: value.reason }), request: expect.objectContaining({ path: request.path }) })]);
});
