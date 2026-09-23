import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  changePassword,
  errorMessage,
  logoutEverywhere,
  setToken,
  getCapabilities,
  getDefaultPrompt,
  getLogStorage,
  getNotePreview,
  getSystemStatus,
  getTenants,
  bodySource,
  pruneLogs,
  testAi,
  testSuperOps,
  testTenantConnection,
  updateTenant,
  type ConnectionTestResult,
  type PsaCapabilities,
  type Tenant,
} from '../api';
import { Alert, Badge, LoadingState, PageHeader, Spinner, Toggle, useToast } from '../components/ui';
import { formatBytes, formatDate, formatDateTime, formatDuration, formatRelative } from '../lib/format';
import { useCan } from '../lib/session';
import { ApprovalSection, CippSection, TriageSection } from '../components/settings/PolicySections';
import { AgentSection, ExecutionSection } from '../components/settings/AgentSections';

type Tab = 'connection' | 'ai' | 'behaviour' | 'triage' | 'approvals' | 'cipp' | 'agent' | 'execution' | 'prompt' | 'diagnostics' | 'account';

const TABS: Array<{ id: Tab; label: string; adminOnly: boolean }> = [
  { id: 'connection', label: 'SuperOps', adminOnly: true },
  { id: 'ai', label: 'AI provider', adminOnly: true },
  { id: 'behaviour', label: 'Behaviour', adminOnly: true },
  { id: 'triage', label: 'Triage rules', adminOnly: true },
  { id: 'approvals', label: 'Approvals', adminOnly: true },
  { id: 'cipp', label: 'CIPP', adminOnly: true },
  { id: 'agent', label: 'Agent', adminOnly: true },
  { id: 'execution', label: 'Execution', adminOnly: true },
  { id: 'prompt', label: 'Prompt', adminOnly: true },
  { id: 'diagnostics', label: 'Diagnostics', adminOnly: true },
  { id: 'account', label: 'Account', adminOnly: false },
];

