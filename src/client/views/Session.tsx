import { submittedAt } from '../clock';
import { useDebouncedSearch } from '../search';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { EntryKind, LedgerEntry, PaymentMethod, PlayerState, SessionState } from '../../domain/session';
import { currencyExponent, parseMoney } from '../../domain/money';
import { draftKey, writeDraft } from '../data';
import { decimal, duration, entryLabels, DraftRecovery, ErrorText, methodLabel, money, resultCurrencyDecimal, resultMoney, resultNumber, Sheet, useClient, useDraft, useFormBusy } from './common';

type RosterPlayer = { id: string; display_name: string };
export type DisplayMode = 'total' | 'hourly' | 'blinds';
function resultText(player: PlayerState, currency: string, mode: DisplayMode) {
  if (player.state === 'playing') return 'Playing';
  if (player.state === 'seated') return 'Not bought in';
  if (mode === 'hourly') {
    if (!player.performance.per_hour) return 'No time recorded';
    const text = resultCurrencyDecimal(player.performance.per_hour, currency);
    return text === 'Even' ? text : `${text}/hour`;
  }
  if (mode === 'blinds') {
    if (!player.performance.big_blinds) return 'No big blind set';
    const text = resultNumber(player.performance.big_blinds);
    return text === 'Even' ? text : `${text} big blinds`;
  }
  const result = BigInt(player.result_minor);
  return result === 0n ? 'Even' : `${resultMoney(player.result_minor, currency)} ${result > 0n ? 'up' : 'down'}`;
}
function balanceText(player: PlayerState, currency: string) {
  const balance = BigInt(player.balance_minor);
  return balance === 0n ? 'No payment due' : balance > 0n ? `Collect ${money(player.balance_minor, currency)}` : `Pay ${money(String(-balance), currency)}`;
}
function Timer({ state, unknownStart }: { state: SessionState; unknownStart: boolean }) {
  const [clock, setClock] = useState(0);
  const loaded = useRef(performance.now());
  useEffect(() => { loaded.current = performance.now(); setClock(0); }, [state.server_now]);
  useEffect(() => { const timer = window.setInterval(() => setClock(Math.max(0, Math.floor(performance.now() - loaded.current))), 1000); return () => clearInterval(timer); }, []);
  const elapsed = state.timing.elapsed_ms === null ? null : String(BigInt(state.timing.elapsed_ms) + (state.session.ended_at === null ? BigInt(clock) : 0n));
  return <span data-testid="session-timer" className="timer">{elapsed === null ? unknownStart ? 'Start time unknown' : 'Timer not started' : `${state.session.ended_at ? 'Finished · ' : 'Playing time · '}${duration(elapsed, state.session.ended_at === null)}`}</span>;
}
export function SessionView({ state, viewer = false }: { state: SessionState; viewer?: boolean }) {
  const { open } = useClient();
  const [mode, setMode] = useState<DisplayMode>(() => (localStorage.getItem('pb-display') as DisplayMode) || 'total');
  const settings = state.session;
  const currency = settings.currency;
  const unknownStart = settings.started_at === null && state.players.some(player => player.buy_in_count > 0);
  const status = settings.status === 'open' ? 'Open session' : settings.closed_balanced ? 'Closed · chips balanced' : 'Closed · chip discrepancy';
  const effective = state.entries.filter(entry => !entry.voids_entry_id && !state.entries.some(row => row.voids_entry_id === entry.id));
  const readyToClose = state.players.some(player => player.state === 'cashed_out') && state.players.every(player => player.state !== 'playing' && !(player.state === 'seated' && (player.payment_in_minor !== '0' || player.payment_out_minor !== '0' || player.expense_minor !== '0')));
  function display(next: DisplayMode) { setMode(next); localStorage.setItem('pb-display', next); }
  return <>
    <header className="session-heading"><div><p className="eyebrow">{new Date(`${settings.played_on}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</p><h1>{settings.name}</h1><p className="session-meta">{[settings.location, settings.game, currency, settings.big_blind_minor ? `${money(settings.big_blind_minor, currency)} big blind` : null].filter(Boolean).join(' · ')}</p><p className="status-line">{status}</p></div>{!viewer && <button aria-label="Session menu" onClick={() => open({ kind: 'menu' })}>Menu</button>}</header>
    <div className="timer-row"><Timer state={state} unknownStart={unknownStart} />{!viewer && (unknownStart ? <button className="text-button" onClick={() => open({ kind: 'timing' })}>Correct times</button> : settings.started_at === null && settings.status === 'open' && <StartTimer />)}</div>
    <section className="totals" aria-label="Session totals" data-testid="totals"><div className="chips-total"><span>{state.totals.on_table_minor !== null ? 'Chips in play' : 'Chip difference'}</span><strong>{money(state.totals.on_table_minor ?? state.totals.discrepancy_minor ?? '0', currency)}</strong><small>{state.totals.on_table_minor !== null ? `${state.players.filter(player => player.state === 'playing').length} playing` : state.totals.discrepancy_minor === '0' ? 'All chips accounted for' : 'Chips returned minus chips bought'}</small></div><div className="payment-totals"><div><span>To collect</span><strong>{money(state.totals.owed_to_banker_minor, currency)}</strong></div><div><span>To pay</span><strong>{money(state.totals.owed_by_banker_minor, currency)}</strong></div></div><p className="chip-history">Chips bought <b>{money(state.totals.total_in_minor, currency)}</b><span aria-hidden="true"> · </span>Chips returned <b>{money(state.totals.total_out_minor, currency)}</b></p>{state.totals.on_table_minor === null && state.totals.discrepancy_minor !== '0' && <p className="hint discrepancy-note">This is a chip difference. Payments are tracked separately.</p>}</section>
    <div className="section-heading"><h2>Players <span className="muted">{state.players.length}</span></h2>{!viewer && <div className="segments display-modes" aria-label="Result display"><button aria-pressed={mode === 'total'} onClick={() => display('total')}>Total</button><button aria-pressed={mode === 'hourly'} onClick={() => display('hourly')}>Per hour</button><button aria-pressed={mode === 'blinds'} onClick={() => display('blinds')}>BB</button></div>}</div>
    <section className="players" aria-label="Session players">{state.players.length === 0 && <div className="empty"><h3>A seat for everyone</h3><p>Add your players, then record the first buy-in.</p></div>}{state.players.map(player => {
      const lastBuy = latestEntry(effective.filter(entry => entry.player_id === player.id && entry.kind === 'buy_in'));
      const content = <><span className="player-main"><strong>{player.display_name}</strong><span className="player-state">{player.state === 'seated' ? 'Not bought in' : player.state === 'playing' ? 'Playing' : 'Cashed out'}</span></span><span className="player-balance">{balanceText(player, currency)}</span><span className="player-detail"><span>Bought {money(player.bought_in_minor, currency)}{player.buy_in_count > 1 ? ` · ${player.buy_in_count - 1} rebuy${player.buy_in_count > 2 ? 's' : ''}` : ''} · Returned {money(player.cashed_out_minor, currency)}</span><span data-testid={`result-${player.id}`}>{resultText(player, currency, mode)}</span></span></>;
      return viewer ? <div key={player.id} data-testid={`player-${player.id}`} className="player-card player-row">{content}</div> : <div className="player-card" key={player.id}><button data-testid={`player-${player.id}`} className="player-row" onClick={() => open({ kind: 'player', player: player.id })}>{content}</button>{settings.status === 'open' && <div className="player-shortcuts"><button data-testid={`buy-in-${player.id}`} aria-label={`Buy-in for ${player.display_name}`} onClick={() => open({ kind: 'money', player: player.id })}>Buy-in</button>{lastBuy && <button data-testid={`repeat-buy-in-${player.id}`} aria-label={`Repeat last buy-in for ${player.display_name}`} onClick={() => open({ kind: 'money', player: player.id, amount: lastBuy.amount_minor })}>Repeat last <span>{money(lastBuy.amount_minor, currency)}</span></button>}</div>}</div>;
    })}</section>
    <Activity state={state} />
    {!viewer && settings.status === 'open' && <div className="bottom-bar" data-testid="session-bottom-bar" aria-label="Session actions"><button className={!state.players.length ? 'primary' : undefined} onClick={() => open({ kind: 'add' })}>Add player</button><button className={!readyToClose && state.players.length ? 'primary' : undefined} disabled={!state.players.length} onClick={() => open({ kind: 'money', player: state.players.find(player => player.state !== 'cashed_out')?.id ?? state.players[0]!.id })}>Buy-in</button>{readyToClose && <button data-testid="session-close" className="primary" onClick={() => open({ kind: 'close' })}>Close game</button>}</div>}
  </>;
}
function StartTimer() {
  const { state, mutate, notify } = useClient();
  return <button className="text-button" onClick={() => { void mutate(`/api/sessions/${state!.session.id}/start`, { op_id: crypto.randomUUID() }).catch(error => notify(error.message)); }}>Start timer</button>;
}
export function Activity({ state, onlyPlayer }: { state: SessionState; onlyPlayer?: string }) {
  const { banker, open } = useClient();
  const voided = new Set(state.entries.flatMap(entry => entry.voids_entry_id ? [entry.voids_entry_id] : []));
  const rows = state.entries.filter(entry => !onlyPlayer || entry.player_id === onlyPlayer);
  return <section className="activity" data-testid="activity"><h2>{onlyPlayer ? 'Player entries' : 'Activity'}</h2>{!rows.length && <p className="muted">No entries yet.</p>}<ul>{rows.map(entry => {
    const cancelled = voided.has(entry.id);
    const player = state.players.find(player => player.id === entry.player_id);
    return <li key={entry.id} data-testid={`entry-${entry.id}`}><div><span className={cancelled ? 'voided' : ''}>{entry.voids_entry_id ? 'Void · ' : ''}{entryLabels[entry.kind]} · {player?.display_name} · <strong>{money(entry.amount_minor, state.session.currency)}</strong>{entry.method && ` · ${methodLabel(entry.method)}`}</span>{cancelled && <span className="entry-status">Voided</span>}<small>{entry.occurred_at === null ? 'Time unavailable' : new Date(entry.occurred_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}{entry.note ? ` · ${entry.note}` : ''}</small></div>{banker && state.session.status === 'open' && !cancelled && !entry.voids_entry_id && <button className="small-button" aria-label={`Correct ${entryLabels[entry.kind]} ${money(entry.amount_minor, state.session.currency)}`} onClick={() => open({ kind: 'correction', entry: entry.id, player: entry.player_id })}>Correct</button>}</li>;
  })}</ul></section>;
}
export function PlayerSheet({ playerId }: { playerId: string }) {
  const { state, open } = useClient();
  const player = state!.players.find(player => player.id === playerId)!;
  return <><p className="player-summary">{balanceText(player, state!.session.currency)} · {duration(player.duration_ms)}</p>{state!.session.status === 'open' && <div className="action-grid"><button className="primary" onClick={() => open({ kind: 'money', player: playerId })}>Buy-in</button><button onClick={() => open({ kind: 'cash_out', player: playerId })}>Cash out</button><button onClick={() => open({ kind: 'payment_in', player: playerId, amount: player.balance_minor === '0' ? undefined : String(BigInt(player.balance_minor) < 0n ? -BigInt(player.balance_minor) : BigInt(player.balance_minor)) })}>Record payment</button><button onClick={() => open({ kind: 'expense', player: playerId })}>Tips and meals</button></div>}<Activity state={state!} onlyPlayer={playerId} /></>;
}
function latestEntry(entries: LedgerEntry[]) {
  return entries.reduce<LedgerEntry | undefined>((latest, entry) => !latest || BigInt(entry.revision) > BigInt(latest.revision) ? entry : latest, undefined);
}
function PaymentMethods({ label = 'Payment method', value, change }: { label?: string; value: PaymentMethod; change: (value: PaymentMethod) => void }) {
  return <fieldset className="payment-methods"><legend>{label}</legend><div>{(['cash', 'venmo', 'zelle'] as const).map(method => <button key={method} type="button" aria-pressed={value === method} onClick={() => change(method)}>{methodLabel(method)}</button>)}</div></fieldset>;
}
type MoneyDraft = { op_id: string; amount: string; paid_now: boolean; method: PaymentMethod; occurred_at: string; note: string; kind: EntryKind; __recovered_occurred_at?: string | null };
export function MoneySheet({ title, playerId, kind: initialKind, initialAmount }: { title: string; playerId: string; kind: EntryKind; initialAmount?: string }) {
  const { banker, state, notify, open } = useClient();
  const currency = state!.session.currency;
  const effective = state!.entries.filter(entry => !entry.voids_entry_id && !state!.entries.some(row => row.voids_entry_id === entry.id));
  const lastMethod = latestEntry(effective.filter(entry => entry.method))?.method ?? 'cash';
  const key = draftKey(banker!.id, state!.session.id, initialKind, playerId);
  const balance = BigInt(state!.players.find(player => player.id === playerId)!.balance_minor);
  const suggestedKind = initialKind === 'payment_in' && balance < 0n ? 'payment_out' : initialKind;
  const draft = useDraft<MoneyDraft>(key, { op_id: crypto.randomUUID(), amount: initialAmount !== undefined ? decimal(initialAmount, currency) : '', paid_now: initialKind === 'buy_in', method: lastMethod, occurred_at: '', note: '', kind: suggestedKind });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const amountInput = useRef<HTMLInputElement>(null);
  const cancelPanel = useRef<HTMLElement>(null);
  useEffect(() => { if (canceling) cancelPanel.current?.focus(); else amountInput.current?.focus(); }, [canceling]);
  useFormBusy(saving);
  const submitting = useRef(false);
  const payment = draft.value.kind === 'payment_in' || draft.value.kind === 'payment_out';
  const chip = draft.value.kind === 'buy_in' || draft.value.kind === 'cash_out';
  const lastBuy = latestEntry(effective.filter(entry => entry.kind === 'buy_in' && entry.player_id === playerId))?.amount_minor;
  const defaultAmount = String(20n * 10n ** BigInt(currencyExponent(currency)));
  let amountFeedback = '';
  if (draft.value.amount.trim()) {
    try {
      const amount = parseMoney(draft.value.amount, currency);
      amountFeedback = `Will record ${money(String(amount), currency)}`;
    } catch {}
  }
  function quick(value: string) { draft.update({ ...draft.value, amount: decimal(value, currency) }); }
  function cancel() {
    if (saving) return;
    if (draft.value.amount.trim() || draft.value.note.trim() || draft.value.occurred_at) setCanceling(true);
    else open(null);
  }
  async function keep() {
    if (saving || submitting.current || !draft.ready) return;
    submitting.current = true; setSaving(true); setError('');
    try { await draft.withSnapshot((value, cursor) => writeDraft(key, value, cursor)); open(null); }
    catch (problem) { setError(problem instanceof Error ? problem.message : 'Could not keep the draft'); submitting.current = false; setSaving(false); }
  }
  async function discard() {
    if (saving) return;
    setSaving(true); setError('');
    try { await draft.clear(); open(null); }
    catch (problem) { setError(problem instanceof Error ? problem.message : 'Could not discard the draft'); setSaving(false); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (submitting.current || !draft.ready) return;
    submitting.current = true; setSaving(true); setError('');
    try {
      const amount = parseMoney(draft.value.amount, currency);
      if (amount === 0n && draft.value.kind !== 'cash_out') throw new Error('Enter an amount above zero');
      const body: Record<string, unknown> = { op_id: draft.value.op_id, player_id: playerId, kind: draft.value.kind, amount_minor: String(amount) };
      if (chip) body.paid_now = draft.value.paid_now;
      if (payment || (chip && draft.value.paid_now && amount > 0n)) body.method = draft.value.method;
      if (draft.value.note) body.note = draft.value.note;
      body.occurred_at = draft.value.occurred_at ? new Date(draft.value.occurred_at).toISOString() : draft.value.__recovered_occurred_at !== undefined ? draft.value.__recovered_occurred_at : submittedAt(chip ? { started_at: state!.session.started_at, ended_at: state!.session.ended_at, server_now: state!.server_now } : undefined);
      await draft.queue({ banker_id: banker!.id, session_id: state!.session.id, path: `/api/sessions/${state!.session.id}/entries`, body, label: `${entryLabels[draft.value.kind]} · ${money(String(amount), currency)}`, draft_key: key });
      notify('Not saved yet'); open(null);
    } catch (problem) { setError(problem instanceof Error ? problem.message : 'Could not save entry'); submitting.current = false; setSaving(false); }
  }
  return <Sheet title={title} leadingClose closeLabel="Cancel" className="money-sheet" close={cancel}>{canceling ? <section className="cancel-draft" role="alertdialog" aria-label="Keep or discard this draft" tabIndex={-1} ref={cancelPanel}><h3>Discard this typed amount?</h3><p>Your typed amount has not been saved to the ledger.</p><button type="button" className="wide" disabled={saving || !draft.ready} onClick={() => { void keep(); }}>Keep draft and close</button><button type="button" className="danger wide" onClick={() => { void discard(); }}>Discard draft</button><button type="button" className="primary wide" onClick={() => setCanceling(false)}>Keep editing</button><ErrorText text={draft.error || error} /></section> : <form className="money-form" onSubmit={submit}><div className="money-fields"><label>Player<select aria-label="Player" value={playerId} onChange={event => open({ kind: initialKind === 'buy_in' ? 'money' : initialKind, player: event.target.value })}>{state!.players.map(player => <option key={player.id} value={player.id}>{player.display_name}</option>)}</select></label>{payment && <label>Payment direction<select aria-label="Payment direction" value={draft.value.kind} onChange={event => draft.update({ ...draft.value, kind: event.target.value as EntryKind })}><option value="payment_in">Player pays bank</option><option value="payment_out">Bank pays player</option></select></label>}<label className="amount-field"><span>Amount <span className="field-currency">({currency})</span></span><input aria-label="Amount" ref={amountInput} data-testid="money-amount" inputMode="decimal" autoComplete="off" placeholder="0" value={draft.value.amount} onChange={event => { draft.update({ ...draft.value, amount: event.target.value }); setError(''); }} disabled={!draft.ready} required /></label>{amountFeedback && <p className="hint amount-preview" role="status">{amountFeedback}</p>}<div className="quick-amounts">{initialKind === 'buy_in' && lastBuy && <button type="button" disabled={!draft.ready} onClick={() => quick(lastBuy)}>Last buy-in {money(lastBuy, currency)}</button>}{initialKind === 'buy_in' && <><button type="button" disabled={!draft.ready} onClick={() => quick(defaultAmount)}>Session default {money(defaultAmount, currency)}</button><button type="button" disabled={!draft.ready} onClick={() => { try { quick(String(parseMoney(draft.value.amount || decimal(defaultAmount, currency), currency) * 2n)); } catch { setError('Enter an exact amount first'); } }}>Double</button></>}{initialKind === 'cash_out' && <button type="button" disabled={!draft.ready} onClick={() => quick('0')}>No chips left · {money('0', currency)}</button>}</div><p className="hint amount-guidance">{initialKind === 'cash_out' ? 'Enter the actual value of chips returned, including zero.' : 'Review the amount before saving.'}</p>
    {chip && <label className="check"><input type="checkbox" checked={draft.value.paid_now} onChange={event => draft.update({ ...draft.value, paid_now: event.target.checked })} />{draft.value.kind === 'buy_in' ? 'Paid now' : 'Paid out now'}</label>}
    {(payment || (chip && draft.value.paid_now)) && <PaymentMethods value={draft.value.method} change={method => draft.update({ ...draft.value, method })} />}
    {initialKind === 'expense' && <label>Expense detail<input placeholder="Tip or meal" value={draft.value.note} onChange={event => draft.update({ ...draft.value, note: event.target.value })} /></label>}
    <details><summary>Record an earlier time or note</summary><label>Entry time<input type="datetime-local" step="1" value={draft.value.occurred_at} onChange={event => draft.update({ ...draft.value, occurred_at: event.target.value })} /></label>{draft.value.__recovered_occurred_at !== undefined && <p className="hint">{draft.value.__recovered_occurred_at === null ? 'The original entry time is unknown. It stays unknown unless you enter a time.' : 'The original entry time is kept unless you enter another time.'}</p>}{initialKind !== 'expense' && <label>Note<input value={draft.value.note} onChange={event => draft.update({ ...draft.value, note: event.target.value })} /></label>}</details><ErrorText text={draft.error || error} /><p className="hint">Only confirmed entries change the totals.</p></div><footer className="money-actions"><button className="primary wide" disabled={saving || !draft.ready}>{saving ? 'Saving…' : 'Save entry'}</button></footer></form>}</Sheet>;
}
export function AddPlayerSheet() {
  const { banker, state, open, client } = useClient();
  const api = client!.api;
  const savedSearch = useDraft(draftKey(banker!.id, state!.session.id, 'add-player'), { op_id: crypto.randomUUID(), search: '' });
  const search = savedSearch.value.search;
  const settledSearch = useDebouncedSearch(search);
  const [loadedSearch, setLoadedSearch] = useState<string | null>(null);
  const searching = loadedSearch !== search;
  const setSearch = (search: string) => savedSearch.update({ ...savedSearch.value, search });
  const [players, setPlayers] = useState<RosterPlayer[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useFormBusy(busy);
  useEffect(() => { let active = true; void api<{ players: RosterPlayer[] }>(`/api/players?q=${encodeURIComponent(settledSearch)}`).then(result => { if (active) { setPlayers(result.players); setLoadedSearch(settledSearch); } }).catch(error => { if (active) setError(error.message); }); return () => { active = false; }; }, [settledSearch]);
  async function add(body: Record<string, unknown>) {
    if (busy) return; setBusy(true); setError('');
    try { await savedSearch.submit(`/api/sessions/${state!.session.id}/players`, { op_id: savedSearch.value.op_id, ...body }, 'POST'); open(null); }
    catch (problem) { setError(problem instanceof Error ? problem.message : 'Could not add player'); setBusy(false); }
  }
  const exact = !searching && players.some(player => player.display_name.trim().toLowerCase() === search.trim().toLowerCase());
  const [confirmed, setConfirmed] = useState(false);
  if (!savedSearch.ready) return savedSearch.error ? <ErrorText text={savedSearch.error} /> : <p>Restoring draft…</p>;
  if (savedSearch.submitted) return <DraftRecovery pending={busy} notice={savedSearch.error} recover={() => savedSearch.reconcile()} recovered={() => open(null)} />;
  return <><label>Search players<input value={search} onChange={event => { setSearch(event.target.value); setConfirmed(false); }} placeholder="Name" /></label><p className="hint">Choose an existing player to keep their history together.</p>{searching && <p role="status">Searching players…</p>}<ul className="choice-list">{players.map(player => <li key={player.id}><button disabled={busy || searching || state!.players.some(seated => seated.id === player.id)} onClick={() => { void add({ player_id: player.id }); }}>{player.display_name}{state!.players.some(seated => seated.id === player.id) ? ' · Already in session' : ''}</button></li>)}</ul>{search.trim() && <>{exact && <><p className="warning">An exact name match already exists. Add the existing player unless this is a different person.</p><label className="check"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />This is a different person</label></>}<button className="primary wide" disabled={busy || searching || (exact && !confirmed)} onClick={() => { void add({ new_player_name: search.trim() }); }}>Add '{search.trim()}' as new</button></>}<ErrorText text={savedSearch.error || error} /></>;
}
export function CorrectionSheet({ entryId }: { entryId: string }) {
  const { banker, state, open } = useClient();
  const entry = state!.entries.find(row => row.id === entryId)!;
  const player = state!.players.find(row => row.id === entry.player_id);
  const [confirmingVoid, setConfirmingVoid] = useState(false);
  const voidPanel = useRef<HTMLElement>(null);
  useEffect(() => { if (confirmingVoid) voidPanel.current?.focus(); }, [confirmingVoid]);
  const draft = useDraft(draftKey(banker!.id, state!.session.id, 'correction', entryId), { op_id: crypto.randomUUID(), amount: decimal(entry.amount_minor, state!.session.currency), method: entry.method ?? 'cash', time: '' });
  const { amount, method, time } = draft.value;
  const setAmount = (amount: string) => draft.update({ ...draft.value, amount });
  const setMethod = (method: PaymentMethod) => draft.update({ ...draft.value, method });
  const setTime = (time: string) => draft.update({ ...draft.value, time });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useFormBusy(busy);
  const payment = entry.kind === 'payment_in' || entry.kind === 'payment_out';
  async function save(replacement: boolean) {
    if (busy) return; setBusy(true); setError('');
    try {
      const body: Record<string, unknown> = { op_id: draft.value.op_id };
      if (replacement) {
        const parsed = parseMoney(amount, state!.session.currency);
        if (parsed === 0n && entry.kind !== 'cash_out') throw new Error('Enter an amount above zero');
        body.replacement_amount_minor = String(parsed);
        if (payment) body.replacement_method = method;
        if (time) body.replacement_occurred_at = new Date(time).toISOString();
      }
      await draft.submit(`/api/sessions/${state!.session.id}/entries/${entryId}/void`, body, 'POST'); open(null);
    } catch (problem) { setError(problem instanceof Error ? problem.message : 'Could not correct entry'); setBusy(false); }
  }
  if (!draft.ready) return draft.error ? <ErrorText text={draft.error} /> : <p>Restoring draft…</p>;
  if (draft.submitted) return <DraftRecovery pending={busy} notice={draft.error} recover={() => draft.reconcile()} recovered={() => open(null)} />;
  return <form className="sheet-form" onSubmit={event => { event.preventDefault(); if (!confirmingVoid) void save(true); }}><div className="form-body"><p className="correction-summary">{entryLabels[entry.kind]} · {player?.display_name ?? 'Player'} · <strong>{money(entry.amount_minor, state!.session.currency)}</strong>{entry.method ? ` · ${methodLabel(entry.method)}` : ''}</p>{confirmingVoid ? <section className="confirmation-panel" role="alertdialog" aria-label="Void ledger entry" tabIndex={-1} ref={voidPanel}><h3>Void this entry?</h3><p>The original stays in the ledger, marked Voided. Its amount stops counting toward totals. No replacement is added.</p></section> : <><p>The original stays in the ledger, marked Voided, with a replacement alongside it.</p><label>Replacement amount<input inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} required /></label>{payment && <PaymentMethods label="Replacement method" value={method} change={setMethod} />}<label>Entry time<input type="datetime-local" step="1" value={time} onChange={event => setTime(event.target.value)} /></label></>}<ErrorText text={draft.error || error} /></div><footer className="form-actions">{confirmingVoid ? <><button key="keep-entry" className="wide" type="button" disabled={busy} onClick={event => { event.preventDefault(); setConfirmingVoid(false); }}>Keep entry</button><button key="confirm-void" className="danger wide" type="button" disabled={busy} onClick={event => { event.preventDefault(); void save(false); }}>Confirm void</button></> : <><button key="save-correction" type="submit" className="primary wide" disabled={busy}>Save correction</button><button key="request-void" className="danger wide" type="button" disabled={busy} onClick={event => { event.preventDefault(); setConfirmingVoid(true); }}>Void entry</button></>}</footer></form>;
}
