import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Banker, BankerClient, OutboxItem } from '../data';
import { acceptDraftConflict, deleteDraft, DraftConflictError, draftConflict, draftSaveFailed, enqueue, flushDraftWrites, prepareDraftSubmission, readDraft, replaySubmittedDraft, writeDraft, type DraftCursor, type DraftRequest } from '../data';
import type { LedgerEntry, SessionState } from '../../domain/session';
import { currencyExponent, formatMoney } from '../../domain/money';
import { formatRational, formatSquareRoot, type Rational } from '../../domain/rational';

export type SheetState = { kind: string; player?: string; entry?: string } | null;
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
  if (!value) throw new Error('Workspace is unavailable');
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
  const symbol = new Intl.NumberFormat('en-US', { style: 'currency', currency }).formatToParts(0n).find(part => part.type === 'currency')?.value ?? currency;
  return `${text.startsWith('−') ? '−' : ''}${symbol}${text.replace('−', '')}`;
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
export function useDraft<T extends object>(key: string, initial: T) {
  const client = useContext(ClientContext);
  type Value = T & { __submitted?: DraftRequest };
  const [value, setValue] = useState<Value>(initial);
  const latestValue = useRef<Value>(initial);
  const cursor = useRef<DraftCursor>({});
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const initialValue = useRef(initial);
  const previousKey = useRef(key);
  const submitted = useRef<DraftRequest | undefined>(undefined);
  const inFlight = useRef<symbol | undefined>(undefined);
  const scope = useRef({ active: true, version: 0 });
  if (previousKey.current !== key) {
    scope.current.active = false;
    scope.current = { active: true, version: 0 };
    initialValue.current = initial; previousKey.current = key; submitted.current = undefined; inFlight.current = undefined; cursor.current = {};
  }
  const owner = scope.current;
  const current = () => scope.current === owner && owner.active && (!client || (client.banker?.id === key.split('/')[0] && client.isCurrent?.() !== false));
  const capture = () => { const version = owner.version; return () => current() && owner.version === version; };
  function adopt(next: Value) { latestValue.current = next; submitted.current = next.__submitted; setValue(next); }
  function refreshConflict(problem: { value: unknown; version: string | null; message: string }) {
    const next = problem.value as Value | undefined;
    if (!next?.__submitted) acceptDraftConflict(key, cursor.current, problem);
    else cursor.current.version = problem.version;
    if (next) adopt(next);
    else freshValue(current);
    setError(problem.message);
  }
  useEffect(() => {
    owner.active = true;
    const isCurrent = capture();
    setReady(false); setError('');
    const observation: DraftCursor = {};
    void readDraft<Value>(key, observation).then(saved => { if (isCurrent()) { cursor.current = observation; adopt(saved ?? initialValue.current); setReady(true); } }).catch(problem => { if (isCurrent()) { const message = problem instanceof Error ? problem.message : 'Could not restore the draft'; setError(message); storageFailure(problem); } });
    return () => { owner.active = false; owner.version++; };
  }, [key]);
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
      void readDraft<Value>(key, observation).then(saved => {
        if (!isCurrent() || latestValue.current !== previous || inFlight.current || draftSaveFailed(key)) return;
        cursor.current = observation;
        if (saved) adopt(saved);
        else freshValue(isCurrent);
      }).catch(problem => { if (isCurrent()) storageFailure(problem); });
    };
    const refreshSaved = () => {
      if (!current() || inFlight.current) return;
      const isCurrent = capture();
      const previous = latestValue.current;
      const observation: DraftCursor = {};
      void readDraft<Value>(key, observation).then(saved => {
        if (!isCurrent() || latestValue.current !== previous || inFlight.current || draftSaveFailed(key)) return;
        const edited = saved === undefined ? observation.version !== cursor.current.version : JSON.stringify(saved) !== JSON.stringify(previous);
        cursor.current = observation;
        if (saved) adopt(saved);
        else if (edited) freshValue(isCurrent);
        if (edited) setError('This draft was edited in another tab. Review the latest draft and submit again.');
        else setError(previous => previous === 'Not saved on this device' ? '' : previous);
      }).catch(problem => { if (isCurrent()) storageFailure(problem); });
    };
    refresh(); window.addEventListener('pb-data', refresh); window.addEventListener('pb-storage-saved', refreshSaved);
    return () => { window.removeEventListener('pb-data', refresh); window.removeEventListener('pb-storage-saved', refreshSaved); };
  }, [key]);
  function update(next: T) {
    if (!ready || cursor.current.version === undefined || !current() || submitted.current || inFlight.current) return;
    const isCurrent = capture();
    adopt(next);
    void writeDraft(key, next, cursor.current).then(async () => {
      if (!isCurrent() || latestValue.current !== next) return;
      const observation: DraftCursor = {};
      const saved = await readDraft<Value>(key, observation);
      if (!isCurrent() || latestValue.current !== next || draftSaveFailed(key)) return;
      cursor.current = observation;
      setError('');
      if (saved) adopt(saved);
    }).catch(problem => { if (isCurrent() && latestValue.current === next) { if (problem instanceof DraftConflictError) refreshConflict(problem); else { setError('Not saved on this device'); storageFailure(problem); } } });
  }
  function freshValue(isCurrent: () => boolean) {
    if (!isCurrent()) return;
    submitted.current = undefined;
    const fresh = { ...initialValue.current, ...('op_id' in initialValue.current ? { op_id: crypto.randomUUID() } : {}) };
    adopt(fresh);
  }
  async function clear() {
    if (!ready || cursor.current.version === undefined) throw new Error('Restoring draft. Wait before changing this form.');
    const isCurrent = capture();
    if (!isCurrent()) return;
    try { await deleteDraft(key, isCurrent, cursor.current); freshValue(isCurrent); }
    catch (problem) { if (isCurrent()) { if (problem instanceof DraftConflictError) refreshConflict(problem); else storageFailure(problem); } throw problem; }
  }
  async function queue(input: Parameters<typeof enqueue>[0]) {
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
        if (prepared.previouslyConfirmed) { if (prepared.value) adopt(prepared.value); else freshValue(isCurrent); throw new Error('This draft was edited in another tab. Review the latest draft and submit again.'); }
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
    const request = submitted.current ?? { path, body: structuredClone(body), method };
    return perform<R>(request, !submitted.current);
  }
  async function reconcile<R>() {
    if (!submitted.current) throw new Error('There is no submitted form to check');
    return perform<R>(submitted.current, false);
  }
  return { value, update, ready, clear, error, submit, reconcile, queue, submitted: !!value.__submitted };
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
export function DraftSaveStatus() {
  const [failed, setFailed] = useState(draftSaveFailed);
  const [busy, setBusy] = useState(false);
  useEffect(() => { const refresh = () => setFailed(draftSaveFailed()); window.addEventListener('pb-data', refresh); refresh(); return () => window.removeEventListener('pb-data', refresh); }, []);
  return failed ? <div className="warning" role="alert"><p>Not saved on this device. Keep this page open until your draft is saved or explicitly discarded.</p><button type="button" disabled={busy} onClick={() => { setBusy(true); void flushDraftWrites().then(() => window.dispatchEvent(new Event('pb-storage-saved'))).catch(storageFailure).finally(() => setBusy(false)); }}>{busy ? 'Saving draft…' : 'Retry saving draft'}</button></div> : null;
}
export function ErrorText({ text }: { text: string }) { return text ? <p role="alert" className="error">{text}</p> : null; }
export function Sheet({ title, children, close, leadingClose = false, closeLabel = 'Done', className = '' }: { title: string; children: ReactNode; close: () => void; leadingClose?: boolean; closeLabel?: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
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
    function focusEditor() {
      if (focused || !panel) return;
      const editor = panel.querySelector<HTMLInputElement>('[data-testid="money-amount"]') ?? panel.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input:not([type="checkbox"]),select,textarea');
      if (editor && !editor.disabled) { editor.focus(); focused = true; }
    }
    focusEditor();
    if (!focused) panel?.querySelector<HTMLElement>('button')?.focus();
    const observer = new MutationObserver(() => { focusEditor(); if (focused) observer.disconnect(); });
    if (panel && !focused) observer.observe(panel, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
    function keyboard(event: KeyboardEvent) {
      if (event.key === 'Escape') { event.preventDefault(); if (!busyRef.current) closeRef.current(); }
      if (event.key !== 'Tab' || !panel) return;
      const fields = [...panel.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]')];
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
  const closeButton = <button type="button" aria-label={leadingClose ? closeLabel : 'Close sheet'} disabled={busy} onClick={close}>{closeLabel}</button>;
  return <div className="sheet-backdrop"><div className={`sheet ${className}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
    {updateBanner}<DraftSaveStatus /><div className="sheet-handle" /><header className={`sheet-header${leadingClose ? ' leading-close' : ''}`}>{leadingClose && closeButton}<h2>{title}</h2>{!leadingClose && closeButton}</header><fieldset className="sheet-fields" disabled={busy}>{children}</fieldset>
  </div></div>;
}
