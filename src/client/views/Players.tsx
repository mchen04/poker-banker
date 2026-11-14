import { useEffect, useRef, useState } from 'react';
import type { playerReport, ReportGrouping, ReportFilters, Metric, SquareRoot } from '../../domain/report';
import type { Rational } from '../../domain/rational';
import { formatRational, formatSquareRoot as formatSquareRootForReport } from '../../domain/rational';
import type { PlayerState, SessionSettings } from '../../domain/session';
import { draftKey, listDeletedPlayers, type DeletedPlayer } from '../data';
import { useDebouncedSearch } from '../search';
import { currencyDecimal, duration, DraftRecovery, ErrorText, money, resultMoney, resultCurrencyDecimal, resultNumber, sessionLabel, Sheet, useClient, useDraft, useFormBusy } from './common';
import { ChevronLeftIcon, ChevronRightIcon, FitText, RowsSkeleton, TrashIcon } from './ui';

type CurrencyResult = { currency: string; result_minor: string };
type Outstanding = { currency: string; owed_to_banker_minor: string; owed_by_banker_minor: string };
type Roster = { id: string; display_name: string; cumulative: CurrencyResult[]; outstanding: Outstanding[] };
type History = { player: { id: string; display_name: string }; cumulative: CurrencyResult[]; outstanding: Outstanding[]; sessions: { session: SessionSettings; player: PlayerState }[] };
type Report = ReturnType<typeof playerReport>;
export function PlayersScreen({ chooseSession, dialogChange }: { chooseSession: (id: string) => void; dialogChange: (open: boolean) => void }) {
  const { notify, client, offerUndo, online } = useClient();
  const api = client!.api;
  const [refresh, setRefresh] = useState(0);
  const [deleted, setDeleted] = useState<DeletedPlayer[]>([]);
  const [deletedNext, setDeletedNext] = useState<string | null>(null);
  const [loadingMoreDeleted, setLoadingMoreDeleted] = useState(false);
  const deletedGeneration = useRef(0);
  const [restoring, setRestoring] = useState<string | null>(null);
  useFormBusy(restoring !== null);
  useEffect(() => {
    const changed = () => setRefresh(value => value + 1);
    window.addEventListener('pb-roster', changed);
    return () => window.removeEventListener('pb-roster', changed);
  }, []);

  async function restore(player: { id: string; display_name: string }) {
    if (restoring) return;
    deletedGeneration.current++;
    setRestoring(player.id); setError('');
    try { await api(`/api/players/${player.id}/restore`, 'POST', { op_id: crypto.randomUUID() }); setRefresh(value => value + 1); notify(`Restored ${player.display_name}`); }
    catch (problem) { setError(problem instanceof Error ? problem.message : 'Could not restore player'); }
    finally { setRestoring(null); }
  }
  const [players, setPlayers] = useState<Roster[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [search, setSearch] = useState('');
  const settledSearch = useDebouncedSearch(search);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedName, setSelectedName] = useState('');
  const [history, setHistory] = useState<History | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [group, setGroup] = useState<ReportGrouping>('overall');
  const [filters, setFilters] = useState<ReportFilters>({});
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState<'rename' | 'filter' | 'delete' | null>(null);
  const searchField = useRef<HTMLInputElement>(null);
  const [returnToSearch, setReturnToSearch] = useState(false);
  async function moreDeleted() {
    if (!client || !deletedNext || loadingMoreDeleted) return;
    const generation = deletedGeneration.current;
    setLoadingMoreDeleted(true);
    try {
      const result = await listDeletedPlayers(client, deletedNext);
      if (!client.isCurrent() || generation !== deletedGeneration.current) return;
      setDeleted(current => [...current, ...result.players]);
      setDeletedNext(result.next);
    } catch (problem) { setError(problem instanceof Error ? problem.message : 'Could not load deleted players'); }
    finally { setLoadingMoreDeleted(false); }
  }
  useEffect(() => { if (!selected && returnToSearch) { searchField.current?.focus(); setReturnToSearch(false); } }, [selected, returnToSearch]);
  function showDialog(next: 'rename' | 'filter' | 'delete' | null) { setDialog(next); dialogChange(next !== null); }
  useEffect(() => () => dialogChange(false), [dialogChange]);
  useEffect(() => {
    let active = true;
    void api<{ players: Roster[] }>(`/api/players?q=${encodeURIComponent(settledSearch)}`).then(result => { if (active) { setPlayers(result.players); setLoaded(true); } }).catch(problem => setError(problem.message));
    return () => { active = false; };
  }, [settledSearch, refresh]);
  useEffect(() => {
    let active = true;
    if (!online || !loaded) return;
    const generation = ++deletedGeneration.current;
    void listDeletedPlayers(client!).then(result => { if (active && generation === deletedGeneration.current) { setDeleted(result.players); setDeletedNext(result.next); } }).catch(() => {});
    return () => { active = false; };
  }, [refresh, online, loaded]);
  useEffect(() => {
    if (!selected) return;
    let active = true;
    const query = new URLSearchParams({ ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== undefined && value !== '')), group });
    void Promise.all([api<History>(`/api/players/${selected}`), api<Report>(`/api/players/${selected}/report?${query}`)])
      .then(([details, values]) => { if (active) { setHistory(details); setReport(values); } }).catch(problem => setError(problem.message));
    return () => { active = false; };
  }, [selected, group, filters, refresh]);
  if (!selected) return <><header className="page-heading"><h1>Players</h1></header><input ref={searchField} className="search-field" type="search" aria-label="Find a player" placeholder="Find a player" value={search} onChange={event => setSearch(event.target.value)} /><ErrorText text={error} />{!loaded && !error ? <RowsSkeleton /> : players.length > 0 && <ul className="roster-list">{players.map(player => {
    const debts = player.outstanding.filter(value => value.owed_to_banker_minor !== '0' || value.owed_by_banker_minor !== '0');
    return <li key={player.id}><button className="roster-row" data-testid={`roster-player-${player.id}`} onClick={() => { setSelected(player.id); setSelectedName(player.display_name); setHistory(null); setReport(null); }}><span className="roster-name"><strong title={player.display_name}>{player.display_name}</strong>{debts.map(value => <small className="outstanding-balances" key={value.currency}><OutstandingBalances value={value} /></small>)}</span><span className="roster-results">{player.cumulative.map(value => <FitText key={value.currency} className={`money-value tone-${BigInt(value.result_minor) > 0n ? 'up' : BigInt(value.result_minor) < 0n ? 'down' : 'even'}`} text={player.cumulative.length > 1 ? `${resultMoney(value.result_minor, value.currency)} ${value.currency}` : resultMoney(value.result_minor, value.currency)} />)}</span><ChevronRightIcon /></button></li>;
  })}</ul>}{loaded && !players.length && <div className="empty-row"><span>{search ? 'No matching players' : 'Players you add at the table appear here'}</span></div>}{deleted.length > 0 && <details className="recover-list" data-testid="recently-deleted-players"><summary>{deletedNext ? 'Recently deleted' : `Recently deleted (${deleted.length})`}</summary><ul>{deleted.map(player => <li key={player.id}><span className="recover-name" title={player.display_name}>{player.display_name}</span><button type="button" aria-label={`Restore ${player.display_name}`} disabled={restoring !== null || !online} onClick={() => { void restore(player); }}>{restoring === player.id ? 'Restoring…' : 'Restore'}</button></li>)}</ul>{deletedNext && <button type="button" className="text-button" disabled={loadingMoreDeleted || !online} onClick={() => { void moreDeleted(); }}>{loadingMoreDeleted ? 'Loading…' : 'Load more deleted players'}</button>}</details>}</>;
  return <><header className="report-heading" data-testid="player-report" aria-busy={!history || !report}><button className="icon-button" aria-label="Back to players" title="Back to players" onClick={() => { setSelected(null); setError(''); }}><ChevronLeftIcon /></button><div className="report-title"><h1 title={history?.player.display_name ?? selectedName}>{history?.player.display_name ?? selectedName}</h1><div className="report-actions"><button className="secondary-small" aria-label="Rename player" disabled={!history} onClick={() => showDialog('rename')}>Rename</button><button className="icon-button quiet-icon" aria-label="Delete player" title="Delete player" disabled={!history} onClick={() => showDialog('delete')}><TrashIcon /></button></div></div></header><ErrorText text={error} />{!history ? <RowsSkeleton rows={3} /> : <><section className="report-summary">{history.cumulative.length ? history.cumulative.map(value => <FitText as="strong" className={`summary-value money-value tone-${BigInt(value.result_minor) > 0n ? 'up' : BigInt(value.result_minor) < 0n ? 'down' : 'even'}`} key={value.currency} text={history.cumulative.length > 1 ? `${resultMoney(value.result_minor, value.currency)} ${value.currency}` : resultMoney(value.result_minor, value.currency)} />) : <p className="muted">No finalized results yet</p>}{history.outstanding.filter(value => value.owed_to_banker_minor !== '0' || value.owed_by_banker_minor !== '0').map(value => <p className="outstanding-balances" key={value.currency}><OutstandingBalances value={value} /></p>)}</section>
    <section className="report"><h2>Cash game report</h2><div className="segmented report-groups" aria-label="Report grouping">{(['overall', 'location', 'game', 'weekday', 'month'] as const).map(value => <button key={value} aria-pressed={group === value} onClick={() => setGroup(value)}>{value.charAt(0).toUpperCase() + value.slice(1)}</button>)}</div><button className="text-button" onClick={() => showDialog('filter')}>Filter: {Object.entries(filters).filter(([, value]) => value).length ? Object.entries(filters).filter(([, value]) => value).map(([key, value]) => `${key} ${key === 'weekday' ? groupTitle('weekday', value!) : key === 'month' ? groupTitle('month', value!) : value}`).join(', ') : 'Off'}</button><p className="hint">Rates use results before tips and meals. Variation describes session rates, not a forecast.</p>{report?.groups.map(bucket => <section className="report-bucket" key={`${bucket.key}/${bucket.currency}`}><h3>{groupTitle(group, bucket.key)} · {bucket.currency}</h3><p className="hint">{bucket.sessions_count} finalized session{bucket.sessions_count === 1 ? '' : 's'}</p><MetricList metrics={bucket.metrics} currency={bucket.currency} /></section>)}{report && !report.groups.length && Object.values(filters).some(Boolean) && <p>No finalized sessions match these filters.</p>}</section>
    {history.sessions.length > 0 && <section><h2>Sessions</h2><ul className="choice-list">{history.sessions.map(item => <li key={item.session.id}><button onClick={() => chooseSession(item.session.id)}>{sessionLabel(item.session)}<small>{item.session.status === 'closed' ? 'Closed' : 'Open'} · {item.player.state === 'cashed_out' ? resultMoney(item.player.result_minor, item.session.currency) : item.player.state === 'playing' ? 'Playing' : 'Not bought in'}</small></button></li>)}</ul></section>}
  </>}{dialog === 'rename' && history && <Sheet title="Rename player" close={() => showDialog(null)}><RenameForm player={history.player} saved={() => { showDialog(null); setRefresh(value => value + 1); notify('Player renamed. History stays with the same player.'); }} /></Sheet>}{dialog === 'delete' && history && <Sheet title="Delete player" close={() => showDialog(null)}><DeletePlayer history={history} cancel={() => showDialog(null)} deleted={() => { const player = history.player; showDialog(null); setReturnToSearch(true); setSelected(null); setHistory(null); setReport(null); setRefresh(value => value + 1); offerUndo(`Deleted ${player.display_name}`, { path: `/api/players/${player.id}/restore`, done: `Restored ${player.display_name}`, sessionId: null }); }} /></Sheet>}{dialog === 'filter' && <Sheet title="Report filters" close={() => showDialog(null)}><FilterForm value={filters} apply={value => { setFilters(value); showDialog(null); }} /></Sheet>}</>;
}
function DeletePlayer({ history, deleted, cancel }: { history: History; deleted: () => void; cancel: () => void }) {
  const { client, online } = useClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useFormBusy(busy);
  const games = history.sessions.length;
  const name = history.player.display_name;
  async function remove() {
    if (busy) return;
    setBusy(true); setError('');
    try { await client!.api(`/api/players/${history.player.id}/delete`, 'POST', { op_id: crypto.randomUUID() }); deleted(); }
    catch (problem) { setError((problem as { code?: string }).code === 'player_seated' ? 'Remove them from their games first.' : problem instanceof Error ? problem.message : 'Could not delete player'); setBusy(false); }
  }
  if (games) return <section className="confirmation-panel" role="alert"><h3>Remove them from their games first</h3><p>{name} is still in {games} {games === 1 ? 'game' : 'games'}. Remove them there, or delete those sessions, then delete the player.</p></section>;
  return <section className="confirmation-panel" role="alertdialog" aria-label="Delete player" tabIndex={-1} data-initial-focus><h3>Delete {name}?</h3><p>They leave the roster and player search.</p><ErrorText text={error} /><div className="confirm-actions"><button type="button" disabled={busy} onClick={cancel}>Keep player</button><button type="button" className="danger" disabled={busy || !online} onClick={() => { void remove(); }}>Confirm delete</button></div></section>;
}
function OutstandingBalances({ value }: { value: Outstanding }) {
  const owes = BigInt(value.owed_to_banker_minor) > 0n, owed = BigInt(value.owed_by_banker_minor) > 0n;
  return <>{owes && <strong className="debt money-value">Owes bank {money(value.owed_to_banker_minor, value.currency)}</strong>}{owes && owed && <span aria-hidden="true"> · </span>}{owed && <strong className="credit money-value">Bank owes {money(value.owed_by_banker_minor, value.currency)}</strong>}</>;
}
function groupTitle(group: ReportGrouping, key: string | null) {
  if (key === null) return 'Not recorded';
  if (group === 'overall') return 'Overall';
  if (group === 'weekday') return ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][Number(key) - 1] ?? key;
  if (group === 'month') return new Date(`${key}-01T12:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  return key;
}
function MetricList({ metrics, currency }: { metrics: Report['groups'][number]['metrics']; currency: string }) {
  const fields: { key: keyof typeof metrics; title: string; type: 'money' | 'duration' | 'count' | 'blinds' | 'sqrtMoney' | 'sqrtBlinds' }[] = [
    { key: 'profit_loss_minor', title: 'Profit/loss', type: 'money' },
    { key: 'per_hour_minor', title: 'Money per hour', type: 'money' },
    { key: 'per_session_minor', title: 'Money per session', type: 'money' },
    { key: 'duration_ms', title: 'Playing duration', type: 'duration' },
    { key: 'winning_sessions', title: 'Winning sessions', type: 'count' },
    { key: 'expenses_minor', title: 'Tips and meals', type: 'money' },
    { key: 'net_after_expenses_minor', title: 'Net after tips and meals', type: 'money' },
    { key: 'big_blinds_per_hour', title: 'Big blinds per hour', type: 'blinds' },
    { key: 'variation_per_hour_minor', title: 'Variation across session rates · money/hour', type: 'sqrtMoney' },
    { key: 'variation_big_blinds_per_hour', title: 'Variation across session rates · big blinds/hour', type: 'sqrtBlinds' },
  ];
  function display(metric: Metric<Rational | SquareRoot>, type: typeof fields[number]['type'], key: keyof typeof metrics) {
    if (metric.value === null) return metric.unavailable === 'insufficient_sessions' ? 'Unavailable · needs two sessions' : type === 'blinds' || type === 'sqrtBlinds' ? 'Unavailable · needs time and big blind' : 'No time recorded';
    if ('sqrt_of' in metric.value) return type === 'sqrtMoney' ? currencyDecimal(metric.value.sqrt_of, currency, true) : `${formatSquareRootForReport(metric.value.sqrt_of)} BB/hour`;
    if (type === 'money') return key === 'expenses_minor' ? currencyDecimal(metric.value, currency) : resultCurrencyDecimal(metric.value, currency);
    if (type === 'duration') return duration(String(BigInt(metric.value.numerator) / BigInt(metric.value.denominator)));
    if (type === 'blinds') { const value = resultNumber(metric.value); return value === 'Even' ? value : `${value} BB/hour`; }
    if (key === 'winning_sessions' && metrics.winning_percentage.value) return `${formatRational(metric.value, 0)} of ${metric.sessions_used} (${formatRational(metrics.winning_percentage.value).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')}%)`;
    return formatRational(metric.value, 0);
  }
  return <dl className="metric-list">{fields.map(field => {
    const metric = metrics[field.key];
    const shortDuration = field.type === 'duration' && metric.value && 'numerator' in metric.value && BigInt(metric.value.numerator) > 0n && BigInt(metric.value.numerator) < 60000n * BigInt(metric.value.denominator);
    return <div key={field.key} data-testid={`report-${field.key}`}><dt>{field.title}<small>{metric.sessions_used} session{metric.sessions_used === 1 ? '' : 's'} used</small>{shortDuration && <small>Under one minute; hourly rates use the exact time.</small>}</dt><dd className={metric.value === null ? 'unavailable' : undefined}>{display(metric, field.type, field.key)}</dd></div>;
  })}</dl>;
}
function FilterForm({ value, apply }: { value: ReportFilters; apply: (value: ReportFilters) => void }) {
  const [filters, setFilters] = useState(value);
  const [error, setError] = useState('');
  const endInput = useRef<HTMLInputElement>(null);
  return <form className="sheet-form" onSubmit={event => { event.preventDefault(); if (filters.from && filters.to && filters.from > filters.to) { setError('To date must be on or after From date.'); endInput.current?.focus(); return; } apply(Object.fromEntries(Object.entries(filters).filter(([, value]) => value))); }}><div className="form-body"><label>Filter location<input value={filters.location ?? ''} onChange={event => setFilters({ ...filters, location: event.target.value })} /></label><label>Filter game<input value={filters.game ?? ''} onChange={event => setFilters({ ...filters, game: event.target.value })} /></label><label>Filter weekday<select aria-label="Filter weekday" value={filters.weekday ?? ''} onChange={event => setFilters({ ...filters, weekday: event.target.value })}><option value="">Any weekday</option>{['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((day, index) => <option key={day} value={String(index + 1)}>{day}</option>)}</select></label><label>Filter month<input type="month" value={filters.month ?? ''} onChange={event => setFilters({ ...filters, month: event.target.value })} /></label><label>From date<input type="date" value={filters.from ?? ''} onChange={event => setFilters({ ...filters, from: event.target.value })} /></label><label>To date<input ref={endInput} aria-invalid={!!error} aria-describedby={error ? "filter-date-error" : undefined} type="date" value={filters.to ?? ''} onChange={event => { setError(''); setFilters({ ...filters, to: event.target.value }); }} /></label><ErrorText id="filter-date-error" text={error} /></div><footer className="form-actions"><button className="primary wide">Apply filters</button><button type="button" className="wide" onClick={() => apply({})}>Clear filters</button></footer></form>;
}

function RenameForm({ player, saved }: { player: { id: string; display_name: string }; saved: () => void }) {
  const { banker } = useClient();
  const draft = useDraft(draftKey(banker!.id, 'roster', 'rename', player.id), { op_id: crypto.randomUUID(), name: player.display_name });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useFormBusy(busy);
  if (!draft.ready) return draft.error ? <ErrorText text={draft.error} /> : <p>Restoring draft…</p>;
  if (draft.submitted) return <DraftRecovery pending={busy} notice={draft.error} recover={() => draft.reconcile()} recovered={() => saved()} />;
  return <form className="sheet-form" onSubmit={event => {
    event.preventDefault(); if (busy) return; setBusy(true); setError('');
    void draft.submit(`/api/players/${player.id}`, { op_id: draft.value.op_id, display_name: draft.value.name }, 'PATCH')
      .then(async () => { saved(); }).catch(problem => { setError(problem.message); setBusy(false); });
  }}><div className="form-body"><label>Player name<input value={draft.value.name} onChange={event => draft.update({ ...draft.value, name: event.target.value })} required /></label></div><footer className="form-actions"><ErrorText text={draft.error || error} /><button className="primary wide" disabled={busy}>Save name</button></footer></form>;
}
