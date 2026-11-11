import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Banker, OutboxItem } from '../data';
import { deleteDraft, readDraft, writeDraft } from '../data';
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
  const [value, setValue] = useState(initial);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const initialValue = useRef(initial);
  const previousKey = useRef(key);
  if (previousKey.current !== key) { initialValue.current = initial; previousKey.current = key; }
  useEffect(() => {
    let active = true;
    setReady(false); setError('');
    void readDraft<T>(key).then(saved => { if (active) { setValue(saved ?? initialValue.current); setReady(true); } }).catch(problem => { if (active) { const message = problem instanceof Error ? problem.message : 'Could not restore the draft'; setError(message); storageFailure(problem); } });
    return () => { active = false; };
  }, [key]);
  function update(next: T) { setValue(next); void writeDraft(key, next).catch(problem => { setError(problem instanceof Error ? problem.message : 'Could not save draft'); storageFailure(problem); }); }
  async function clear() { try { await deleteDraft(key); } catch (problem) { storageFailure(problem); throw problem; } }
  return { value, update, ready, clear, error };
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
