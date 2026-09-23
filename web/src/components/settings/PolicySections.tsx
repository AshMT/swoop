import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  errorMessage,
  getClients,
  getPolicies,
  testCipp,
  updateTenant,
  type ApprovalPolicy,
  type Tenant,
  type TriageSettings,
} from '../../api';
import { Alert, LoadingState, Spinner, Toggle, useToast } from '../ui';
import { useVocabulary } from '../../lib/session';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function SaveBar({ saving, dirty }: { saving: boolean; dirty: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <button type="submit" className="btn-primary" disabled={saving || !dirty}>
        {saving ? <Spinner /> : null} {saving ? 'Saving…' : 'Save'}
      </button>
      {dirty && !saving && <span className="text-xs text-slate-500">Unsaved changes</span>}
    </div>
  );
}

export function usePolicies(tenantId: string) {
  return useQuery({
    queryKey: ['policies', tenantId],
    queryFn: () => getPolicies(tenantId).then((r) => r.data),
  });
}

// ─── Triage rules ──────────────────────────────────────────────────────────────

export function TriageSection({ tenant }: { tenant: Tenant }) {
  const { data, isLoading } = usePolicies(tenant.id);
  if (isLoading || !data) return <LoadingState />;
  return <TriageForm tenant={tenant} initial={data.triageSettings} categories={data.categories} />;
}

function TriageForm({
  tenant,
  initial,
  categories,
}: {
  tenant: Tenant;
  initial: TriageSettings;
  categories: Array<{ id: string; label: string; defaultQueue: string }>;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [value, setValue] = useState<TriageSettings>(initial);
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(value) !== JSON.stringify(initial);
  const set = <K extends keyof TriageSettings>(key: K, v: TriageSettings[K]) => setValue((prev) => ({ ...prev, [key]: v }));
  const hours = value.businessHours;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await updateTenant(tenant.id, { triageSettings: value });
      await queryClient.invalidateQueries({ queryKey: ['policies', tenant.id] });
      toast.success('Triage rules saved — they apply from the next ticket');
    } catch (err) {
      toast.error(errorMessage(err, 'Could not save the triage rules'));
    } finally {
      setSaving(false);
    }
  };

  // Newer than this project's TypeScript lib target, so feature-detected.
  const intl = Intl as unknown as { supportedValuesOf?: (key: 'timeZone') => string[] };
  const zones: string[] = typeof intl.supportedValuesOf === 'function' ? intl.supportedValuesOf('timeZone') : [];

  return (
    <form onSubmit={submit} className="space-y-6">
      <section className="card space-y-4 p-4">
        <div>
          <h2 className="text-sm font-semibold">Business hours</h2>
          <p className="hint">Urgent tickets raised outside these hours go to the out-of-hours queue.</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="sm:col-span-3">
            <label className="label">Timezone</label>
            {zones.length > 0 ? (
              <select className="input" value={hours.timezone} onChange={(e) => set('businessHours', { ...hours, timezone: e.target.value })}>
                {!zones.includes(hours.timezone) && <option value={hours.timezone}>{hours.timezone}</option>}
                {zones.map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </select>
            ) : (
              <input className="input" value={hours.timezone} onChange={(e) => set('businessHours', { ...hours, timezone: e.target.value })} />
            )}
          </div>
          <div>
            <label className="label">Opens</label>
            <input type="time" className="input" value={hours.start} onChange={(e) => set('businessHours', { ...hours, start: e.target.value })} />
          </div>
          <div>
            <label className="label">Closes</label>
            <input type="time" className="input" value={hours.end} onChange={(e) => set('businessHours', { ...hours, end: e.target.value })} />
          </div>
          <div>
            <label className="label">Out-of-hours queue</label>
            <input className="input" value={value.afterHoursQueue} placeholder="Leave empty to turn off" onChange={(e) => set('afterHoursQueue', e.target.value)} />
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {DAYS.map((label, index) => {
            const day = index + 1;
            const on = hours.days.includes(day);
            return (
              <button
                type="button"
                key={label}
                onClick={() =>
                  set('businessHours', {
                    ...hours,
                    days: on ? hours.days.filter((d) => d !== day) : [...hours.days, day].sort(),
                  })
                }
                className={`rounded-md px-2.5 py-1 text-xs font-medium ${on ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900' : 'bg-slate-100 text-slate-500 dark:bg-slate-800'}`}
              >
                {label}
              </button>
            );
          })}
        </div>
      </section>

      <section className="card p-4">
        <h2 className="text-sm font-semibold">Queue routing</h2>
        <p className="hint mb-3">Which queue each category goes to. Security findings always go to the Security queue.</p>
        <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
          {categories.map((c) => (
            <div key={c.id} className="flex items-center gap-2">
              <span className="w-44 shrink-0 text-sm text-slate-600 dark:text-slate-300">{c.label}</span>
              <input
                className="input py-1"
                placeholder={c.defaultQueue}
                value={value.queueRouting[c.id] ?? ''}
                onChange={(e) => {
                  const next = { ...value.queueRouting };
                  if (e.target.value.trim()) next[c.id] = e.target.value;
                  else delete next[c.id];
                  set('queueRouting', next);
                }}
              />
            </div>
          ))}
        </div>
      </section>

      <section className="card space-y-4 p-4">
        <h2 className="text-sm font-semibold">Patterns</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField label="Incident: similar tickets needed" value={value.clusterThreshold} min={2} max={50} onChange={(v) => set('clusterThreshold', v)} hint="How many alike tickets make a possible incident." />
          <NumberField label="Incident: within minutes" value={value.clusterWindowMinutes} min={5} max={1440} onChange={(v) => set('clusterWindowMinutes', v)} />
          <NumberField label="Duplicate window (hours)" value={value.duplicateWindowHours} min={1} max={336} onChange={(v) => set('duplicateWindowHours', v)} hint="Same requester, same problem, within this window." />
          <NumberField label="Repeat requester after" value={value.repeatRequesterThreshold} min={2} max={50} onChange={(v) => set('repeatRequesterThreshold', v)} hint="Tickets in 7 days before it is called out." />
        </div>
        <Toggle
          checked={value.useReviewedExamples}
          onChange={(on) => set('useReviewedExamples', on)}
          label="Learn from reviewed tickets"
          description="Show the model up to three similar tickets a technician has already confirmed or corrected. The cheapest accuracy gain there is."
        />
      </section>

      <SaveBar saving={saving} dirty={dirty} />
    </form>
  );
}

