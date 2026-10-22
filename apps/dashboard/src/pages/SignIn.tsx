import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { KeyRound, Mail, Wallet, GitBranch } from 'lucide-react';
import { api, tokenStore } from '../lib/api';
import { useApp } from '../lib/app';
import { Banner, Button, Field } from '../components/ui';

export function SignIn() {
  const { refreshMe, me } = useApp();
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const next = sp.get('next') ?? '/';
  const [mode, setMode] = useState<'choose' | 'email' | 'sent' | 'token' | 'wallet'>('choose');
  const [email, setEmail] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const magic = sp.get('token');

  // Landing from an email link: exchange the one-time token for a session.
  useEffect(() => {
    if (!magic) return;
    setBusy(true);
    api('/v1/auth/email/verify', { method: 'POST', body: { token: magic } })
      .then(() => refreshMe())
      .then(() => nav('/', { replace: true }))
      .catch((e: Error) => setErr(e.message))
      .finally(() => setBusy(false));
  }, [magic, nav, refreshMe]);
  useEffect(() => {
    if (me) nav(next, { replace: true });
  }, [me, next, nav]);

  const wrap = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="auth-wrap">
      <div className="card auth-card col" style={{ gap: 16 }}>
        <div className="row">
          <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden>
            <rect width="32" height="32" rx="7" fill="var(--bg-raised)" />
            <path
              d="M6 22h20M8 17h16M11 12h10"
              stroke="var(--brand)"
              strokeWidth="2.2"
              strokeLinecap="round"
            />
          </svg>
          <h2>buiry</h2>
        </div>
        <p className="muted">One shared, verifiable memory for every agent on your project.</p>
        {err && <Banner kind="error">{err}</Banner>}
        {mode === 'choose' && (
          <div className="col">
            <Button icon={<Wallet size={16} />} onClick={() => setMode('wallet')}>
              Continue with a Sui wallet
            </Button>
            <Button
              icon={<GitBranch size={16} />}
              onClick={() => {
                window.location.href = '/v1/auth/oauth/github/start';
              }}
            >
              Continue with GitHub
            </Button>
            <Button
              onClick={() => {
                window.location.href = '/v1/auth/oauth/google/start';
              }}
            >
              Continue with Google
            </Button>
            <Button icon={<Mail size={16} />} onClick={() => setMode('email')}>
              Continue with email
            </Button>
            <button className="btn ghost sm" onClick={() => setMode('token')}>
              <KeyRound size={14} /> Use a session token
            </button>
          </div>
        )}
        {mode === 'email' && (
          <form
            className="col"
            onSubmit={(e) => {
              e.preventDefault();
              void wrap(async () => {
                await api('/v1/auth/email/start', { method: 'POST', body: { email } });
                setMode('sent');
              });
            }}
          >
            <Field label="Email">
              {(id) => (
                <input
                  id={id}
                  className="inp"
                  type="email"
                  required
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              )}
            </Field>
            <Button variant="primary" loading={busy} type="submit">
              Send sign-in link
            </Button>
            <Button variant="ghost" type="button" onClick={() => setMode('choose')}>
              Back
            </Button>
          </form>
        )}
        {mode === 'sent' && (
          <Banner kind="success">
            If that address can sign in, a link is on its way. Open it on this device.
          </Banner>
        )}
        {mode === 'token' && (
          <form
            className="col"
            onSubmit={(e) => {
              e.preventDefault();
              void wrap(async () => {
                tokenStore.set(token.trim());
                try {
                  await refreshMe();
                } catch (x) {
                  tokenStore.set(null);
                  throw x;
                }
              });
            }}
          >
            <Field
              label="Session token"
              help="From the CLI or the development server. It is kept in this browser only."
            >
              {(id) => (
                <input
                  id={id}
                  className="inp mono"
                  type="password"
                  autoFocus
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                />
              )}
            </Field>
            <Button variant="primary" loading={busy} type="submit">
              Sign in
            </Button>
            <Button variant="ghost" type="button" onClick={() => setMode('choose')}>
              Back
            </Button>
          </form>
        )}
        {mode === 'wallet' && (
          <div className="col">
            <Banner kind="info">
              Wallet sign-in asks your wallet to sign a short message that proves you control the address. It
              does not move funds. Connecting a wallet requires a browser wallet extension, which this build
              does not bundle.
            </Banner>
            <Button variant="ghost" onClick={() => setMode('choose')}>
              Back
            </Button>
          </div>
        )}
        <p className="faint small">By continuing you agree to the terms and privacy notice.</p>
      </div>
    </div>
  );
}
