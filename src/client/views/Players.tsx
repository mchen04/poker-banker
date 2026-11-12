import { useEffect, useState } from 'react';
import type { playerReport, ReportGrouping, ReportFilters, Metric, SquareRoot } from '../../domain/report';
import type { Rational } from '../../domain/rational';
import { formatRational, formatSquareRoot as formatSquareRootForReport } from '../../domain/rational';
import type { PlayerState, SessionSettings } from '../../domain/session';
import { draftKey } from '../data';
import { useDebouncedSearch } from '../search';
import { currencyDecimal, duration, DraftRecovery, ErrorText, money, resultMoney, resultCurrencyDecimal, resultNumber, sessionLabel, Sheet, useClient, useDraft, useFormBusy } from './common';

type CurrencyResult = { currency: string; result_minor: string };
type Outstanding = { currency: string; owed_to_banker_minor: string; owed_by_banker_minor: string };
type Roster = { id: string; display_name: string; cumulative: CurrencyResult[]; outstanding: Outstanding[] };
type History = { player: { id: string; display_name: string }; cumulative: CurrencyResult[]; outstanding: Outstanding[]; sessions: { session: SessionSettings; player: PlayerState }[] };
type Report = ReturnType<typeof playerReport>;
export function PlayersScreen({ chooseSession, dialogChange }: { chooseSession: (id: string) => void; dialogChange: (open: boolean) => void }) {
  const { notify, client } = useClient();
  const api = client!.api;
  const [players, setPlayers] = useState<Roster[]>([]);
  const [search, setSearch] = useState('');
  const settledSearch = useDebouncedSearch(search);
  const [selected, setSelected] = useState<string | null>(null);
  const [history, setHistory] = useState<History | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [group, setGroup] = useState<ReportGrouping>('overall');
  const [filters, setFilters] = useState<ReportFilters>({});
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState<'rename' | 'filter' | null>(null);
  const [refresh, setRefresh] = useState(0);
  function showDialog(next: 'rename' | 'filter' | null) { setDialog(next); dialogChange(next !== null); }
  useEffect(() => () => dialogChange(false), [dialogChange]);
  useEffect(() => {
    let active = true;
    void api<{ players: Roster[] }>(`/api/players?q=${encodeURIComponent(settledSearch)}`).then(result => { if (active) setPlayers(result.players); }).catch(problem => setError(problem.message));
    return () => { active = false; };
  }, [settledSearch, refresh]);
  useEffect(() => {
    if (!selected) return;
    let active = true;
    const query = new URLSearchParams({ ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== undefined && value !== '')), group });
    void Promise.all([api<History>(`/api/players/${selected}`), api<Report>(`/api/players/${selected}/report?${query}`)])
      .then(([details, values]) => { if (active) { setHistory(details); setReport(values); } }).catch(problem => setError(problem.message));
    return () => { active = false; };
  }, [selected, group, filters, refresh]);
  if (!selected) return <><header className="page-heading"><p className="eyebrow">Your reusable roster</p><h1>Players</h1><p>Finalized results, with currencies kept separate.</p></header><label>Find a player<input type="search" value={search} onChange={event => setSearch(event.target.value)} /></label><ErrorText text={error} /><ul className="roster-list">{players.map(player => <li key={player.id}><button data-testid={`roster-player-${player.id}`} onClick={() => { setSelected(player.id); setHistory(null); setReport(null); }}><strong>{player.display_name}</strong>{player.cumulative.length ? player.cumulative.map(value => <span key={value.currency}>{value.currency} · {resultMoney(value.result_minor, value.currency)} finalized</span>) : <span>No finalized results</span>}{player.outstanding.map(value => <small key={value.currency}>Owes bank {money(value.owed_to_banker_minor, value.currency)} · Bank owes {money(value.owed_by_banker_minor, value.currency)}</small>)}</button></li>)}</ul>{!players.length && <div className="empty"><h2>Your roster starts at the table</h2><p>Add a player in a session to save them here.</p></div>}</>;
  return <><button className="text-button" onClick={() => { setSelected(null); setError(''); }}>Back to players</button><ErrorText text={error} />{!history ? <p>Loading player…</p> : <><header className="page-heading"><p className="eyebrow">Player history</p><h1>{history.player.display_name}</h1><button onClick={() => showDialog('rename')}>Rename player</button></header><section><h2>Finalized results</h2>{history.cumulative.length ? history.cumulative.map(value => <p className="summary-value" key={value.currency}>{value.currency} · {resultMoney(value.result_minor, value.currency)}</p>) : <p>No finalized results yet.</p>}{history.outstanding.map(value => <p key={value.currency}>Owes bank {money(value.owed_to_banker_minor, value.currency)} · Bank owes {money(value.owed_by_banker_minor, value.currency)}</p>)}</section>
    <section className="report"><h2>Cash game report</h2><div className="segments report-groups" aria-label="Report grouping">{(['overall', 'location', 'game', 'weekday', 'month'] as const).map(value => <button key={value} aria-pressed={group === value} onClick={() => setGroup(value)}>{value.charAt(0).toUpperCase() + value.slice(1)}</button>)}</div><button className="text-button" onClick={() => showDialog('filter')}>Filter: {Object.entries(filters).filter(([, value]) => value).length ? Object.entries(filters).filter(([, value]) => value).map(([key, value]) => `${key} ${value}`).join(', ') : 'Off'}</button><p className="hint">Rates use results before tips and meals. Variation describes session rates, not a forecast.</p>{report?.groups.map(bucket => <section className="report-bucket" key={`${bucket.key}/${bucket.currency}`}><h3>{groupTitle(group, bucket.key)} · {bucket.currency}</h3><p className="hint">{bucket.sessions_count} finalized session{bucket.sessions_count === 1 ? '' : 's'}</p><MetricList metrics={bucket.metrics} currency={bucket.currency} /></section>)}{report && !report.groups.length && <p>No finalized sessions match these filters.</p>}</section>
    <section><h2>Past sessions</h2><ul className="choice-list">{history.sessions.map(item => <li key={item.session.id}><button onClick={() => chooseSession(item.session.id)}>{sessionLabel(item.session)}<small>{item.session.status === 'closed' ? 'Closed' : 'Open'} · {item.player.state === 'cashed_out' ? resultMoney(item.player.result_minor, item.session.currency) : item.player.state === 'playing' ? 'Playing' : 'Seated'}</small></button></li>)}</ul></section>
  </>}{dialog === 'rename' && history && <Sheet title="Rename player" close={() => showDialog(null)}><RenameForm player={history.player} saved={() => { showDialog(null); setRefresh(value => value + 1); notify('Player renamed. History stays with the same player.'); }} /></Sheet>}{dialog === 'filter' && <Sheet title="Report filters" close={() => showDialog(null)}><FilterForm value={filters} apply={value => { setFilters(value); showDialog(null); }} /></Sheet>}</>;
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
    return <div key={field.key} data-testid={`report-${field.key}`}><dt>{field.title}<small>{metric.sessions_used} session{metric.sessions_used === 1 ? '' : 's'} used</small></dt><dd className={metric.value === null ? 'unavailable' : undefined}>{display(metric, field.type, field.key)}</dd></div>;
  })}</dl>;
}
function FilterForm({ value, apply }: { value: ReportFilters; apply: (value: ReportFilters) => void }) {
  const [filters, setFilters] = useState(value);
  return <form onSubmit={event => { event.preventDefault(); apply(Object.fromEntries(Object.entries(filters).filter(([, value]) => value))); }}><label>Filter location<input value={filters.location ?? ''} onChange={event => setFilters({ ...filters, location: event.target.value })} /></label><label>Filter game<input value={filters.game ?? ''} onChange={event => setFilters({ ...filters, game: event.target.value })} /></label><label>Filter weekday<select aria-label="Filter weekday" value={filters.weekday ?? ''} onChange={event => setFilters({ ...filters, weekday: event.target.value })}><option value="">Any weekday</option>{['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((day, index) => <option key={day} value={String(index + 1)}>{day}</option>)}</select></label><label>Filter month<input type="month" value={filters.month ?? ''} onChange={event => setFilters({ ...filters, month: event.target.value })} /></label><label>From date<input type="date" value={filters.from ?? ''} onChange={event => setFilters({ ...filters, from: event.target.value })} /></label><label>To date<input type="date" value={filters.to ?? ''} onChange={event => setFilters({ ...filters, to: event.target.value })} /></label><button className="primary wide">Apply filters</button><button type="button" className="wide" onClick={() => apply({})}>Clear filters</button></form>;
}

function RenameForm({ player, saved }: { player: { id: string; display_name: string }; saved: () => void }) {
  const { banker } = useClient();
  const draft = useDraft(draftKey(banker!.id, 'roster', 'rename', player.id), { op_id: crypto.randomUUID(), name: player.display_name });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useFormBusy(busy);
  if (!draft.ready) return draft.error ? <ErrorText text={draft.error} /> : <p>Restoring draft…</p>;
  if (draft.submitted) return <DraftRecovery pending={busy} notice={draft.error} recover={() => draft.reconcile()} recovered={() => saved()} />;
  return <form onSubmit={event => {
    event.preventDefault(); if (busy) return; setBusy(true); setError('');
    void draft.submit(`/api/players/${player.id}`, { op_id: draft.value.op_id, display_name: draft.value.name }, 'PATCH')
      .then(async () => { saved(); }).catch(problem => { setError(problem.message); setBusy(false); });
  }}><label>Player name<input value={draft.value.name} onChange={event => draft.update({ ...draft.value, name: event.target.value })} required /></label><ErrorText text={draft.error || error} /><button className="primary wide" disabled={busy}>Save name</button></form>;
}
