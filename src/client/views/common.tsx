import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Banker, BankerClient, OutboxItem } from '../data';
import { deleteDraft, dismissDraftConflict, DraftConflictError, draftConflict, draftConflictNotice, draftConflictNotices, draftSaveFailed, enqueue, flushDraftWrites, prepareDraftSubmission, readDraft, replaySubmittedDraft, writeDraft, type DraftCursor, type DraftRequest, type RecoveredDraft, listRecoveredDrafts, resolveRecoveredDraft, editRecoveredDraft } from '../data';
import type { LedgerEntry, SessionState } from '../../domain/session';
import { currencyExponent, formatMoney } from '../../domain/money';
import { formatRational, formatSquareRoot, type Rational } from '../../domain/rational';

export type SheetState = { kind: string; player?: string; entry?: string; amount?: string } | null;
export type ClientState = {
  banker: Banker | null;
  client: BankerClient | null;
  state: SessionState | null;
  online: boolean;
  pending: OutboxItem[];
  open: (sheet: SheetState) => void;
  update: (state: SessionState) => void;
  notify: (text: string) => void;
  updateBanner?: ReactNode;
  formBusy: boolean;
  setFormBusy: (busy: boolean) => void;
  isCurrent?: () => boolean;
  mutate: (path: string, body: Record<string, unknown>, method?: string) => Promise<SessionState>;
};
export const ClientContext = createContext<ClientState | null>(null);
export function useClient() {
  const value = useContext(ClientContext);
  if (!value) throw new Error('Table is unavailable');
  return value;
}
export function money(value: string, currency: string) { return formatMoney(BigInt(value), currency); }
export function resultMoney(value: string, currency: string) {
  const amount = BigInt(value);
  return amount === 0n ? 'Even' : `${amount > 0n ? '+' : ''}${money(value, currency)}`;
}
export function resultCurrencyDecimal(value: Rational, currency: string) {
  return resultMoney(formatRational(value, 0).replace('−', '-'), currency);
}
export function resultNumber(value: Rational) {
  const text = formatRational(value);
  return /^0(?:\.0+)?$/.test(text) ? 'Even' : `${text.startsWith('−') ? '' : '+'}${text}`;
}
export function decimal(value: string, currency: string) {
  const exponent = currencyExponent(currency);
  const amount = BigInt(value);
  const scale = 10n ** BigInt(exponent);
  return `${amount / scale}${exponent ? `.${String(amount % scale).padStart(exponent, '0')}` : ''}`;
}
export function currencyDecimal(value: Rational, currency: string, squareRoot = false) {
  const exponent = currencyExponent(currency);
  const scale = 10n ** BigInt(exponent);
  const scaled = { numerator: value.numerator, denominator: String(BigInt(value.denominator) * (squareRoot ? scale * scale : scale)) };
  const text = squareRoot ? formatSquareRoot(scaled, exponent) : formatRational(scaled, exponent);
  return money(text.replace('−', '-').replace('.', ''), currency);
}
export function duration(value: string | null, showSeconds = false) {
  if (value === null) return 'No time recorded';
  const seconds = BigInt(value) / 1000n;
  const hours = seconds / 3600n;
  const minutes = (seconds % 3600n) / 60n;
  const remainder = seconds % 60n;
  if (showSeconds) return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
  return hours > 0n ? `${hours} h ${String(minutes).padStart(2, '0')} min` : `${minutes} min`;
}
export function sessionLabel(session: { played_on: string; name: string }) {
  return `${new Date(`${session.played_on}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · ${session.name}`;
}
export const entryLabels: Record<LedgerEntry['kind'], string> = { buy_in: 'Buy-in', cash_out: 'Cash-out', payment_in: 'Payment received', payment_out: 'Payment paid', expense: 'Tips and meals' };
export function methodLabel(method: string | null) { return method ? method.charAt(0).toUpperCase() + method.slice(1) : ''; }
export function useDraft<T extends object>(key: string, initial: T, options: { requireConflictReview?: boolean } = {}) {
  const client = useContext(ClientContext);
  type Value = T & { __submitted?: DraftRequest };
  const [value, setValue] = useState<Value>(initial);
  const latestValue = useRef<Value>(initial);
  const cursor = useRef<DraftCursor>({});
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [reviewRequired, setReviewRequired] = useState(false);
  const reviewBlocked = useRef(false);
  const [shownNotice, setShownNotice] = useState<DraftConflictError | null>(null);
  const initialValue = useRef(initial);
  const previousKey = useRef(key);
  const submitted = useRef<DraftRequest | undefined>(undefined);
  const retainedEdit = useRef(false);
  const retainedEditMessage = 'This form was submitted in another tab. Your later edit is kept. Check the saved result before submitting it.';
  const inFlight = useRef<symbol | undefined>(undefined);
  const scope = useRef({ active: true, version: 0 });
  if (previousKey.current !== key) {
    scope.current.active = false;
    scope.current = { active: true, version: 0 };
    initialValue.current = initial; previousKey.current = key; submitted.current = undefined; inFlight.current = undefined; cursor.current = {}; reviewBlocked.current = false;
  }
  const owner = scope.current;
  const current = () => scope.current === owner && owner.active && (!client || (client.banker?.id === key.split('/')[0] && client.isCurrent?.() !== false));
  const capture = () => { const version = owner.version; return () => current() && owner.version === version; };
  function adopt(next: Value) { latestValue.current = next; submitted.current = next.__submitted; retainedEdit.current = false; setValue(next); }
  function adoptObserved(next: Value, observation: DraftCursor) {
    const waiting = retainedEdit.current;
    adopt(next);
    if (observation.submitted) { submitted.current = observation.submitted; retainedEdit.current = true; setError(retainedEditMessage); }
    else if (waiting) setError(previous => previous === retainedEditMessage ? '' : previous);
  }
  function requireReview() { if (options.requireConflictReview) { reviewBlocked.current = true; setReviewRequired(true); } }
  function acknowledgeReview() {
    if (!current() || !reviewBlocked.current) return;
    reviewBlocked.current = false; setReviewRequired(false); setError('');
  }
  function refreshConflict(problem: { value: unknown; version: string | null; message: string }) {
    requireReview();
    const next = problem.value as Value | undefined;
    cursor.current.version = problem.version;
    setShownNotice(problem instanceof DraftConflictError ? problem : draftConflictNotice(key) ?? null);
    if (next) adopt(next);
    else freshValue(current);
    setError(problem.message);
  }
  useEffect(() => {
    owner.active = true;
    const isCurrent = capture();
    setReady(false); setError(''); setShownNotice(null); reviewBlocked.current = false; setReviewRequired(false);
    const observation: DraftCursor = {};
    void readDraft<Value>(key, observation).then(saved => {
      if (!isCurrent()) return;
      cursor.current = observation; adopt(saved ?? initialValue.current);
      const notice = draftConflictNotice(key);
      if (notice) { setShownNotice(notice); setError(notice.message); }
      setReady(true);
    }).catch(problem => { if (isCurrent()) { const message = problem instanceof Error ? problem.message : 'Could not restore the draft'; setError(message); storageFailure(problem); } });
    return () => { owner.active = false; owner.version++; };
  }, [key]);
  useLayoutEffect(() => {
    if (!shownNotice || shownNotice.key !== key || !ready || !current() || error !== shownNotice.message) return;
    dismissDraftConflict(shownNotice);
    setShownNotice(previous => previous === shownNotice ? null : previous);
  }, [key, ready, error, shownNotice]);
  useEffect(() => {
    const refresh = () => {
      if (!current()) return;
      const conflict = draftConflict(key, cursor.current, latestValue.current);
      if (conflict && !inFlight.current) { refreshConflict(conflict); return; }
      setError(previous => draftSaveFailed(key) ? 'Not saved on this device' : previous === 'Not saved on this device' ? '' : previous);
      if (!submitted.current || inFlight.current || draftSaveFailed(key)) return;
      const isCurrent = capture();
      const previous = latestValue.current;
      const observation: DraftCursor = {};
      void readDraft<Value>(key, observation, { includeNext: retainedEdit.current }).then(saved => {
        if (!isCurrent() || latestValue.current !== previous || inFlight.current || draftSaveFailed(key)) return;
        cursor.current = observation;
        if (saved) adoptObserved(saved, observation);
        else freshValue(isCurrent);
      }).catch(problem => { if (isCurrent()) storageFailure(problem); });
    };
    const refreshSaved = () => {
      if (!current() || inFlight.current) return;
      const isCurrent = capture();
      const previous = latestValue.current;
      const observation: DraftCursor = {};
      void readDraft<Value>(key, observation, { includeNext: retainedEdit.current }).then(saved => {
        if (!isCurrent() || latestValue.current !== previous || inFlight.current || draftSaveFailed(key)) return;
        const edited = saved === undefined ? observation.version !== cursor.current.version : JSON.stringify(saved) !== JSON.stringify(previous);
        if (edited) requireReview();
        cursor.current = observation;
        if (saved) adoptObserved(saved, observation);
        else if (edited) freshValue(isCurrent);
        if (edited) setError('This draft was edited in another tab. Review the latest draft and submit again.');
        else setError(previous => previous === 'Not saved on this device' ? '' : previous);
      }).catch(problem => { if (isCurrent()) storageFailure(problem); });
    };
    refresh(); window.addEventListener('pb-data', refresh); window.addEventListener('pb-storage-saved', refreshSaved);
    return () => { window.removeEventListener('pb-data', refresh); window.removeEventListener('pb-storage-saved', refreshSaved); };
  }, [key]);
  function update(next: T) {
    if (!ready || cursor.current.version === undefined || !current() || (submitted.current && !retainedEdit.current) || inFlight.current || reviewBlocked.current) return;
    const isCurrent = capture();
    const earlier = retainedEdit.current ? submitted.current : undefined;
    adopt(next);
    if (earlier) { submitted.current = earlier; retainedEdit.current = true; }
    void writeDraft(key, next, cursor.current).then(async () => {
      if (!isCurrent() || latestValue.current !== next) return;
      const observation: DraftCursor = {};
      const saved = await readDraft<Value>(key, observation, { includeNext: true });
      if (!isCurrent() || latestValue.current !== next || draftSaveFailed(key)) return;
      if (!observation.submitted && JSON.stringify(saved) !== JSON.stringify(next)) requireReview();
      cursor.current = observation;
      setError(observation.submitted ? retainedEditMessage : JSON.stringify(saved) === JSON.stringify(next) ? '' : 'This draft was edited in another tab. Review the latest draft and submit again.');
      if (saved) adoptObserved(saved, observation);
    }).catch(problem => { if (isCurrent() && latestValue.current === next) { if (problem instanceof DraftConflictError) refreshConflict(problem); else { setError('Not saved on this device'); storageFailure(problem); } } });
  }
  function freshValue(isCurrent: () => boolean) {
    if (!isCurrent()) return;
    submitted.current = undefined;
    const fresh = { ...initialValue.current, ...('op_id' in initialValue.current ? { op_id: crypto.randomUUID() } : {}) };
    adopt(fresh);
  }
  async function clear() {
    if (retainedEdit.current) throw new Error(retainedEditMessage);
    if (!ready || cursor.current.version === undefined) throw new Error('Restoring draft. Wait before changing this form.');
    const isCurrent = capture();
    if (!isCurrent()) return;
    const previous = latestValue.current;
    const message = 'This draft changed while discarding. Review your latest edit before discarding again.';
    try { await deleteDraft(key, isCurrent, cursor.current); }
    catch (problem) {
      if (isCurrent()) {
        if (problem instanceof DraftConflictError) {
          if (latestValue.current !== previous) setError(message);
          else refreshConflict(problem);
        } else storageFailure(problem);
      }
      throw problem;
    }
    if (!isCurrent()) return;
    if (latestValue.current !== previous) { setError(message); throw new Error(message); }
    freshValue(isCurrent);
  }
  async function queue(input: Parameters<typeof enqueue>[0]) {
    if (retainedEdit.current) throw new Error(retainedEditMessage);
    if (!ready || cursor.current.version === undefined) throw new Error('Restoring draft. Wait before changing this form.');
    const isCurrent = capture();
    if (!isCurrent()) throw new Error('Account changed or this form is no longer open. Check your saved work.');
    if (inFlight.current) throw new Error('Wait for this entry to finish saving');
    const flight = Symbol();
    inFlight.current = flight;
    setError('');
    try {
      const result = await enqueue({ ...input, draft_key: key, draft_cursor: cursor.current, draft_value: latestValue.current });
      if (!isCurrent()) throw new Error('Account changed or this form is no longer open. Check your saved work.');
      if ('draft_conflict' in result) { refreshConflict(result); throw new Error(result.message); }
      return result;
    } catch (problem) { if (isCurrent() && problem instanceof DraftConflictError) refreshConflict(problem); throw problem; }
    finally { if (inFlight.current === flight) inFlight.current = undefined; }
  }
  async function perform<R>(request: DraftRequest, first: boolean): Promise<R> {
    if (!ready || cursor.current.version === undefined) throw new Error('Restoring draft. Wait before changing this form.');
    const isCurrent = capture();
    const ensureCurrent = () => { if (!isCurrent()) throw new Error('Account changed or this form is no longer open. Check your saved work.'); };
    ensureCurrent();
    if (inFlight.current) throw new Error('Wait for this saved result to finish checking');
    const flight = Symbol();
    inFlight.current = flight;
    setError('');
    try {
      if (first) {
        const prepared = await prepareDraftSubmission(key, value, request, isCurrent, cursor.current);
        ensureCurrent();
        if (prepared.previouslyConfirmed) {
          const message = 'This draft was edited in another tab. Review the latest draft and submit again.';
          refreshConflict({ value: prepared.value, version: cursor.current.version ?? null, message });
          throw new Error(message);
        }
        adopt(prepared.value);
      }
      let result: R;
      try { result = await replaySubmittedDraft<R>(key, isCurrent, cursor.current); }
      catch (problem) {
        ensureCurrent();
        if (problem instanceof DraftConflictError) throw problem;
        const observation: DraftCursor = {};
        const restored = await readDraft<Value>(key, observation);
        ensureCurrent();
        if (restored && !restored.__submitted) {
          cursor.current = observation;
          adopt(restored);
        }
        throw problem;
      }
      ensureCurrent();
      const observation: DraftCursor = {};
      const retained = await readDraft<Value>(key, observation);
      ensureCurrent();
      cursor.current = observation;
      if (retained) adopt(retained);
      else freshValue(isCurrent);
      if (result && typeof result === 'object' && 'session' in result) client?.update(result as unknown as SessionState);
      return result;
    } catch (problem) { if (isCurrent() && problem instanceof DraftConflictError) refreshConflict(problem); throw problem; }
    finally { if (inFlight.current === flight) inFlight.current = undefined; }
  }
  async function submit<R>(path: string, body: Record<string, unknown>, method = 'POST') {
    if (retainedEdit.current) throw new Error(retainedEditMessage);
    const request = submitted.current ?? { path, body: structuredClone(body), method };
    return perform<R>(request, !submitted.current);
  }
  async function reconcile<R>() {
    if (!submitted.current) throw new Error('There is no submitted form to check');
    return perform<R>(submitted.current, false);
  }
  async function withSnapshot<R>(action: (value: Value, observation: DraftCursor) => Promise<R>, allowReviewRequired = false): Promise<R> {
    if (!ready || cursor.current.version === undefined) throw new Error('Restoring draft. Wait before changing this form.');
    const isCurrent = capture();
    if (!isCurrent()) throw new Error('Account changed or this form is no longer open. Check your saved work.');
    if (retainedEdit.current) throw new Error(retainedEditMessage);
    if (inFlight.current) throw new Error('Wait for this draft to finish saving');
    if (reviewBlocked.current && !allowReviewRequired) throw new Error('Review the saved draft before changing or resubmitting it.');
    const flight = Symbol();
    const expected = JSON.stringify(latestValue.current);
    inFlight.current = flight;
    try {
      await flushDraftWrites();
      if (!isCurrent()) throw new Error('Account changed or this form is no longer open. Check your saved work.');
      if (JSON.stringify(latestValue.current) !== expected) { requireReview(); throw new Error('This draft was edited in another tab. Review the latest draft and submit again.'); }
      if (reviewBlocked.current && !allowReviewRequired) throw new Error('Review the saved draft before changing or resubmitting it.');
      const result = await action(latestValue.current, { version: cursor.current.version });
      if (isCurrent()) {
        const observation: DraftCursor = {};
        const saved = await readDraft<Value>(key, observation);
        if (isCurrent() && saved) { cursor.current = observation; adopt(saved); }
      }
      return result;
    } catch (problem) {
      if (isCurrent() && problem instanceof DraftConflictError) refreshConflict(problem);
      throw problem;
    } finally { if (inFlight.current === flight) inFlight.current = undefined; }
  }
  return { value, update, ready, clear, error, submit, reconcile, queue, withSnapshot, reviewRequired, acknowledgeReview, submitted: !!value.__submitted };
}
export function DraftRecovery<T>({ recover, recovered, pending = false, notice = '' }: { recover: () => Promise<T>; recovered: (value: T) => void; pending?: boolean; notice?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useFormBusy(busy || pending);
  return <><p className="warning">This form was submitted here or in another tab and may already have been saved. Check the saved result before editing it or starting another.</p><ErrorText text={notice} /><ErrorText text={error === notice ? '' : error} /><button className="primary wide" disabled={busy || pending} onClick={() => { if (busy || pending) return; setBusy(true); setError(''); void recover().then(recovered).catch(problem => { setError(problem instanceof Error ? problem.message : 'Could not check the saved result'); setBusy(false); }); }}>{busy ? 'Checking saved result…' : 'Check saved result'}</button></>;
}
export function useFormBusy(busy: boolean) {
  const setBusy = useClient().setFormBusy;
  useLayoutEffect(() => { setBusy(busy); return () => setBusy(false); }, [busy, setBusy]);
}
export function storageFailure(problem: unknown) { window.dispatchEvent(new CustomEvent('pb-storage-error', { detail: problem instanceof Error ? problem.message : 'Local storage is unavailable' })); }
const recoveryFieldLabels: Record<string, string> = { amount: 'Amount', amount_minor: 'Amount in minor units', player_id: 'Player ID', name: 'Name', display_name: 'Player name', new_player_name: 'New player name', search: 'Player search', played_on: 'Session date', currency: 'Currency', location: 'Location', game: 'Game', blind: 'Big blind', big_blind_minor: 'Big blind in minor units', reason: 'Reason', start: 'Started at', end: 'Ended at', started_at: 'Started at', ended_at: 'Ended at', time: 'Entry time', occurred_at: 'Entry time', method: 'Payment method', paid_now: 'Paid now', note: 'Note', kind: 'Entry kind', action: 'Sharing action', expected_revision: 'Expected session revision', accept_discrepancy_minor: 'Accepted discrepancy in minor units', replacement_amount_minor: 'Replacement amount in minor units', replacement_method: 'Replacement method', replacement_occurred_at: 'Replacement entry time' };
function recoveryFields(value: unknown): [string, unknown][] {
  if (!value || typeof value !== 'object') return [];
  const fields = value as Record<string, unknown>;
  return Object.entries(fields).filter(([key]) => !(key === 'amount' && fields.__recovery_raw_amount === true) && key !== 'op_id' && !key.startsWith('__') && !(key === 'amount_minor' && typeof fields.amount === 'string' && fields.amount.trim()));
}
function RecoveredDraftFields({ value }: { value: unknown }) {
  const fields = recoveryFields(value);
  return fields.length ? <dl>{fields.map(([key, value]) => <div key={key}><dt>{recoveryFieldLabels[key] ?? key.replaceAll('_', ' ')}</dt><dd>{typeof value === 'boolean' ? value ? 'Yes' : 'No' : typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value ?? '') || 'Not recorded'}</dd></div>)}</dl> : <p>No saved draft.</p>;
}
type RecoverySnapshot = (action: (value: Record<string, unknown>, observation: DraftCursor) => Promise<unknown>, allowReviewRequired?: boolean) => Promise<unknown>;
function recoveredFieldsValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : { saved_value: value };
}
function RecoveredDraftEditor({ recovery, busy, act }: { recovery: RecoveredDraft; busy: boolean; act: (recovery: RecoveredDraft, action: 'save' | 'discard' | 'submit', acceptUncertainDiscard: boolean, observe: RecoverySnapshot) => Promise<void> }) {
  const account = useClient();
  const [roster, setRoster] = useState<{ id: string; display_name: string }[]>([]);
  const [rosterError, setRosterError] = useState('');
  const draft = useDraft<Record<string, unknown>>(recovery.key, recoveredFieldsValue(recovery.value), { requireConflictReview: true });
  const value = recoveredFieldsValue(draft.value);
  const json = value.__recovery_json as Record<string, string> | undefined;
  const existingPlayer = /^\/api\/sessions\/[^/]+\/players$/.test(recovery.request?.path ?? '') && typeof value.player_id === 'string';
  useEffect(() => {
    let active = true;
    const client = account.client;
    if (existingPlayer && client) void client.api<{ players: { id: string; display_name: string }[] }>('/api/players').then(result => { if (active && client.isCurrent()) { setRoster(result.players); setRosterError(''); } }).catch(problem => { if (active && client.isCurrent()) setRosterError(problem instanceof Error ? problem.message : 'Could not load players'); });
    return () => { active = false; };
  }, [account.client, existingPlayer]);
  const fields = recoveryFields(value).filter(([key]) => !(existingPlayer && key === 'search') && !(key === 'new_player_name' && typeof value.search === 'string') && !(recovery.request?.method === 'PATCH' && /^\/api\/sessions\/[^/]+$/.test(recovery.request.path) && key === 'currency'));
  function run(action: 'save' | 'discard' | 'submit') {
    const accepted = action !== 'discard' || !recovery.uncertain || window.confirm('This operation may already exist on the server. Discarding this draft does not undo a saved operation. Re-entering it may record it twice. Discard anyway?');
    if (accepted) void act(recovery, action, accepted, draft.withSnapshot);
  }
  return <details className="warning" data-testid="recovered-draft"><summary>Review recovered edit</summary><h3>{recovery.label}</h3><p>Check the game for an earlier save before resubmitting. Your edits are saved on this device as you type.</p>{fields.map(([key, field]) => {
    const label = recoveryFieldLabels[key] ?? key.replaceAll('_', ' ');
    const change = (next: unknown) => draft.update({ ...value, [key]: next });
    const disabled = busy || !draft.ready || draft.submitted || draft.reviewRequired;
    if (existingPlayer && key === 'player_id') return <label key={key}>Player<select value={String(field)} onChange={event => change(event.target.value)} disabled={disabled}>{!roster.some(player => player.id === field) && <option value={String(field)}>Saved player</option>}{roster.map(player => <option key={player.id} value={player.id}>{player.display_name}</option>)}</select></label>;
    return <label key={key}>{label}{typeof field === 'boolean' ? <input type="checkbox" checked={field} onChange={event => change(event.target.checked)} disabled={disabled} /> : field !== null && typeof field === 'object' ? <textarea value={json?.[key] ?? JSON.stringify(field)} onChange={event => draft.update({ ...value, __recovery_json: { ...json, [key]: event.target.value } })} disabled={disabled} /> : <input value={String(field ?? '')} onChange={event => change(typeof field === 'number' ? Number(event.target.value) : event.target.value === '' && field === null ? null : event.target.value)} disabled={disabled} />}</label>;
  })}{recovery.request_error?.includes('currency is unavailable') && <><label>Session currency<select value={String(value.__recovery_currency ?? recovery.currency ?? '')} onChange={event => draft.update({ ...value, __recovery_currency: event.target.value })} disabled={busy || !draft.ready || draft.reviewRequired}><option value="">Choose the game's currency</option>{['USD', 'JPY', 'CAD', 'EUR', 'GBP', 'SGD', 'HKD', 'AUD'].map(currency => <option key={currency}>{currency}</option>)}</select></label><p className="hint">Choose the original session currency, then save this draft to review its amount before resubmitting.</p></>}{!recovery.request && <p>{recovery.request_error ?? 'The original request is unavailable. You can review, edit, copy, or discard these saved fields.'}</p>}<ErrorText text={draft.error || rosterError} />{draft.reviewRequired && <button type="button" disabled={busy} onClick={draft.acknowledgeReview}>Review saved draft</button>}<button type="button" disabled={busy || !draft.ready || draft.submitted || draft.reviewRequired} onClick={() => run('save')}>Save recovered draft</button>{recovery.request && <button type="button" disabled={busy || !draft.ready || draft.submitted || draft.reviewRequired} onClick={() => run('submit')}>Resubmit recovered draft</button>}<button type="button" disabled={busy || !draft.ready || draft.submitted} onClick={() => run('discard')}>Discard recovered draft</button></details>;
}

export function DraftSaveStatus() {
  const account = useContext(ClientContext);
  const bankerId = account?.banker?.id;
  const [failed, setFailed] = useState(draftSaveFailed);
  const [notices, setNotices] = useState<DraftConflictError[]>([]);
  const [recoveries, setRecoveries] = useState<RecoveredDraft[]>([]);
  const [recoveryError, setRecoveryError] = useState('');
  const [busy, setBusy] = useState(false);
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    let revision = 0;
    const refresh = () => {
      setFailed(draftSaveFailed()); setNotices(bankerId ? draftConflictNotices(bankerId) : []);
      const version = ++revision;
      if (!bankerId) { setRecoveries([]); return; }
      void listRecoveredDrafts(bankerId).then(next => { if (alive.current && version === revision && account?.isCurrent?.() !== false) setRecoveries(next); }).catch(problem => { if (alive.current && version === revision) setRecoveryError(problem instanceof Error ? problem.message : 'Could not load recovered edits'); });
    };
    window.addEventListener('pb-data', refresh); refresh();
    return () => { alive.current = false; revision++; window.removeEventListener('pb-data', refresh); };
  }, [bankerId]);
  async function resolve(recovery: RecoveredDraft, useRecovered: boolean) {
    const current = () => alive.current && account?.isCurrent?.() !== false && recovery.key.startsWith(`${bankerId}/`);
    if (busy || !current() || !bankerId) return;
    setBusy(true); setRecoveryError('');
    try { await resolveRecoveredDraft(recovery, useRecovered, current); }
    catch (problem) { if (current()) setRecoveryError(problem instanceof Error ? problem.message : 'Could not resolve this recovered edit'); }
    finally {
      if (current()) {
        try { const next = await listRecoveredDrafts(bankerId); if (current()) setRecoveries(next); }
        catch (problem) { if (current()) setRecoveryError(problem instanceof Error ? problem.message : 'Could not reload recovered edits'); }
        if (current()) setBusy(false);
      }
    }
  }
  async function edit(recovery: RecoveredDraft, action: 'save' | 'discard' | 'submit', acceptUncertainDiscard: boolean, observe: RecoverySnapshot) {
    const current = () => alive.current && account?.isCurrent?.() !== false && recovery.key.startsWith(`${bankerId}/`);
    if (busy || !current() || !bankerId) return;
    setBusy(true); setRecoveryError('');
    try {
      const result = await observe(async (saved, observation) => {
        const value = { ...recoveredFieldsValue(saved) };
        if (action !== 'discard') for (const [key, text] of Object.entries(value.__recovery_json as Record<string, string> ?? {})) {
          try { value[key] = JSON.parse(text); }
          catch { throw new Error('Enter valid JSON for the structured field.'); }
        }
        delete value.__recovery_json;
        return editRecoveredDraft({ ...recovery, version: observation.version ?? null, source_version: observation.version ?? null }, value, action, current, acceptUncertainDiscard);
      }, action === 'discard');
      if (current() && result && typeof result === 'object' && 'session' in result && 'players' in result && 'entries' in result && 'revision' in result) account?.update(result as SessionState);
    } catch (problem) { if (current()) setRecoveryError(problem instanceof Error ? problem.message : 'Could not save this recovered draft'); }
    finally {
      if (current()) {
        try { const next = await listRecoveredDrafts(bankerId); if (current()) setRecoveries(next); }
        catch (problem) { if (current()) setRecoveryError(problem instanceof Error ? problem.message : 'Could not reload recovered drafts'); }
        if (current()) setBusy(false);
      }
    }
  }
  const visible = notices.filter(notice => bankerId && notice.key.startsWith(`${bankerId}/`));
  return <>{visible.length > 0 && <div className="warning" role="alert" data-testid="draft-conflict-notice">{visible.map(notice => <p key={notice.key}>{notice.message}</p>)}<button type="button" onClick={() => { if (account?.isCurrent?.() === false) return; for (const notice of visible) dismissDraftConflict(notice); }}>Dismiss draft change notice</button></div>}
    {recoveries.length > 0 && <section aria-label="Needs review"><h2>Needs review</h2>{recoveries.filter(recovery => bankerId && recovery.key.startsWith(`${bankerId}/`)).map(recovery => recovery.collision ? <details className="warning" key={recovery.key} data-testid="recovered-draft"><summary>Review recovered edit</summary><p>A saved draft and your recovered edit are both kept. Check the game for an earlier save before choosing.</p><h3>Saved draft</h3><RecoveredDraftFields value={recovery.source_value} /><h3>Your recovered edit</h3><RecoveredDraftFields value={recovery.value} /><button type="button" disabled={busy} onClick={() => { void resolve(recovery, true); }}>Use recovered edit</button><button type="button" disabled={busy} onClick={() => { void resolve(recovery, false); }}>Keep saved edit</button></details> : <RecoveredDraftEditor key={recovery.key} recovery={recovery} busy={busy} act={edit} />)}</section>}
    <ErrorText text={recoveryError} />{failed && <div className="warning" role="alert"><p>Not saved on this device. Keep this page open until your draft is saved or explicitly discarded.</p><button type="button" disabled={busy} onClick={() => { setBusy(true); void flushDraftWrites().then(() => window.dispatchEvent(new Event('pb-storage-saved'))).catch(storageFailure).finally(() => setBusy(false)); }}>{busy ? 'Saving draft…' : 'Retry saving draft'}</button></div>}</>;
}
export function ErrorText({ text, id }: { text: string; id?: string }) { return text ? <p id={id} role="alert" className="error" tabIndex={-1}>{text}</p> : null; }
export function Sheet({ title, children, close, leadingClose = true, closeLabel = 'Cancel', className = '' }: { title: string; children: ReactNode; close: () => void; leadingClose?: boolean; closeLabel?: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const shownError = useRef('');
  const client = useContext(ClientContext);
  const updateBanner = client?.updateBanner;
  const busy = client?.formBusy ?? false;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const panel = ref.current;
    let focused = false;
    const available = (element: HTMLElement) => element.getClientRects().length > 0 && !element.matches(':disabled') && getComputedStyle(element).visibility !== 'hidden';
    function focusEditor() {
      if (focused || !panel) return;
      const editors = [...panel.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input:not([type="checkbox"]),select,textarea')].filter(editor => available(editor) && editor.dataset.autofocus !== 'false');
      const editor = editors.find(editor => editor.dataset.testid === 'money-amount') ?? editors[0];
      if (editor) { editor.focus(); focused = document.activeElement === editor; }
    }
    focusEditor();
    if (!focused) [...panel?.querySelectorAll<HTMLElement>('button,summary') ?? []].find(available)?.focus();
    const observer = new MutationObserver(() => { focusEditor(); if (focused) observer.disconnect(); });
    if (panel && !focused) observer.observe(panel, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
    function keyboard(event: KeyboardEvent) {
      if (event.key === 'Escape') { event.preventDefault(); if (!busyRef.current) closeRef.current(); }
      if (event.key !== 'Tab' || !panel) return;
      const fields = [...panel.querySelectorAll<HTMLElement>('button,input,select,textarea,a[href],summary,[tabindex]')].filter(element => element.tabIndex >= 0 && available(element));
      const first = fields[0], last = fields.at(-1);
      if (!first) { event.preventDefault(); panel.focus(); return; }
      if (!panel.contains(document.activeElement)) { event.preventDefault(); first.focus(); return; }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    document.addEventListener('keydown', keyboard);
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { observer.disconnect(); document.removeEventListener('keydown', keyboard); document.body.style.overflow = oldOverflow; previous?.focus(); };
  }, []);
  useLayoutEffect(() => {
    const panel = ref.current;
    const backdrop = panel?.parentElement;
    const viewport = window.visualViewport;
    let frame = 0;
    const keepVisible = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!panel || !backdrop) return;
        const height = viewport?.height ?? window.innerHeight;
        backdrop.dataset.compact = String(height < 480);
        backdrop.style.height = `${height}px`;
        backdrop.style.setProperty('--sheet-viewport-height', `${height}px`);
        backdrop.style.top = `${viewport?.offsetTop ?? 0}px`;
        backdrop.style.bottom = 'auto';
        const active = document.activeElement;
        if (!(active instanceof HTMLElement) || !panel.contains(active) || !active.matches('input,select,textarea')) return;
        const body = active.closest<HTMLElement>('.form-body,.money-fields,.sheet-fields,.sheet-status');
        if (!body) return;
        const field = active.getBoundingClientRect();
        const bounds = body.getBoundingClientRect();
        if (field.bottom > bounds.bottom - 16) body.scrollTop += field.bottom - bounds.bottom + 16;
        else if (field.top < bounds.top + 16) body.scrollTop -= bounds.top + 16 - field.top;
      });
    };
    keepVisible();
    viewport?.addEventListener('resize', keepVisible);
    viewport?.addEventListener('scroll', keepVisible);
    window.addEventListener('resize', keepVisible);
    panel?.addEventListener('focusin', keepVisible);
    return () => {
      cancelAnimationFrame(frame);
      viewport?.removeEventListener('resize', keepVisible);
      viewport?.removeEventListener('scroll', keepVisible);
      window.removeEventListener('resize', keepVisible);
      panel?.removeEventListener('focusin', keepVisible);
    };
  }, []);
  useLayoutEffect(() => {
    const panel = ref.current;
    const revealError = () => {
      const error = panel?.querySelector<HTMLElement>('.error');
      const message = error?.textContent ?? '';
      if (message && message !== shownError.current && error) {
        const invalid = panel?.querySelector<HTMLElement>('[aria-invalid="true"]');
        (invalid ?? error).focus({ preventScroll: true });
        const body = error.closest<HTMLElement>('.form-body,.money-fields,.sheet-fields,.sheet-status');
        if (body) {
          const bounds = body.getBoundingClientRect();
          const content = error.getBoundingClientRect();
          if (content.bottom > bounds.bottom - 16) body.scrollTop += content.bottom - bounds.bottom + 16;
          else if (content.top < bounds.top + 16) body.scrollTop -= bounds.top + 16 - content.top;
        }
      }
      shownError.current = message;
    };
    const observer = new MutationObserver(revealError);
    if (panel) observer.observe(panel, { childList: true, subtree: true, characterData: true });
    revealError();
    return () => observer.disconnect();
  }, []);
  const closeButton = <button type="button" aria-label={className.includes('money-sheet') ? closeLabel : 'Close sheet'} disabled={busy} onClick={close}>{closeLabel}</button>;
  return <div className="sheet-backdrop"><div className={`sheet ${className}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
    <div className="sheet-status">{updateBanner}<DraftSaveStatus /></div><div className="sheet-handle" /><header className={`sheet-header${leadingClose ? ' leading-close' : ''}`}>{leadingClose && closeButton}<h2>{title}</h2>{!leadingClose && closeButton}</header><div className="sheet-fields"><fieldset className="sheet-controls" disabled={busy}>{children}</fieldset></div>
  </div></div>;
}
