import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { SessionState } from '../domain/session';
import { bankerClient, blockBankerWork, clearBankerData, discoverAccount, discardItem, outboxUncertain, invalidateBankerWork, listOutbox, listSubmittedDrafts, listSnapshots, pollSession, readBankerWork, readDraft, readSnapshot, replaySubmittedDraft, requestPersistence, resumeBankerWork, retryItem, storeSnapshot, syncOutbox, verifyBankerWork, type Banker, type BankerWork, type OutboxItem, type SubmittedDraft } from './data';
import { usePwaUpdate } from './pwa';
import { Auth } from './views/Auth';
import { AddPlayerSheet, CorrectionSheet, MoneySheet, PlayerSheet, SessionView } from './views/Session';
import { CloseSheet, HistorySheet, MenuSheet, ReopenSheet, SessionForm, ShareSheet, TimingSheet, type SessionSummary } from './views/Settings';
import { PlayersScreen } from './views/Players';
import { ClientContext, DraftSaveStatus, ErrorText, money, sessionLabel, Sheet, storageFailure, type SheetState } from './views/common';

const viewerToken = location.pathname.startsWith('/v/') ? location.pathname.split('/')[2] : null;
export function App() {
  const [banker, setBanker] = useState<Banker | null>(null);
  const [checking, setChecking] = useState(!viewerToken);
  const [online, setOnline] = useState(navigator.onLine);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(new URLSearchParams(location.search).get('session'));
  const [state, setState] = useState<SessionState | null>(null);
  const [pending, setPending] = useState<OutboxItem[]>([]);
  const [submittedForms, setSubmittedForms] = useState<SubmittedDraft[]>([]);
  const [checkingForm, setCheckingForm] = useState(false);
  const [formsRevision, setFormsRevision] = useState(0);
  const [sheet, setSheet] = useState<SheetState>(null);
  const [childDialog, setChildDialog] = useState(false);
  const [screen, setScreen] = useState<'workspace' | 'players'>('workspace');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [accountChanged, setAccountChanged] = useState(false);
  const [reloadingAccount, setReloadingAccount] = useState(false);
  const [formBusy, setFormBusy] = useState(false);
  const current = useRef(state);
  const chosen = useRef(sessionId);
  const activeBanker = useRef(banker);
  const stopSync = useRef<(() => void) | null>(null);
  const epoch = useRef(0);
  const initialSession = useRef(new URLSearchParams(location.search).get('session'));
  const activeSessionTab = useRef<HTMLButtonElement>(null);
  useEffect(() => { activeSessionTab.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [sessionId, sessions.length, screen]);
  const renderEpoch = epoch.current;
  const client = useMemo(() => banker ? bankerClient(banker.id) : null, [banker, renderEpoch]);
  current.current = state; chosen.current = sessionId; activeBanker.current = banker;
  const pwa = usePwaUpdate({ sheetOpen: sheet !== null || childDialog || checking || loggingOut || formBusy || (!banker && !viewerToken), outboxCount: pending.length });
  const dialogChange = useCallback((open: boolean) => { if (epoch.current === renderEpoch) setChildDialog(open); }, [renderEpoch]);
  const notify = useCallback((text: string) => setNotice(text), []);
  const open = useCallback((next: SheetState) => setSheet(next), []);
  useEffect(() => {
    function connection() { setOnline(navigator.onLine); }
    function storageError(event: Event) { setError((event as CustomEvent<string>).detail || 'Local storage is unavailable. Keep this page open until your entry is saved.'); }
    function storageSaved() { setError(previous => /not saved on this device|quota|local storage/i.test(previous) ? '' : previous); }
    window.addEventListener('online', connection); window.addEventListener('offline', connection); window.addEventListener('pb-storage-error', storageError); window.addEventListener('pb-storage-saved', storageSaved);
    return () => { epoch.current++; window.removeEventListener('online', connection); window.removeEventListener('offline', connection); window.removeEventListener('pb-storage-error', storageError); window.removeEventListener('pb-storage-saved', storageSaved); };
  }, []);
  const resetAuth = useCallback((options: { clearIdentity?: boolean } = {}) => {
    const previousBanker = activeBanker.current?.id;
    epoch.current++;
    if (previousBanker) invalidateBankerWork(previousBanker);
    stopSync.current?.(); stopSync.current = null;
    activeBanker.current = null; current.current = null; chosen.current = null; initialSession.current = null;
    setBanker(null); setState(null); setSessionId(null); setSessions([]); setPending([]); setSubmittedForms([]); setCheckingForm(false);
    setSheet(null); setChildDialog(false); setFormBusy(false); setNotice(''); setError(''); setScreen('workspace'); setLastUpdated(null);
    setAccountChanged(false);
    if (options.clearIdentity !== false) {
      let stored: Banker | null = null;
      try { stored = JSON.parse(localStorage.getItem('pb-banker') ?? 'null') as Banker | null; } catch {}
      if (!previousBanker || stored?.id === previousBanker) { localStorage.removeItem('pb-banker'); localStorage.removeItem('pb-pending-codes'); }
    }
    if (!viewerToken) history.replaceState(null, '', '/');
  }, []);
  useEffect(() => {
    const changed = (event: Event) => {
      if ((event as CustomEvent<{ bankerId: string }>).detail.bankerId !== activeBanker.current?.id) return;
      epoch.current++; stopSync.current?.(); stopSync.current = null;
      setAccountChanged(true); setSheet(null); setChildDialog(false); setFormBusy(false); setCheckingForm(false); setLoggingOut(false); setError('');
    };
    window.addEventListener('pb-account-changed', changed);
    return () => window.removeEventListener('pb-account-changed', changed);
  }, []);
  useEffect(() => {
    const changedAccount = (event: StorageEvent) => {
      if (event.key !== 'pb-banker' || !activeBanker.current) return;
      let account: Banker | null = null;
      try { account = event.newValue ? JSON.parse(event.newValue) as Banker : null; } catch {}
      if (account?.id !== activeBanker.current.id) {
        if (account) blockBankerWork(activeBanker.current.id);
        else resetAuth({ clearIdentity: false });
      }
    };
    window.addEventListener('storage', changedAccount);
    return () => window.removeEventListener('storage', changedAccount);
  }, [resetAuth]);
  const signedIn = useCallback((account: Banker) => {
    const requested = initialSession.current;
    resetAuth({ clearIdentity: false });
    resumeBankerWork(account.id);
    setBanker(account); activeBanker.current = account;
    if (requested) { chosen.current = requested; setSessionId(requested); history.replaceState(null, '', `/?session=${encodeURIComponent(requested)}`); }
    localStorage.setItem('pb-banker', JSON.stringify(account)); setChecking(false); void requestPersistence();
  }, [resetAuth]);
  useEffect(() => {
    if (viewerToken) return;
    let active = true;
    const generation = epoch.current;
    void discoverAccount().then(async result => {
      const pendingKey = localStorage.getItem('pb-pending-codes');
      const pending = pendingKey ? await readDraft<{ banker: Banker; codes: string[] }>(pendingKey) : undefined;
      if (active && epoch.current === generation && pending?.banker.id !== result.banker.id) signedIn(result.banker);
    }).catch(problem => {
      if (!active || epoch.current !== generation) return;
      if (problem.status === 401) resetAuth();
      else {
        try { const saved = localStorage.getItem('pb-banker'); if (saved) signedIn(JSON.parse(saved) as Banker); }
        catch { resetAuth(); }
      }
    }).finally(() => { if (active) setChecking(false); });
    return () => { active = false; };
  }, [signedIn, resetAuth]);
  const update = useCallback((next: SessionState) => {
    if (epoch.current !== renderEpoch || (!viewerToken && (!banker || activeBanker.current?.id !== banker.id || !client?.isCurrent()))) return;
    if (current.current?.session.id === next.session.id && (BigInt(current.current.revision) > BigInt(next.revision) || (current.current.revision === next.revision && Date.parse(current.current.server_now) > Date.parse(next.server_now)))) return;
    if (banker && !viewerToken) void storeSnapshot(banker.id, next).catch(storageFailure);
    if (chosen.current === next.session.id || viewerToken) { setState(next); current.current = next; setLastUpdated(new Date().toISOString()); setError(''); }
    setSessions(rows => {
      const summary: SessionSummary = { id: next.session.id, name: next.session.name, played_on: next.session.played_on, currency: next.session.currency, status: next.session.status, revision: next.revision };
      return [...rows.filter(row => row.id !== summary.id), summary].sort((a, b) => b.played_on.localeCompare(a.played_on) || b.id.localeCompare(a.id));
    });
  }, [banker, client, renderEpoch]);
  const refreshSessions = useCallback(async (account: Banker) => {
    const generation = epoch.current;
    try {
      if (!client || client.bankerId !== account.id) return [];
      const result = await client.api<{ sessions: SessionSummary[] }>('/api/sessions');
      if (epoch.current === generation && activeBanker.current?.id === account.id) setSessions(result.sessions);
      return result.sessions;
    } catch (problem) {
      if (epoch.current !== generation || activeBanker.current?.id !== account.id) return [];
      if ((problem as { status?: number }).status === 401) { resetAuth(); return []; }
      const snapshots = await listSnapshots(account.id);
      const rows = snapshots.map(item => ({ ...item.session, revision: item.revision }));
      if (epoch.current === generation && activeBanker.current?.id === account.id) setSessions(rows);
      return rows;
    }
  }, [client, resetAuth]);
  useEffect(() => {
    if (!banker || accountChanged || loggingOut) return;
    let active = true;
    const generation = epoch.current;
    void refreshSessions(banker).then(rows => {
      if (!active || epoch.current !== generation || chosen.current) return;
      const saved = localStorage.getItem(`pb-session-${banker.id}`);
      const selected = rows.find(row => row.id === saved)?.id ?? rows[0]?.id ?? null;
      setSessionId(selected);
    });
    return () => { active = false; };
  }, [banker, refreshSessions, accountChanged, loggingOut]);
  useEffect(() => {
    if (!banker || loggingOut || accountChanged) return;
    const account = banker;
    const generation = epoch.current;
    const changed = () => { void Promise.all([listOutbox(account.id), listSubmittedDrafts(account.id)]).then(([items, forms]) => { if (epoch.current === generation) { setPending(items); setSubmittedForms(forms); if (!items.length) setNotice(current => current === 'Not saved yet' ? '' : current); } }).catch(storageFailure); };
    changed();
    const stop = syncOutbox(account.id, (next, item) => {
      if (epoch.current !== generation) return;
      update(next);
      const saved = next.entries.find(entry => entry.player_id === item.body.player_id && entry.kind === item.body.kind && entry.amount_minor === item.body.amount_minor && !entry.voids_entry_id);
      notify(saved ? `Saved ${money(saved.amount_minor, next.session.currency)}` : `Saved ${item.label}`);
      void refreshSessions(account);
    }, changed);
    stopSync.current = stop;
    window.addEventListener('pb-data', changed);
    return () => { stop(); window.removeEventListener('pb-data', changed); stopSync.current = null; };
  }, [banker, loggingOut, accountChanged, update, notify, refreshSessions]);
  useEffect(() => {
    if (loggingOut || accountChanged || (!viewerToken && (!banker || !sessionId || !client))) return;
    let active = true;
    let requestRunning = false;
    let pendingForce = false;
    const visible = () => document.visibilityState !== 'hidden';
    const generation = epoch.current;
    const isCurrent = () => active && epoch.current === generation && (viewerToken || activeBanker.current?.id === banker?.id);
    const path = viewerToken ? `/api/view/${viewerToken}` : `/api/sessions/${sessionId}`;
    if (!viewerToken) { setState(null); current.current = null; void readSnapshot(banker!.id, sessionId!).then(saved => { if (isCurrent() && saved && !current.current) { setState(saved); current.current = saved; } }).catch(storageFailure); }
    async function refresh(event?: Event) {
      if (!isCurrent()) return;
      if (event) pendingForce = true;
      if (requestRunning || !visible()) return;
      const force = pendingForce; pendingForce = false;
      requestRunning = true;
      try { const revision = !force && (current.current?.session.id === sessionId || viewerToken) ? current.current?.revision : undefined; const result = viewerToken ? await pollSession(path, revision) : await client!.pollSession(path, revision); if (isCurrent() && result) update(result); if (isCurrent()) setLastUpdated(new Date().toISOString()); }
      catch (problem) {
        if (!isCurrent()) return;
        const failure = problem as Error & { status?: number };
        if (failure.status === 401 && !viewerToken) resetAuth();
        else if (failure.status === 404) { setState(null); current.current = null; setError(viewerToken ? 'This viewer link is unavailable. Ask the banker for a current link.' : 'Session not found. It may belong to another account.'); }
        else if (!current.current) setError('Unable to load this session. Reconnect to try again.');
      } finally { requestRunning = false; if (isCurrent() && pendingForce && visible()) void refresh(); }
    }
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 2000);
    for (const event of ['visibilitychange', 'pageshow', 'focus', 'online']) window.addEventListener(event, refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => { active = false; clearInterval(timer); for (const event of ['visibilitychange', 'pageshow', 'focus', 'online']) window.removeEventListener(event, refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [banker, client, sessionId, loggingOut, accountChanged, update, resetAuth]);
  function choose(id: string) {
    setScreen('workspace'); setSheet(null); setError('');
    setSessionId(id); chosen.current = id;
    history.replaceState(null, '', `/?session=${encodeURIComponent(id)}`);
    if (banker) localStorage.setItem(`pb-session-${banker.id}`, id);
  }
  async function mutate(path: string, body: Record<string, unknown>, method = 'POST') {
    const generation = epoch.current;
    const account = client?.bankerId;
    try {
      if (!client) throw new Error('Sign in to continue');
      const result = await client.api<SessionState>(path, method, body);
      if (epoch.current !== generation || activeBanker.current?.id !== account) throw new Error('Account changed. Sign in to review your saved work.');
      update(result); return result;
    } catch (problem) {
      if (epoch.current === generation && (problem as { status?: number }).status === 401) resetAuth();
      throw problem;
    }
  }
  async function checkSubmittedForm(form: SubmittedDraft) {
    if (checkingForm || !banker) return;
    const generation = epoch.current;
    const account = banker.id;
    const isCurrent = () => epoch.current === generation && activeBanker.current?.id === account;
    setCheckingForm(true); setError('');
    try {
      const result = await replaySubmittedDraft<unknown>(form.key, isCurrent);
      if (!isCurrent()) return;
      if (result && typeof result === 'object' && 'session' in result) {
        const saved = result as SessionState;
        update(saved);
        if (form.form === 'new-session') choose(saved.session.id);
      }
      setFormsRevision(value => value + 1);
      setNotice('Saved form confirmed');
    } catch (problem) { if (isCurrent()) setError(problem instanceof Error ? problem.message : 'Could not check the saved form'); }
    finally { if (isCurrent()) setCheckingForm(false); }
  }
  async function signOut(consent?: BankerWork) {
    if (!client || !sameAccount()) return;
    const account = client.bankerId;
    const startingEpoch = epoch.current;
    setLoggingOut(true); setError('');
    let loggedOut = false;
    try {
      await verifyBankerWork(account, consent);
      if (epoch.current !== startingEpoch || activeBanker.current?.id !== account || !client.isCurrent()) return;
      const generation = ++epoch.current; invalidateBankerWork(account); stopSync.current?.();
      const logoutClient = bankerClient(account);
      const isCurrent = () => epoch.current === generation && activeBanker.current?.id === account && logoutClient.isCurrent();
      await logoutClient.api('/api/auth/logout', 'POST', {});
      loggedOut = true;
      if (!isCurrent()) return;
      await clearBankerData(account, consent);
      if (epoch.current !== generation || activeBanker.current?.id !== account) return;
      let stored: Banker | null = null;
      try { stored = JSON.parse(localStorage.getItem('pb-banker') ?? 'null') as Banker | null; } catch {}
      if (stored?.id === account) localStorage.removeItem('pb-banker');
      if (localStorage.getItem('pb-pending-codes')?.startsWith(`${account}/`)) localStorage.removeItem('pb-pending-codes');
      localStorage.removeItem(`pb-session-${account}`);
      resetAuth({ clearIdentity: false });
    } catch (problem) {
      if (activeBanker.current?.id === account) {
        if (loggedOut) resetAuth({ clearIdentity: false });
        setError(loggedOut ? 'Signed out. New local work was retained. Sign in again to review your saved drafts and entries.' : problem instanceof Error ? problem.message : 'Could not sign out. Reconnect and try again.');
      }
    }
    finally { setLoggingOut(false); }
  }
  async function reloadAccount() {
    if (reloadingAccount) return;
    setReloadingAccount(true); setError('');
    const generation = epoch.current;
    try {
      const result = await discoverAccount();
      const pendingKey = localStorage.getItem('pb-pending-codes');
      const pending = pendingKey ? await readDraft<{ banker: Banker; codes: string[] }>(pendingKey) : undefined;
      if (epoch.current === generation) {
        if (pending?.banker.id === result.banker.id) resetAuth({ clearIdentity: false });
        else signedIn(result.banker);
      }
    }
    catch (problem) { if (epoch.current === generation) { if ((problem as { status?: number }).status === 401) resetAuth({ clearIdentity: false }); else setError(problem instanceof Error ? problem.message : 'Could not reload account state'); } }
    finally { setReloadingAccount(false); }
  }
  const sameAccount = () => !loggingOut && !accountChanged && epoch.current === renderEpoch && (!!viewerToken || (activeBanker.current?.id === banker?.id && !!client?.isCurrent()));
  const boundUpdate = (next: SessionState) => { if (sameAccount()) update(next); };
  const boundOpen = (next: SheetState) => { if (sameAccount()) open(next); };
  const boundNotify = (text: string) => { if (sameAccount()) notify(text); };
  const boundMutate = (path: string, body: Record<string, unknown>, method?: string) => sameAccount() ? mutate(path, body, method) : Promise.reject(new Error('Account changed. Sign in to continue.'));
  let content: ReactNode;
  let title = '';
  if (sheet?.kind === 'money' || sheet?.kind === 'cash_out' || sheet?.kind === 'payment_in' || sheet?.kind === 'payment_out' || sheet?.kind === 'expense') {
    title = sheet.kind === 'money' ? 'Buy-in' : sheet.kind === 'cash_out' ? 'Cash out' : sheet.kind === 'expense' ? 'Tips and meals' : 'Record payment';
    content = <MoneySheet key={`${state?.session.id}/${sheet.player}/${sheet.kind}`} title={title} playerId={sheet.player!} kind={sheet.kind === 'money' ? 'buy_in' : sheet.kind} />;
  } else if (sheet?.kind === 'player') { title = state?.players.find(player => player.id === sheet.player)?.display_name ?? 'Player'; content = <PlayerSheet playerId={sheet.player!} />; }
  else if (sheet?.kind === 'add') { title = 'Add player'; content = <AddPlayerSheet />; }
  else if (sheet?.kind === 'new') { title = 'New session'; content = <SessionForm creating created={next => { if (sameAccount()) { update(next); choose(next.session.id); } }} />; }
  else if (sheet?.kind === 'settings') { title = 'Session settings'; content = <SessionForm creating={false} created={boundUpdate} />; }
  else if (sheet?.kind === 'history') { title = 'History'; content = <HistorySheet choose={choose} />; }
  else if (sheet?.kind === 'menu') { title = 'Session menu'; content = <MenuSheet />; }
  else if (sheet?.kind === 'close') { title = 'Close game'; content = <CloseSheet />; }
  else if (sheet?.kind === 'reopen') { title = 'Reopen game'; content = <ReopenSheet />; }
  else if (sheet?.kind === 'timing') { title = 'Correct times'; content = <TimingSheet />; }
  else if (sheet?.kind === 'share') { title = 'Share session'; content = <ShareSheet />; }
  else if (sheet?.kind === 'correction') { title = 'Correct entry'; content = <CorrectionSheet entryId={sheet.entry!} />; }
  else if (sheet?.kind === 'signout') { title = 'Sign out'; content = <SignoutSheet banker={banker!} busy={loggingOut} signOut={signOut} />; }
  const moneySheet = ['money', 'cash_out', 'payment_in', 'payment_out', 'expense'].includes(sheet?.kind ?? '');
  const updateBanner = pwa.waiting ? <div className="update-banner" role="status"><span>Update ready</span><button data-testid="update-reload" disabled={pending.length > 0 || formBusy || loggingOut} onClick={() => { void pwa.activate().catch(problem => setError(problem.message)); }}>Reload</button></div> : null;
  const recentClosed = new Set(sessions.filter(session => session.status === 'closed').slice(0, 5).map(session => session.id));
  const tabSessions = sessions.filter(session => session.status === 'open' || session.id === sessionId || recentClosed.has(session.id));
  const provider = { banker: viewerToken ? null : banker, client, state, online, pending, open: boundOpen, update: boundUpdate, notify: boundNotify, mutate: boundMutate, updateBanner, formBusy: formBusy || loggingOut, setFormBusy, isCurrent: sameAccount };
  if (checking) return <main className="auth"><DraftSaveStatus /><div className="brand-mark">PB</div><p>Opening your bank…</p></main>;
  if (accountChanged) return <main className="auth"><DraftSaveStatus /><div className="brand-mark">PB</div><h1>Account changed</h1><p>Reload account state to continue. Saved drafts and entries stay with their account.</p><ErrorText text={error} /><button className="primary wide" disabled={reloadingAccount} onClick={() => { void reloadAccount(); }}>{reloadingAccount ? 'Reloading…' : 'Reload account state'}</button></main>;
  if (!banker && !viewerToken) return <>{updateBanner}<DraftSaveStatus /><ErrorText text={error} /><Auth signedIn={signedIn} /></>;
  return <ClientContext.Provider value={provider}><div className="app-shell">{!viewerToken && <header className="app-bar"><a className="wordmark" href="/" onClick={event => { event.preventDefault(); setScreen('workspace'); }}>Poker banker</a><nav aria-label="Workspace navigation"><button aria-pressed={screen === 'workspace'} onClick={() => setScreen('workspace')}>Workspace</button><button aria-pressed={screen === 'players'} onClick={() => { setScreen('players'); setSheet(null); }}>Players</button></nav></header>}
    {!sheet && !childDialog && <>{updateBanner}<DraftSaveStatus /></>}
    {!online && <p className="offline-banner" role="status">Offline. Saved totals are read only. New entries wait to sync.</p>}
    {notice && <div className="notice" role="status" data-testid={notice.startsWith('Saved ') ? 'saved-confirmation' : 'save-status'}>{notice}</div>}<ErrorText text={error} />
    {submittedForms.length > 0 && <section className="outbox" aria-label="Unconfirmed forms"><h2>Unconfirmed forms</h2><p>These forms may already have been saved. Check their saved results before starting another copy.</p><ul>{submittedForms.map(form => <li key={form.key}><button disabled={checkingForm || formBusy} onClick={() => { void checkSubmittedForm(form); }}>Check saved form: {({ 'new-session': 'New session', settings: 'Session settings', reopen: 'Reopen session', timing: 'Correct times', correction: 'Entry correction', 'add-player': 'Add player', rename: 'Rename player' } as Record<string, string>)[form.form] ?? 'Saved form'}</button></li>)}</ul></section>}
    {viewerToken ? <main className="workspace viewer"><p className="viewer-label">View only, updated {lastUpdated ? new Date(lastUpdated).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'when connected'}</p>{state ? <SessionView state={state} viewer /> : !error && <p>Loading shared session…</p>}</main> : screen === 'players' ? <main className="workspace"><PlayersScreen key={formsRevision} chooseSession={choose} dialogChange={dialogChange} /><section className="account-section" aria-label="Account"><h2>Account</h2><p>{banker?.username}</p><button onClick={() => setSheet({ kind: 'signout' })}>Sign out</button></section></main> : <><div className="session-strip" data-testid="session-strip"><div className="session-tabs" role="tablist" aria-label="Sessions">{tabSessions.map(session => <button key={session.id} ref={session.id === sessionId ? activeSessionTab : undefined} role="tab" aria-selected={session.id === sessionId} data-testid={`session-tab-${session.id}`} onClick={() => choose(session.id)}>{sessionLabel(session)}</button>)}</div><div className="session-actions" data-testid="session-actions"><button onClick={() => setSheet({ kind: 'history' })}>History</button><button onClick={() => setSheet({ kind: 'new' })}>New session</button></div></div><main className="workspace">{state ? <SessionView state={state} /> : !sessionId && <div className="empty welcome"><p className="eyebrow">Ready for game night</p><h1>Start with a session</h1><p>A separate ledger for each game. Your players and history stay together.</p><button className="primary" onClick={() => setSheet({ kind: 'new' })}>Create your first session</button></div>}{pending.filter(item => item.session_id === sessionId).length > 0 && <section className="outbox" aria-label="Unsent entries"><h2>Not saved yet</h2><p>Only server-confirmed entries count in totals. An unconfirmed save may already be included.</p><ul>{pending.filter(item => item.session_id === sessionId).map(item => <li key={item.op_id} data-testid={`pending-${item.op_id}`}><strong>{item.label}</strong><span>{item.status === 'rejected' ? item.error : outboxUncertain(item) ? 'Save not confirmed. This entry may already exist on the server.' : 'Not saved yet'}</span>{(item.status === 'rejected' || outboxUncertain(item)) && <button disabled={item.status === 'sending'} onClick={() => { void retryItem(item.op_id); }}>{outboxUncertain(item) ? 'Check saved entry' : 'Retry'}</button>}<button disabled={item.status === 'sending'} onClick={() => { const accepted = outboxUncertain(item) && window.confirm('This entry may already exist on the server. Discarding it does not undo a saved entry. Re-entering it may record it twice. Discard anyway?'); if (!outboxUncertain(item) || accepted) void discardItem(item.op_id, accepted).catch(problem => setError(problem.message)); }}>Discard</button></li>)}</ul></section>}</main></>}
    {sheet && content && (moneySheet ? content : <Sheet key={`${sheet.kind}/${sheet.player ?? ''}/${sheet.entry ?? ''}`} title={title} close={() => setSheet(null)}>{content}</Sheet>)}
  </div></ClientContext.Provider>;
}
function SignoutSheet({ banker, busy, signOut }: { banker: Banker; busy: boolean; signOut: (consent?: BankerWork) => Promise<void> }) {
  const [work, setWork] = useState<BankerWork | null>(null);
  const [discard, setDiscard] = useState<BankerWork | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true, revision = 0;
    const refresh = () => {
      const reading = ++revision;
      void readBankerWork(banker.id).then(next => {
        if (!active || reading !== revision) return;
        setWork(next); setDiscard(previous => previous?.fingerprint === next.fingerprint ? previous : null); setError('');
      }).catch(problem => { if (active && reading === revision) { setWork(null); setDiscard(null); setError(problem instanceof Error ? problem.message : 'Could not check local work'); } });
    };
    refresh(); window.addEventListener('pb-data', refresh); window.addEventListener('storage', refresh);
    const timer = window.setInterval(refresh, 500);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener('pb-data', refresh); window.removeEventListener('storage', refresh); };
  }, [banker.id]);
  return <><p>Signing out clears this account's local drafts and offline snapshots on this device.</p>{work?.hasUnsent && <><p className="warning">You have unsent work. Some entries or forms may already exist on the server. Discarding local work will not undo saved entries. Check saved results first, or explicitly discard it.</p><label className="check"><input type="checkbox" checked={discard !== null} onChange={event => setDiscard(event.target.checked ? work : null)} />Discard unsent entries and drafts</label></>}<ErrorText text={error} /><button className="primary wide" disabled={busy || work === null || (work.hasUnsent && discard === null)} onClick={() => { void signOut(discard ?? undefined); }}>{busy ? 'Signing out…' : 'Confirm sign out'}</button></>;
}
