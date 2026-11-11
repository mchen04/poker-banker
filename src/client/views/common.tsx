import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Banker, OutboxItem } from '../data';
import { ApiError, deleteDraft, prepareDraftSubmission, readDraft, releaseRejectedDraft, replaySubmittedDraft, writeDraft, type DraftRequest } from '../data';
import type { LedgerEntry, SessionState } from '../../domain/session';
import { currencyExponent, formatMoney } from '../../domain/money';
import { formatRational, formatSquareRoot, type Rational } from '../../domain/rational';

export type SheetState = { kind: string; player?: string; entry?: string } | null;
export type ClientState = {
  banker: Banker | null;
  state: SessionState | null;
  online: boolean;
  pending: OutboxItem[];
  open: (sheet: SheetState) => void;
  update: (state: SessionState) => void;
  notify: (text: string) => void;
  updateBanner?: ReactNode;
  formBusy: boolean;
  setFormBusy: (busy: boolean) => void;
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
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const initialValue = useRef(initial);
  const previousKey = useRef(key);
  const submitted = useRef<DraftRequest | undefined>(undefined);
  const inFlight = useRef(false);
  const active = useRef(true);
  if (previousKey.current !== key) { initialValue.current = initial; previousKey.current = key; submitted.current = undefined; }
  useEffect(() => {
    let current = true;
    active.current = true;
    setReady(false); setError('');
    void readDraft<Value>(key).then(saved => { if (current) { const next = saved ?? initialValue.current; submitted.current = (next as Value).__submitted; setValue(next); setReady(true); } }).catch(problem => { if (current) { const message = problem instanceof Error ? problem.message : 'Could not restore the draft'; setError(message); storageFailure(problem); } });
    return () => { current = false; active.current = false; };
  }, [key]);
  function update(next: T) { if (submitted.current) return; setValue(next); void writeDraft(key, next).catch(problem => { setError(problem instanceof Error ? problem.message : 'Could not save draft'); storageFailure(problem); }); }
  function freshValue() {
    submitted.current = undefined;
    const fresh = { ...initialValue.current, ...('op_id' in initialValue.current ? { op_id: crypto.randomUUID() } : {}) };
    if (active.current) setValue(fresh);
  }
  async function clear() { try { await deleteDraft(key); freshValue(); } catch (problem) { storageFailure(problem); throw problem; } }
  async function perform<R>(request: DraftRequest, first: boolean): Promise<R> {
    if (inFlight.current) throw new Error('Wait for this saved result to finish checking');
    inFlight.current = true;
    try {
      if (first) {
        const prepared = await prepareDraftSubmission(key, value, request);
        if (prepared.previouslyConfirmed) { submitted.current = undefined; if (active.current) setValue(prepared.value); throw new Error('The previous form was saved. Review this new draft and save again.'); }
        request = prepared.request; first = prepared.first;
        submitted.current = request;
        if (active.current) setValue(prepared.value);
      }
      let result: R;
      try { result = await replaySubmittedDraft<R>(key); }
      catch (problem) {
        const restored = await readDraft<Value>(key);
        if (restored && !restored.__submitted && active.current) {
          submitted.current = undefined;
          setValue(restored);
        } else if (first && problem instanceof ApiError && problem.status >= 400 && problem.status < 500 && ![401, 403, 429].includes(problem.status) && problem.code !== 'idempotency_mismatch' && active.current) {
          submitted.current = undefined;
          const fresh = { ...value, ...('op_id' in value ? { op_id: crypto.randomUUID() } : {}) };
          delete fresh.__submitted;
          await releaseRejectedDraft(key, request, fresh); setValue(fresh);
        }
        throw problem;
      }
      freshValue();
      if (result && typeof result === 'object' && 'session' in result) client?.update(result as unknown as SessionState);
      return result;
    } finally { inFlight.current = false; }
  }
  async function submit<R>(path: string, body: Record<string, unknown>, method = 'POST') {
    const request = submitted.current ?? { path, body: structuredClone(body), method };
    return perform<R>(request, !submitted.current);
  }
  async function reconcile<R>() {
    if (!submitted.current) throw new Error('There is no submitted form to check');
    return perform<R>(submitted.current, false);
  }
  return { value, update, ready, clear, error, submit, reconcile, submitted: !!value.__submitted };
}
export function DraftRecovery<T>({ recover, recovered, pending = false }: { recover: () => Promise<T>; recovered: (value: T) => void; pending?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useFormBusy(busy || pending);
  return <><p className="warning">This form may already have been saved. Check the saved result before editing it or starting another.</p><ErrorText text={error} /><button className="primary wide" disabled={busy || pending} onClick={() => { if (busy || pending) return; setBusy(true); setError(''); void recover().then(recovered).catch(problem => { setError(problem instanceof Error ? problem.message : 'Could not check the saved result'); setBusy(false); }); }}>{busy ? 'Checking saved result…' : 'Check saved result'}</button></>;
}
export function useFormBusy(busy: boolean) {
  const setBusy = useClient().setFormBusy;
  useLayoutEffect(() => { setBusy(busy); return () => setBusy(false); }, [busy, setBusy]);
}
export function storageFailure(problem: unknown) { window.dispatchEvent(new CustomEvent('pb-storage-error', { detail: problem instanceof Error ? problem.message : 'Local storage is unavailable' })); }
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
    {updateBanner}<div className="sheet-handle" /><header className={`sheet-header${leadingClose ? ' leading-close' : ''}`}>{leadingClose && closeButton}<h2>{title}</h2>{!leadingClose && closeButton}</header><fieldset className="sheet-fields" disabled={busy}>{children}</fieldset>
  </div></div>;
}
