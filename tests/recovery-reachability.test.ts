import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
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
  ...['buy_in', 'cash_out', 'payment_in', 'payment_out', 'expense'].map(kind => ({ kind, path: `/api/sessions/${session}/entries`, method: 'POST', body: { kind, player_id: 'player', amount_minor: '5000', ...(kind === 'buy_in' || kind.startsWith('payment') ? { method: 'cash' } : {}), occurred_at: null } })),
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
  await data.enqueue({ banker_id: owner, session_id: session, path: operation.path, method: operation.method as 'POST' | 'PATCH', label: operation.kind, body });
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

it('reconstructs a current money edit rather than resubmitting the earlier operation amount', async () => {
  const data = await import('../src/client/data');
  const key = data.draftKey(owner, session, 'buy_in', 'player');
  const request = { path: `/api/sessions/${session}/entries`, method: 'POST', body: { op_id: 'old', player_id: 'player', kind: 'buy_in', amount_minor: '1000', paid_now: true, method: 'cash', occurred_at: null } };
  await data.writeDraft(key, { op_id: 'fresh', amount: '50.00', kind: 'buy_in', paid_now: true, method: 'cash', occurred_at: '', __recovered_occurred_at: null, __operation_conflict: 'Review', __recovery_request: request, __recovery_currency: 'USD' });
  const recovery = (await data.listRecoveredDrafts(owner))[0]!;
  expect(recovery.request?.body).toMatchObject({ amount_minor: '5000', occurred_at: null });
  vi.stubGlobal('fetch', vi.fn(async (path: string) => Response.json(path === '/api/auth/me' ? { banker: { id: owner, username: owner } } : { ok: true }, { headers: { 'X-PB-Banker-ID': owner } })));
  await data.editRecoveredDraft(recovery, { ...(recovery.value as object), amount: '60.00' }, 'submit');
  const sends = vi.mocked(fetch).mock.calls.filter(([path]) => path !== '/api/auth/me');
  expect(sends).toHaveLength(1);
  expect(JSON.parse(String(sends[0]![1]?.body))).toMatchObject({ amount_minor: '6000', occurred_at: null });
  expect(await data.listRecoveredDrafts(owner)).toEqual([]);
});

it.each(['save', 'discard', 'submit'] as const)('rejects a stale recovered %s before changing a newer draft or sending', async action => {
  const data = await import('../src/client/data');
  const key = data.draftKey(owner, session, 'reopen');
  const value = { op_id: 'fresh', reason: 'Recovered reason', __operation_conflict: 'Review', __recovery_request: { path: `/api/sessions/${session}/reopen`, method: 'POST', body: { op_id: 'old', reason: 'Old reason' } } };
  await data.writeDraft(key, value);
  const stale = (await data.listRecoveredDrafts(owner))[0]!;
  await data.writeDraft(key, { ...value, reason: 'Newer reason' });
  await expect(data.editRecoveredDraft(stale, stale.value, action)).rejects.toBeInstanceOf(data.DraftConflictError);
  expect((await data.readDraft<{ reason: string }>(key))?.reason).toBe('Newer reason');
  expect(fetch).not.toHaveBeenCalled();
});

it.each([401, 403, 431, 503])('keeps a %s resubmission frozen with its exact edited request', async status => {
  const data = await import('../src/client/data');
  const key = data.draftKey(owner, session, 'share');
  const value = { op_id: 'fresh', action: 'enable', __operation_conflict: 'Review', __recovery_request: { path: `/api/sessions/${session}/share`, method: 'POST', body: { op_id: 'old', action: 'enable' } } };
  await data.writeDraft(key, value);
  const recovery = (await data.listRecoveredDrafts(owner))[0]!;
  vi.stubGlobal('fetch', vi.fn(async (path: string) => path === '/api/auth/me' ? Response.json({ banker: { id: owner, username: owner } }, { headers: { 'X-PB-Banker-ID': owner } }) : Response.json({ error: { code: 'invalid_request', message: 'Unconfirmed result' } }, { status, headers: status === 401 || status === 403 ? { 'X-PB-Banker-ID': owner } : {} })));
  await expect(data.editRecoveredDraft(recovery, { ...value, action: 'rotate' }, 'submit')).rejects.toThrow();
  const submitted = await data.listSubmittedDrafts(owner);
  expect(submitted).toHaveLength(1);
  expect(submitted[0]!.request.body).toMatchObject({ action: 'rotate' });
  expect(await data.listRecoveredDrafts(owner)).toEqual([]);
});

