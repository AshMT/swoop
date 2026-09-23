import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { errorMessage, getClients, updateTenant, type AgentSettings, type ExecutionPolicy, type Tenant } from '../../api';
import { actionLabel, useVocabulary } from '../../lib/session';
import { Alert, ConfirmDialog, LoadingState, Toggle, useToast } from '../ui';
import { NumberField, SaveBar, usePolicies } from './PolicySections';

// ─── Agent ─────────────────────────────────────────────────────────────────────

export function AgentSection({ tenant }: { tenant: Tenant }) {
  const { data, isLoading } = usePolicies(tenant.id);
  if (isLoading || !data) return <LoadingState />;
  return <AgentForm tenant={tenant} initial={data.agentSettings} />;
}

const AUTO_RUN: Array<{ id: AgentSettings['autoRun']; label: string; description: string }> = [
  { id: 'actions', label: 'Tickets proposing a change', description: 'Investigate before anyone approves a password reset, group or licence change.' },
  { id: 'all', label: 'Every ticket', description: 'Also investigate tickets for a technician. More model calls and CIPP reads.' },
  { id: 'manual', label: 'Only when asked', description: 'A reviewer presses Investigate on the ticket page.' },
];

function AgentForm({ tenant, initial }: { tenant: Tenant; initial: AgentSettings }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [value, setValue] = useState<AgentSettings>(initial);
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(value) !== JSON.stringify(initial);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await updateTenant(tenant.id, { agentSettings: { ...value, model: value.model?.trim() || null } });
      await queryClient.invalidateQueries({ queryKey: ['policies', tenant.id] });
      toast.success('Agent settings saved');
    } catch (err) {
      toast.error(errorMessage(err, 'Could not save'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-6">
      <Alert tone="info" title="The agent investigates; it cannot change anything">
        It works a ticket the way a technician would: looks the people involved up in Microsoft 365 (account, groups,
        licences, MFA, recent sign-ins), searches this client’s runbooks and past tickets, and writes up a diagnosis and
        a recommendation. Every lookup is limited to the ticket’s own client. Its tools only read.
      </Alert>

      {!tenant.cippEnabled && (
        <Alert tone="warning" title="CIPP is not connected">
          Without CIPP the agent can still read runbooks and past tickets, but not Microsoft 365.
        </Alert>
      )}

      <section className="card space-y-4 p-4">
        <Toggle
          checked={value.enabled}
          onChange={(on) => setValue((v) => ({ ...v, enabled: on }))}
          label="Investigate tickets"
          description="Off by default. Each investigation is several model calls and CIPP reads."
        />
        {value.enabled && (
          <div className="space-y-4 border-t border-slate-100 pt-4 dark:border-slate-800">
            <fieldset>
              <legend className="label">Run it automatically on</legend>
              <div className="space-y-2">
                {AUTO_RUN.map((o) => (
                  <label key={o.id} className="flex cursor-pointer items-start gap-2 text-sm">
                    <input
                      type="radio"
                      name="autoRun"
                      className="mt-1 accent-swoop-600"
                      checked={value.autoRun === o.id}
                      onChange={() => setValue((v) => ({ ...v, autoRun: o.id }))}
                    />
                    <span>
                      <span className="block text-slate-800 dark:text-slate-200">{o.label}</span>
                      <span className="block text-xs text-slate-500">{o.description}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div>
              <label className="label" htmlFor="agent-model">
                Model
              </label>
              <input
                id="agent-model"
                className="input"
                placeholder={tenant.aiModel ? `Same as triage (${tenant.aiModel})` : 'Same as triage'}
                value={value.model ?? ''}
                onChange={(e) => setValue((v) => ({ ...v, model: e.target.value }))}
              />
              <p className="hint">
                Must support tool calling on your AI provider. Small local models often pick tools badly — a stronger model
                here pays for itself. Uses the provider set on the AI provider tab.
              </p>
            </div>
            <NumberField
              label="Lookups per investigation"
              value={value.maxSteps}
              min={2}
              max={15}
              onChange={(n) => setValue((v) => ({ ...v, maxSteps: n }))}
              hint="After this many, the agent must answer with what it has."
            />
          </div>
        )}
      </section>

      <p className="text-sm text-slate-500">
        The agent reads runbooks from the{' '}
        <Link to="/knowledge" className="font-medium text-swoop-700 hover:underline dark:text-swoop-300">
          Knowledge
        </Link>{' '}
        page, including articles synced from SuperOps.
      </p>

      <SaveBar saving={saving} dirty={dirty} />
    </form>
  );
}

// ─── Execution ─────────────────────────────────────────────────────────────────

export function ExecutionSection({ tenant }: { tenant: Tenant }) {
  const { data, isLoading } = usePolicies(tenant.id);
  if (isLoading || !data) return <LoadingState />;
  return (
    <ExecutionForm
      tenant={tenant}
      initial={data.executionPolicy}
      disabledByInstall={data.executionDisabledByInstall}
      executable={data.executableActions}
    />
  );
}

const MODES: Array<{ id: ExecutionPolicy['mode']; label: string; description: string }> = [
  { id: 'off', label: 'Off', description: 'Swoop proposes and plans. A technician makes every change.' },
  {
    id: 'dry_run',
    label: 'Dry runs only',
    description: 'Approvers can have Swoop resolve a plan against the live tenant and show exactly what it would send. Nothing is sent.',
  },
  {
    id: 'live',
    label: 'Live',
    description: 'Approved changes can be carried out through CIPP, for the actions and clients below, and read back from the tenant to confirm.',
  },
];

function ExecutionForm({
  tenant,
  initial,
  disabledByInstall,
  executable,
}: {
  tenant: Tenant;
  initial: ExecutionPolicy;
  disabledByInstall: boolean;
  executable: string[];
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { data: vocabulary } = useVocabulary();
  const { data: clients } = useQuery({ queryKey: ['clients', tenant.id], queryFn: () => getClients(tenant.id).then((r) => r.data) });
  const [value, setValue] = useState<ExecutionPolicy>(initial);
  const [saving, setSaving] = useState(false);
  const [confirmLive, setConfirmLive] = useState(false);
  const dirty = JSON.stringify(value) !== JSON.stringify(initial);
  const goingLive = value.mode === 'live' && initial.mode !== 'live';
  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  const save = async () => {
    setSaving(true);
    try {
      await updateTenant(tenant.id, { executionPolicy: value });
      await queryClient.invalidateQueries({ queryKey: ['policies', tenant.id] });
      await queryClient.invalidateQueries({ queryKey: ['executions'] });
      toast.success(value.mode === 'live' ? 'Execution is live' : 'Execution settings saved');
    } catch (err) {
      toast.error(errorMessage(err, 'Could not save'));
    } finally {
      setSaving(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (goingLive) setConfirmLive(true);
    else void save();
  };

  const mapped = (clients ?? []).filter((c) => c.m365DefaultDomain || c.m365TenantId);
  const unmapped = (clients ?? []).filter((c) => !c.m365DefaultDomain && !c.m365TenantId);

  return (
    <form onSubmit={submit} className="space-y-6">
      {disabledByInstall && (
        <Alert tone="danger" title="Switched off for this whole install">
          SWOOP_DISABLE_EXECUTION is set, so nothing runs whatever is chosen here. Remove it from the environment and
          restart to use these settings.
        </Alert>
      )}

      <Alert tone="warning" title="This lets Swoop change your clients’ Microsoft 365 tenants">
        Only approved proposals run, only for the actions and clients you tick, and only through CIPP. Before sending,
        Swoop resolves every user, group and licence against the live tenant and refuses anything ambiguous; afterwards it
        reads the tenant back to confirm. Identity-sensitive changes need an approver who recorded how the requester was
        verified. Every run is audited and noted on the ticket.
      </Alert>

      <section className="card space-y-3 p-4">
        <div className="label">Mode</div>
        {MODES.map((m) => (
          <label
            key={m.id}
            className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${
              value.mode === m.id
                ? m.id === 'live'
                  ? 'border-eye-400 bg-eye-50 dark:border-eye-700 dark:bg-eye-900/30'
                  : 'border-swoop-400 bg-swoop-50/50 dark:border-swoop-700 dark:bg-swoop-900/20'
                : 'border-slate-200 dark:border-slate-800'
            }`}
          >
            <input
              type="radio"
              name="mode"
              className="mt-1 accent-swoop-600"
              checked={value.mode === m.id}
              onChange={() => setValue((v) => ({ ...v, mode: m.id }))}
            />
            <span>
              <span className="block text-sm font-medium text-slate-800 dark:text-slate-200">{m.label}</span>
              <span className="block text-xs text-slate-500">{m.description}</span>
            </span>
          </label>
        ))}
      </section>

      {value.mode !== 'off' && (
        <>
          <section className="card space-y-4 p-4">
            <div>
              <div className="label">Actions Swoop may run</div>
              <p className="hint !mt-0 mb-2">Nothing is ticked by default. Mailbox permissions stay plan-only for now.</p>
              <div className="flex flex-wrap gap-1.5">
                {executable.map((id) => {
                  const on = value.actions.includes(id);
                  const sensitive = vocabulary?.attestationActions?.includes(id);
                  return (
                    <button
                      type="button"
                      key={id}
                      onClick={() => setValue((v) => ({ ...v, actions: toggle(v.actions, id) }))}
                      title={sensitive ? 'An approver must record how the requester’s identity was verified' : undefined}
                      className={`rounded-md px-2.5 py-1 text-xs font-medium ${on ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900' : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'}`}
                    >
                      {actionLabel(vocabulary, id)}
                      {sensitive ? ' · ID check' : ''}
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <div className="label">Clients Swoop may change</div>
              <p className="hint !mt-0 mb-2">
                None ticked means none. A client added later is never included until you tick it. Clients need a Microsoft
                365 domain on the Clients page.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {mapped.map((c) => {
                  const on = value.clientIds.includes(c.id);
                  return (
                    <button
                      type="button"
                      key={c.id}
                      onClick={() => setValue((v) => ({ ...v, clientIds: toggle(v.clientIds, c.id) }))}
                      className={`rounded-md px-2.5 py-1 text-xs font-medium ${on ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900' : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'}`}
                    >
                      {c.name}
                    </button>
                  );
                })}
                {mapped.length === 0 && <span className="text-sm text-slate-500">No client has a Microsoft 365 domain yet.</span>}
              </div>
              {unmapped.length > 0 && (
                <p className="hint">
                  Not mappable yet: {unmapped.slice(0, 8).map((c) => c.name).join(', ')}
                  {unmapped.length > 8 ? ` and ${unmapped.length - 8} more` : ''}.
                </p>
              )}
            </div>
          </section>

          <section className="card space-y-4 p-4">
            <Toggle
              checked={value.requireDryRun}
              onChange={(on) => setValue((v) => ({ ...v, requireDryRun: on }))}
              label="Require a dry run first"
              description="A live run needs a passing dry run of the same proposal from the last 24 hours. Recommended."
            />
            <Toggle
              checked={value.runOnApproval}
              disabled={value.mode !== 'live'}
              onChange={(on) => setValue((v) => ({ ...v, runOnApproval: on }))}
              label="Run as soon as it is approved"
              description="Skips the Run button: the last approval starts the dry run and then the live run. Auto-approval never triggers identity-sensitive changes."
            />
            <Toggle
              checked={value.postResultNote}
              onChange={(on) => setValue((v) => ({ ...v, postResultNote: on }))}
              label="Post the result to the ticket"
              description="A private note with what was sent, what the tenant showed afterwards, and how to undo it."
            />
            <Toggle
              checked={value.replyToRequester}
              onChange={(on) => setValue((v) => ({ ...v, replyToRequester: on }))}
              label="Tell the requester when it is done"
              description="A short public reply once the change is confirmed. Never includes a password."
            />
          </section>

          <Alert tone="info" title="CIPP permissions">
            The CIPP API client needs a role that can write users and groups. With a read-only role every run stops safely at
            the first write and says so.
          </Alert>
        </>
      )}

      <SaveBar saving={saving} dirty={dirty} />

      <ConfirmDialog
        open={confirmLive}
        destructive
        title="Let Swoop change client tenants?"
        description={`From now on, approvers can have Swoop run ${value.actions.length} kind${value.actions.length === 1 ? '' : 's'} of change for ${value.clientIds.length} client${value.clientIds.length === 1 ? '' : 's'}${value.runOnApproval ? ', starting automatically on approval' : ''}. This is recorded in the audit log.`}
        confirmLabel="Go live"
        onConfirm={() => {
          setConfirmLive(false);
          void save();
        }}
        onCancel={() => setConfirmLive(false)}
      />
    </form>
  );
}