export default function Settings() {
  const isAdmin = useCan('admin');
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab');
  const chosen: Tab = TABS.some((t) => t.id === requested) ? (requested as Tab) : 'connection';
  const setTab = (next: Tab) => setParams(next === 'connection' ? {} : { tab: next }, { replace: true });
  // Everyone can manage their own account; only admins see the tenant settings.
  const tab: Tab = isAdmin ? chosen : 'account';
  const { data: tenants, isLoading } = useQuery({
    queryKey: ['tenants'],
    queryFn: () => getTenants().then((r) => r.data),
  });
  const tenant = tenants?.[0];

  if (isLoading) {
    return (
      <div>
        <PageHeader title="Settings" />
        <LoadingState />
      </div>
    );
  }

  if (!tenant) {
    return (
      <div>
        <PageHeader title="Settings" />
        <Alert tone="warning" title="No SuperOps connection configured">
          Re-run the setup wizard at <code>/setup</code> to connect SuperOps.
        </Alert>
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="Settings" description={`${tenant.name} · ${tenant.superopsSubdomain}`} />

      <div className="mb-6 flex flex-wrap gap-1 border-b border-slate-200 dark:border-slate-800">
        {TABS.filter((item) => isAdmin || !item.adminOnly).map((item) => (
          <button
            key={item.id}
            onClick={() => setTab(item.id)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
              tab === item.id
                ? 'border-swoop-600 text-swoop-700 dark:text-swoop-400'
                : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="max-w-3xl">
        {tab === 'connection' && <SuperOpsSection tenant={tenant} />}
        {tab === 'ai' && <AiSection tenant={tenant} />}
        {tab === 'behaviour' && <BehaviourSection tenant={tenant} />}
        {tab === 'triage' && <TriageSection tenant={tenant} />}
        {tab === 'approvals' && <ApprovalSection tenant={tenant} />}
        {tab === 'cipp' && <CippSection tenant={tenant} />}
        {tab === 'agent' && <AgentSection tenant={tenant} />}
        {tab === 'execution' && <ExecutionSection tenant={tenant} />}
        {tab === 'prompt' && <PromptSection tenant={tenant} />}
        {tab === 'diagnostics' && <DiagnosticsSection tenant={tenant} />}
        {tab === 'account' && <AccountSection />}
      </div>
    </div>
  );
}

/** Shared save-state button so every section behaves identically. */
function SaveButton({ state, disabled }: { state: 'idle' | 'saving' | 'saved'; disabled?: boolean }) {
  return (
    <button type="submit" disabled={disabled || state === 'saving'} className="btn-primary">
      {state === 'saving' ? <Spinner /> : null}
      {state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved' : 'Save'}
    </button>
  );
}

function useSaveState() {
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const markSaved = () => {
    setState('saved');
    window.setTimeout(() => setState('idle'), 2500);
  };
  return { state, setState, markSaved };
}

// ─── SuperOps ─────────────────────────────────────────────────────────────────

function SuperOpsSection({ tenant }: { tenant: Tenant }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { state, setState, markSaved } = useSaveState();

  const [name, setName] = useState(tenant.name);
  const [subdomain, setSubdomain] = useState(tenant.superopsSubdomain);
  const [region, setRegion] = useState<'us' | 'eu'>((tenant.superopsRegion as 'us' | 'eu') || 'us');
  const [apiKey, setApiKey] = useState('');
  const [test, setTest] = useState<ConnectionTestResult | null>(null);
  const [testing, setTesting] = useState(false);

  /** Operators paste the whole URL; keep only the host part. */
  const cleanSubdomain = (value: string) =>
    value.replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim();

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      // With a new key in the box, test that; otherwise test what is stored.
      const res = apiKey.trim()
        ? await testSuperOps(subdomain, apiKey.trim(), region)
        : await testTenantConnection(tenant.id);
      setTest(res.data);
      if (res.data.ok) {
        void queryClient.invalidateQueries({ queryKey: ['tenants'] });
        void queryClient.invalidateQueries({ queryKey: ['capabilities'] });
      }
    } catch (err) {
      setTest({ ok: false, error: errorMessage(err, 'The connection test failed') });
    } finally {
      setTesting(false);
    }
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setState('saving');
    try {
      const body: Record<string, unknown> = { name, superopsSubdomain: subdomain, superopsRegion: region };
      if (apiKey.trim()) body.superopsApiKey = apiKey.trim();
      await updateTenant(tenant.id, body);
      setApiKey('');
      setTest(null);
      markSaved();
      void queryClient.invalidateQueries({ queryKey: ['tenants'] });
      toast.success('SuperOps connection saved');
    } catch (err) {
      setState('idle');
      toast.error(errorMessage(err, 'Could not save the connection'));
    }
  };

  return (
    <form onSubmit={save} className="space-y-5">
      <div>
        <label className="label">MSP name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} className="input" required />
        <p className="hint">Shown in the internal notes Swoop posts to tickets.</p>
      </div>

      <div>
        <label className="label">SuperOps subdomain</label>
        <input
          value={subdomain}
          onChange={(e) => {
            setSubdomain(cleanSubdomain(e.target.value));
            setTest(null);
          }}
          className="input"
          required
        />
        <p className="hint">
          Just the subdomain, e.g. <code>mightyit</code> for mightyit.superops.ai. A custom vanity domain such
          as <code>mighty.it</code> works too.
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
                  setTest(null);
                }}
                className="accent-swoop-600"
              />
              <span className="text-sm text-slate-700 dark:text-slate-300">
                {value === 'us' ? 'US / Global' : 'EU'}
              </span>
            </label>
          ))}
        </div>
        <p className="hint">A US token will not authenticate against the EU endpoint, and vice versa.</p>
      </div>

      <div>
        <label className="label">
          API token{' '}
          <span className="font-normal text-slate-400">
            {tenant.hasSuperopsApiKey ? '(stored — leave blank to keep it)' : '(not set)'}
          </span>
        </label>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => {
            setApiKey(e.target.value);
            setTest(null);
          }}
          placeholder={tenant.hasSuperopsApiKey ? 'Enter a new token to replace the stored one' : 'Paste your API token'}
          className="input"
          autoComplete="off"
        />
        <p className="hint">SuperOps → Settings → My Profile → API Token.</p>
      </div>

      {test && <ConnectionResult result={test} />}

      <div className="flex gap-2">
        <button type="button" onClick={runTest} disabled={!subdomain || testing} className="btn-secondary">
          {testing ? <Spinner /> : null}
          {testing ? 'Testing…' : 'Test connection'}
        </button>
        <SaveButton state={state} disabled={!subdomain || !name} />
      </div>
    </form>
  );
}

