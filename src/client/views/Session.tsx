import { submittedAt } from '../clock';
import { useDebouncedSearch } from '../search';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import type { EntryKind, LedgerEntry, PaymentMethod, PlayerState, SessionState } from '../../domain/session';
import { MAX_MINOR, parseMoney } from '../../domain/money';
import { moneyOptions } from '../money-options';
import { retainedTimerStart } from '../undo-timing';
import { draftKey, enqueue } from '../data';
import { decimal, duration, entryLabels, entryNouns, DraftRecovery, ErrorText, methodLabel, money, resultCurrencyDecimal, resultMoney, resultNumber, Sheet, useClient, useDraft, useFormBusy } from './common';
import { ChevronDownIcon, ChevronRightIcon, FitText, MoreIcon, PlusIcon } from './ui';

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
    return text === 'Even' ? text : `${text} BB`;
  }
  return resultMoney(player.result_minor, currency);
}
function resultTone(player: Extract<PlayerState, { state: 'cashed_out' }>, mode: DisplayMode) {
  const value = mode === 'hourly' ? player.performance.per_hour?.numerator : mode === 'blinds' ? player.performance.big_blinds?.numerator : player.result_minor;
  if (value === undefined) return 'unavailable';
  const amount = BigInt(value);
  return amount > 0n ? 'up' : amount < 0n ? 'down' : 'even';
}
function balanceText(player: PlayerState, currency: string) {
  const balance = BigInt(player.balance_minor);
  return balance === 0n ? 'Paid up' : balance > 0n ? `Owes ${money(player.balance_minor, currency)}` : `Owed ${money(String(-balance), currency)}`;
}
function clock(value: bigint) {
  const seconds = value / 1000n;
  return `${seconds / 3600n}:${String((seconds % 3600n) / 60n).padStart(2, '0')}:${String(seconds % 60n).padStart(2, '0')}`;
}
function Timer({ state, unknownStart }: { state: SessionState; unknownStart: boolean }) {
  const [tick, setTick] = useState(0);
  const loaded = useRef(performance.now());
  useEffect(() => { loaded.current = performance.now(); setTick(0); }, [state.server_now]);
  useEffect(() => { const timer = window.setInterval(() => setTick(Math.max(0, Math.floor(performance.now() - loaded.current))), 1000); return () => clearInterval(timer); }, []);
  if (state.timing.elapsed_ms === null) return unknownStart ? <span data-testid="session-timer" className="meta-item timer">Start time unknown</span> : null;
  const running = state.session.ended_at === null;
  const elapsed = BigInt(state.timing.elapsed_ms) + (running ? BigInt(tick) : 0n);
  return <span data-testid="session-timer" className="meta-item timer"><span className="sr-only">{running ? 'Playing time ' : 'Finished, played '}</span>{running ? clock(elapsed) : duration(String(elapsed))}</span>;
}
export function SessionView({ state, viewer = false }: { state: SessionState; viewer?: boolean }) {
  const { open } = useClient();
  const [mode, setMode] = useState<DisplayMode>(() => (localStorage.getItem('pb-display') as DisplayMode) || 'total');
  const settings = state.session;
  const currency = settings.currency;
  const unknownStart = settings.started_at === null && state.players.some(player => player.buy_in_count > 0);
  const status = settings.status === 'open' ? 'In progress' : settings.closed_balanced ? 'Closed · chips balanced' : 'Closed · chip discrepancy';
  const info = [new Date(`${settings.played_on}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), settings.location, settings.game, currency, settings.big_blind_minor ? `${money(settings.big_blind_minor, currency)} BB` : null].filter(Boolean).join(' · ');
  const hasResults = state.players.some(player => player.state === 'cashed_out');
  const readyToClose = !viewer && settings.status === 'open' && hasResults && !state.players.some(player => player.state === 'playing');
  const unsettled = state.players.filter(player => BigInt(player.balance_minor) !== 0n).length;
  const retainedTimer = !viewer ? retainedTimerStart(state) : null;
  const actions = !viewer && settings.status === 'open';
  const chips = state.totals.on_table_minor ?? state.totals.discrepancy_minor ?? '0';
  const collect = state.totals.owed_to_banker_minor, pay = state.totals.owed_by_banker_minor;
  const stacked = money(collect, currency).length + money(pay, currency).length > 24;
  const playersRef = useRef<HTMLElement>(null);
  const [actionsBelow, setActionsBelow] = useState('');
  const [inlineActions, setInlineActions] = useState(false);
  useLayoutEffect(() => {
    const section = playersRef.current;
    if (!section) { setActionsBelow(''); setInlineActions(false); return; }
    const measure = () => {
      const cards = [...section.querySelectorAll<HTMLElement>('.player-card')];
      const was = cards.map(card => card.classList.contains('actions-below'));
      for (const card of cards) card.classList.remove('actions-below');
      const clips = (card: HTMLElement) => {
        const amount = card.querySelector<HTMLElement>('.player-detail .fit-text');
        if (!amount) return false;
        const fitted = amount.style.fontSize;
        const wrapped = amount.classList.contains('fit-wrap');
        amount.style.fontSize = '';
        amount.classList.remove('fit-wrap');
        const clipped = amount.scrollWidth > amount.clientWidth + 1;
        amount.style.fontSize = fitted;
        amount.classList.toggle('fit-wrap', wrapped);
        return clipped;
      };
      const inlineWas = section.classList.contains('inline-actions');
      section.classList.remove('inline-actions');
      const clippedAmounts = new Set(cards.filter(clips));
      section.classList.add('measuring');
      const crowded = cards.filter(card => {
        const name = card.querySelector<HTMLElement>('.player-name strong');
        if (clippedAmounts.has(card)) return true;
        const status = card.querySelector<HTMLElement>('.player-state');
        if (section.classList.contains('with-actions') && status && status.scrollWidth > status.clientWidth + 1) return true;
        if (!name) return false;
        const line = Number.parseFloat(getComputedStyle(name).lineHeight);
        return name.scrollWidth > name.clientWidth + 1 || name.getBoundingClientRect().height > line * 2 + 1;
      }).map(card => card.dataset.player ?? '');
      section.classList.remove('measuring');
      let inline = false;
      if (crowded.length && section.classList.contains('with-actions') && window.matchMedia('(max-width: 374px)').matches) {
        section.classList.add('inline-actions');
        for (const card of cards) card.classList.add('actions-below');
        inline = !cards.some(clips);
      }
      section.classList.toggle('inline-actions', inlineWas);
      cards.forEach((card, index) => card.classList.toggle('actions-below', was[index]!));
      setInlineActions(inline);
      setActionsBelow(crowded.length ? cards.map(card => card.dataset.player ?? '').join(' ') : '');
    };
    measure();
    let last = -1;
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(entries => { const width = Math.round(entries[0]!.contentRect.width); if (width !== last) { last = width; measure(); } });
    observer?.observe(section);
    return () => observer?.disconnect();
  }, [state, mode, actions]);
  const titleParts = typeof Intl.Segmenter === 'function' ? Array.from(new Intl.Segmenter().segment(settings.name), part => part.segment) : Array.from(settings.name);
  const titleTail = titleParts.pop() ?? '', titleHead = titleParts.join('');
  function display(next: DisplayMode) { setMode(next); localStorage.setItem('pb-display', next); }
  return <div className="session-board">
    <div className="session-overview">
      <header className="session-heading">
        <div className="session-heading-text">
          <h1 aria-label={settings.name} title={settings.name}>{viewer ? <span className="session-title">{settings.name}</span> : <button className="session-title" data-testid={`session-tab-${settings.id}`} aria-label="Switch session" aria-haspopup="dialog" onClick={() => open({ kind: 'history' })}><span className="session-title-text">{titleHead}<span className="session-title-end">{titleTail}<ChevronDownIcon /></span></span></button>}</h1>
        </div>
        {!viewer && <div className="session-heading-actions"><button className={`icon-button${settings.status === 'closed' ? ' closed-session-new' : ''}`} aria-label="New session" title="New session" onClick={() => open({ kind: 'new' })}><PlusIcon /></button><button className="icon-button" aria-label="Session menu" title="Session menu" onClick={() => open({ kind: 'menu' })}><MoreIcon /></button></div>}
        <p className="session-meta"><span className="meta-item meta-info" title={info}>{info}</span><span className="meta-item status-line">{status}</span><Timer state={state} unknownStart={unknownStart} />{!viewer && (unknownStart ? <button className="text-button meta-action" onClick={() => open({ kind: 'timing' })}>Correct times</button> : settings.started_at === null && settings.status === 'open' && <StartTimer />)}</p>
        {retainedTimer && <p className="retained-timer-notice" data-testid="retained-timer-notice">Timer started {new Date(retainedTimer).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · <button className="text-button" onClick={() => open({ kind: 'timing' })}>Correct times</button></p>}
      </header>
      <section className={`totals${stacked ? ' totals-stacked' : ''}`} aria-label="Session totals" data-testid="totals">
        <div className="totals-main"><span className="totals-label">{state.totals.on_table_minor !== null ? 'Chips in play' : 'Chip difference'}</span><FitText as="strong" className="money-value totals-hero" text={money(chips, currency)} /></div>
        <div className="totals-split"><div><span className="totals-label">To collect</span><FitText as="strong" className={`money-value totals-amount${BigInt(collect) > 0n ? ' owed' : ''}`} text={money(collect, currency)} /></div><div><span className="totals-label">To pay</span><FitText as="strong" className={`money-value totals-amount${BigInt(pay) > 0n ? ' owe' : ''}`} text={money(pay, currency)} /></div></div>
        <p className="chip-history"><span>Bought <b className="money-value">{money(state.totals.total_in_minor, currency)}</b></span><span>Returned <b className="money-value">{money(state.totals.total_out_minor, currency)}</b></span></p>
        {state.totals.on_table_minor === null && state.totals.discrepancy_minor !== '0' && <p className="hint discrepancy-note">Returned chips differ from bought chips. Payments are separate.</p>}
      </section>
    </div>
    <div className="session-table">{readyToClose && <button className="ready-to-close" data-testid="ready-to-close" onClick={() => open({ kind: 'close' })}><span>Everyone has cashed out · Close session{unsettled > 0 ? ` · ${unsettled} unsettled` : ''}</span><ChevronRightIcon /></button>}
      <div className="section-heading"><h2>Players <span className="count">{state.players.length}</span></h2>{actions && state.players.length > 0 && <button className="text-button" onClick={() => open({ kind: 'add' })}>Add player</button>}</div>
      {hasResults && <div className="segmented display-modes" role="group" aria-label="Result display"><button aria-pressed={mode === 'total'} onClick={() => display('total')}>Total</button><button aria-pressed={mode === 'hourly'} onClick={() => display('hourly')}>Per hour</button><button aria-pressed={mode === 'blinds'} onClick={() => display('blinds')}>BB</button></div>}
      <section ref={playersRef} className={`players${actions ? ' with-actions' : ''}${inlineActions ? ' inline-actions' : ''}`} aria-label="Session players">{state.players.length === 0 && <div className="empty-row"><span>No players yet</span></div>}{state.players.map(player => {
        const { lastBuy } = moneyOptions(state.entries, player.id);
        const balance = BigInt(player.balance_minor);
        const content = <>
          <span className="player-name"><strong title={player.display_name}>{player.display_name}</strong><span className="player-state"><span data-testid={player.state !== 'cashed_out' ? `result-${player.id}` : undefined}>{player.state === 'seated' ? 'Not bought in' : player.state === 'playing' ? 'Playing' : 'Cashed out'}</span>{(player.state !== 'seated' || balance !== 0n) && <><span className="state-separator"> · </span>{balance === 0n ? <span className="player-paid">Paid up</span> : <span className={`player-balance ${balance > 0n ? 'owe' : 'owed'}`}>{balance > 0n ? 'Owes' : 'Owed'} <span className="money-value">{money(String(balance > 0n ? balance : -balance), currency)}</span></span>}</>}</span></span>
          <span className="player-detail">
            {player.state === 'cashed_out' ? <span className="player-position-wrap">{!resultText(player, currency, mode).startsWith('No ') && <span className="position-label">Result </span>}<FitText className={`money-value player-position tone-${resultTone(player, mode)}`} testId={`result-${player.id}`} text={resultText(player, currency, mode)} refit={`${actionsBelow.split(' ').includes(player.id)}:${inlineActions}`} /></span> : player.state === 'playing' ? <span className="player-position-wrap bought"><span className="position-label" aria-hidden="true">In </span><span className="sr-only">Bought </span><FitText className="money-value player-position" text={money(player.bought_in_minor, currency)} refit={`${actionsBelow.split(' ').includes(player.id)}:${inlineActions}`} /></span> : null}
          </span>
        </>;
        const controls = actions && <div className="player-actions">{player.state === 'seated' ? <button data-testid={`buy-in-${player.id}`} aria-label={`Buy-in for ${player.display_name}`} onClick={() => open({ kind: 'money', player: player.id })}>Buy-in</button> : player.state === 'playing' ? <><button data-testid={`cash-out-${player.id}`} aria-label={`Cash out ${player.display_name}`} onClick={() => open({ kind: 'cash_out', player: player.id })}>Cash out</button>{lastBuy && <button data-testid={`repeat-buy-in-${player.id}`} aria-label={`Repeat last buy-in for ${player.display_name}`} title={`Rebuy ${money(lastBuy, currency)}`} onClick={() => open({ kind: 'money', player: player.id, amount: lastBuy })}>Rebuy</button>}</> : balance !== 0n ? <button data-testid={`settle-${player.id}`} aria-label={`Settle ${player.display_name}`} onClick={() => open({ kind: balance < 0n ? 'payment_out' : 'payment_in', player: player.id, amount: String(balance < 0n ? -balance : balance) })}>Settle</button> : null}</div>;
        return viewer ? <div className={`player-card${actionsBelow.split(' ').includes(player.id) ? ' actions-below' : ''}`} data-player={player.id} key={player.id}><div data-testid={`player-${player.id}`} className="player-row">{content}</div></div> : <div className={`player-card${actionsBelow.split(' ').includes(player.id) ? ' actions-below' : ''}`} data-player={player.id} key={player.id}><button data-testid={`player-${player.id}`} className="player-row" onClick={() => open({ kind: 'player', player: player.id })}>{content}</button>{controls}</div>;
      })}</section>
      {!viewer && <RemovedPlayers state={state} />}
    </div>
    <Activity state={state} />
  </div>;
}
function StartTimer() {
  const { state, mutate, notify } = useClient();
  return <button className="text-button meta-action" onClick={() => { void mutate(`/api/sessions/${state!.session.id}/start`, { op_id: crypto.randomUUID() }).catch(error => notify(error.message)); }}>Start timer</button>;
}
type EntryMark = 'live' | 'void' | 'hidden' | 'deleted' | 'removed' | 'voided';
export function entryMarks(entries: LedgerEntry[]) {
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const voids = new Map(entries.flatMap(entry => entry.voids_entry_id ? [[entry.voids_entry_id, entry] as const] : []));
  const restored = new Set(entries.flatMap(entry => entry.restores_entry_id ? [entry.restores_entry_id] : []));
  const replaced = (original: LedgerEntry, row: LedgerEntry) => entries.some(entry => entry.revision === row.revision && entry.player_id === original.player_id && entry.kind === original.kind && entry.voids_entry_id === null && entry.id !== row.id && entry.id !== original.id);
  return (entry: LedgerEntry): EntryMark => {
    if (entry.voids_entry_id) {
      const original = byId.get(entry.voids_entry_id);
      return original && !entry.removal_id && replaced(original, entry) ? 'void' : 'hidden';
    }
    const row = voids.get(entry.id);
    if (!row) return 'live';
    if (!row.removal_id && replaced(entry, row)) return 'voided';
    if (restored.has(entry.id)) return 'hidden';
    return row.removal_id ? 'removed' : 'deleted';
  };
}
const markLabels: Partial<Record<EntryMark, string>> = { deleted: 'Deleted', removed: 'Removed', voided: 'Voided' };
export function Activity({ state, onlyPlayer }: { state: SessionState; onlyPlayer?: string }) {
  const { banker, open, pending } = useClient();
  const mark = entryMarks(state.entries);
  const deleting = new Set(pending.filter(item => item.session_id === state.session.id).flatMap(item => { const match = /\/entries\/([^/]+)\/void$/.exec(item.path); return match ? [match[1]!] : []; }));
  const names = new Map([...state.players, ...(state.removed_players ?? [])].map(player => [player.id, player.display_name]));
  const rows = state.entries.filter(entry => (!onlyPlayer || entry.player_id === onlyPlayer) && mark(entry) !== 'hidden');
  const timeFormat = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' });
  const writable = !!banker && state.session.status === 'open';
  return <section className="activity" data-testid="activity"><h2>{onlyPlayer ? 'Entries' : 'Activity'}</h2>{!rows.length && <p className="muted empty-line">No entries yet</p>}<ul className="entry-list">{rows.map(entry => {
    const status = mark(entry);
    const cancelled = !!markLabels[status];
    const name = names.get(entry.player_id);
    const amount = money(entry.amount_minor, state.session.currency);
    const shownAmount = entry.kind === 'payment_in' ? `+${amount}` : entry.kind === 'payment_out' ? `−${amount}` : amount;
    const label = [status === 'void' ? `Void · ${entryLabels[entry.kind]}` : entryLabels[entry.kind], entry.method ? methodLabel(entry.method) : null].filter(Boolean).join(' · ');
    const statusText = markLabels[status] ?? (deleting.has(entry.id) ? 'Delete pending' : null);
    const time = entry.occurred_at === null ? 'Time unavailable' : timeFormat.format(new Date(entry.occurred_at));
    const spoken = (verb: string) => [`${verb} ${entryLabels[entry.kind]} ${amount}`, name, entry.method ? methodLabel(entry.method) : null, time, entry.note].filter(Boolean).join(' · ');
    const body = <><span className="entry-main"><span className={`entry-title${cancelled ? ' voided' : ''}`}>{!onlyPlayer && name && <><strong className="entry-player">{name}</strong><span className="entry-separator"> · </span></>}<span className="entry-label">{label}</span></span><small>{time}{entry.note ? ` · ${entry.note}` : ''}</small></span><span className="entry-side"><FitText as="strong" className={`money-value entry-amount${cancelled ? ' voided' : entry.kind === 'payment_in' ? ' owed' : ''}`} text={shownAmount} />{statusText && <span className="entry-status">{statusText}</span>}</span></>;
    const editable = writable && status === 'live' && !deleting.has(entry.id);
    const awaiting = writable && status === 'live' && deleting.has(entry.id);
    const restorable = writable && status === 'deleted' && state.players.some(player => player.id === entry.player_id);
    return <li key={entry.id} data-testid={`entry-${entry.id}`} className={cancelled ? 'is-voided' : undefined}>{editable ? <button className="entry-row" aria-label={spoken('Correct')} onClick={() => open({ kind: 'correction', entry: entry.id, player: entry.player_id })}>{body}</button> : restorable ? <button className="entry-row" aria-label={spoken('Deleted')} onClick={() => open({ kind: 'restore-entry', entry: entry.id, player: entry.player_id })}>{body}</button> : awaiting ? <button className="entry-row" aria-disabled="true" aria-label={spoken('Delete pending')} onClick={event => event.preventDefault()}>{body}</button> : <div className="entry-row">{body}</div>}</li>;
  })}</ul></section>;
}
export function PlayerSheet({ playerId }: { playerId: string }) {
  const { state, open } = useClient();
  const player = state!.players.find(player => player.id === playerId)!;
  const currency = state!.session.currency;
  const balance = BigInt(player.balance_minor);
  const lead = player.state === 'playing' ? 'cash' : player.state === 'cashed_out' ? balance !== 0n ? 'pay' : '' : 'buy';
  return <><dl className="player-stats"><div><dt>Balance</dt><dd><FitText className={balance === 0n ? undefined : `money-value player-balance ${balance > 0n ? 'owe' : 'owed'}`} text={balanceText(player, currency)} /></dd></div><div><dt>Bought</dt><dd><FitText className="money-value" text={money(player.bought_in_minor, currency)} /></dd></div><div><dt>Returned</dt><dd><FitText className="money-value" text={money(player.cashed_out_minor, currency)} /></dd></div><div><dt>Time</dt><dd>{duration(player.duration_ms)}</dd></div></dl>{state!.session.status === 'open' && <div className="action-grid"><button className={lead === 'buy' ? 'primary' : undefined} onClick={() => open({ kind: 'money', player: playerId })}>Buy-in</button>{player.state !== 'cashed_out' && <button className={lead === 'cash' ? 'primary' : undefined} onClick={() => open({ kind: 'cash_out', player: playerId })}>Cash out</button>}<button className={lead === 'pay' ? 'primary' : undefined} onClick={() => open({ kind: 'payment_in', player: playerId, amount: balance === 0n ? undefined : String(balance < 0n ? -balance : balance) })}>Record payment</button><button onClick={() => open({ kind: 'expense', player: playerId })}>Tips and meals</button></div>}<Activity state={state!} onlyPlayer={playerId} />{state!.session.status === 'open' && <RemovePlayer playerId={playerId} />}</>;
}
function RemovePlayer({ playerId }: { playerId: string }) {
  const { banker, state, pending, open, notify } = useClient();
  const player = state!.players.find(player => player.id === playerId)!;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const panel = useRef<HTMLElement>(null);
  useFormBusy(busy);
  useEffect(() => {
    if (!confirming) return;
    const reveal = () => panel.current?.scrollIntoView({ block: 'nearest' });
    panel.current?.focus({ preventScroll: true }); reveal();
    window.addEventListener('resize', reveal);
    return () => window.removeEventListener('resize', reveal);
  }, [confirming]);
  const path = `/api/sessions/${state!.session.id}/players/${playerId}/remove`;
  const voided = new Set(state!.entries.flatMap(entry => entry.voids_entry_id ? [entry.voids_entry_id] : []));
  const count = state!.entries.filter(entry => entry.player_id === playerId && !entry.voids_entry_id && !voided.has(entry.id)).length;
  if (pending.some(item => item.path === path)) return <p className="hint remove-pending">Removal not saved yet</p>;
  async function remove() {
    if (busy) return;
    setBusy(true); setError('');
    try {
      await enqueue({ banker_id: banker!.id, session_id: state!.session.id, path, body: { op_id: crypto.randomUUID() }, label: `Remove ${player.display_name}` });
      notify('Not saved yet'); open(null);
    } catch (problem) { setError(problem instanceof Error ? problem.message : 'Could not remove player'); setBusy(false); }
  }
  return confirming ? <section className="confirmation-panel" role="alertdialog" aria-label="Remove player" tabIndex={-1} ref={panel}><h3>Remove {player.display_name} from this game?</h3><p>{count ? `Their ${count} ${count === 1 ? 'entry' : 'entries'} will be deleted.` : 'They have no entries.'} Totals update right away.</p><ErrorText text={error} /><div className="confirm-actions"><button type="button" disabled={busy} onClick={() => setConfirming(false)}>Keep player</button><button type="button" className="danger" disabled={busy} onClick={() => { void remove(); }}>Confirm remove</button></div></section> : <button type="button" className="quiet-danger" onClick={() => setConfirming(true)}>Remove from game</button>;
}
export function RemovedPlayers({ state }: { state: SessionState }) {
  const { mutate, notify, online } = useClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  useFormBusy(busy !== null);
  const removed = state.removed_players ?? [];
  if (!removed.length) return null;
  async function restore(id: string, name: string) {
    if (busy) return;
    setBusy(id); setError('');
    try { await mutate(`/api/sessions/${state.session.id}/players/${id}/restore`, { op_id: crypto.randomUUID() }); notify(`Restored ${name}`); }
    catch (problem) { setError(problem instanceof Error ? problem.message : 'Could not restore player'); }
    finally { setBusy(null); }
  }
  return <details className="recover-list" data-testid="removed-players"><summary>Removed ({removed.length})</summary><ul>{removed.map(player => <li key={player.id}><span className="recover-name" title={player.display_name}>{player.display_name}</span>{state.session.status === 'open' && <button type="button" aria-label={`Restore ${player.display_name}`} disabled={busy !== null || !online} onClick={() => { void restore(player.id, player.display_name); }}>{busy === player.id ? 'Restoring…' : 'Restore'}</button>}</li>)}</ul><ErrorText text={error} /></details>;
}
function PaymentMethods({ label = 'Payment method', value, change }: { label?: string; value: PaymentMethod; change: (value: PaymentMethod) => void }) {
  return <fieldset className="payment-methods"><legend>{label}</legend><div>{(['cash', 'venmo', 'zelle'] as const).map(method => <button key={method} type="button" aria-pressed={value === method} onClick={() => change(method)}>{methodLabel(method)}</button>)}</div></fieldset>;
}
type MoneyDraft = { op_id: string; amount: string; paid_now: boolean; method: PaymentMethod; occurred_at: string; note: string; kind: EntryKind; __recovered_occurred_at?: string | null };
export function MoneySheet({ title, playerId, kind: initialKind, initialAmount }: { title: string; playerId: string; kind: EntryKind; initialAmount?: string }) {
  const { banker, state, notify, open } = useClient();
  const currency = state!.session.currency;
  const player = state!.players.find(player => player.id === playerId)!;
  const { lastBuy, typicalBuy, lastBuyMethod, method: lastMethod } = moneyOptions(state!.entries, playerId);
  const key = draftKey(banker!.id, state!.session.id, initialKind, playerId);
  const balance = BigInt(state!.players.find(player => player.id === playerId)!.balance_minor);
  const suggestedKind = initialKind === 'payment_in' && balance < 0n ? 'payment_out' : initialKind;
  const remembered = initialKind === 'buy_in' && lastBuyMethod !== undefined && balance <= 0n;
  const draft = useDraft<MoneyDraft>(key, { op_id: crypto.randomUUID(), amount: initialAmount !== undefined ? decimal(initialAmount, currency) : '', paid_now: remembered, method: (remembered && lastBuyMethod) || lastMethod, occurred_at: '', note: '', kind: suggestedKind });
  const [error, setError] = useState('');
  const [amountError, setAmountError] = useState('');
  const [saving, setSaving] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const amountInput = useRef<HTMLInputElement>(null);
  const cancelPanel = useRef<HTMLElement>(null);
  const [fields, setFields] = useState<HTMLDivElement | null>(null);
  const [below, setBelow] = useState(false);
  useLayoutEffect(() => {
    const element = fields;
    if (!element) { setBelow(false); return; }
    const check = () => setBelow(element.scrollTop + element.clientHeight < element.scrollHeight - 1);
    check();
    element.addEventListener('scroll', check, { passive: true });
    element.addEventListener('toggle', check, true);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(check);
    observer?.observe(element);
    return () => { element.removeEventListener('scroll', check); element.removeEventListener('toggle', check, true); observer?.disconnect(); };
  }, [fields]);
  useLayoutEffect(() => {
    const element = fields;
    if (element) setBelow(element.scrollTop + element.clientHeight < element.scrollHeight - 1);
  });
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
      let plain: bigint | null = null;
      try { plain = parseMoney(draft.value.amount.replace(/,/g, ''), currency); } catch {}
      if (plain !== amount) amountFeedback = `Will record ${money(String(amount), currency)}`;
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
    try { await draft.keep(); open(null); }
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
  return <Sheet title={title} leadingClose closeLabel="Cancel" className="money-sheet" close={cancel}>{canceling ? <section className="cancel-draft" role="alertdialog" aria-label="Keep or discard this draft" tabIndex={-1} ref={cancelPanel}><h3>Discard this typed amount?</h3><p>Your typed amount has not been saved to the ledger.</p><button type="button" className="wide" disabled={saving || !draft.ready} onClick={() => { void keep(); }}>Keep draft and close</button><button type="button" className="danger wide" onClick={() => { void discard(); }}>Discard draft</button><button type="button" className="primary wide" onClick={() => setCanceling(false)}>Keep editing</button><ErrorText text={draft.error || error} /></section> : <form className="money-form" noValidate onSubmit={submit}><div className="money-fields" ref={setFields}><p className="money-player" data-testid="money-player">{player.display_name}</p><label className="amount-field"><span>Amount <span className="field-currency">({currency})</span></span><input aria-label="Amount" aria-invalid={!!amountError} aria-describedby={amountError ? 'money-amount-error' : amountFeedback ? 'money-amount-preview' : undefined} ref={amountInput} data-testid="money-amount" inputMode="decimal" autoComplete="off" placeholder="0" value={draft.value.amount} onChange={event => { draft.update({ ...draft.value, amount: event.target.value }); setAmountError(''); setError(''); }} disabled={!draft.ready} required /></label>{amountError && <p id="money-amount-error" className="error field-error money-amount-error" role="alert">{amountError}</p>}{amountFeedback && !amountError && <p id="money-amount-preview" className="hint amount-preview" role="status">{amountFeedback}</p>}
    {chip && <fieldset className="payment-methods payment-choice" aria-label="Payment method"><legend>{draft.value.kind === 'buy_in' ? 'Received from player' : 'Paid to player'}</legend><div><button type="button" aria-pressed={!draft.value.paid_now} onClick={() => draft.update({ ...draft.value, paid_now: false })}>Unpaid</button>{(['cash', 'venmo', 'zelle'] as const).map(method => <button key={method} type="button" aria-pressed={draft.value.paid_now && draft.value.method === method} onClick={() => draft.update({ ...draft.value, paid_now: true, method })}>{methodLabel(method)}</button>)}</div></fieldset>}
    {payment && <><fieldset className="payment-methods payment-directions" aria-label="Payment direction"><legend>Payment direction</legend><div><button type="button" aria-pressed={draft.value.kind === 'payment_in'} onClick={() => draft.update({ ...draft.value, kind: 'payment_in' })}>Player pays bank</button><button type="button" aria-pressed={draft.value.kind === 'payment_out'} onClick={() => draft.update({ ...draft.value, kind: 'payment_out' })}>Bank pays player</button></div></fieldset><PaymentMethods value={draft.value.method} change={method => draft.update({ ...draft.value, method })} /></>}
    {(initialKind === 'buy_in' && (lastBuy || typicalBuy || doubleAmount) || initialKind === 'cash_out') && <div className="quick-amounts" aria-label="Quick amounts">{initialKind === 'buy_in' && lastBuy && <button type="button" disabled={!draft.ready} onClick={() => quick(lastBuy)}>Last <span className="money-value">{money(lastBuy, currency)}</span></button>}{initialKind === 'buy_in' && typicalBuy && typicalBuy !== lastBuy && <button type="button" disabled={!draft.ready} onClick={() => quick(typicalBuy)}>Typical <span className="money-value">{money(typicalBuy, currency)}</span></button>}{initialKind === 'buy_in' && doubleAmount && <button type="button" disabled={!draft.ready} onClick={() => quick(doubleAmount!)}>×2 <span className="money-value">{money(doubleAmount, currency)}</span></button>}{initialKind === 'cash_out' && <button type="button" disabled={!draft.ready} onClick={() => quick('0')}>No chips left · <span className="money-value">{money('0', currency)}</span></button>}</div>}
    {initialKind === 'cash_out' && <p className="hint amount-guidance">Enter the actual chips returned. Unpaid means you will pay later.</p>}
    {initialKind === 'expense' && <label>Expense detail<input placeholder="Tip or meal" value={draft.value.note} onChange={event => draft.update({ ...draft.value, note: event.target.value })} /></label>}
    <details><summary>Record an earlier time or note</summary><label>Entry time<input type="datetime-local" step="1" value={draft.value.occurred_at} onChange={event => draft.update({ ...draft.value, occurred_at: event.target.value })} /></label>{draft.value.__recovered_occurred_at !== undefined && <p className="hint">{draft.value.__recovered_occurred_at === null ? 'The original entry time is unknown. It stays unknown unless you enter a time.' : 'The original entry time is kept unless you enter another time.'}</p>}{initialKind !== 'expense' && <label>Note<input value={draft.value.note} onChange={event => draft.update({ ...draft.value, note: event.target.value })} /></label>}</details></div><footer className={`money-actions${below ? ' content-below' : ''}`}><ErrorText text={draft.error || error} />{remembered && draft.value.kind === 'buy_in' && draft.value.paid_now && draft.value.method === lastBuyMethod && <p className="payment-default" data-testid="payment-default">{methodLabel(lastBuyMethod)}, same as their last buy-in</p>}<button className="primary wide" disabled={saving || !draft.ready}>{saving ? 'Saving…' : 'Save entry'}</button></footer></form>}</Sheet>;
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
  return <><label>Search players<input value={search} onChange={event => { setSearch(event.target.value); setConfirmed(false); }} placeholder="Name" /></label><p className="hint">Choose an existing player to keep their history together.</p>{searching && <p role="status">Searching players…</p>}<ul className="choice-list">{players.map(player => { const seated = state!.players.some(seated => seated.id === player.id), removed = (state!.removed_players ?? []).some(removed => removed.id === player.id); return <li key={player.id}><button disabled={busy || searching || seated || removed} onClick={() => { void add({ player_id: player.id }); }}>{player.display_name}{seated ? ' · Already in session' : removed ? ' · Removed from this game' : ''}</button></li>; })}</ul>{search.trim() && <>{exact && <><p className="warning">An exact name match already exists. Add the existing player unless this is a different person.</p><label className="check"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />This is a different person</label></>}<button className="primary wide" disabled={busy || searching || (exact && !confirmed)} onClick={() => { void add({ new_player_name: search.trim() }); }}>Add '{search.trim()}' as new</button></>}<ErrorText text={savedSearch.error || error} /></>;
}
export function CorrectionSheet({ entryId }: { entryId: string }) {
  const { banker, state, open, notify } = useClient();
  const entry = state!.entries.find(row => row.id === entryId)!;
  const player = state!.players.find(row => row.id === entry.player_id);
  const currency = state!.session.currency;
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const deletePanel = useRef<HTMLElement>(null);
  useEffect(() => { if (confirmingDelete) deletePanel.current?.focus(); }, [confirmingDelete]);
  const key = draftKey(banker!.id, state!.session.id, 'correction', entryId);
  const originalTime = entry.occurred_at ? new Date(new Date(entry.occurred_at).getTime() - new Date(entry.occurred_at).getTimezoneOffset() * 60000).toISOString().slice(0, 19) : '';
  const draft = useDraft(key, { op_id: crypto.randomUUID(), amount: decimal(entry.amount_minor, currency), method: entry.method ?? 'cash', time: originalTime, original_time: originalTime });
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
  const name = player?.display_name ?? 'Player';
  const shown = money(entry.amount_minor, currency);
  async function save() {
    if (busy) return;
    let parsed: bigint;
    try {
      parsed = parseMoney(amount, currency);
      if (parsed === 0n && entry.kind !== 'cash_out') throw new Error('Enter an amount above zero');
    } catch (problem) { setAmountError(problem instanceof Error ? problem.message : 'Enter an exact amount'); amountInput.current?.focus(); return; }
    setBusy(true); setError(''); setAmountError('');
    try {
      const body: Record<string, unknown> = { op_id: draft.value.op_id, replacement_amount_minor: String(parsed) };
      if (payment) body.replacement_method = method;
      if (time && time !== (draft.value.original_time ?? originalTime)) body.replacement_occurred_at = new Date(time).toISOString();
      await draft.submit(`/api/sessions/${state!.session.id}/entries/${entryId}/void`, body, 'POST'); open(null);
    } catch (problem) { setError(problem instanceof Error ? problem.message : 'Could not correct entry'); setBusy(false); }
  }
  async function remove() {
    if (busy) return;
    setBusy(true); setError('');
    try {
      await draft.queue({ banker_id: banker!.id, session_id: state!.session.id, path: `/api/sessions/${state!.session.id}/entries/${entryId}/void`, body: { op_id: draft.value.op_id }, label: `Delete ${entryNouns[entry.kind]} · ${name} · ${shown}`, draft_key: key });
      notify('Not saved yet'); open(null);
    } catch (problem) { setError(problem instanceof Error ? problem.message : 'Could not delete entry'); setBusy(false); }
  }
  if (!draft.ready) return draft.error ? <ErrorText text={draft.error} /> : <p>Restoring draft…</p>;
  if (draft.submitted) return <DraftRecovery pending={busy} notice={draft.error} recover={() => draft.reconcile()} recovered={() => open(null)} />;
  return <form className="sheet-form" noValidate onSubmit={event => { event.preventDefault(); if (!confirmingDelete) void save(); }}><div className="form-body"><p className="correction-summary">{entryLabels[entry.kind]} · {name} · <strong className="money-value">{shown}</strong>{entry.method ? ` · ${methodLabel(entry.method)}` : ''}</p>{confirmingDelete ? <section className="confirmation-panel" role="alertdialog" aria-label="Delete entry" tabIndex={-1} ref={deletePanel}><h3>Delete {name}'s <span className="money-value">{shown}</span> {entryNouns[entry.kind]}?</h3><p>Totals update right away.</p></section> : <><p className="hint">The original stays in the ledger, marked Voided, with a replacement alongside it.</p><label>Replacement amount<input ref={amountInput} className="amount-input" inputMode="decimal" aria-invalid={!!amountError} aria-describedby={amountError ? 'replacement-amount-error' : undefined} value={amount} onChange={event => { setAmount(event.target.value); setAmountError(''); }} required /></label>{amountError && <p id="replacement-amount-error" className="error field-error" role="alert">{amountError}</p>}{payment && <PaymentMethods label="Replacement method" value={method} change={setMethod} />}<label>Entry time<input type="datetime-local" step="1" value={time} onChange={event => setTime(event.target.value)} /></label></>}</div><footer className="form-actions"><ErrorText text={draft.error || error} />{confirmingDelete ? <div className="confirm-actions"><button key="keep-entry" type="button" disabled={busy} onClick={event => { event.preventDefault(); setConfirmingDelete(false); }}>Keep entry</button><button key="confirm-delete" className="danger" type="button" disabled={busy} onClick={event => { event.preventDefault(); void remove(); }}>Confirm delete</button></div> : <><button key="save-correction" type="submit" className="primary wide" disabled={busy}>Save correction</button><button key="request-delete" className="danger wide" type="button" disabled={busy} onClick={event => { event.preventDefault(); setConfirmingDelete(true); }}>Delete entry</button></>}</footer></form>;
}
export function RestoreEntrySheet({ entryId }: { entryId: string }) {
  const { state, mutate, open, notify, online } = useClient();
  const entry = state!.entries.find(row => row.id === entryId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useFormBusy(busy);
  if (!entry) return <p>This entry is no longer available.</p>;
  const name = state!.players.find(row => row.id === entry.player_id)?.display_name ?? 'Player';
  const shown = money(entry.amount_minor, state!.session.currency);
  const deletion = state!.entries.find(row => row.voids_entry_id === entry.id);
  async function restore() {
    if (busy) return;
    setBusy(true); setError('');
    try { await mutate(`/api/sessions/${state!.session.id}/entries/${entryId}/restore`, { op_id: crypto.randomUUID() }); notify(`Restored ${entryNouns[entry!.kind]} · ${name} · ${shown}`); open(null); }
    catch (problem) { setError(problem instanceof Error ? problem.message : 'Could not restore entry'); setBusy(false); }
  }
  return <><p className="correction-summary">{entryLabels[entry.kind]} · {name} · <strong className="money-value">{shown}</strong>{entry.method ? ` · ${methodLabel(entry.method)}` : ''}</p><p className="hint">Deleted{deletion ? ` at ${new Date(deletion.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}. It doesn’t count toward totals.</p><ErrorText text={error} /><button className="primary wide" disabled={busy || !online} onClick={() => { void restore(); }}>{busy ? 'Restoring…' : 'Restore entry'}</button>{!online && <p className="hint">Reconnect to restore.</p>}</>;
}