it('exposes an unknown reserved legacy draft without inventing a resubmission endpoint', async () => {
  const data = await import('../src/client/data');
  const key = `${owner}/_operations/uncertain/legacy`;
  await data.writeDraft(key, 'Preserved legacy text');
  const recoveries = await data.listRecoveredDrafts(owner);
  expect(recoveries).toHaveLength(1);
  expect(recoveries[0]).toMatchObject({ key, value: { saved_value: 'Preserved legacy text' }, request: undefined });
  await expect(data.editRecoveredDraft(recoveries[0]!, recoveries[0]!.value, 'discard')).rejects.toThrow(/may already be saved/i);
  await data.editRecoveredDraft(recoveries[0]!, recoveries[0]!.value, 'discard', () => true, true);
  expect(await data.listRecoveredDrafts(owner)).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
});

it('keeps edits to amount and time fields on an unknown legacy request', async () => {
  const data = await import('../src/client/data');
  const key = data.draftKey(owner, session, 'legacy-command');
  const request = { path: `/api/sessions/${session}/legacy-command`, method: 'POST', body: { op_id: 'old', amount_minor: '1000', occurred_at: null } };
  await data.writeDraft(key, { op_id: 'fresh', amount_minor: '5000', occurred_at: '2026-11-11T12:00:00.000Z', __operation_conflict: 'Review', __recovery_request: request });
  expect((await data.listRecoveredDrafts(owner))[0]!.request?.body).toMatchObject({ amount_minor: '5000', occurred_at: '2026-11-11T12:00:00.000Z' });
});

it.each(['buy_in', 'correction'])('can explicitly restore currency before resubmitting an edited %s amount', async form => {
  const data = await import('../src/client/data');
  const key = data.draftKey(owner, session, form);
  const request = { path: form === 'correction' ? `/api/sessions/${session}/entries/entry/void` : `/api/sessions/${session}/entries`, method: 'POST', body: { op_id: 'old', ...(form === 'correction' ? { replacement_amount_minor: '1000' } : { kind: 'buy_in', amount_minor: '1000', paid_now: false, occurred_at: null }) } };
  await data.writeDraft(key, { op_id: 'fresh', amount: '50.00', __operation_conflict: 'Review', __recovery_request: request });
  const blocked = (await data.listRecoveredDrafts(owner))[0]!;
  expect(blocked.request).toBeUndefined();
  expect(blocked.request_error).toMatch(/currency is unavailable/i);
  await data.editRecoveredDraft(blocked, { ...(blocked.value as object), __recovery_currency: 'USD' }, 'save');
  const reviewed = (await data.listRecoveredDrafts(owner))[0]!;
  expect(reviewed.request?.body).toMatchObject(form === 'correction' ? { replacement_amount_minor: '5000' } : { amount_minor: '5000' });
  expect(fetch).not.toHaveBeenCalled();
});

it.each([
  { kind: 'buy_in', amount: '50.00', paid_now: false },
  { kind: 'cash_out', amount: '0.00', paid_now: true },
])('removes the payment method from a recovered $kind without a positive paid amount', async edit => {
  const data = await import('../src/client/data');
  const key = data.draftKey(owner, session, edit.kind, 'player');
  const request = { path: `/api/sessions/${session}/entries`, method: 'POST', body: { op_id: 'old', player_id: 'player', kind: edit.kind, amount_minor: '1000', paid_now: true, method: 'cash', occurred_at: null } };
  await data.writeDraft(key, { op_id: 'fresh', ...edit, method: 'cash', __recovered_occurred_at: null, __operation_conflict: 'Review', __recovery_request: request, __recovery_currency: 'USD' });
  const recovered = (await data.listRecoveredDrafts(owner))[0]!;
  expect(recovered.request?.body).not.toHaveProperty('method');
  expect(recovered.request?.body).toMatchObject({ kind: edit.kind, amount_minor: edit.amount === '0.00' ? '0' : '5000', paid_now: edit.paid_now });
});

it('uses an edited raw minor amount when a source-less entry has no currency', async () => {
  const data = await import('../src/client/data');
  await data.enqueue({ banker_id: owner, session_id: session, path: `/api/sessions/${session}/entries`, label: 'Payment out', body: { op_id: 'legacy', kind: 'payment_out', player_id: 'player', amount_minor: '5000', method: 'cash', occurred_at: null } });
  const stop = data.syncOutbox(owner, () => {}, () => {});
  try { await vi.waitFor(async () => expect(await data.listOutbox(owner)).toEqual([])); } finally { stop(); }
  const recovered = (await data.listRecoveredDrafts(owner))[0]!;
  await data.editRecoveredDraft(recovered, { ...(recovered.value as object), amount_minor: '7500' }, 'save');
  expect((await data.listRecoveredDrafts(owner))[0]!.request?.body.amount_minor).toBe('7500');
});

