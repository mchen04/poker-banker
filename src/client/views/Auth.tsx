import { useEffect, useState, type FormEvent } from 'react';
import { api, deleteDraft, draftKey, readDraft, requestPersistence, writeDraft, type Banker } from '../data';
import { ErrorText } from './common';

export function Auth({ signedIn }: { signedIn: (banker: Banker) => void }) {
  const [mode, setMode] = useState<'login' | 'signup' | 'recover'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [newBanker, setNewBanker] = useState<Banker | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    const key = localStorage.getItem('pb-pending-codes');
    if (key) void readDraft<{ banker: Banker; codes: string[] }>(key).then(saved => { if (saved) { setCodes(saved.codes); setNewBanker(saved.banker); } });
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      if (mode === 'recover') {
        await api('/api/auth/recover', 'POST', { username, recovery_code: code, new_password: password });
        setMode('login'); setNotice('Password reset. Sign in with your new password.'); setPassword('');
      } else {
        const result = await api<{ banker: Banker; recovery_codes?: string[] }>(`/api/auth/${mode}`, 'POST', { username, password });
        await requestPersistence();
        if (mode === 'signup') { const key = draftKey(result.banker.id, 'account', 'recovery-codes'); await writeDraft(key, { banker: result.banker, codes: result.recovery_codes! }); localStorage.setItem('pb-pending-codes', key); setCodes(result.recovery_codes!); setNewBanker(result.banker); }
        else signedIn(result.banker);
      }
    } catch (problem) { setError(problem instanceof Error ? problem.message : 'Could not sign in'); }
    finally { setBusy(false); }
  }
  if (codes) return <main className="auth"><div className="brand-mark" aria-hidden="true">PB</div><p className="eyebrow">Keep your account</p><h1>Save your recovery codes</h1><p>Each code works once. Without your password or a code, your account cannot be recovered.</p><div className="recovery-codes" data-testid="recovery-codes">{codes.map(value => <code key={value}>{value}</code>)}</div><label className="check"><input type="checkbox" checked={saved} onChange={event => setSaved(event.target.checked)} />I saved these codes</label><button className="primary wide" disabled={!saved} onClick={() => { const key = localStorage.getItem('pb-pending-codes'); void (key ? deleteDraft(key) : Promise.resolve()).then(() => { localStorage.removeItem('pb-pending-codes'); signedIn(newBanker!); }); }}>Continue to workspace</button></main>;
  return <main className="auth"><div className="brand-mark" aria-hidden="true">PB</div><p className="eyebrow">Justin's home game</p><h1>{mode === 'login' ? 'Welcome to the bank' : mode === 'signup' ? 'Make room for game night' : 'Recover your account'}</h1><p>Keep the game moving. Every buy-in and payout, accounted for.</p><div className="segments" aria-label="Account access"><button type="button" aria-pressed={mode === 'login'} onClick={() => { setMode('login'); setError(''); }}>Sign in</button><button type="button" aria-pressed={mode === 'signup'} onClick={() => { setMode('signup'); setError(''); }}>Sign up</button></div><form onSubmit={submit}>
    <label>Username<input autoComplete="username" autoCapitalize="none" value={username} onChange={event => setUsername(event.target.value)} required minLength={3} maxLength={32} /></label>
    {mode === 'recover' && <label>Recovery code<input autoComplete="off" value={code} onChange={event => setCode(event.target.value)} required /></label>}
    <label>{mode === 'recover' ? 'New password' : 'Password'}<input type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={event => setPassword(event.target.value)} required minLength={mode === 'login' ? 1 : 10} /></label>
    {mode !== 'login' && <p className="hint">Use at least 10 characters. Avoid a common password.</p>}<ErrorText text={error} />{notice && <p role="status">{notice}</p>}<button className="primary wide" disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Sign in to workspace' : mode === 'signup' ? 'Create account' : 'Reset password'}</button>
  </form><button className="text-button" type="button" onClick={() => { setMode('recover'); setError(''); }}>Recover account</button></main>;
}
