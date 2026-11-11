import { useEffect, useState, type FormEvent } from 'react';
import { parseMoney } from '../../domain/money';
import { draftKey, listOutbox } from '../data';
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
  const [busy, setBusy] = useState(false);
  useFormBusy(busy);
  useEffect(() => { void api<typeof suggestions>('/api/suggestions').then(setSuggestions).catch(() => {}); }, []);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy || !draft.ready) return;
    setBusy(true); setError('');
    try {
      const value = draft.value;
      const body: Record<string, unknown> = { op_id: value.op_id, name: value.name, played_on: value.played_on, location: value.location || null, game: value.game || null, big_blind_minor: value.blind ? String(parseMoney(value.blind, value.currency)) : null };
      let result: SessionState;
      if (creating) result = await draft.submit<SessionState>('/api/sessions', { ...body, currency: value.currency });
      else result = await draft.submit<SessionState>(`/api/sessions/${state!.session.id}`, body, 'PATCH');
      created(result); open(null);
    } catch (problem) { setError(problem instanceof Error ? problem.message : 'Could not save session'); setBusy(false); }
  }
  if (!draft.ready) return draft.error ? <ErrorText text={draft.error} /> : <p>Restoring draft…</p>;
  if (draft.submitted) return <DraftRecovery pending={busy} recover={() => draft.reconcile<SessionState>()} recovered={result => { created(result); open(null); }} />;
  return <form onSubmit={submit}><label>Session name<input value={draft.value.name} onChange={event => draft.update({ ...draft.value, name: event.target.value })} required maxLength={100} /></label><label>Session date<input type="date" value={draft.value.played_on} onChange={event => draft.update({ ...draft.value, played_on: event.target.value })} required /></label><label>Currency<select aria-label="Currency" value={draft.value.currency} disabled={!creating} onChange={event => draft.update({ ...draft.value, currency: event.target.value })}>{['USD', 'JPY', 'CAD', 'EUR', 'GBP', 'SGD', 'HKD', 'AUD'].map(currency => <option key={currency}>{currency}</option>)}</select></label><label>Location<input list="past-locations" value={draft.value.location} onChange={event => draft.update({ ...draft.value, location: event.target.value })} /></label><datalist id="past-locations">{suggestions.locations.map(location => <option key={location}>{location}</option>)}</datalist><label>Game<input list="past-games" value={draft.value.game} onChange={event => draft.update({ ...draft.value, game: event.target.value })} /></label><datalist id="past-games">{suggestions.games.map(game => <option key={game}>{game}</option>)}</datalist><label>Big blind<input inputMode="decimal" placeholder="Optional" value={draft.value.blind} onChange={event => draft.update({ ...draft.value, blind: event.target.value })} /></label><ErrorText text={error} /><button className="primary wide" disabled={busy || !draft.ready || (!creating && state!.session.status === 'closed')}>{creating ? 'Create session' : 'Save settings'}</button></form>;
}
export function HistorySheet({ choose }: { choose: (id: string) => void }) {
  const api = useClient().client!.api;
  const [search, setSearch] = useState('');
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [error, setError] = useState('');
  const [before, setBefore] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void api<{ sessions: SessionSummary[]; next: string | null }>(`/api/sessions?q=${encodeURIComponent(search)}`).then(result => { if (active) { setSessions(result.sessions); setBefore(result.next); } }).catch(error => setError(error.message));
    return () => { active = false; };
  }, [search]);
  const months = [...new Set(sessions.map(session => session.played_on.slice(0, 7)))];
  async function more() { const result = await api<{ sessions: SessionSummary[]; next: string | null }>(`/api/sessions?q=${encodeURIComponent(search)}&before=${encodeURIComponent(before!)}`); setSessions(current => [...current, ...result.sessions]); setBefore(result.next); }
  return <><label>Search sessions<input value={search} onChange={event => setSearch(event.target.value)} /></label>{months.map(month => <section key={month}><h3>{new Date(`${month}-01T12:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</h3><ul className="choice-list">{sessions.filter(session => session.played_on.startsWith(month)).map(session => <li key={session.id}><button onClick={() => choose(session.id)}>{sessionLabel(session)}<small>{session.status === 'closed' ? 'Closed' : 'Open'} · {session.currency}</small></button></li>)}</ul></section>)}{!sessions.length && <p>No matching sessions.</p>}{before && <button className="wide" onClick={() => { void more().catch(error => setError(error.message)); }}>Load more sessions</button>}<ErrorText text={error} /></>;
}
export function MenuSheet() {
  const { state, open } = useClient();
  return <div className="menu-list"><button onClick={() => open({ kind: 'settings' })}>Session settings</button><button onClick={() => open({ kind: 'timing' })}>Correct times</button><button onClick={() => open({ kind: 'share' })}>Share session</button>{state!.session.status === 'open' ? <button onClick={() => open({ kind: 'close' })}>Close game</button> : <button onClick={() => open({ kind: 'reopen' })}>Reopen game</button>}</div>;
}
export function CloseSheet() {
  const { banker, state, pending, mutate, open, notify } = useClient();
  const waiting = pending.filter(item => item.session_id === state!.session.id);
  const [acceptedRevision, setAcceptedRevision] = useState<string | null>(null);
  const accepted = acceptedRevision === state!.revision;
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
  return <>{waiting.length > 0 && <p className="warning">{waiting.length} {waiting.length === 1 ? 'entry is' : 'entries are'} not saved yet. Save or discard them before closing. They are excluded from these totals.</p>}{blockers.length ? <><p className="warning">Cash out everyone with entries before closing.</p><ul>{blockers.map(player => <li key={player.id}>{player.display_name} is {player.state === 'playing' ? 'still playing' : 'not cashed out'}.</li>)}</ul></> : discrepancy === '0' ? <p>Everyone has cashed out and the chip totals match. Close as balanced.</p> : <><p>The cash-outs and buy-ins are off by {money(discrepancy ?? '0', state!.session.currency)}. This discrepancy stays in the closed recap.</p><label className="check"><input type="checkbox" checked={accepted} onChange={event => setAcceptedRevision(event.target.checked ? state!.revision : null)} />Accept discrepancy of {money(discrepancy ?? '0', state!.session.currency)}</label></>}<p>Outstanding payments are separate. Bank is owed {money(state!.totals.owed_to_banker_minor, state!.session.currency)} and owes {money(state!.totals.owed_by_banker_minor, state!.session.currency)}.</p><ErrorText text={error} /><button className="primary wide" disabled={busy || waiting.length > 0 || blockers.length > 0 || (discrepancy !== '0' && !accepted)} onClick={() => { void close(); }}>Close session</button></>;
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
  if (draft.submitted) return <DraftRecovery pending={busy} recover={() => draft.reconcile()} recovered={() => open(null)} />;
  return <form onSubmit={event => { event.preventDefault(); if (busy) return; setBusy(true); void draft.submit(`/api/sessions/${state!.session.id}/reopen`, { op_id: draft.value.op_id, reason }, 'POST').then(async () => { open(null); }).catch(problem => { setError(problem.message); setBusy(false); }); }}><p>Reopening removes this session from cumulative results until you close it again. The timer's end stays recorded; correct timing if play resumes.</p><label>Reason<input value={reason} onChange={event => setReason(event.target.value)} required /></label><ErrorText text={error} /><button className="primary wide" disabled={busy}>Reopen session</button></form>;
}
export function TimingSheet() {
  const { banker, state, open } = useClient();
  function local(value: string | null) { if (!value) return ''; const date = new Date(value); const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60000); return shifted.toISOString().slice(0, 19); }
  const draft = useDraft(draftKey(banker!.id, state!.session.id, 'timing'), { op_id: crypto.randomUUID(), start: local(state!.session.started_at), end: local(state!.session.ended_at) });
  const { start, end } = draft.value;
  const setStart = (start: string) => draft.update({ ...draft.value, start });
  const setEnd = (end: string) => draft.update({ ...draft.value, end });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useFormBusy(busy);
  if (!draft.ready) return draft.error ? <ErrorText text={draft.error} /> : <p>Restoring draft…</p>;
  if (draft.submitted) return <DraftRecovery pending={busy} recover={() => draft.reconcile()} recovered={() => open(null)} />;
  return <><form onSubmit={event => { event.preventDefault(); if (busy) return; setBusy(true); void draft.submit(`/api/sessions/${state!.session.id}/timing`, { op_id: draft.value.op_id, started_at: new Date(start).toISOString(), ended_at: end ? new Date(end).toISOString() : null }, 'PATCH').then(async () => { open(null); }).catch(problem => { setError(problem.message); setBusy(false); }); }}><label>Started at<input type="datetime-local" step="1" value={start} onChange={event => setStart(event.target.value)} required /></label><label>Ended at<input type="datetime-local" step="1" value={end} onChange={event => setEnd(event.target.value)} /></label><p className="hint">Leave Ended at blank to keep timing. Corrections must include the recorded entry times.</p><ErrorText text={error} /><button className="primary wide" disabled={busy || state!.session.status === 'closed'}>Save timing</button>{state!.session.status === 'closed' && <p>Reopen this game before correcting its timing.</p>}</form><h3>Timing history</h3><ul className="event-list">{state!.events.filter(event => event.kind === 'timer_started' || event.kind === 'timing_corrected' || event.kind === 'closed').map(event => <li key={event.id}><strong>{event.kind === 'timer_started' ? 'Timer started' : event.kind === 'closed' ? 'Timer stopped at close' : 'Timing corrected'}</strong><small>{new Date(event.created_at).toLocaleString()}</small><TimingEvent detail={event.detail} /></li>)}</ul></>;
}
export function ShareSheet() {
  const { state, mutate } = useClient();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  useFormBusy(busy);
  const link = state!.session.share_token ? `${location.origin}/v/${state!.session.share_token}` : '';
  async function action(action: string) { setBusy(true); setError(''); try { await mutate(`/api/sessions/${state!.session.id}/share`, { op_id: crypto.randomUUID(), action }); } catch (problem) { setError(problem instanceof Error ? problem.message : 'Could not change sharing'); } finally { setBusy(false); } }
  return <><p>Anyone with this private link can view this game. It does not expose your account or other sessions.</p>{link ? <><label>Viewer link<input readOnly value={link} /></label><button className="primary wide" onClick={() => { void navigator.clipboard.writeText(link).then(() => setNotice('Link copied')).catch(() => setNotice('Select the viewer link and copy it.')); }}>Copy link</button><button className="wide" disabled={busy || state!.session.status === 'closed'} onClick={() => { void action('rotate'); }}>Rotate link</button><p className="hint">Rotating makes the old link stop working.</p><button className="danger wide" disabled={busy || state!.session.status === 'closed'} onClick={() => { void action('disable'); }}>Disable sharing</button></> : <button className="primary wide" disabled={busy || state!.session.status === 'closed'} onClick={() => { void action('enable'); }}>Enable sharing</button>}{state!.session.status === 'closed' && <p>Reopen the session to change sharing.</p>}{notice && <p role="status">{notice}</p>}<ErrorText text={error} /></>;
}

function TimingEvent({ detail }: { detail: Record<string, unknown> }) {
  const old = (detail.old ?? {}) as { started_at?: string | null; ended_at?: string | null };
  const next = (detail.new ?? {}) as { started_at?: string | null; ended_at?: string | null };
  const readable = (value: string | null | undefined) => value ? new Date(value).toLocaleString() : 'Not recorded';
  return <>{next.started_at !== undefined && <p className="hint">Start {readable(next.started_at)}. Previously {readable(old.started_at)}.</p>}{next.ended_at !== undefined && <p className="hint">End {readable(next.ended_at)}. Previously {readable(old.ended_at)}.</p>}</>;
}