function ConnectionResult({ result }: { result: ConnectionTestResult }) {
  if (!result.ok) {
    return (
      <Alert tone="danger" title="Connection failed">
        <p>{result.error}</p>
        {result.endpoint && <p className="mt-1 text-xs opacity-75">Endpoint: {result.endpoint}</p>}
      </Alert>
    );
  }

  const caps = result.capabilities;
  const blocking = caps?.warnings ?? [];

  return (
    <div className="space-y-2">
      <Alert tone={blocking.length > 0 ? 'warning' : 'success'} title="Connected to SuperOps">
        <p>
          Swoop inspected the GraphQL schema and worked out how to read tickets
          {caps?.noteMutation ? ' and post notes' : ''}.
        </p>
        {caps && (
          <ul className="mt-2 space-y-0.5 text-xs">
            <li>
              Ticket list: <code>{caps.listQuery ?? 'not found'}</code>
            </li>
            <li>
              Ticket body:{' '}
              {bodySource(caps) ? <code>{bodySource(caps)}</code> : <span className="font-medium">not found</span>}
              {result.bodyCheck && 'characters' in result.bodyCheck && (
                <span>
                  {' '}
                  — read {result.bodyCheck.characters} characters from ticket {result.bodyCheck.ticket}: “{result.bodyCheck.preview}
                  {result.bodyCheck.characters > result.bodyCheck.preview.length ? '…' : ''}”
                </span>
              )}
              {result.bodyCheck && 'error' in result.bodyCheck && (
                <span className="font-medium">
                  {' '}
                  — but reading it{result.bodyCheck.ticket ? ` from ticket ${result.bodyCheck.ticket}` : ''} failed: {result.bodyCheck.error}
                </span>
              )}
            </li>
            <li>
              Note mutation:{' '}
              {caps.noteMutation ? <code>{caps.noteMutation}</code> : <span className="font-medium">not found</span>}
            </li>
          </ul>
        )}
      </Alert>
      {blocking.map((warning) => (
        <Alert key={warning} tone="warning">
          {warning}
        </Alert>
      ))}
    </div>
  );
}

// ─── AI provider ──────────────────────────────────────────────────────────────

const PRESETS = [
  { label: 'Ollama (local)', baseUrl: 'http://localhost:11434', model: 'qwen3:8b' },
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
  { label: 'LM Studio', baseUrl: 'http://localhost:1234/v1', model: '' },
];

function AiSection({ tenant }: { tenant: Tenant }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { state, setState, markSaved } = useSaveState();

  const [baseUrl, setBaseUrl] = useState(tenant.aiBaseUrl ?? '');
  const [model, setModel] = useState(tenant.aiModel ?? '');
  const [apiKey, setApiKey] = useState('');
  const [test, setTest] = useState<{ ok: boolean; error?: string; reply?: string; latencyMs?: number } | null>(
    null,
  );
  const [testing, setTesting] = useState(false);

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      const res = await testAi(baseUrl, apiKey, model);
      setTest(res.data);
    } catch (err) {
      setTest({ ok: false, error: errorMessage(err, 'The connection test failed') });
    } finally {
      setTesting(false);
    }
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setState('saving');
    try {
      await updateTenant(tenant.id, {
        aiBaseUrl: baseUrl.trim() || null,
        aiModel: model.trim() || null,
        // An empty box means "clear the key", which Ollama needs.
        aiApiKey: apiKey.trim() || null,
      });
      setApiKey('');
      markSaved();
      void queryClient.invalidateQueries({ queryKey: ['tenants'] });
      toast.success('AI provider saved');
    } catch (err) {
      setState('idle');
      toast.error(errorMessage(err, 'Could not save the AI settings'));
    }
  };

  return (
    <form onSubmit={save} className="space-y-5">
      <div>
        <label className="label">Presets</label>
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              onClick={() => {
                setBaseUrl(preset.baseUrl);
                if (preset.model) setModel(preset.model);
                setTest(null);
              }}
              className="btn-secondary !py-1 text-xs"
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="label">Base URL</label>
        <input
          value={baseUrl}
          onChange={(e) => {
            setBaseUrl(e.target.value);
            setTest(null);
          }}
          placeholder="http://localhost:11434"
          className="input"
          required
        />
        <p className="hint">
          Any OpenAI-compatible endpoint. <code>/v1</code> is appended automatically if you leave it off.
        </p>
      </div>

      <div>
        <label className="label">Model</label>
        <input
          value={model}
          onChange={(e) => {
            setModel(e.target.value);
            setTest(null);
          }}
          placeholder="qwen3:8b"
          className="input font-mono"
          required
        />
        <p className="hint">
          For Ollama, the model must already be pulled. Small reasoning models work, and Swoop strips their
          reasoning traces before parsing the answer.
        </p>
      </div>

      <div>
        <label className="label">
          API key{' '}
          <span className="font-normal text-slate-400">
            {tenant.hasAiApiKey ? '(stored — leave blank to keep it)' : '(not needed for Ollama)'}
          </span>
        </label>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => {
            setApiKey(e.target.value);
            setTest(null);
          }}
          placeholder="sk-…"
          className="input"
          autoComplete="off"
        />
      </div>

      {test && (
        <Alert tone={test.ok ? 'success' : 'danger'} title={test.ok ? 'The model responded' : 'AI connection failed'}>
          {test.ok ? (
            <p className="text-xs">
              Replied in {formatDuration(test.latencyMs)}
              {test.reply ? `: ${test.reply}` : ''}
            </p>
          ) : (
            <p>{test.error}</p>
          )}
        </Alert>
      )}

      <div className="flex gap-2">
        <button type="button" onClick={runTest} disabled={!baseUrl || !model || testing} className="btn-secondary">
          {testing ? <Spinner /> : null}
          {testing ? 'Testing…' : 'Test connection'}
        </button>
        <SaveButton state={state} disabled={!baseUrl || !model} />
      </div>
    </form>
  );
}

