import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { USE_MOCK } from '../lib/env';
import { usePageTitle } from '../lib/usePageTitle';
import { useAuth } from '../state/authStore';

// Seed accounts from plan §6.3. Quick-fill sets the email only; passwords live in .env, never in the repo.
const SEED = [
  { label: 'Admin', email: 'admin@epicenter.dev', hint: 'all teams' },
  { label: 'SRE', email: 'sre@epicenter.dev', hint: 'all teams' },
  { label: 'Viewer', email: 'payments@epicenter.dev', hint: 'payments only' },
];

export function Login() {
  usePageTitle('Sign in');
  const status = useAuth((s) => s.status);
  const login = useAuth((s) => s.login);
  const navigate = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from ?? '/';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (status === 'authed') return <Navigate to={from} replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await login(email.trim().toLowerCase(), password);
      navigate(from, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
      setBusy(false);
    }
  }

  const field = 'field w-full px-3 py-2';

  return (
    <div className="flex min-h-full items-center justify-center overflow-hidden px-4 py-10">
      <div className="relative isolate w-full max-w-sm">
        <div aria-hidden className="ambient ambient-centered" />
        <div className="mb-6 text-center">
          <svg viewBox="0 0 24 24" className="mx-auto size-10 text-accent" fill="none" stroke="currentColor" aria-hidden>
            <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" />
            <circle cx="12" cy="12" r="6" strokeWidth="1.5" opacity="0.6" />
            <circle cx="12" cy="12" r="10" strokeWidth="1.5" opacity="0.25" />
          </svg>
          <h1 className="page-title mt-3 text-2xl">Epicenter</h1>
          <p className="mt-1 text-sm text-muted">Find where the fire started.</p>
        </div>

        <form onSubmit={onSubmit} className="card space-y-4 p-5">
          <div>
            <label htmlFor="email" className="mb-1.5 block text-sm text-muted">
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@epicenter.dev"
              className={field}
            />
          </div>
          <div>
            <label htmlFor="password" className="mb-1.5 block text-sm text-muted">
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={field}
            />
          </div>

          {error && (
            <p role="alert" className="rounded-md border border-crit/40 bg-crit/10 px-3 py-2 text-sm text-crit">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="btn-primary w-full py-2 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <div className="mt-5">
          <p className="mb-2 text-center text-xs text-faint">Demo accounts</p>
          <div className="grid grid-cols-3 gap-2">
            {SEED.map((u) => (
              <button
                key={u.email}
                type="button"
                onClick={() => {
                  setEmail(u.email);
                  if (USE_MOCK) setPassword('mock');
                  setError(null);
                }}
                className="card rounded-md px-2 py-2 text-center transition-colors hover:border-accent hover:bg-raised"
              >
                <span className="block text-sm text-fg">{u.label}</span>
                <span className="block text-mini text-muted">{u.hint}</span>
              </button>
            ))}
          </div>
          {USE_MOCK && (
            <p className="mt-3 text-center text-xs text-muted">Mock mode: no backend, any password works for the demo accounts.</p>
          )}
        </div>
      </div>
    </div>
  );
}
