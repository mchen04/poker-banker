import { useEffect, useRef, useState, type FormEvent } from 'react';
import { parseMoney } from '../../domain/money';
import { draftKey, enqueue, listDeletedSessions, listOutbox, listSnapshots, type DeletedSession } from '../data';
import type { SessionState } from '../../domain/session';
import { decimal, DraftRecovery, ErrorText, money, sessionLabel, useClient, useDraft, useFormBusy } from './common';

export type SessionSummary = { id: string; name: string; played_on: string; currency: string; status: string; revision: string };
export function SessionForm({ creating, created }: { creating: boolean; created: (state: SessionState) => void }) {
  const { banker, state, open, client } = useClient();
  const api = client!.api;
  const initial = { op_id: crypto.randomUUID(), name: creating ? '' : state!.session.name, played_on: creating ? new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10) : state!.session.played_on, currency: creating ? 'USD' : state!.session.currency, location: creating ? '' : state!.session.location ?? '', game: creating ? '' : state!.session.game ?? '', blind: creating ? '' : state!.session.big_blind_minor ? decimal(state!.session.big_blind_minor, state!.session.currency) : '' };
  const draft = useDraft(draftKey(banker!.id, creating ? 'new' : state!.session.id, creating ? 'new-session' : 'settings'), initial);
  const [suggestions, setSuggestions] = useState<{ locations: string[]; games: string[] }>({ locations: [], games: [] });
  const [error, setError] = useState('');
  const [blindError, setBlindError] = useState('');
  const blindInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  useFormBusy(busy);
  useEffect(() => { void api<typeof suggestions>('/api/suggestions').then(setSuggestions).catch(() => {}); }, []);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy || !draft.ready) return;
    setBusy(true); setError(''); setBlindError('');
    let blind: string | null = null;
    try {
      if (draft.value.blind) {
        const amount = parseMoney(draft.value.blind, draft.value.currency);
        if (amount === 0n) throw new Error('Enter a big blind above zero.');
        blind = String(amount);
      }
    } catch (problem) {
      setBlindError(problem instanceof Error ? problem.message : 'Check the big blind.');
      setBusy(false); blindInput.current?.focus(); return;
    }
    try {
      const value = draft.value;
      const body: Record<string, unknown> = { op_id: value.op_id, name: value.name, played_on: value.played_on, location: value.location || null, game: value.game || null, big_blind_minor: blind };
      let result: SessionState;
      if (creating) result = await draft.submit<SessionState>('/api/sessions', { ...body, currency: value.currency });
      else result = await draft.submit<SessionState>(`/api/sessions/${state!.session.id}`, body, 'PATCH');
      created(result); open(null);
    } catch (problem) { setError(problem instanceof Error ? problem.message : 'Could not save session'); setBusy(false); }
  }
  if (!draft.ready) return draft.error ? <ErrorText text={draft.error} /> : <p>Restoring draft…</p>;
  if (draft.submitted) return <DraftRecovery pending={busy} notice={draft.error} recover={() => draft.reconcile<SessionState>()} recovered={result => { created(result); open(null); }} />;
  return <form className="sheet-form" onSubmit={submit}><div className="form-body"><label>Session name<input value={draft.value.name} onChange={event => draft.update({ ...draft.value, name: event.target.value })} required maxLength={100} /></label><label>Session date<input type="date" value={draft.value.played_on} onChange={event => draft.update({ ...draft.value, played_on: event.target.value })} required /></label><label>Currency<select aria-label="Currency" value={draft.value.currency} disabled={!creating} onChange={event => draft.update({ ...draft.value, currency: event.target.value })}>{['USD', 'JPY', 'CAD', 'EUR', 'GBP', 'SGD', 'HKD', 'AUD'].map(currency => <option key={currency}>{currency}</option>)}</select>{!creating && <small>Currency is fixed after creation.</small>}</label><label>Location<input list="past-locations" value={draft.value.location} onChange={event => draft.update({ ...draft.value, location: event.target.value })} /></label><datalist id="past-locations">{suggestions.locations.map(location => <option key={location}>{location}</option>)}</datalist><label>Game<input list="past-games" value={draft.value.game} onChange={event => draft.update({ ...draft.value, game: event.target.value })} /></label><datalist id="past-games">{suggestions.games.map(game => <option key={game}>{game}</option>)}</datalist><label>Big blind<input ref={blindInput} aria-invalid={!!blindError} aria-describedby={blindError ? "big-blind-error" : undefined} inputMode="decimal" placeholder="Optional" value={draft.value.blind} onChange={event => { setBlindError(''); draft.update({ ...draft.value, blind: event.target.value }); }} /></label><ErrorText id="big-blind-error" text={blindError} /></div><footer className="form-actions"><ErrorText text={draft.error || error} /><button className="primary wide" disabled={busy || !draft.ready || (!creating && state!.session.status === 'closed')}>{creating ? 'Create session' : 'Save settings'}</button></footer></form>;
}
export function DeletedSessions({ choose }: { choose: (id: string | null, notice?: string) => void }) {
  const { client, online, update } = useClient();
  const [deleted, setDeleted] = useState<DeletedSession[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const deletedGeneration = useRef(0);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [error, setError] = useState('');
  useFormBusy(restoring !== null);
  useEffect(() => {
    let active = true;
    if (!online || !client) return;
    const generation = ++deletedGeneration.current;
    setError('');
    void listDeletedSessions(client).then(result => { if (active && client.isCurrent() && generation === deletedGeneration.current) { setDeleted(result.sessions); setNext(result.next); } }).catch(() => {});
    return () => { active = false; };
  }, [online, client]);
  async function more() {
    if (!client || !next || loadingMore) return;
    const generation = deletedGeneration.current;
    setLoadingMore(true); setError('');
    try {
      const result = await listDeletedSessions(client, next);
      if (!client.isCurrent() || generation !== deletedGeneration.current) return;
      setDeleted(current => [...current, ...result.sessions]);
      setNext(result.next);
    } catch (problem) { if (client.isCurrent() && generation === deletedGeneration.current) setError(problem instanceof Error ? problem.message : 'Could not load deleted sessions'); }
    finally { if (client.isCurrent()) setLoadingMore(false); }
  }
  async function restore(session: DeletedSession) {
    if (restoring) return;
    deletedGeneration.current++;
    setRestoring(session.id); setError('');
    try {
      const result = await client!.api<SessionState>(`/api/sessions/${session.id}/restore`, 'POST', { op_id: crypto.randomUUID() });
      if (!client!.isCurrent()) return;
      setDeleted(current => current.filter(item => item.id !== session.id));
      update(result); choose(session.id, `Restored ${session.name}`);
    } catch (problem) { if (client!.isCurrent()) { setError(problem instanceof Error ? problem.message : 'Could not restore session'); setRestoring(null); } }
  }
  if (!deleted.length) return null;
  return <details className="recover-list" data-testid="recently-deleted-sessions"><summary>{next ? 'Recently deleted' : `Recently deleted (${deleted.length})`}</summary><ul>{deleted.map(session => <li key={session.id}><span className="recover-name" title={session.name}>{sessionLabel(session)}</span><button type="button" aria-label={`Restore ${session.name}`} disabled={restoring !== null || !online} onClick={() => { void restore(session); }}>{restoring === session.id ? 'Restoring…' : 'Restore'}</button></li>)}</ul>{next && <button type="button" className="text-button" disabled={loadingMore || !online} onClick={() => { void more(); }}>{loadingMore ? 'Loading…' : 'Load more deleted sessions'}</button>}<ErrorText text={error} /></details>;
}
export function HistorySheet({ choose }: { choose: (id: string | null, notice?: string) => void }) {
  const { banker, client, open, state, online } = useClient();
  const api = client!.api;
  const [search, setSearch] = useState('');
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [openSessions, setOpenSessions] = useState<SessionSummary[]>([]);
  const [cache, setCache] = useState<{ bankerId: string; sessions: SessionSummary[] } | null>(null);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [openLoaded, setOpenLoaded] = useState(false);
  const [error, setError] = useState('');
  const [before, setBefore] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const sessionGeneration = useRef(0);
  useEffect(() => {
    let active = true;
    void listSnapshots(banker!.id).then(saved => {
      if (active && client!.isCurrent()) setCache({ bankerId: banker!.id, sessions: saved.map(value => ({ ...value.session, revision: value.revision })).sort((left, right) => right.played_on.localeCompare(left.played_on) || right.id.localeCompare(left.id)) });
    }).catch(problem => { if (active && client!.isCurrent()) setError(problem.message); });
    return () => { active = false; };
  }, [banker!.id, client, online]);
  useEffect(() => {
    let active = true;
    const generation = ++sessionGeneration.current;
    setHistoryLoaded(false); setBefore(null); setError(''); setLoadingMore(false);
    if (!online) return;
    void api<{ sessions: SessionSummary[]; next: string | null }>(`/api/sessions?q=${encodeURIComponent(search)}`).then(result => { if (active && client!.isCurrent() && generation === sessionGeneration.current) { setSessions(result.sessions); setBefore(result.next); setHistoryLoaded(true); } }).catch(error => { if (active && client!.isCurrent() && generation === sessionGeneration.current) setError(error.message); });
    return () => { active = false; };
  }, [search, online, client]);
  useEffect(() => {
    let active = true;
    setOpenLoaded(false);
    if (!online) return;
    async function loadOpen() {
      let cursor: string | null = null;
      const all: SessionSummary[] = [];
      do {
        const result: { sessions: SessionSummary[]; next: string | null } = await api(`/api/sessions?status=open${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`);
        if (!active || !client!.isCurrent()) return;
        all.push(...result.sessions); setOpenSessions([...all]); cursor = result.next;
      } while (cursor);
      setOpenLoaded(true);
    }
    void loadOpen().catch(problem => { if (active && client!.isCurrent()) setError(problem.message); });
    return () => { active = false; };
  }, [online, client]);
  const known = new Map<string, SessionSummary>();
  const cached = (cache?.bankerId === banker!.id ? cache.sessions : []).filter(session => !online || (session.status === 'open' ? !openLoaded : !historyLoaded));
  for (const session of [...cached, ...(online ? [...sessions, ...openSessions] : []), ...(state ? [{ ...state.session, revision: state.revision }] : [])]) {
    const prior = known.get(session.id);
    if (!prior || BigInt(session.revision) >= BigInt(prior.revision)) known.set(session.id, session);
  }
  const current = state?.session;
  const choices = [...known.values()].filter(session => session.name.toLowerCase().includes(search.toLowerCase()));
  const pinned = choices.filter(session => session.id === current?.id || session.status === 'open').sort((left, right) => Number(right.id === current?.id) - Number(left.id === current?.id));
  const historical = choices.filter(session => !pinned.some(item => item.id === session.id));
  const months = [...new Set(historical.map(session => session.played_on.slice(0, 7)))];
  async function more() {
    if (!before || loadingMore) return;
    const generation = sessionGeneration.current;
    setLoadingMore(true); setError('');
    try {
      const result = await api<{ sessions: SessionSummary[]; next: string | null }>(`/api/sessions?q=${encodeURIComponent(search)}&before=${encodeURIComponent(before)}`);
      if (!client!.isCurrent() || generation !== sessionGeneration.current) return;
      setSessions(current => [...current, ...result.sessions]);
      setBefore(result.next);
    } catch (problem) { if (client!.isCurrent() && generation === sessionGeneration.current) setError(problem instanceof Error ? problem.message : 'Could not load more sessions'); }
    finally { setLoadingMore(false); }
  }
  function choice(session: SessionSummary) {
    return <li key={session.id}><button data-testid={`session-tab-${session.id}`} aria-current={state?.session.id === session.id ? 'true' : undefined} onClick={() => choose(session.id)}><span>{sessionLabel(session)}</span><small>{state?.session.id === session.id ? 'Current · ' : ''}{session.status === 'closed' ? 'Closed' : 'Open'} · {session.currency}</small></button></li>;
  }
  return <><button className="primary wide" onClick={() => open({ kind: 'new' })}>New session</button>{!online && <p className="hint" role="status">Offline · saved sessions on this device</p>}<label>Search sessions<input data-autofocus="false" value={search} onChange={event => setSearch(event.target.value)} /></label>{pinned.length > 0 && <section aria-label="Current and open sessions"><h3>Current and open sessions</h3><ul className="choice-list">{pinned.map(choice)}</ul></section>}{months.map(month => <section key={month}><h3>{new Date(`${month}-01T12:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</h3><ul className="choice-list">{historical.filter(session => session.played_on.startsWith(month)).map(choice)}</ul></section>)}{!choices.length && <p>No matching sessions.</p>}{online && before && <button className="wide" disabled={loadingMore} onClick={() => { setError(''); void more(); }}>Load more sessions</button>}<ErrorText text={error} /><DeletedSessions choose={choose} /></>;

}
export function MenuSheet() {
  const { banker, state, pending, open, notify } = useClient();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const panel = useRef<HTMLElement>(null);
  useFormBusy(busy);
  useEffect(() => { if (confirming) panel.current?.focus(); }, [confirming]);
  const session = state!.session;
  const path = `/api/sessions/${session.id}/delete`;
  async function remove() {
    if (busy) return;
    setBusy(true); setError('');
    try {
      await enqueue({ banker_id: banker!.id, session_id: session.id, path, body: { op_id: crypto.randomUUID() }, label: `Delete session · ${session.name}` });
      notify('Not saved yet'); open(null);
    } catch (problem) { setError(problem instanceof Error ? problem.message : 'Could not delete session'); setBusy(false); }
  }
  if (confirming) return <section className="confirmation-panel" role="alertdialog" aria-label="Delete session" tabIndex={-1} ref={panel}><h3>Delete {session.name}?</h3><p>It disappears from history and reports, and its viewer link stops working.</p>{(state!.totals.owed_to_banker_minor !== '0' || state!.totals.owed_by_banker_minor !== '0') && <p className="warning">Not settled yet: {[state!.totals.owed_to_banker_minor !== '0' ? `${money(state!.totals.owed_to_banker_minor, session.currency)} owed to you` : '', state!.totals.owed_by_banker_minor !== '0' ? `${money(state!.totals.owed_by_banker_minor, session.currency)} you owe` : ''].filter(Boolean).join(', ')}. These amounts leave player balances until you restore the session.</p>}<ErrorText text={error} /><div className="confirm-actions"><button type="button" disabled={busy} onClick={() => setConfirming(false)}>Keep session</button><button type="button" className="danger" disabled={busy} onClick={() => { void remove(); }}>Confirm delete</button></div></section>;
  return <><div className="menu-list"><button onClick={() => open({ kind: 'settings' })}>Session settings</button><button onClick={() => open({ kind: 'timing' })}>Correct times</button><button onClick={() => open({ kind: 'share' })}>Share session</button>{session.status === 'open' ? <button data-testid="session-close" onClick={() => open({ kind: 'close' })}>Close session</button> : <button onClick={() => open({ kind: 'reopen' })}>Reopen session</button>}</div><div className="menu-list menu-danger">{pending.some(item => item.path === path) ? <p className="hint">Delete not saved yet</p> : <button className="danger" onClick={() => setConfirming(true)}>Delete session</button>}</div></>;
}
export function CloseSheet() {
  const { banker, state, pending, mutate, open, notify } = useClient();
  const waiting = pending.filter(item => item.session_id === state!.session.id);
  const [acceptedRevision, setAcceptedRevision] = useState<string | null>(null);
  const accepted = acceptedRevision === state!.revision;
  const [bar, setBar] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    const scroller = bar?.closest<HTMLElement>('.sheet-fields');
    if (!bar || !scroller || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => { scroller.style.scrollPaddingBottom = `${bar.offsetHeight + 16}px`; });
    observer.observe(bar);
    return () => { observer.disconnect(); scroller.style.scrollPaddingBottom = ''; };
  }, [bar]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useFormBusy(busy);
  const blockers = state!.players.filter(player => player.state === 'playing' || (player.state === 'seated' && (player.payment_in_minor !== '0' || player.payment_out_minor !== '0' || player.expense_minor !== '0')));
  const discrepancy = state!.totals.discrepancy_minor;
  async function close() {
    setBusy(true); setError('');
    try {
      if ((await listOutbox(banker!.id)).some(item => item.session_id === state!.session.id)) throw new Error('Save or discard the entries marked Not saved yet before closing.');
      await mutate(`/api/sessions/${state!.session.id}/close`, { op_id: crypto.randomUUID(), expected_revision: state!.revision, ...(discrepancy && discrepancy !== '0' ? { accept_discrepancy_minor: discrepancy } : {}) }); notify('Session closed'); open(null); }
    catch (problem) { setError(problem instanceof Error ? problem.message : 'Could not close session'); setBusy(false); }
  }
  const reason = waiting.length > 0 ? 'Save or discard unsaved entries first' : blockers.length > 0 ? `Cash out ${blockers.length} ${blockers.length === 1 ? 'player' : 'players'} first` : discrepancy !== '0' && !accepted ? 'Accept the discrepancy first' : '';
  return <>{waiting.length > 0 && <p className="warning">{waiting.length} {waiting.length === 1 ? 'entry is' : 'entries are'} not saved yet. Save or discard them before closing. They are excluded from these totals.</p>}{blockers.length ? <><p className="warning">Cash out everyone with entries before closing.</p><ul className="close-blockers">{blockers.map(player => <li key={player.id}><button className="close-blocker" aria-label={`Cash out ${player.display_name}`} onClick={() => open({ kind: 'cash_out', player: player.id })}><span><strong>{player.display_name}</strong><small>{player.state === 'playing' ? 'Still playing' : 'Not cashed out'}</small></span><span className="close-blocker-action">Cash out</span></button></li>)}</ul></> : discrepancy === '0' ? <p>Everyone has cashed out and the chip totals match. Close as balanced.</p> : <><p>Chips returned and chips bought differ by <span className="money-value">{money(discrepancy ?? '0', state!.session.currency)}</span>. This chip discrepancy stays in the closed recap. Payments do not change it.</p><label className="check"><input type="checkbox" checked={accepted} onChange={event => setAcceptedRevision(event.target.checked ? state!.revision : null)} />Accept discrepancy of <span className="money-value">{money(discrepancy ?? '0', state!.session.currency)}</span></label></>}{(BigInt(state!.totals.owed_to_banker_minor) !== 0n || BigInt(state!.totals.owed_by_banker_minor) !== 0n) && <p className="hint">Outstanding payments stay open after closing: {[BigInt(state!.totals.owed_to_banker_minor) !== 0n && `players owe ${money(state!.totals.owed_to_banker_minor, state!.session.currency)}`, BigInt(state!.totals.owed_by_banker_minor) !== 0n && `bank owes ${money(state!.totals.owed_by_banker_minor, state!.session.currency)}`].filter(Boolean).join(', ')}.</p>}<div className="sticky-action" ref={setBar}><ErrorText text={error} />{reason && <p className="hint close-reason" id="close-reason">{reason}</p>}<button className="primary wide" aria-describedby={reason ? 'close-reason' : undefined} disabled={busy || waiting.length > 0 || blockers.length > 0 || (discrepancy !== '0' && !accepted)} onClick={() => { void close(); }}>Close session</button></div></>;
}
export function ReopenSheet() {
  const { banker, state, open } = useClient();
  const draft = useDraft(draftKey(banker!.id, state!.session.id, 'reopen'), { op_id: crypto.randomUUID(), reason: '' });
  const reason = draft.value.reason;
  const setReason = (reason: string) => draft.update({ ...draft.value, reason });
  const [busy, setBusy] = useState(false);
  useFormBusy(busy);
  const [error, setError] = useState('');
  if (!draft.ready) return draft.error ? <ErrorText text={draft.error} /> : <p>Restoring draft…</p>;
  if (draft.submitted) return <DraftRecovery pending={busy} notice={draft.error} recover={() => draft.reconcile()} recovered={() => open(null)} />;
  return <form className="sheet-form" onSubmit={event => { event.preventDefault(); if (busy) return; setBusy(true); void draft.submit(`/api/sessions/${state!.session.id}/reopen`, { op_id: draft.value.op_id, reason }, 'POST').then(async () => { open(null); }).catch(problem => { setError(problem.message); setBusy(false); }); }}><div className="form-body"><p>Reopening removes this session from cumulative results until you close it again. The timer's end stays recorded; correct timing if play resumes.</p><label>Reason<input value={reason} onChange={event => setReason(event.target.value)} required /></label><ErrorText text={draft.error || error} /></div><footer className="form-actions"><button className="primary wide" disabled={busy}>Reopen session</button></footer></form>;
}
export function TimingSheet() {
  const { banker, state, open } = useClient();
  function local(value: string | null) { if (!value) return ''; const date = new Date(value); const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60000); return shifted.toISOString().slice(0, 19); }
  const draft = useDraft(draftKey(banker!.id, state!.session.id, 'timing'), { op_id: crypto.randomUUID(), start: local(state!.session.started_at), end: local(state!.session.ended_at) });
  const { start, end } = draft.value;
  const setStart = (start: string) => draft.update({ ...draft.value, start });
  const setEnd = (end: string) => draft.update({ ...draft.value, end });
  const [error, setError] = useState('');
  const [timeError, setTimeError] = useState('');
  const endInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  useFormBusy(busy);
  function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return;
    setError(''); setTimeError('');
    const started = new Date(start), ended = end ? new Date(end) : null;
    if (Number.isNaN(started.getTime()) || (ended && (Number.isNaN(ended.getTime()) || ended < started))) {
      setTimeError('End must be at or after a valid start. Correct these times.'); endInput.current?.focus(); return;
    }
    setBusy(true);
    void draft.submit(`/api/sessions/${state!.session.id}/timing`, { op_id: draft.value.op_id, started_at: started.toISOString(), ended_at: ended?.toISOString() ?? null }, 'PATCH').then(() => open(null)).catch(problem => { setError(problem.message); setBusy(false); });
  }
  if (!draft.ready) return draft.error ? <ErrorText text={draft.error} /> : <p>Restoring draft…</p>;
  if (draft.submitted) return <DraftRecovery pending={busy} notice={draft.error} recover={() => draft.reconcile()} recovered={() => open(null)} />;
  return <form className="sheet-form" onSubmit={submit}><div className="form-body"><label>Started at<input type="datetime-local" step="1" value={start} onChange={event => setStart(event.target.value)} required /></label><label>Ended at<input ref={endInput} aria-invalid={!!timeError} aria-describedby={timeError ? "timing-end-error" : undefined} type="datetime-local" step="1" value={end} onChange={event => { setTimeError(''); setEnd(event.target.value); }} /></label><ErrorText id="timing-end-error" text={timeError} /><p className="hint">Leave Ended at blank to keep timing. Corrections must include the recorded entry times.</p>{state!.session.status === 'closed' && <p>Reopen this session before correcting its timing.</p>}<h3>Timing history</h3><ul className="event-list">{state!.events.filter(event => event.kind === 'timer_started' || event.kind === 'timing_corrected' || event.kind === 'closed').map(event => <li key={event.id}><strong>{event.kind === 'timer_started' ? 'Timer started' : event.kind === 'closed' ? 'Timer stopped at close' : 'Timing corrected'}</strong><small>{new Date(event.created_at).toLocaleString()}</small><TimingEvent detail={event.detail} /></li>)}</ul></div><footer className="form-actions"><ErrorText text={draft.error || error} /><button className="primary wide" disabled={busy || state!.session.status === 'closed'}>Save timing</button></footer></form>;
}
export function ShareSheet() {
  const { state, mutate } = useClient();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<'rotate' | 'disable' | null>(null);
  const confirmPanel = useRef<HTMLElement>(null);
  useFormBusy(busy);
  const token = state!.session.share_token;
  const link = token ? `${location.origin}/v/${token}` : '';
  useEffect(() => { setNotice(''); }, [token]);
  useEffect(() => { if (confirmation) confirmPanel.current?.focus(); }, [confirmation]);
  async function action(action: string) { setBusy(true); setError(''); try { await mutate(`/api/sessions/${state!.session.id}/share`, { op_id: crypto.randomUUID(), action }); setConfirmation(null); } catch (problem) { setError(problem instanceof Error ? problem.message : 'Could not change sharing'); } finally { setBusy(false); } }
  return <><p>Anyone with this private link can view this session. It does not expose your account or other sessions.</p>{link ? <><label>Viewer link<input readOnly value={link} /></label>{confirmation ? <section className="confirmation-panel" role="alertdialog" aria-label={confirmation === 'rotate' ? 'Rotate viewer link' : 'Disable viewer link'} tabIndex={-1} ref={confirmPanel}><h3>{confirmation === 'rotate' ? 'Replace this viewer link?' : 'Turn off viewer access?'}</h3><p>{confirmation === 'rotate' ? 'Everyone using the old link will lose access. Share the new link to let them view this session again.' : 'Everyone using this link will lose access to this session.'}</p><button className="wide" disabled={busy} onClick={() => setConfirmation(null)}>{confirmation === 'rotate' ? 'Keep link' : 'Keep sharing'}</button><button className="danger wide" disabled={busy || state!.session.status === 'closed'} onClick={() => { void action(confirmation); }}>{confirmation === 'rotate' ? 'Confirm rotate' : 'Confirm disable'}</button></section> : <><button className="primary wide" onClick={() => { void navigator.clipboard.writeText(link).then(() => setNotice('Link copied')).catch(() => setNotice('Select the viewer link and copy it.')); }}>Copy link</button><button className="wide" disabled={busy || state!.session.status === 'closed'} onClick={() => { setNotice(''); setConfirmation('rotate'); }}>Rotate link</button><p className="hint">Rotating makes the old link stop working.</p><button className="danger wide" disabled={busy || state!.session.status === 'closed'} onClick={() => { setNotice(''); setConfirmation('disable'); }}>Disable sharing</button></>}</> : <button className="primary wide" disabled={busy || state!.session.status === 'closed'} onClick={() => { void action('enable'); }}>Enable sharing</button>}{state!.session.status === 'closed' && <p>Reopen the session to change sharing.</p>}{notice && <p role="status">{notice}</p>}<ErrorText text={error} /></>;
}

function TimingEvent({ detail }: { detail: Record<string, unknown> }) {
  const old = (detail.old ?? {}) as { started_at?: string | null; ended_at?: string | null };
  const next = (detail.new ?? {}) as { started_at?: string | null; ended_at?: string | null };
  const readable = (value: string | null | undefined) => value ? new Date(value).toLocaleString() : 'Not recorded';
  return <>{next.started_at !== undefined && <p className="hint">Start {readable(next.started_at)}. Previously {readable(old.started_at)}.</p>}{next.ended_at !== undefined && <p className="hint">End {readable(next.ended_at)}. Previously {readable(old.ended_at)}.</p>}</>;
}
