import React, { useCallback, useEffect, useState } from 'react';
import { ArrowRight, Eye, EyeOff, Leaf, LockKeyhole, ShieldCheck, Wallet } from 'lucide-react';
import './auth.css';

async function authRequest(path, body) {
  const response = await fetch(`/api/auth/${path}`, { credentials: 'same-origin', cache: 'no-store', ...(body !== undefined ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Unable to connect. Please try again.');
  return result;
}

export default function AuthGate({ children }) {
  const [session, setSession] = useState(null);
  const [connectionError, setConnectionError] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const checkSession = useCallback(async () => {
    try { setSession(await authRequest('session')); setConnectionError(''); }
    catch { setSession(null); setConnectionError('Couldn’t check your session. Check your connection and try again.'); }
  }, []);
  useEffect(() => {
    checkSession();
    const expired = () => { setSession((s) => ({ configured: s?.configured ?? true, authenticated: false })); setPassword(''); setError('Your session ended. Please sign in again.'); };
    const focus = () => { if (document.visibilityState === 'visible') checkSession(); };
    window.addEventListener('pocket-session-expired', expired);
    document.addEventListener('visibilitychange', focus);
    const timer = setInterval(checkSession, 60_000);
    return () => { clearInterval(timer); window.removeEventListener('pocket-session-expired', expired); document.removeEventListener('visibilitychange', focus); };
  }, [checkSession]);
  const signOut = async () => {
    if (busy) return;
    setBusy(true);
    try { await authRequest('logout', {}); setSession({ configured: true, authenticated: false }); setPassword(''); setError(''); }
    catch { window.alert('Couldn’t sign out. Check your connection and try again.'); }
    finally { setBusy(false); }
  };
  if (session?.authenticated) return children({ signOut, signingOut: busy });
  const signIn = async (event) => {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError('');
    try { const result = await authRequest('login', { username, password }); setPassword(''); setSession({ ...result, configured: true }); }
    catch (error) { setError(error.message); setPassword(''); }
    finally { setBusy(false); }
  };
  return <div className="login-layout">
    <section className="login-story" aria-label="About Pocket"><a className="brand" href="/"><span className="brand-icon"><Wallet size={24} /></span>pocket<span className="brand-dot">.</span></a><div className="login-story-content"><span className="login-kicker">YOUR MONEY. YOUR SPACE.</span><h1>A little clarity.<br />A lot more<br /><em>peace of mind.</em></h1><p>A private place for your everyday spending, your big dreams, and everything in between.</p><div className="login-illustration" aria-hidden="true"><div className="login-orbit" /><div className="login-orbit second" /><div className="login-illustration-icon"><Leaf size={54} strokeWidth={1.3} /></div><span className="login-floating-tag"><ShieldCheck size={16} /> Just yours. Always.</span></div></div><div className="login-story-footer"><ShieldCheck size={15} /> Single-owner access. No public sign-ups.</div></section>
    <main className="login-main"><div className="login-card"><div className="login-lock"><LockKeyhole size={24} /></div><span className="eyebrow">A SPACE THAT’S ONLY YOURS</span><h2>Welcome back, Akash.</h2><p className="login-subtitle">Sign in to put your money in perspective.</p>
      {connectionError ? <><div className="alert error" role="alert">{connectionError}</div><button className="button secondary" onClick={checkSession}>Try again</button></> : !session ? <p role="status" className="login-message">Checking your session…</p> : <>
        {!session.configured && <div className="login-setup" role="status"><strong>One small setup step.</strong><p>Create your private login by running <code>npm run setup-owner</code> in your server terminal. Then choose “Check setup” below. There’s no public registration.</p><button className="text-button" onClick={checkSession}>Check setup <ArrowRight size={14} /></button></div>}
        <form onSubmit={signIn} className="login-form"><label className="form-field"><span>Username</span><input name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} required maxLength={100} disabled={!session.configured || busy} placeholder="Your owner username" /></label><label className="form-field"><span>Password</span><div className="login-password"><input name="password" type={visible ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required maxLength={256} disabled={!session.configured || busy} placeholder="Your private passphrase" /><button type="button" aria-label={visible ? 'Hide password' : 'Show password'} aria-pressed={visible} onClick={() => setVisible(!visible)}>{visible ? <EyeOff size={18} /> : <Eye size={18} />}</button></div></label>{error && <div className="alert error" role="alert">{error}</div>}<button className="button primary login-submit" disabled={!session.configured || busy}>{busy ? 'Signing in…' : 'Sign in to Pocket'}<ArrowRight size={17} /></button></form><p className="login-recovery">Forgot your password? Reset it from your server terminal with <code>npm run setup-owner</code>.</p>
      </>}
      <div className="login-security"><ShieldCheck size={16} /><p>Owner-only access · Secure server-side sessions<br />Your password is never stored in plain text.</p></div></div><footer><Leaf size={13} /> Small steps. A healthier financial life.</footer></main>
  </div>;
}