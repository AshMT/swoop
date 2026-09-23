import { useState, type FormEvent } from 'react';
import { errorMessage, login, setToken } from '../api';
import { Alert, Spinner } from '../components/ui';
import { SwoopLogo } from '../components/Icons';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await login(email, password);
      setToken(res.data.token);
      // A full navigation rather than a router push: it re-runs the app
      // bootstrap so the token is picked up everywhere at once.
      window.location.assign('/queue');
    } catch (err) {
      setError(errorMessage(err, 'Sign-in failed'));
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 bg-[radial-gradient(ellipse_at_top,rgba(47,111,224,0.10),transparent_60%)] p-4 dark:bg-slate-950">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <SwoopLogo className="h-14 w-14 drop-shadow-md" />
          <h1 className="mt-3 text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">Swoop</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Triage that swoops first — for MSPs on SuperOps</p>
        </div>

        <div className="card p-6">
          <h2 className="mb-5 text-base font-semibold text-slate-900 dark:text-slate-100">Sign in</h2>

          {error && (
            <div className="mb-4">
              <Alert tone="danger">{error}</Alert>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="label" htmlFor="email">
                Email
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
                autoComplete="username"
                placeholder="you@msp.com"
                className="input"
              />
            </div>
            <div>
              <label className="label" htmlFor="password">
                Password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                placeholder="••••••••••••"
                className="input"
              />
            </div>
            <button type="submit" disabled={loading} className="btn-primary w-full">
              {loading ? <Spinner /> : null}
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </div>

        <p className="mt-6 text-center text-xs text-slate-400 dark:text-slate-500">
          Self-hosted. Your tickets and credentials stay on your infrastructure, apart from the calls to the AI
          provider you chose and, if you connect it, your own CIPP.
        </p>
      </div>
    </div>
  );
}