export function NumberField({
  label,
  value,
  min,
  max,
  onChange,
  hint,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  hint?: string;
}) {
  return (
    <div>
      <label className="label">{label}</label>
      <input
        type="number"
        className="input"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Math.min(max, Math.max(min, Number(e.target.value) || min)))}
      />
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}

// ─── Approvals ─────────────────────────────────────────────────────────────────

export function ApprovalSection({ tenant }: { tenant: Tenant }) {
  const { data, isLoading } = usePolicies(tenant.id);
  if (isLoading || !data) return <LoadingState />;
  return <ApprovalForm tenant={tenant} initial={data.approvalPolicy} />;
}

function ApprovalForm({ tenant, initial }: { tenant: Tenant; initial: ApprovalPolicy }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { data: vocabulary } = useVocabulary();
  const { data: clients } = useQuery({ queryKey: ['clients', tenant.id], queryFn: () => getClients(tenant.id).then((r) => r.data) });
  const [value, setValue] = useState<ApprovalPolicy>(initial);
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(value) !== JSON.stringify(initial);
  const auto = value.autoApprove;
  const setAuto = (patch: Partial<ApprovalPolicy['autoApprove']>) => setValue((v) => ({ ...v, autoApprove: { ...v.autoApprove, ...patch } }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await updateTenant(tenant.id, { approvalPolicy: value });
      await queryClient.invalidateQueries({ queryKey: ['policies', tenant.id] });
      toast.success('Approval policy saved');
    } catch (err) {
      toast.error(errorMessage(err, 'Could not save the policy'));
    } finally {
      setSaving(false);
    }
  };

  const eligible = (vocabulary?.actions ?? []).filter((a) => a.id !== 'ESCALATE' && a.id !== 'FOLLOW_UP');

  return (
    <form onSubmit={submit} className="space-y-6">
      <Alert tone="info" title="Approval signs off a plan">
        Every proposed change waits for a person. Approving records who agreed and posts the plan to the ticket. Whether
        Swoop then carries it out is a separate choice, under Execution — off by default, in which case a technician does.
        Password, MFA and sign-in changes always ask the approver how they confirmed the requester’s identity.
      </Alert>

      <section className="card space-y-4 p-4">
        <Toggle
          checked={value.dualApprovalForSensitive}
          onChange={(on) => setValue((v) => ({ ...v, dualApprovalForSensitive: on }))}
          label="Two people for sensitive changes"
          description="MFA resets, disabling or enabling accounts, mailbox access, and anything flagged high sensitivity need two different approvers."
        />
        <Toggle
          checked={value.postDecisionNotes}
          onChange={(on) => setValue((v) => ({ ...v, postDecisionNotes: on }))}
          label="Post decisions to the ticket"
          description="A private note with who approved and the plan to follow."
        />
        <NumberField
          label="Proposals expire after (hours)"
          value={value.expiryHours}
          min={1}
          max={720}
          onChange={(v) => setValue((p) => ({ ...p, expiryHours: v }))}
          hint="An old approval is a risk: the situation may have changed. Re-run the ticket for a fresh one."
        />
      </section>

      <section className="card space-y-4 p-4">
        <Toggle
          checked={auto.enabled}
          onChange={(on) => setAuto({ enabled: on })}
          label="Auto-approve routine, confident proposals"
          description="Off until the Calibration page shows you trust it. Never applies to sensitive actions, high-sensitivity or cross-client tickets, or anything with a warning flag or plan blocker."
        />
        {auto.enabled && (
          <div className="space-y-4 border-t border-slate-100 pt-4 dark:border-slate-800">
            <div>
              <label className="label">Minimum confidence — {Math.round(auto.minConfidence * 100)}%</label>
              <input type="range" min={0.5} max={1} step={0.01} value={auto.minConfidence} onChange={(e) => setAuto({ minConfidence: Number(e.target.value) })} className="w-full accent-swoop-600" />
            </div>
            <div>
              <label className="label">Actions</label>
              <div className="flex flex-wrap gap-1.5">
                {eligible.map((a) => {
                  const on = auto.actions.includes(a.id);
                  return (
                    <button
                      type="button"
                      key={a.id}
                      disabled={a.sensitive}
                      title={a.sensitive ? 'Sensitive actions always need a person' : undefined}
                      onClick={() => setAuto({ actions: on ? auto.actions.filter((x) => x !== a.id) : [...auto.actions, a.id] })}
                      className={`rounded-md px-2.5 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-40 ${on ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900' : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'}`}
                    >
                      {a.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <label className="label">Clients</label>
              <p className="hint !mt-0 mb-1.5">None selected means every client.</p>
              <div className="flex flex-wrap gap-1.5">
                {clients?.map((c) => {
                  const on = auto.clientIds.includes(c.id);
                  return (
                    <button
                      type="button"
                      key={c.id}
                      onClick={() => setAuto({ clientIds: on ? auto.clientIds.filter((x) => x !== c.id) : [...auto.clientIds, c.id] })}
                      className={`rounded-md px-2.5 py-1 text-xs font-medium ${on ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900' : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'}`}
                    >
                      {c.name}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </section>

      <SaveBar saving={saving} dirty={dirty} />
    </form>
  );
}

// ─── CIPP ──────────────────────────────────────────────────────────────────────

export function CippSection({ tenant }: { tenant: Tenant }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [apiUrl, setApiUrl] = useState(tenant.cippApiUrl ?? '');
  const [entraTenant, setEntraTenant] = useState(tenant.cippTenantId ?? '');
  const [clientId, setClientId] = useState(tenant.cippClientId ?? '');
  const [secret, setSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string; tenants?: string[] } | null>(null);

  useEffect(() => {
    setApiUrl(tenant.cippApiUrl ?? '');
    setEntraTenant(tenant.cippTenantId ?? '');
    setClientId(tenant.cippClientId ?? '');
  }, [tenant.cippApiUrl, tenant.cippTenantId, tenant.cippClientId]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await updateTenant(tenant.id, {
        cippApiUrl: apiUrl.trim() || null,
        cippTenantId: entraTenant.trim() || null,
        cippClientId: clientId.trim() || null,
        ...(secret.trim() ? { cippClientSecret: secret.trim() } : {}),
      });
      setSecret('');
      await queryClient.invalidateQueries({ queryKey: ['tenants'] });
      toast.success('CIPP connection saved');
    } catch (err) {
      toast.error(errorMessage(err, 'Could not save'));
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      const res = await testCipp(tenant.id);
      setResult({
        ok: true,
        message: `Connected. This client can see ${res.data.tenantCount} tenant${res.data.tenantCount === 1 ? '' : 's'}.`,
        tenants: res.data.tenants?.map((t) => t.domain ?? t.name ?? '').filter(Boolean).slice(0, 12),
      });
    } catch (err) {
      setResult({ ok: false, message: errorMessage(err, 'The test failed') });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="space-y-6">
      <Alert tone="info" title="Read-only lookups">
        With CIPP connected, Swoop looks up the user a proposal is about — whether the account exists, is enabled,
        synced from on-premises, licensed and MFA-registered — so an approver sees the facts before agreeing. Lookups
        only send GET requests. Changes are sent only when Execution is switched on, for the clients and actions you
        allow there.
      </Alert>

      <section className="card space-y-4 p-4">
        <Toggle
          checked={Boolean(tenant.cippEnabled)}
          onChange={async (on) => {
            try {
              await updateTenant(tenant.id, { cippEnabled: on });
              await queryClient.invalidateQueries({ queryKey: ['tenants'] });
              toast.success(on ? 'CIPP lookups on' : 'CIPP lookups off');
            } catch (err) {
              toast.error(errorMessage(err, 'Could not change the setting'));
            }
          }}
          label="Look users up in CIPP"
          description="Needs each client's Microsoft 365 default domain set on the Clients page."
        />
      </section>

      <form onSubmit={save} className="card space-y-4 p-4">
        <div>
          <label className="label">CIPP API URL</label>
          <input className="input font-mono" placeholder="https://cipp-xxxx.azurewebsites.net" value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label">Your Entra tenant ID</label>
            <input className="input font-mono" placeholder="GUID" value={entraTenant} onChange={(e) => setEntraTenant(e.target.value)} />
            <p className="hint">The MSP's own tenant, where the CIPP-API app registration lives — not a client's.</p>
          </div>
          <div>
            <label className="label">Client ID</label>
            <input className="input font-mono" placeholder="GUID" value={clientId} onChange={(e) => setClientId(e.target.value)} />
          </div>
        </div>
        <div>
          <label className="label">Client secret</label>
          <input
            type="password"
            className="input font-mono"
            autoComplete="off"
            placeholder={tenant.hasCippClientSecret ? 'Saved — enter a new one to replace it' : 'The secret Value, not its ID'}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
          <p className="hint">Encrypted at rest. Add the app under CIPP → Integrations → CIPP-API and enable it first.</p>
        </div>
        <div className="flex gap-2">
          <button type="submit" className="btn-primary" disabled={saving}>
            {saving ? <Spinner /> : null} Save
          </button>
          <button type="button" className="btn-secondary" onClick={test} disabled={testing || !tenant.cippApiUrl}>
            {testing ? <Spinner /> : null} Test connection
          </button>
        </div>
        {result && (
          <Alert tone={result.ok ? 'success' : 'danger'} title={result.message}>
            {result.tenants && result.tenants.length > 0 && <span className="font-mono text-xs">{result.tenants.join(', ')}</span>}
          </Alert>
        )}
      </form>
    </div>
  );
}