// ─── Behaviour ────────────────────────────────────────────────────────────────

function BehaviourSection({ tenant }: { tenant: Tenant }) {
  const queryClient = useQueryClient();
  const toast = useToast();

  const [interval, setInterval] = useState(tenant.pollIntervalSeconds ?? 60);
  const [threshold, setThreshold] = useState(tenant.confidenceThreshold ?? 0.75);
  const [concurrency, setConcurrency] = useState(tenant.classifyConcurrency ?? 1);
  const { state, setState, markSaved } = useSaveState();

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => updateTenant(tenant.id, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tenants'] });
      void queryClient.invalidateQueries({ queryKey: ['system-status'] });
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not save the setting')),
  });

  return (
    <div className="space-y-6">
      <div className="card space-y-4 p-4">
        <Toggle
          checked={!tenant.automationPaused}
          onChange={(on) => {
            patch.mutate({ automationPaused: !on });
            toast.success(on ? 'Automation resumed' : 'Automation paused');
          }}
          label="Automation running"
          description="The master switch. Pausing stops all classification without touching your per-client toggles."
        />

        <Toggle
          checked={Boolean(tenant.dryRun)}
          onChange={(on) => {
            patch.mutate({ dryRun: on });
            toast.success(on ? 'Preview mode on — notes stay in Swoop' : 'Preview mode off — notes post to SuperOps');
          }}
          label="Preview mode"
          description="Classify and log, but never write a note back to SuperOps. Use this while you are calibrating and do not want the noise in your clients' tickets."
        />
      </div>

      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setState('saving');
          try {
            await updateTenant(tenant.id, {
              pollIntervalSeconds: interval,
              confidenceThreshold: threshold,
              classifyConcurrency: concurrency,
            });
            markSaved();
            void queryClient.invalidateQueries({ queryKey: ['tenants'] });
            toast.success('Saved');
          } catch (err) {
            setState('idle');
            toast.error(errorMessage(err, 'Could not save'));
          }
        }}
        className="space-y-5"
      >
        <div>
          <label className="label">Poll interval — every {interval} seconds</label>
          <input
            type="range"
            min={15}
            max={600}
            step={15}
            value={interval}
            onChange={(e) => setInterval(Number(e.target.value))}
            className="w-full accent-swoop-600"
          />
          <p className="hint">
            How often Swoop asks SuperOps for new tickets. A shorter interval means faster triage and more API
            calls; 60 seconds suits most desks.
          </p>
        </div>

        <div>
          <label className="label">
            Confidence threshold — {(threshold * 100).toFixed(0)}%
          </label>
          <input
            type="range"
            min={0.5}
            max={0.95}
            step={0.05}
            value={threshold}
            onChange={(e) => setThreshold(Number(e.target.value))}
            className="w-full accent-swoop-600"
          />
          <p className="hint">
            Anything the model is less sure of than this is escalated instead. Raise it to see fewer wrong
            proposals and more escalations; check the Calibration page first to see whether confidence is
            actually separating right from wrong for your ticket mix.
          </p>
        </div>

        <div>
          <label className="label">
            Classify {concurrency} ticket{concurrency === 1 ? '' : 's'} at a time
          </label>
          <input
            type="range"
            min={1}
            max={8}
            step={1}
            value={concurrency}
            onChange={(e) => setConcurrency(Number(e.target.value))}
            className="w-full accent-swoop-600"
          />
          <p className="hint">
            Raise this if a slow local model is falling behind on a busy morning — a small model on CPU can
            take tens of seconds per ticket, and one at a time means a backlog clears slower than handling it
            by hand. Leave it at 1 for a hosted provider, where the requests are fast and the rate limit is
            the real constraint.
          </p>
        </div>

        <SaveButton state={state} />
      </form>

      <NoteFormatSection tenant={tenant} />
      <RetentionSection tenant={tenant} />
    </div>
  );
}

