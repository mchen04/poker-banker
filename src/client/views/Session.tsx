import { submittedAt } from '../clock';
import { useDebouncedSearch } from '../search';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { EntryKind, PaymentMethod, PlayerState, SessionState } from '../../domain/session';
import { MAX_MINOR, parseMoney } from '../../domain/money';
import { moneyOptions } from '../money-options';
import { retainedTimerStart } from '../undo-timing';
import { draftKey, writeDraft } from '../data';
import { decimal, duration, entryLabels, DraftRecovery, ErrorText, methodLabel, money, resultCurrencyDecimal, resultMoney, resultNumber, Sheet, useClient, useDraft, useFormBusy } from './common';

type RosterPlayer = { id: string; display_name: string };
export type DisplayMode = 'total' | 'hourly' | 'blinds';
function resultText(player: Extract<PlayerState, { state: 'cashed_out' }>, currency: string, mode: DisplayMode) {
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
  return balance === 0n ? 'Paid up' : balance > 0n ? `Owes ${money(player.balance_minor, currency)}` : `Owed ${money(String(-balance), currency)}`;
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
  const status = settings.status === 'open' ? 'In progress' : settings.closed_balanced ? 'Closed · chips balanced' : 'Closed · chip discrepancy';
  const metadata = [new Date(`${settings.played_on}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), settings.location, settings.game, currency, settings.big_blind_minor ? `${money(settings.big_blind_minor, currency)} big blind` : null].filter(Boolean).join(' · ');
  const hasResults = state.players.some(player => player.state === 'cashed_out');
  const readyToClose = !viewer && settings.status === 'open' && hasResults && !state.players.some(player => player.state === 'playing');
  const unsettled = state.players.filter(player => BigInt(player.balance_minor) !== 0n).length;
  const retainedTimer = !viewer ? retainedTimerStart(state) : null;
  function display(next: DisplayMode) { setMode(next); localStorage.setItem('pb-display', next); }
  return <div className="session-board">
    <div className="session-overview">
      <header className="session-heading"><div><h1 aria-label={settings.name} title={settings.name}>{viewer ? settings.name : <button className="session-title" data-testid={`session-tab-${settings.id}`} aria-label="Switch session" aria-haspopup="dialog" onClick={() => open({ kind: 'history' })}><span>{settings.name}</span><span aria-hidden="true">⌄</span></button>}</h1><p className="session-meta" title={metadata}>{metadata}</p></div>{!viewer && <div className="session-heading-actions"><button className={settings.status === 'closed' ? 'closed-session-new' : undefined} aria-label="New session" onClick={() => open({ kind: 'new' })}>+ New</button><button aria-label="Session menu" onClick={() => open({ kind: 'menu' })}>Menu</button></div>}</header>
      <div className="timer-row"><span className="status-line">{status}</span><Timer state={state} unknownStart={unknownStart} />{!viewer && (unknownStart ? <button className="text-button" onClick={() => open({ kind: 'timing' })}>Correct times</button> : settings.started_at === null && settings.status === 'open' && <StartTimer />)}{retainedTimer && <p className="retained-timer-notice" data-testid="retained-timer-notice">Timer started {new Date(retainedTimer).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · <button className="text-button" onClick={() => open({ kind: 'timing' })}>Correct times</button></p>}</div>
      <section className="totals" aria-label="Session totals" data-testid="totals"><div className="chips-total"><span>{state.totals.on_table_minor !== null ? 'Chips in play' : 'Chip difference'}</span><strong className="money-value">{money(state.totals.on_table_minor ?? state.totals.discrepancy_minor ?? '0', currency)}</strong></div><div className="payment-totals"><div><span>To collect</span><strong className="money-value">{money(state.totals.owed_to_banker_minor, currency)}</strong></div><div><span>To pay</span><strong className="money-value">{money(state.totals.owed_by_banker_minor, currency)}</strong></div></div><p className="chip-history">Chips bought <b className="money-value">{money(state.totals.total_in_minor, currency)}</b><span aria-hidden="true"> · </span>Returned <b className="money-value">{money(state.totals.total_out_minor, currency)}</b></p>{state.totals.on_table_minor === null && state.totals.discrepancy_minor !== '0' && <p className="hint discrepancy-note">Returned chips differ from bought chips. Payments are separate.</p>}</section>
    </div>
    <div className="session-table">{readyToClose && <button className="ready-to-close" data-testid="ready-to-close" onClick={() => open({ kind: 'close' })}>Everyone has cashed out · Close session{unsettled > 0 ? ` · ${unsettled} unsettled` : ''}</button>}<div className="section-heading"><h2>Players <span className="muted">{state.players.length}</span></h2>{!viewer && settings.status === 'open' && state.players.length > 0 && <button className="text-button" onClick={() => open({ kind: 'add' })}>Add player</button>}{!viewer && hasResults && <div className="segments display-modes" aria-label="Result display"><button aria-pressed={mode === 'total'} onClick={() => display('total')}>Total</button><button aria-pressed={mode === 'hourly'} onClick={() => display('hourly')}>Per hour</button><button aria-pressed={mode === 'blinds'} onClick={() => display('blinds')}>BB</button></div>}</div>
      <section className="players" aria-label="Session players">{state.players.length === 0 && <div className="empty"><h3>A seat for everyone</h3><p>Add your players, then record the first buy-in.</p>{!viewer && settings.status === 'open' && <button onClick={() => open({ kind: 'add' })}>Add player</button>}</div>}{state.players.map(player => {
        const { lastBuy } = moneyOptions(state.entries, player.id);
        const balance = BigInt(player.balance_minor);
        const stateLabel = <span className="player-state" data-testid={player.state !== 'cashed_out' ? `result-${player.id}` : undefined}>{player.state === 'seated' ? 'Not bought in' : player.state === 'playing' ? 'Playing' : 'Cashed out'}</span>;
        const stateInActions = !viewer && settings.status === 'open';
        const content = <><span className="player-main"><strong title={player.display_name}>{player.display_name}</strong>{!stateInActions && stateLabel}</span>{(player.state !== 'seated' || balance !== 0n) && <span className="player-detail"><span className="player-position money-value">{player.state === 'cashed_out' ? <span data-testid={`result-${player.id}`}>{resultText(player, currency, mode)}</span> : player.state === 'playing' ? `Bought ${money(player.bought_in_minor, currency)}` : ''}</span><span className={balance === 0n ? 'muted' : 'player-balance money-value'}>{balanceText(player, currency)}</span></span>}</>;

        const controls = settings.status === 'open' && <div className="player-shortcuts">{stateLabel}<div className="player-row-actions">{player.state === 'seated' ? <button data-testid={`buy-in-${player.id}`} aria-label={`Buy-in for ${player.display_name}`} onClick={() => open({ kind: 'money', player: player.id })}>Buy-in</button> : player.state === 'playing' ? <><button data-testid={`cash-out-${player.id}`} aria-label={`Cash out ${player.display_name}`} onClick={() => open({ kind: 'cash_out', player: player.id })}>Cash out</button>{lastBuy && <button data-testid={`repeat-buy-in-${player.id}`} aria-label={`Repeat last buy-in for ${player.display_name}`} onClick={() => open({ kind: 'money', player: player.id, amount: lastBuy })}>Rebuy <span className="money-value">{money(lastBuy, currency)}</span></button>}</> : balance !== 0n ? <button data-testid={`settle-${player.id}`} aria-label={`Settle ${player.display_name}`} onClick={() => open({ kind: balance < 0n ? 'payment_out' : 'payment_in', player: player.id, amount: String(balance < 0n ? -balance : balance) })}>Settle <span className="money-value">{money(String(balance < 0n ? -balance : balance), currency)}</span></button> : null}</div></div>;
        return viewer ? <div className="player-card" key={player.id}><div data-testid={`player-${player.id}`} className="player-row">{content}</div></div> : <div className="player-card" key={player.id}><button data-testid={`player-${player.id}`} className="player-row" onClick={() => open({ kind: 'player', player: player.id })}>{content}</button>{controls}</div>;
      })}</section>
    </div>
    <Activity state={state} />
  </div>;
}
function StartTimer() {
  const { state, mutate, notify } = useClient();
  return <button className="text-button" onClick={() => { void mutate(`/api/sessions/${state!.session.id}/start`, { op_id: crypto.randomUUID() }).catch(error => notify(error.message)); }}>Start timer</button>;
}
export function Activity({ state, onlyPlayer }: { state: SessionState; onlyPlayer?: string }) {
  const { banker, open } = useClient();
  const voided = new Set(state.entries.flatMap(entry => entry.voids_entry_id ? [entry.voids_entry_id] : []));
  const rows = state.entries.filter(entry => !onlyPlayer || entry.player_id === onlyPlayer);
  const timeFormat = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' });
  return <section className="activity" data-testid="activity"><h2>{onlyPlayer ? 'Player entries' : 'Activity'}</h2>{!rows.length && <p className="muted">No entries yet.</p>}<ul>{rows.map(entry => {
    const cancelled = voided.has(entry.id);
    const player = state.players.find(player => player.id === entry.player_id);
    return <li key={entry.id} data-testid={`entry-${entry.id}`}><div><span className={cancelled ? 'voided' : ''}>{entry.voids_entry_id ? 'Void · ' : ''}{entryLabels[entry.kind]} · {player?.display_name} · <strong className="money-value">{money(entry.amount_minor, state.session.currency)}</strong>{entry.method && ` · ${methodLabel(entry.method)}`}</span>{cancelled && <span className="entry-status">Voided</span>}<small>{entry.occurred_at === null ? 'Time unavailable' : timeFormat.format(new Date(entry.occurred_at))}{entry.note ? ` · ${entry.note}` : ''}</small></div>{banker && state.session.status === 'open' && !cancelled && !entry.voids_entry_id && <button className="small-button" aria-label={`Correct ${entryLabels[entry.kind]} ${money(entry.amount_minor, state.session.currency)}`} onClick={() => open({ kind: 'correction', entry: entry.id, player: entry.player_id })}>Correct</button>}</li>;
  })}</ul></section>;
}
export function PlayerSheet({ playerId }: { playerId: string }) {
  const { state, open } = useClient();
  const player = state!.players.find(player => player.id === playerId)!;
  return <><p className="player-summary"><span className={player.balance_minor === '0' ? 'muted' : 'player-balance money-value'}>{balanceText(player, state!.session.currency)}</span> · {duration(player.duration_ms)}</p><p className="hint">Bought <span className="money-value">{money(player.bought_in_minor, state!.session.currency)}</span> · Returned <span className="money-value">{money(player.cashed_out_minor, state!.session.currency)}</span></p>{state!.session.status === 'open' && <div className="action-grid"><button className="primary" onClick={() => open({ kind: 'money', player: playerId })}>Buy-in</button><button onClick={() => open({ kind: 'cash_out', player: playerId })}>Cash out</button><button onClick={() => open({ kind: 'payment_in', player: playerId, amount: player.balance_minor === '0' ? undefined : String(BigInt(player.balance_minor) < 0n ? -BigInt(player.balance_minor) : BigInt(player.balance_minor)) })}>Record payment</button><button onClick={() => open({ kind: 'expense', player: playerId })}>Tips and meals</button></div>}<Activity state={state!} onlyPlayer={playerId} /></>;
}
function PaymentMethods({ label = 'Payment method', value, change }: { label?: string; value: PaymentMethod; change: (value: PaymentMethod) => void }) {
  return <fieldset className="payment-methods"><legend>{label}</legend><div>{(['cash', 'venmo', 'zelle'] as const).map(method => <button key={method} type="button" aria-pressed={value === method} onClick={() => change(method)}>{methodLabel(method)}</button>)}</div></fieldset>;
}
type MoneyDraft = { op_id: string; amount: string; paid_now: boolean; method: PaymentMethod; occurred_at: string; note: string; kind: EntryKind; __recovered_occurred_at?: string | null };
export function MoneySheet({ title, playerId, kind: initialKind, initialAmount }: { title: string; playerId: string; kind: EntryKind; initialAmount?: string }) {
  const { banker, state, notify, open } = useClient();
  const currency = state!.session.currency;
  const player = state!.players.find(player => player.id === playerId)!;
  const { lastBuy, typicalBuy, method: lastMethod } = moneyOptions(state!.entries, playerId);
  const key = draftKey(banker!.id, state!.session.id, initialKind, playerId);
  const balance = BigInt(state!.players.find(player => player.id === playerId)!.balance_minor);
  const suggestedKind = initialKind === 'payment_in' && balance < 0n ? 'payment_out' : initialKind;
  const draft = useDraft<MoneyDraft>(key, { op_id: crypto.randomUUID(), amount: initialAmount !== undefined ? decimal(initialAmount, currency) : '', paid_now: initialKind === 'buy_in', method: lastMethod, occurred_at: '', note: '', kind: suggestedKind });
  const [error, setError] = useState('');
  const [amountError, setAmountError] = useState('');
  const [saving, setSaving] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const amountInput = useRef<HTMLInputElement>(null);
  const cancelPanel = useRef<HTMLElement>(null);
  useEffect(() => { if (canceling) cancelPanel.current?.focus(); else amountInput.current?.focus(); }, [canceling]);
  useFormBusy(saving);
  const submitting = useRef(false);
  const payment = draft.value.kind === 'payment_in' || draft.value.kind === 'payment_out';
  const chip = draft.value.kind === 'buy_in' || draft.value.kind === 'cash_out';
  let doubleAmount: string | undefined;
  try {
    const base = parseMoney(draft.value.amount || decimal(lastBuy ?? typicalBuy ?? '0', currency), currency);
    if (base > 0n && base * 2n <= MAX_MINOR) doubleAmount = String(base * 2n);
  } catch {}
  let amountFeedback = '';
  if (draft.value.amount.trim()) {
    try {
      const amount = parseMoney(draft.value.amount, currency);
      amountFeedback = `Will record ${money(String(amount), currency)}`;
    } catch {}
  }
  function quick(value: string) { draft.update({ ...draft.value, amount: decimal(value, currency) }); setAmountError(''); }
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
    let amount: bigint;
    try {
      amount = parseMoney(draft.value.amount, currency);
      if (amount === 0n && draft.value.kind !== 'cash_out') throw new Error('Enter an amount above zero');
    } catch (problem) { setAmountError(problem instanceof Error ? problem.message : 'Enter an exact amount'); amountInput.current?.focus(); return; }
    submitting.current = true; setSaving(true); setError(''); setAmountError('');
    try {
      const body: Record<string, unknown> = { op_id: draft.value.op_id, player_id: playerId, kind: draft.value.kind, amount_minor: String(amount) };
      if (chip) body.paid_now = draft.value.paid_now;
      if (payment || (chip && draft.value.paid_now && amount > 0n)) body.method = draft.value.method;
      if (draft.value.note) body.note = draft.value.note;
      body.occurred_at = draft.value.occurred_at ? new Date(draft.value.occurred_at).toISOString() : draft.value.__recovered_occurred_at !== undefined ? draft.value.__recovered_occurred_at : submittedAt(chip ? { started_at: state!.session.started_at, ended_at: state!.session.ended_at, server_now: state!.server_now } : undefined);
      await draft.queue({ banker_id: banker!.id, session_id: state!.session.id, path: `/api/sessions/${state!.session.id}/entries`, body, label: `${entryLabels[draft.value.kind]} · ${money(String(amount), currency)}`, draft_key: key });
      notify('Not saved yet'); open(null);
    } catch (problem) { setError(problem instanceof Error ? problem.message : 'Could not save entry'); submitting.current = false; setSaving(false); }
  }
  return <Sheet title={title} leadingClose closeLabel="Cancel" className="money-sheet" close={cancel}>{canceling ? <section className="cancel-draft" role="alertdialog" aria-label="Keep or discard this draft" tabIndex={-1} ref={cancelPanel}><h3>Discard this typed amount?</h3><p>Your typed amount has not been saved to the ledger.</p><button type="button" className="wide" disabled={saving || !draft.ready} onClick={() => { void keep(); }}>Keep draft and close</button><button type="button" className="danger wide" onClick={() => { void discard(); }}>Discard draft</button><button type="button" className="primary wide" onClick={() => setCanceling(false)}>Keep editing</button><ErrorText text={draft.error || error} /></section> : <form className="money-form" noValidate onSubmit={submit}><div className="money-fields"><p className="money-player" data-testid="money-player">{player.display_name}</p><label className="amount-field"><span>Amount <span className="field-currency">({currency})</span></span><input aria-label="Amount" aria-invalid={!!amountError} aria-describedby={amountError ? 'money-amount-error' : amountFeedback ? 'money-amount-preview' : undefined} ref={amountInput} data-testid="money-amount" inputMode="decimal" autoComplete="off" placeholder="0" value={draft.value.amount} onChange={event => { draft.update({ ...draft.value, amount: event.target.value }); setAmountError(''); setError(''); }} disabled={!draft.ready} required /></label>{amountError && <p id="money-amount-error" className="error field-error money-amount-error" role="alert">{amountError}</p>}{amountFeedback && !amountError && <p id="money-amount-preview" className="hint amount-preview" role="status">{amountFeedback}</p>}
    {chip && <fieldset className="payment-methods payment-choice" aria-label="Payment method"><legend>{draft.value.kind === 'buy_in' ? 'Received from player' : 'Paid to player'}</legend><div><button type="button" aria-pressed={!draft.value.paid_now} onClick={() => draft.update({ ...draft.value, paid_now: false })}>Unpaid</button>{(['cash', 'venmo', 'zelle'] as const).map(method => <button key={method} type="button" aria-pressed={draft.value.paid_now && draft.value.method === method} onClick={() => draft.update({ ...draft.value, paid_now: true, method })}>{methodLabel(method)}</button>)}</div></fieldset>}
    {payment && <><fieldset className="payment-methods payment-directions" aria-label="Payment direction"><legend>Payment direction</legend><div><button type="button" aria-pressed={draft.value.kind === 'payment_in'} onClick={() => draft.update({ ...draft.value, kind: 'payment_in' })}>Player pays bank</button><button type="button" aria-pressed={draft.value.kind === 'payment_out'} onClick={() => draft.update({ ...draft.value, kind: 'payment_out' })}>Bank pays player</button></div></fieldset><PaymentMethods value={draft.value.method} change={method => draft.update({ ...draft.value, method })} /></>}
    {(initialKind === 'buy_in' && (lastBuy || typicalBuy || doubleAmount) || initialKind === 'cash_out') && <div className="quick-amounts" aria-label="Quick amounts">{initialKind === 'buy_in' && lastBuy && <button type="button" disabled={!draft.ready} onClick={() => quick(lastBuy)}>Last <span className="money-value">{money(lastBuy, currency)}</span></button>}{initialKind === 'buy_in' && typicalBuy && typicalBuy !== lastBuy && <button type="button" disabled={!draft.ready} onClick={() => quick(typicalBuy)}>Typical <span className="money-value">{money(typicalBuy, currency)}</span></button>}{initialKind === 'buy_in' && doubleAmount && <button type="button" disabled={!draft.ready} onClick={() => quick(doubleAmount!)}>×2 <span className="money-value">{money(doubleAmount, currency)}</span></button>}{initialKind === 'cash_out' && <button type="button" disabled={!draft.ready} onClick={() => quick('0')}>No chips left · <span className="money-value">{money('0', currency)}</span></button>}</div>}
    {initialKind === 'cash_out' && <p className="hint amount-guidance">Enter the actual chips returned. Unpaid means you will pay later.</p>}
    {initialKind === 'expense' && <label>Expense detail<input placeholder="Tip or meal" value={draft.value.note} onChange={event => draft.update({ ...draft.value, note: event.target.value })} /></label>}
    <details><summary>Record an earlier time or note</summary><label>Entry time<input type="datetime-local" step="1" value={draft.value.occurred_at} onChange={event => draft.update({ ...draft.value, occurred_at: event.target.value })} /></label>{draft.value.__recovered_occurred_at !== undefined && <p className="hint">{draft.value.__recovered_occurred_at === null ? 'The original entry time is unknown. It stays unknown unless you enter a time.' : 'The original entry time is kept unless you enter another time.'}</p>}{initialKind !== 'expense' && <label>Note<input value={draft.value.note} onChange={event => draft.update({ ...draft.value, note: event.target.value })} /></label>}</details></div><footer className="money-actions"><ErrorText text={draft.error || error} /><button className="primary wide" disabled={saving || !draft.ready}>{saving ? 'Saving…' : 'Save entry'}</button></footer></form>}</Sheet>;
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
  const [amountError, setAmountError] = useState('');
  const amountInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  useFormBusy(busy);
  const payment = entry.kind === 'payment_in' || entry.kind === 'payment_out';
  async function save(replacement: boolean) {
    if (busy) return;
    let parsed: bigint | undefined;
    if (replacement) {
      try {
        parsed = parseMoney(amount, state!.session.currency);
        if (parsed === 0n && entry.kind !== 'cash_out') throw new Error('Enter an amount above zero');
      } catch (problem) { setAmountError(problem instanceof Error ? problem.message : 'Enter an exact amount'); amountInput.current?.focus(); return; }
    }
    setBusy(true); setError(''); setAmountError('');
    try {
      const body: Record<string, unknown> = { op_id: draft.value.op_id };
      if (replacement) {
        body.replacement_amount_minor = String(parsed);
        if (payment) body.replacement_method = method;
        if (time) body.replacement_occurred_at = new Date(time).toISOString();
      }
      await draft.submit(`/api/sessions/${state!.session.id}/entries/${entryId}/void`, body, 'POST'); open(null);
    } catch (problem) { setError(problem instanceof Error ? problem.message : 'Could not correct entry'); setBusy(false); }
  }
  if (!draft.ready) return draft.error ? <ErrorText text={draft.error} /> : <p>Restoring draft…</p>;
  if (draft.submitted) return <DraftRecovery pending={busy} notice={draft.error} recover={() => draft.reconcile()} recovered={() => open(null)} />;
  return <form className="sheet-form" noValidate onSubmit={event => { event.preventDefault(); if (!confirmingVoid) void save(true); }}><div className="form-body"><p className="correction-summary">{entryLabels[entry.kind]} · {player?.display_name ?? 'Player'} · <strong className="money-value">{money(entry.amount_minor, state!.session.currency)}</strong>{entry.method ? ` · ${methodLabel(entry.method)}` : ''}</p>{confirmingVoid ? <section className="confirmation-panel" role="alertdialog" aria-label="Void ledger entry" tabIndex={-1} ref={voidPanel}><h3>Void this entry?</h3><p>The original stays in the ledger, marked Voided. Its amount stops counting toward totals. No replacement is added.</p></section> : <><p>The original stays in the ledger, marked Voided, with a replacement alongside it.</p><label>Replacement amount<input ref={amountInput} inputMode="decimal" aria-invalid={!!amountError} aria-describedby={amountError ? 'replacement-amount-error' : undefined} value={amount} onChange={event => { setAmount(event.target.value); setAmountError(''); }} required /></label>{amountError && <p id="replacement-amount-error" className="error field-error" role="alert">{amountError}</p>}{payment && <PaymentMethods label="Replacement method" value={method} change={setMethod} />}<label>Entry time<input type="datetime-local" step="1" value={time} onChange={event => setTime(event.target.value)} /></label></>}</div><footer className="form-actions"><ErrorText text={draft.error || error} />{confirmingVoid ? <><button key="keep-entry" className="wide" type="button" disabled={busy} onClick={event => { event.preventDefault(); setConfirmingVoid(false); }}>Keep entry</button><button key="confirm-void" className="danger wide" type="button" disabled={busy} onClick={event => { event.preventDefault(); void save(false); }}>Confirm void</button></> : <><button key="save-correction" type="submit" className="primary wide" disabled={busy}>Save correction</button><button key="request-void" className="danger wide" type="button" disabled={busy} onClick={event => { event.preventDefault(); setConfirmingVoid(true); }}>Void entry</button></>}</footer></form>;
}
