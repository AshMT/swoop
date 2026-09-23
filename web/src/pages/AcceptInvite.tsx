import { useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { acceptInvite, errorMessage, getInvite, setToken } from '../api';
import { Alert, LoadingState, Spinner } from '../components/ui';
import { SwoopLogo } from '../components/Icons';

/** Where an invitation link lands: set a password and you are in. */
export default function AcceptInvite() {
  const { token = '' } = useParams();
  const { data, isLoading, error } = useQuery({
    queryKey: ['invite', token],
    queryFn: () => getInvite(token).then((r) => r.data),
    retry: false,
  });
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [problem, setProblem] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setProblem('');
    if (password !== confirm) {
      setProblem('The two passwords do not match.');
      return;
    }
    setSaving(true);
    try {
      const res = await acceptInvite(token, password, name.trim() || undefined);
      setToken(res.data.token);
      window.location.assign('/queue');
    } catch (err) {
      setProblem(errorMessage(err, 'Could not accept the invitation'));
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-4 dark:bg-slate-950">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <SwoopLogo className="h-14 w-14" />
          <h1 className="mt-3 text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">Join Swoop</h1>
        </div>
        <div className="card p-6">
          {isLoading ? (
            <LoadingState label="Checking the invitation" />
          ) : error || !data ? (
            <Alert tone="danger" title="This link will not work">
              {errorMessage(error, 'It is invalid, expired or already used. Ask whoever sent it for a new one.')}
            </Alert>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <p className="text-sm text-slate-600 dark:text-slate-300">
                You have been invited as <strong>{data.role}</strong> with <strong>{data.email}</strong>. Choose a password
                to finish.
              </p>
              {problem && <Alert tone="danger">{problem}</Alert>}
              <div>
                <label className="label" htmlFor="name">
                  Your name
                </label>
                <input id="name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Optional" />
              </div>
              <div>
                <label className="label" htmlFor="password">
                  Password
                </label>
                <input id="password" type="password" className="input" autoComplete="new-password" minLength={12} required value={password} onChange={(e) => setPassword(e.target.value)} />
                <p className="hint">At least 12 characters.</p>
              </div>
              <div>
                <label className="label" htmlFor="confirm">
                  Confirm password
                </label>
                <input id="confirm" type="password" className="input" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
              </div>
              <button className="btn-primary w-full" disabled={saving}>
                {saving ? <Spinner /> : null} Join
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