/**
 * Whether a PSA renders Markdown or HTML in a note cannot be settled from
 * outside a real instance, and guessing wrong is visible on every ticket — a
 * note full of raw asterisks reads worse than plain text. So rather than
 * guess, show exactly what each option produces.
 */
function NoteFormatSection({ tenant }: { tenant: Tenant }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ['note-preview', tenant.id],
    queryFn: () => getNotePreview(tenant.id).then((r) => r.data),
  });

  const choose = useMutation({
    mutationFn: (format: string) => updateTenant(tenant.id, { noteFormat: format }),
    onSuccess: (_res, format) => {
      void queryClient.invalidateQueries({ queryKey: ['tenants'] });
      void queryClient.invalidateQueries({ queryKey: ['note-preview'] });
      toast.success(`Notes will be posted as ${format}`);
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not change the note format')),
  });

  const current = tenant.noteFormat ?? 'plain';

  return (
    <section className="border-t border-slate-200 pt-6 dark:border-slate-800">
      <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Internal note format</h2>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
        How the proposal is written into the ticket. Plain text is the safe default because it reads
        correctly even where the PSA renders nothing. If your SuperOps notes are a rich-text field, paste a
        preview below into a test ticket to see which one it renders, then pick that.
      </p>

      <div className="mt-4 space-y-2">
        {(data?.formats ?? []).map((format) => (
          <div key={format.id} className="card overflow-hidden">
            <div className="flex flex-wrap items-center gap-3 p-3">
              <label className="flex flex-1 cursor-pointer items-center gap-2.5">
                <input
                  type="radio"
                  name="noteFormat"
                  checked={current === format.id}
                  onChange={() => choose.mutate(format.id)}
                  disabled={choose.isPending}
                  className="accent-swoop-600"
                />
                <span>
                  <span className="block text-sm font-medium text-slate-800 dark:text-slate-200">
                    {format.label}
                  </span>
                  <span className="block text-xs text-slate-500 dark:text-slate-400">
                    {format.description}
                  </span>
                </span>
              </label>
              <button
                type="button"
                onClick={() => setExpanded((open) => (open === format.id ? null : format.id))}
                className="btn-ghost !py-1 text-xs"
              >
                {expanded === format.id ? 'Hide preview' : 'Preview'}
              </button>
            </div>

            {expanded === format.id && (
              <pre className="max-h-72 overflow-auto border-t border-slate-200 bg-slate-50 p-3 font-mono text-[11px] leading-relaxed text-slate-600 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-400">
                {format.preview}
              </pre>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * Log retention. Every action log row keeps the full ticket body and the raw
 * model response, which is what makes the log useful and also what makes it
 * grow without bound.
 */
function RetentionSection({ tenant }: { tenant: Tenant }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [days, setDays] = useState(tenant.logRetentionDays ?? 0);
  const { state, setState, markSaved } = useSaveState();

  const { data: storage } = useQuery({
    queryKey: ['log-storage', tenant.id],
    queryFn: () => getLogStorage(tenant.id).then((r) => r.data),
  });

  const prune = useMutation({
    mutationFn: () => pruneLogs(tenant.id),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ['log-storage'] });
      void queryClient.invalidateQueries({ queryKey: ['actions'] });
      toast.success(
        `Cleared ${res.data.bodiesCleared} ticket bodies and deleted ${res.data.rowsDeleted} row(s)`,
      );
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not prune the logs')),
  });

  const OPTIONS = [
    { value: 0, label: 'Keep everything' },
    { value: 30, label: '30 days' },
    { value: 90, label: '90 days' },
    { value: 180, label: '6 months' },
    { value: 365, label: '1 year' },
    { value: 730, label: '2 years' },
  ];

  return (
    <section className="border-t border-slate-200 pt-6 dark:border-slate-800">
      <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Log retention</h2>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
        Ticket bodies are cleared at a third of this window and the row is deleted at the end of it. The
        classification and your review survive the first stage, so accuracy figures are unaffected by it.
      </p>

      {storage && (
        <dl className="card mt-3 divide-y divide-slate-100 text-sm dark:divide-slate-800">
          <Field label="Log rows">{storage.rows.toLocaleString()}</Field>
          <Field label="Oldest entry">
            {storage.oldestAt ? formatDate(storage.oldestAt) : 'none yet'}
          </Field>
          <Field label="Ticket text stored">{formatBytes(storage.bodyBytes)}</Field>
          <Field label="Total text stored">{formatBytes(storage.totalBytes)}</Field>
        </dl>
      )}

      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setState('saving');
          try {
            await updateTenant(tenant.id, { logRetentionDays: days });
            markSaved();
            void queryClient.invalidateQueries({ queryKey: ['tenants'] });
            void queryClient.invalidateQueries({ queryKey: ['log-storage'] });
            toast.success(days === 0 ? 'Logs will be kept indefinitely' : `Retention set to ${days} days`);
          } catch (err) {
            setState('idle');
            toast.error(errorMessage(err, 'Could not save the retention window'));
          }
        }}
        className="mt-4 space-y-3"
      >
        <div>
          <label className="label">Keep action logs for</label>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="input">
            {OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex gap-2">
          <SaveButton state={state} />
          {(tenant.logRetentionDays ?? 0) > 0 && (
            <button
              type="button"
              onClick={() => prune.mutate()}
              disabled={prune.isPending}
              className="btn-secondary"
            >
              {prune.isPending ? <Spinner /> : null} Prune now
            </button>
          )}
        </div>
      </form>
    </section>
  );
}

// ─── Prompt ───────────────────────────────────────────────────────────────────

function PromptSection({ tenant }: { tenant: Tenant }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { state, setState, markSaved } = useSaveState();

  const [prompt, setPrompt] = useState(tenant.systemPromptOverride ?? '');
  const { data: defaultPrompt } = useQuery({
    queryKey: ['default-prompt', tenant.id],
    queryFn: () => getDefaultPrompt(tenant.id).then((r) => r.data.prompt),
  });

  const overriding = Boolean(tenant.systemPromptOverride);

  return (
    <div className="space-y-5">
      <Alert tone="info" title="Only override this once the data tells you to">
        The built-in prompt is tuned for the action list Swoop ships with. The usual reason to change it is a
        confusion pair on the Calibration page — add the distinction the model is missing, then re-run a few
        known tickets from the Dashboard to check it helped.
      </Alert>

      <div>
        <label className="label">Custom system prompt {overriding ? '' : '(not set — using the built-in prompt)'}</label>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={18}
          placeholder="Leave blank to use the built-in prompt."
          className="input font-mono text-xs"
          spellCheck={false}
        />
        <p className="hint">
          Your prompt replaces the built-in one entirely, so it must still ask for the same JSON shape — Swoop
          validates the response and escalates anything it cannot parse. Client context from the Clients page
          is not injected into a custom prompt.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          onClick={async () => {
            setState('saving');
            try {
              await updateTenant(tenant.id, { systemPromptOverride: prompt.trim() || null });
              markSaved();
              void queryClient.invalidateQueries({ queryKey: ['tenants'] });
              toast.success(prompt.trim() ? 'Custom prompt saved' : 'Reverted to the built-in prompt');
            } catch (err) {
              setState('idle');
              toast.error(errorMessage(err, 'Could not save the prompt'));
            }
          }}
          disabled={state === 'saving'}
          className="btn-primary"
        >
          {state === 'saving' ? <Spinner /> : null}
          {state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved' : 'Save prompt'}
        </button>

        {defaultPrompt && (
          <button onClick={() => setPrompt(defaultPrompt)} className="btn-secondary">
            Load the built-in prompt to edit
          </button>
        )}

        {prompt && (
          <button onClick={() => setPrompt('')} className="btn-ghost">
            Clear
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Diagnostics ──────────────────────────────────────────────────────────────

function DiagnosticsSection({ tenant }: { tenant: Tenant }) {
  const { data: status } = useQuery({
    queryKey: ['system-status'],
    queryFn: () => getSystemStatus().then((r) => r.data),
    refetchInterval: 15_000,
  });

  const { data: caps } = useQuery({
    queryKey: ['capabilities', tenant.id],
    queryFn: () => getCapabilities(tenant.id).then((r) => r.data),
  });

  const tenantStatus = status?.tenants.find((t) => t.id === tenant.id);

  return (
    <div className="space-y-6">
      <section>
        <h2 className="mb-3 text-sm font-semibold text-slate-900 dark:text-slate-100">Poll health</h2>
        <dl className="card divide-y divide-slate-100 text-sm dark:divide-slate-800">
          <Field label="Poller">
            {status?.poller.running ? (
              <Badge tone="success">Running</Badge>
            ) : (
              <Badge tone="danger">Stopped</Badge>
            )}
          </Field>
          <Field label="Last poll">{formatRelative(tenantStatus?.lastPollFinishedAt)}</Field>
          <Field label="Last result">
            {tenantStatus?.lastPollStatus === 'ok' ? (
              <Badge tone="success">OK</Badge>
            ) : tenantStatus?.lastPollStatus === 'error' ? (
              <Badge tone="danger">Error</Badge>
            ) : tenantStatus?.lastPollStatus ? (
              <Badge tone="warning">{tenantStatus.lastPollStatus}</Badge>
            ) : (
              <span className="text-slate-400">no polls yet</span>
            )}
          </Field>
          {tenantStatus?.lastPollError && (
            <Field label="Error">
              <span className="text-red-600 dark:text-red-400">{tenantStatus.lastPollError}</span>
            </Field>
          )}
          <Field label="Duration">{formatDuration(tenantStatus?.lastPollDurationMs)}</Field>
          <Field label="Tickets fetched">{tenantStatus?.lastPollTicketCount ?? '—'}</Field>
          <Field label="Watermark">{formatDateTime(tenantStatus?.lastPolledAt)}</Field>
        </dl>
      </section>

      <section>
        <h2 className="mb-1 text-sm font-semibold text-slate-900 dark:text-slate-100">
          Discovered SuperOps schema
        </h2>
        <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
          Rather than hardcoding field names, Swoop introspects your SuperOps GraphQL schema and builds its
          queries from what it finds. This is what it discovered.
        </p>

        {!caps?.capabilities ? (
          <Alert tone="warning" title="The schema has not been probed yet">
            Run the connection test on the SuperOps tab.
          </Alert>
        ) : (
          <CapabilityTable caps={caps.capabilities} probedAt={caps.probedAt} />
        )}
      </section>

      {status && (
        <section>
          <h2 className="mb-3 text-sm font-semibold text-slate-900 dark:text-slate-100">Install</h2>
          <dl className="card divide-y divide-slate-100 text-sm dark:divide-slate-800">
            <Field label="Version">{status.version}</Field>
            <Field label="Environment">{status.nodeEnv}</Field>
            <Field label="Secrets at rest">
              {status.encryptionEnabled ? (
                <Badge tone="success">Encrypted</Badge>
              ) : (
                <Badge tone="danger">Plaintext — set ENCRYPTION_KEY</Badge>
              )}
            </Field>
            <Field label="AI model">{tenantStatus?.aiModel ?? '—'}</Field>
            <Field label="Tenant ID">
              <code className="text-xs">{tenant.id}</code>
            </Field>
          </dl>
        </section>
      )}
    </div>
  );
}

function CapabilityTable({ caps, probedAt }: { caps: PsaCapabilities; probedAt?: number }) {
  return (
    <div className="space-y-3">
      {caps.warnings.length > 0 &&
        caps.warnings.map((warning) => (
          <Alert key={warning} tone="warning">
            {warning}
          </Alert>
        ))}

      <dl className="card divide-y divide-slate-100 text-sm dark:divide-slate-800">
        <Field label="Endpoint">
          <code className="text-xs">{caps.endpoint}</code>
        </Field>
        <Field label="Probed">{formatRelative(probedAt ?? caps.probedAt)}</Field>
        <Field label="Ticket list query">
          <Code value={caps.listQuery} />
        </Field>
        <Field label="Ticket detail query">
          <Code value={caps.detailQuery} />
        </Field>
        <Field label="Ticket body">
          <Code value={bodySource(caps)} missingLabel="not found — classification uses the subject only" />
        </Field>
        {caps.ticketFields && caps.ticketFields.length > 0 && (
          <Field label="Ticket fields">
            <span className="break-words font-mono text-xs text-slate-500">{caps.ticketFields.join(', ')}</span>
          </Field>
        )}
        <Field label="Ticket number field">
          <Code value={caps.displayIdField} />
        </Field>
        <Field label="Created-time field">
          <Code value={caps.createdField} />
        </Field>
        <Field label="Sorting">
          {caps.sortClause ? (
            <code className="text-xs">
              {caps.sortClause.attribute} {caps.sortClause.order}
            </code>
          ) : (
            <span className="text-xs text-slate-400">unsorted — pages are walked instead</span>
          )}
        </Field>
        <Field label="Client field">
          <span className="text-xs">
            {caps.client.fieldName ? (
              <>
                <code>{caps.client.fieldName}</code> ({caps.client.shape}
                {caps.client.idField ? `, id: ${caps.client.idField}` : ''})
              </>
            ) : (
              <span className="text-slate-400">not found</span>
            )}
          </span>
        </Field>
        <Field label="Note mutation">
          <Code value={caps.noteMutation} missingLabel="not found — Swoop cannot post notes" />
        </Field>
      </dl>
    </div>
  );
}

function Code({ value, missingLabel = 'not found' }: { value: string | null; missingLabel?: string }) {
  return value ? (
    <code className="text-xs">{value}</code>
  ) : (
    <span className="text-xs text-amber-600 dark:text-amber-400">{missingLabel}</span>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 px-4 py-2.5">
      <dt className="w-44 shrink-0 text-slate-500 dark:text-slate-400">{label}</dt>
      <dd className="min-w-0 break-words text-slate-800 dark:text-slate-200">{children}</dd>
    </div>
  );
}

// ─── Account ──────────────────────────────────────────────────────────────────

function AccountSection() {
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const { state, setState, markSaved } = useSaveState();

  const mismatch = next !== '' && confirm !== '' && next !== confirm;

  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        setError('');
        if (next !== confirm) {
          setError('The new passwords do not match.');
          return;
        }
        setState('saving');
        try {
          const res = await changePassword(current, next);
          // Changing the password signs out every other session; keep this one.
          if (res.data.token) setToken(res.data.token);
          setCurrent('');
          setNext('');
          setConfirm('');
          markSaved();
          toast.success(res.data.note ?? 'Password changed');
        } catch (err) {
          setState('idle');
          setError(errorMessage(err, 'Could not change the password'));
        }
      }}
      className="max-w-md space-y-5"
    >
      <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Change password</h2>

      {error && <Alert tone="danger">{error}</Alert>}

      <div>
        <label className="label">Current password</label>
        <input
          type="password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          required
          className="input"
          autoComplete="current-password"
        />
      </div>

      <div>
        <label className="label">New password</label>
        <input
          type="password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          required
          minLength={12}
          className="input"
          autoComplete="new-password"
        />
        <p className="hint">At least 12 characters.</p>
      </div>

      <div>
        <label className="label">Confirm new password</label>
        <input
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
          className="input"
          autoComplete="new-password"
        />
        {mismatch && <p className="mt-1 text-xs text-red-600 dark:text-red-400">These do not match.</p>}
      </div>

      <SaveButton state={state} disabled={!current || next.length < 12 || mismatch} />

      <div className="border-t border-slate-200 pt-5 dark:border-slate-800">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Sessions</h2>
        <p className="hint mb-3">Signs out every browser signed in to this account, including this one.</p>
        <button
          type="button"
          className="btn-secondary"
          onClick={async () => {
            try {
              await logoutEverywhere();
            } finally {
              setToken(null);
              window.location.assign('/login');
            }
          }}
        >
          Sign out everywhere
        </button>
      </div>
    </form>
  );
}