it('does not fall back to a previous amount when the decimal amount was cleared', async () => {
  const data = await import('../src/client/data');
  const request = { path: `/api/sessions/${session}/entries`, method: 'POST', body: { op_id: 'old', kind: 'payment_out', amount_minor: '5000', method: 'cash' } };
  await data.writeDraft(data.draftKey(owner, session, 'payment_out'), { op_id: 'fresh', amount: '', kind: 'payment_out', __recovery_currency: 'USD', __operation_conflict: 'Review', __recovery_request: request });
  const recovered = (await data.listRecoveredDrafts(owner))[0]!;
  expect(recovered.request).toBeUndefined();
  expect(recovered.request_error).toMatch(/enter an amount/i);
});

it('uses the original session currency for an ordinary settings patch', async () => {
  const data = await import('../src/client/data');
  const request = { path: `/api/sessions/${session}`, method: 'PATCH', body: { op_id: 'old', big_blind_minor: '100' } };
  await data.writeDraft(data.draftKey(owner, session, 'settings'), { op_id: 'fresh', blind: '1', currency: 'JPY', __recovery_currency: 'USD', __operation_conflict: 'Review', __recovery_request: request });
  expect((await data.listRecoveredDrafts(owner))[0]!.request?.body).toMatchObject({ big_blind_minor: '100' });
});

it('does not infer the attempted request from a conflicting historical operation binding', async () => {
  const data = await import('../src/client/data');
  const key = data.draftKey(owner, session, 'correction');
  await data.writeDraft(`${owner}/_operations/requests/old`, { request: { path: `/api/sessions/${session}/entries/entry/void`, method: 'POST', body: { op_id: 'old', replacement_amount_minor: '1000' } }, source: { key, value: { op_id: 'old', amount: '10' } } });
  await data.writeDraft(key, { op_id: 'fresh', amount: '50', __recovery_currency: 'USD', __operation_conflict: 'Review' });
  const recovered = (await data.listRecoveredDrafts(owner)).find(item => item.key === key)!;
  expect(recovered.request).toBeUndefined();
  expect(recovered.uncertain).toBe(true);
});


it('blocks stale continued typing until the banker explicitly reviews the adopted draft', async () => {
  const data = await import('../src/client/data');
  const key = data.draftKey(owner, session, 'payment_out', 'player');
  const original = { op_id: 'fresh', amount: '50.00' };
  await data.writeDraft(key, original);
  const begin = source.indexOf('function draftForm(');
  const end = source.indexOf("\nit.each([false, true])('adopts", begin);
  const code = ts.transpileModule(source.slice(begin, end).replace('const form = useDraft(formKey, initial);', 'const form = useDraft(formKey, initial, { requireConflictReview: true });') + '\nreturn draftForm;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const create = Function('ts', 'readFileSync', 'runInNewContext', 'window', 'crypto', 'structuredClone', 'Event', 'CustomEvent', code)(ts, readFileSync, runInNewContext, window, crypto, structuredClone, Event, CustomEvent);
  const harness = create(data, key, original) as { render: () => { ready: boolean; value: typeof original; update: (value: typeof original) => void; reviewRequired?: boolean; acknowledgeReview?: () => void; withSnapshot: (action: () => Promise<unknown>) => Promise<unknown> }; close: () => void };
  let form = harness.render();
  try {
    await vi.waitFor(() => { form = harness.render(); expect(form.ready).toBe(true); });
    vi.resetModules();
    const other = await import('../src/client/data');
    await other.writeDraft(key, { ...original, amount: '75.00' });
    form.update({ ...original, amount: '' });
    await vi.waitFor(() => { form = harness.render(); expect(form.value.amount).toBe('75.00'); expect(form.reviewRequired).toBe(true); });
    form.update({ ...form.value, amount: '75.0025.00' });
    await data.flushDraftWrites();
    expect((await other.readDraft<typeof original>(key))?.amount).toBe('75.00');
    const action = vi.fn(async () => undefined);
    await expect(form.withSnapshot(action)).rejects.toThrow(/review/i);
    expect(action).not.toHaveBeenCalled();
    form.acknowledgeReview!();
    form = harness.render();
    expect(form.reviewRequired).toBe(false);
    form.update({ ...form.value, amount: '80.00' });
    await data.flushDraftWrites();
    expect((await other.readDraft<typeof original>(key))?.amount).toBe('80.00');
  } finally { harness.close(); }
});
