import { useState, type FormEvent } from 'react';
import {
  errorMessage,
  setToken,
  setupAdmin,
  setupAiConfig,
  setupClient,
  setupTenant,
  testAi,
  testSuperOps,
  type ConnectionTestResult,
  bodySource,
} from '../api';
import { Alert, Spinner, Toggle } from '../components/ui';
import { CheckIcon, SwoopLogo } from '../components/Icons';

type Step = 'admin' | 'superops' | 'ai' | 'client' | 'done';

const STEPS: Array<{ id: Step; label: string }> = [
  { id: 'admin', label: 'Account' },
  { id: 'superops', label: 'SuperOps' },
  { id: 'ai', label: 'AI provider' },
  { id: 'client', label: 'First client' },
];

const AI_PRESETS = [
  { label: 'Ollama (local)', baseUrl: 'http://localhost:11434', model: 'qwen3:8b', key: '' },
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', key: '' },
  { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', key: '' },
];

export default function Setup({ onComplete }: { onComplete: () => void }) {
  const [step, setStep] = useState<Step>('admin');
  const [tenantId, setTenantId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Step 1
  const [adminEmail, setAdminEmail] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [adminConfirm, setAdminConfirm] = useState('');

  // Step 2
  const [mspName, setMspName] = useState('');
  const [subdomain, setSubdomain] = useState('');
  const [superopsKey, setSuperopsKey] = useState('');
  const [region, setRegion] = useState<'us' | 'eu'>('us');
  const [superopsTest, setSuperopsTest] = useState<ConnectionTestResult | null>(null);

  // Step 3
  const [aiBaseUrl, setAiBaseUrl] = useState('http://localhost:11434');
  const [aiModel, setAiModel] = useState('qwen3:8b');
  const [aiKey, setAiKey] = useState('');
  const [aiTest, setAiTest] = useState<{ ok: boolean; error?: string; reply?: string } | null>(null);

  // Step 4
  const [clientName, setClientName] = useState('');
  const [clientCompanyId, setClientCompanyId] = useState('');
  const [clientEnabled, setClientEnabled] = useState(true);

  const stepIndex = STEPS.findIndex((s) => s.id === step);

  const run = async (fn: () => Promise<void>) => {
    setError('');
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const handleAdmin = (event: FormEvent) => {
    event.preventDefault();
    if (adminPassword !== adminConfirm) {
      setError('The passwords do not match.');
      return;
    }
    void run(async () => {
      const res = await setupAdmin(adminEmail, adminPassword);
      // Every later step is authenticated with this token.
      setToken(res.data.token);
      setStep('superops');
    });
  };

  const handleSuperOps = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const res = await setupTenant(mspName, subdomain, superopsKey, region);
      setTenantId(res.data.id);
      setStep('ai');
    });
  };

  const handleAi = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      await setupAiConfig(tenantId, aiBaseUrl, aiKey, aiModel);
      setStep('client');
    });
  };

  const handleClient = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      await setupClient(tenantId, clientName, clientCompanyId || undefined, clientEnabled);
      setStep('done');
    });
  };

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-10 dark:bg-slate-950">
      <div className="mx-auto max-w-xl">
        <div className="mb-8 flex flex-col items-center text-center">
          <SwoopLogo className="h-12 w-12 text-swoop-600" />
          <h1 className="mt-3 text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">
            Set up Swoop
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Four steps. Swoop reads tickets and proposes actions — it never executes anything.
          </p>
        </div>

        {step !== 'done' && (
          <ol className="mb-6 flex items-center justify-between">
            {STEPS.map((item, index) => {
              const done = index < stepIndex;
              const active = index === stepIndex;
              return (
                <li key={item.id} className="flex flex-1 items-center">
                  <div className="flex flex-col items-center gap-1">
                    <span
                      className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold ${
                        done
                          ? 'bg-emerald-600 text-white'
                          : active
                            ? 'bg-swoop-600 text-white'
                            : 'bg-slate-200 text-slate-500 dark:bg-slate-800 dark:text-slate-400'
                      }`}
                    >
                      {done ? <CheckIcon className="h-3.5 w-3.5" /> : index + 1}
                    </span>
                    <span
                      className={`text-xs ${
                        active ? 'font-medium text-slate-900 dark:text-slate-100' : 'text-slate-400'
                      }`}
                    >
                      {item.label}
                    </span>
                  </div>
                  {index < STEPS.length - 1 && (
                    <span
                      className={`mx-2 mb-4 h-px flex-1 ${
                        done ? 'bg-emerald-600' : 'bg-slate-200 dark:bg-slate-800'
                      }`}
                    />
                  )}
                </li>
              );
            })}
          </ol>
        )}

        <div className="card p-6">
          {error && (
            <div className="mb-5">
              <Alert tone="danger">{error}</Alert>
            </div>
          )}

          {/* ─── Step 1 ────────────────────────────────────────────────────── */}
          {step === 'admin' && (
            <form onSubmit={handleAdmin} className="space-y-4">
              <Heading title="Create your admin account" subtitle="This is the only account, and it stays on your server." />
              <div>
                <label className="label">Email</label>
                <input
                  type="email"
                  value={adminEmail}
                  onChange={(e) => setAdminEmail(e.target.value)}
                  required
                  autoFocus
                  autoComplete="username"
                  placeholder="you@msp.com"
                  className="input"
                />
              </div>
              <div>
                <label className="label">Password</label>
                <input
                  type="password"
                  value={adminPassword}
                  onChange={(e) => setAdminPassword(e.target.value)}
                  required
                  minLength={12}
                  autoComplete="new-password"
                  className="input"
                />
                <p className="hint">At least 12 characters.</p>
              </div>
              <div>
                <label className="label">Confirm password</label>
                <input
                  type="password"
                  value={adminConfirm}
                  onChange={(e) => setAdminConfirm(e.target.value)}
                  required
                  autoComplete="new-password"
                  className="input"
                />
              </div>
              <button type="submit" disabled={busy || adminPassword.length < 12} className="btn-primary w-full">
                {busy ? <Spinner /> : null} Continue
              </button>
            </form>
          )}

          {/* ─── Step 2 ────────────────────────────────────────────────────── */}
          {step === 'superops' && (
            <form onSubmit={handleSuperOps} className="space-y-4">
              <Heading
                title="Connect SuperOps"
                subtitle="Swoop reads tickets and posts private internal notes. It never changes a ticket's state."
              />
              <div>
                <label className="label">Your MSP name</label>
                <input
                  value={mspName}
                  onChange={(e) => setMspName(e.target.value)}
                  required
                  autoFocus
                  placeholder="MightyIT"
                  className="input"
                />
                <p className="hint">Appears in the notes Swoop posts.</p>
              </div>
              <div>
                <label className="label">SuperOps subdomain</label>
                <input
                  value={subdomain}
                  onChange={(e) => {
                    setSubdomain(e.target.value.replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim());
                    setSuperopsTest(null);
                  }}
                  required
                  placeholder="mightyit"
                  className="input"
                />
                <p className="hint">
                  Just the subdomain from <code>yourcompany.superops.ai</code>. A custom domain works too.
                </p>
              </div>
              <div>
                <label className="label">Data centre</label>
                <div className="flex gap-4">
                  {(['us', 'eu'] as const).map((value) => (
                    <label key={value} className="flex cursor-pointer items-center gap-2">
                      <input
                        type="radio"
                        name="region"
                        checked={region === value}
                        onChange={() => {
                          setRegion(value);
                          setSuperopsTest(null);
                        }}
                        className="accent-swoop-600"
                      />
                      <span className="text-sm text-slate-700 dark:text-slate-300">
                        {value === 'us' ? 'US / Global' : 'EU'}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <label className="label">API token</label>
                <input
                  type="password"
                  value={superopsKey}
                  onChange={(e) => {
                    setSuperopsKey(e.target.value);
                    setSuperopsTest(null);
                  }}
                  required
                  autoComplete="off"
                  className="input"
                />
                <p className="hint">SuperOps → Settings → My Profile → API Token.</p>
              </div>

              {superopsTest && <SuperOpsTestResult result={superopsTest} />}

              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={!subdomain || !superopsKey || busy}
                  onClick={() =>
                    void run(async () => {
                      const res = await testSuperOps(subdomain, superopsKey, region);
                      setSuperopsTest(res.data);
                    })
                  }
                  className="btn-secondary flex-1"
                >
                  {busy ? <Spinner /> : null} Test connection
                </button>
                <button type="submit" disabled={busy || !mspName || !subdomain || !superopsKey} className="btn-primary flex-1">
                  Continue
                </button>
              </div>
            </form>
          )}

          {/* ─── Step 3 ────────────────────────────────────────────────────── */}
          {step === 'ai' && (
            <form onSubmit={handleAi} className="space-y-4">
              <Heading
                title="Choose an AI provider"
                subtitle="Any OpenAI-compatible endpoint. A local model keeps ticket content on your own hardware."
              />

              <div className="flex flex-wrap gap-2">
                {AI_PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => {
                      setAiBaseUrl(preset.baseUrl);
                      setAiModel(preset.model);
                      setAiKey(preset.key);
                      setAiTest(null);
                    }}
                    className="btn-secondary !py-1 text-xs"
                  >
                    {preset.label}
                  </button>
                ))}
              </div>

              <div>
                <label className="label">Base URL</label>
                <input
                  value={aiBaseUrl}
                  onChange={(e) => {
                    setAiBaseUrl(e.target.value);
                    setAiTest(null);
                  }}
                  required
                  className="input"
                />
                <p className="hint">
                  <code>/v1</code> is appended automatically. In Docker, use{' '}
                  <code>http://host.docker.internal:11434</code> to reach an Ollama on the host.
                </p>
              </div>
              <div>
                <label className="label">Model</label>
                <input
                  value={aiModel}
                  onChange={(e) => {
                    setAiModel(e.target.value);
                    setAiTest(null);
                  }}
                  required
                  className="input font-mono"
                />
              </div>
              <div>
                <label className="label">
                  API key <span className="font-normal text-slate-400">(leave blank for Ollama)</span>
                </label>
                <input
                  type="password"
                  value={aiKey}
                  onChange={(e) => {
                    setAiKey(e.target.value);
                    setAiTest(null);
                  }}
                  autoComplete="off"
                  className="input"
                />
              </div>

              {aiTest && (
                <Alert tone={aiTest.ok ? 'success' : 'danger'}>
                  {aiTest.ok ? 'The model responded correctly.' : aiTest.error}
                </Alert>
              )}

              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={!aiBaseUrl || !aiModel || busy}
                  onClick={() =>
                    void run(async () => {
                      const res = await testAi(aiBaseUrl, aiKey, aiModel);
                      setAiTest(res.data);
                    })
                  }
                  className="btn-secondary flex-1"
                >
                  {busy ? <Spinner /> : null} Test connection
                </button>
                <button type="submit" disabled={busy || !aiBaseUrl || !aiModel} className="btn-primary flex-1">
                  Continue
                </button>
              </div>
            </form>
          )}

          {/* ─── Step 4 ────────────────────────────────────────────────────── */}
          {step === 'client' && (
            <form onSubmit={handleClient} className="space-y-4">
              <Heading
                title="Add your first client"
                subtitle="Swoop only touches clients you list here. Start with one — you can add the rest once you have seen the agreement rate."
              />
              <div>
                <label className="label">Client name</label>
                <input
                  value={clientName}
                  onChange={(e) => setClientName(e.target.value)}
                  required
                  autoFocus
                  placeholder="Acme Corp"
                  className="input"
                />
                <p className="hint">Spell it as SuperOps does — it is used as a fallback match.</p>
              </div>
              <div>
                <label className="label">
                  SuperOps company ID <span className="font-normal text-slate-400">(recommended)</span>
                </label>
                <input
                  value={clientCompanyId}
                  onChange={(e) => setClientCompanyId(e.target.value)}
                  className="input font-mono"
                />
                <p className="hint">The reliable way to match tickets. Names get renamed; IDs do not.</p>
              </div>

              <Toggle
                checked={clientEnabled}
                onChange={setClientEnabled}
                label="Start classifying straight away"
                description="Leave this off to add the client without switching automation on yet."
              />

              <div className="flex gap-2">
                <button type="button" onClick={() => setStep('done')} className="btn-secondary flex-1">
                  Skip for now
                </button>
                <button type="submit" disabled={busy || !clientName} className="btn-primary flex-1">
                  {busy ? <Spinner /> : null} Finish
                </button>
              </div>
            </form>
          )}

          {/* ─── Done ──────────────────────────────────────────────────────── */}
          {step === 'done' && (
            <div className="space-y-5 text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400">
                <CheckIcon className="h-6 w-6" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">Swoop is running</h2>
                <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                  It will poll SuperOps on the next cycle and start classifying tickets from clients you have
                  enabled.
                </p>
              </div>

              <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-left text-sm dark:border-slate-800 dark:bg-slate-900/60">
                <p className="font-medium text-slate-800 dark:text-slate-200">What to do next</p>
                <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs text-slate-600 dark:text-slate-400">
                  <li>
                    On the Dashboard, hit <strong>Poll now</strong> rather than waiting for the interval.
                  </li>
                  <li>
                    Open Settings → Diagnostics to confirm Swoop found a ticket body field on your schema.
                  </li>
                  <li>
                    Mark each classification correct or incorrect. Twenty reviews is enough for the agreement
                    rate on the Calibration page to mean something.
                  </li>
                  <li>Enable a second client once agreement is at or above 90%.</li>
                </ol>
              </div>

              <button
                onClick={() => {
                  onComplete();
                  window.location.assign('/queue');
                }}
                className="btn-primary w-full"
              >
                Open the dashboard
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Heading({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-5">
      <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">{title}</h2>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{subtitle}</p>
    </div>
  );
}

function SuperOpsTestResult({ result }: { result: ConnectionTestResult }) {
  if (!result.ok) {
    return (
      <Alert tone="danger" title="Connection failed">
        {result.error}
      </Alert>
    );
  }
  const caps = result.capabilities;
  return (
    <Alert tone={bodySource(caps) ? 'success' : 'warning'} title="Connected">
      <p className="text-xs">
        Swoop inspected your GraphQL schema and will read tickets via <code>{caps?.listQuery}</code>
        {bodySource(caps) ? (
          <>
            , reading the ticket text from <code>{bodySource(caps)}</code>
          </>
        ) : (
          ' — but found no ticket body field, so it will classify on the subject line alone'
        )}
        .
      </p>
    </Alert>
  );
}
