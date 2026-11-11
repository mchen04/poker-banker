import { useEffect, useState, type FormEvent } from 'react';
import { api, deleteDraft, draftKey, flushDraftWrites, requestPersistence, writeDraft, type Banker, type DraftCursor } from '../data';
import { ErrorText } from './common';

export type PendingRecoveryCodes = { banker: Banker; codes: string[] };

export function Auth({ signedIn, pendingCodes, pendingCursor, codesVisible, busyChanged }: { signedIn: (banker: Banker) => void; pendingCodes?: PendingRecoveryCodes; pendingCursor?: DraftCursor; codesVisible?: (visible: boolean) => void; busyChanged?: (busy: boolean) => void }) {
  const [mode, setMode] = useState<'login' | 'signup' | 'recover'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [pending, setPending] = useState<PendingRecoveryCodes | null>(pendingCodes ?? null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [backupFailed, setBackupFailed] = useState(false);
  const [codesCursor] = useState<DraftCursor>(pendingCursor ? { ...pendingCursor } : { version: null });
  function setWorking(value: boolean) { setBusy(value); busyChanged?.(value); }
  useEffect(() => () => busyChanged?.(false), [busyChanged]);
  useEffect(() => {
    if (pendingCodes) { codesCursor.version = pendingCursor?.version ?? null; setPending(pendingCodes); setSaved(false); void saveCodes(pendingCodes); }
  }, [pendingCodes, pendingCursor]);
  useEffect(() => { codesVisible?.(pending !== null); return () => codesVisible?.(false); }, [pending !== null, codesVisible]);
  async function saveCodes(value: PendingRecoveryCodes, retry = false) {
    setWorking(true); setError('');
    const key = draftKey(value.banker.id, 'account', 'recovery-codes');
    const problems: string[] = [];
    try { localStorage.setItem('pb-pending-codes', key); }
    catch (problem) { problems.push(problem instanceof Error ? problem.message : 'Could not save the recovery-code reminder'); }
    try { await writeDraft(key, value, codesCursor); if (retry) await flushDraftWrites(); }
    catch (problem) { problems.push(problem instanceof Error ? problem.message : 'Could not save recovery codes on this device'); }
    setBackupFailed(problems.length > 0);
    if (problems.length) setError(`Not saved on this device. Keep this page open and save your recovery codes. ${problems.join(' ')}`);
    setWorking(false);
  }
  async function acknowledgeCodes() {
    if (!pending || busy || !saved) return;
    setWorking(true); setError('');
    const key = draftKey(pending.banker.id, 'account', 'recovery-codes');
    try {
      await deleteDraft(key, undefined, codesCursor);
      if (localStorage.getItem('pb-pending-codes') === key) localStorage.removeItem('pb-pending-codes');
      signedIn(pending.banker);
    } catch (problem) { setError(problem instanceof Error ? problem.message : 'Could not acknowledge your recovery codes'); }
    finally { setWorking(false); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return;
    setWorking(true); setError(''); setNotice('');
    try {
      if (mode === 'recover') {
        await api('/api/auth/recover', 'POST', { username, recovery_code: code, new_password: password });
        setMode('login'); setNotice('Password reset. Sign in with your new password.'); setPassword('');
      } else {
        const result = await api<{ banker: Banker; recovery_codes?: string[] }>(`/api/auth/${mode}`, 'POST', { username, password });
        if (mode === 'signup') {
          const value = { banker: result.banker, codes: result.recovery_codes! };
          codesCursor.version = null;
          setPending(value);
          void requestPersistence();
          await saveCodes(value);
        } else { void requestPersistence(); signedIn(result.banker); }
      }
    } catch (problem) { setError(problem instanceof Error ? problem.message : 'Could not sign in'); }
    finally { setWorking(false); }
  }
  if (pending) return <main className="auth"><div className="brand-mark" aria-hidden="true">PB</div><p className="eyebrow">Keep your account</p><h1>Save your recovery codes</h1><p>Each code works once. Without your password or a code, your account cannot be recovered.</p><div className="recovery-codes" data-testid="recovery-codes">{pending.codes.map(value => <code key={value}>{value}</code>)}</div><ErrorText text={error} />{backupFailed && <button type="button" disabled={busy} onClick={() => { void saveCodes(pending, true); }}>{busy ? 'Saving draft…' : 'Retry saving draft'}</button>}<label className="check"><input type="checkbox" checked={saved} onChange={event => setSaved(event.target.checked)} />I saved these codes</label><button className="primary wide" disabled={!saved || busy} onClick={() => { void acknowledgeCodes(); }}>Continue to workspace</button></main>;
  return <main className="auth"><div className="brand-mark" aria-hidden="true">PB</div><p className="eyebrow">Justin's home game</p><h1>{mode === 'login' ? 'Welcome to the bank' : mode === 'signup' ? 'Make room for game night' : 'Recover your account'}</h1><p>Keep the game moving. Every buy-in and payout, accounted for.</p><div className="segments" aria-label="Account access"><button type="button" aria-pressed={mode === 'login'} onClick={() => { setMode('login'); setError(''); }}>Sign in</button><button type="button" aria-pressed={mode === 'signup'} onClick={() => { setMode('signup'); setError(''); }}>Sign up</button></div><form onSubmit={submit}>
    <label>Username<input autoComplete="username" autoCapitalize="none" value={username} onChange={event => setUsername(event.target.value)} required minLength={3} maxLength={32} /></label>
    {mode === 'recover' && <label>Recovery code<input autoComplete="off" value={code} onChange={event => setCode(event.target.value)} required /></label>}
    <label>{mode === 'recover' ? 'New password' : 'Password'}<input type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={event => setPassword(event.target.value)} required minLength={mode === 'login' ? 1 : 10} /></label>
    {mode !== 'login' && <p className="hint">Use at least 10 characters. Avoid a common password.</p>}<ErrorText text={error} />{notice && <p role="status">{notice}</p>}<button className="primary wide" disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Sign in to workspace' : mode === 'signup' ? 'Create account' : 'Reset password'}</button>
  </form><button className="text-button" type="button" onClick={() => { setMode('recover'); setError(''); }}>Recover account</button></main>;
}
