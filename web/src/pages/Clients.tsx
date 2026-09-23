import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createClient,
  deleteClient,
  errorMessage,
  getClients,
  getPsaClients,
  getSuggestedDomains,
  getTenants,
  updateClient,
  type Client,
} from '../api';
import {
  Alert,
  Badge,
  ConfirmDialog,
  EmptyState,
  LoadingState,
  PageHeader,
  Toggle,
  useToast,
} from '../components/ui';
import { TrashIcon } from '../components/Icons';
import { formatRelative } from '../lib/format';
import { useCan } from '../lib/session';

/** Splits what someone typed or pasted into a clean list. */
function splitList(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

export default function Clients() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const isAdmin = useCan('admin');

  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<Client | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Client | null>(null);

  const { data: tenants } = useQuery({ queryKey: ['tenants'], queryFn: () => getTenants().then((r) => r.data) });
  const tenantId = tenants?.[0]?.id ?? '';

  const { data: clients = [], isLoading } = useQuery({
    queryKey: ['clients', tenantId],
    queryFn: () => getClients(tenantId).then((r) => r.data),
    enabled: Boolean(tenantId),
  });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['clients'] });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      updateClient(id, { automationEnabled: enabled }),
    onSuccess: (_res, variables) => {
      invalidate();
      toast.success(variables.enabled ? 'Automation enabled' : 'Automation disabled');
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not change the automation setting')),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteClient(id),
    onSuccess: () => {
      invalidate();
      setPendingDelete(null);
      toast.success('Client removed — its classification history was kept');
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not remove the client')),
  });

  const enabledCount = clients.filter((c) => c.automationEnabled).length;

  if (!tenantId) {
    return (
      <div>
        <PageHeader title="Clients" />
        <div className="card">
          <EmptyState
            title="No SuperOps connection yet"
            description="Connect SuperOps in Settings before adding clients."
          />
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Clients"
        description="Swoop only reads tickets from clients you enable here. Everything else is skipped without being logged."
        actions={
          isAdmin ? (
            <button onClick={() => setShowAdd(true)} className="btn-primary">
              Add client
            </button>
          ) : null
        }
      />

      {clients.length > 0 && enabledCount === 0 && (
        <div className="mb-4">
          <Alert tone="warning" title="No clients have automation enabled">
            Swoop is polling SuperOps but discarding every ticket, because the allowlist is empty. Enable one
            client to start.
          </Alert>
        </div>
      )}

      {showAdd && (
        <ClientForm
          tenantId={tenantId}
          existing={clients}
          onClose={() => setShowAdd(false)}
          onSaved={() => {
            setShowAdd(false);
            invalidate();
            toast.success('Client added');
          }}
        />
      )}

      {editing && (
        <ClientForm
          tenantId={tenantId}
          existing={clients}
          client={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            invalidate();
            toast.success('Client updated');
          }}
        />
      )}

      <div className="card overflow-hidden">
        {isLoading ? (
          <LoadingState label="Loading clients" />
        ) : clients.length === 0 ? (
          <EmptyState
            title="No clients yet"
            description="Add a client and give it the SuperOps company ID so Swoop can match its tickets. Start with one, and enable more once the agreement rate looks right."
            action={
              <button onClick={() => setShowAdd(true)} className="btn-primary">
                Add your first client
              </button>
            }
          />
        ) : (
          <table className="w-full">
            <thead className="border-b border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/60">
              <tr>
                <th className="th">Client</th>
                <th className="th">SuperOps company ID</th>
                <th className="th">Recognised by</th>
                <th className="th">Automation</th>
                <th className="th text-right">Classified</th>
                <th className="th">Last activity</th>
                <th className="th" />
              </tr>
            </thead>
            <tbody>
              {clients.map((client) => (
                <tr key={client.id} className="border-b border-slate-100 dark:border-slate-800/60">
                  <td className="td">
                    <button
                      onClick={() => isAdmin && setEditing(client)}
                      className="font-medium text-slate-900 hover:text-swoop-600 dark:text-slate-100 dark:hover:text-swoop-400"
                    >
                      {client.name}
                    </button>
                    {client.contextNotes && (
                      <p
                        className="mt-0.5 max-w-sm truncate text-xs text-slate-400 dark:text-slate-500"
                        title={client.contextNotes}
                      >
                        {client.contextNotes}
                      </p>
                    )}
                    {client.systemPromptOverride && (
                      <Badge tone="info" className="mt-1">
                        Custom prompt
                      </Badge>
                    )}
                  </td>
                  <td className="td font-mono text-xs">
                    {client.superopsCompanyId || (
                      <span className="font-sans text-slate-400" title="Swoop will fall back to matching on the client name">
                        matching by name
                      </span>
                    )}
                  </td>
                  <td className="td text-xs">
                    {client.emailDomains.length > 0 ? (
                      <span className="text-slate-600 dark:text-slate-300">{client.emailDomains.join(', ')}</span>
                    ) : (
                      <span className="text-amber-600 dark:text-amber-400" title="Without domains Swoop cannot spot a request from outside this client">
                        No domains
                      </span>
                    )}
                    {client.m365DefaultDomain && (
                      <div className="mt-0.5 text-slate-400" title="Microsoft 365 tenant">
                        M365: {client.m365DefaultDomain}
                      </div>
                    )}
                    {client.vipEmails.length > 0 && (
                      <div className="mt-0.5 text-slate-400">{client.vipEmails.length} VIP{client.vipEmails.length === 1 ? '' : 's'}</div>
                    )}
                  </td>
                  <td className="td">
                    <Toggle
                      checked={client.automationEnabled}
                      disabled={toggle.isPending || !isAdmin}
                      label={client.automationEnabled ? 'Enabled' : 'Disabled'}
                      onChange={(enabled) => toggle.mutate({ id: client.id, enabled })}
                    />
                  </td>
                  <td className="td tnum text-right">{client.actionCount ?? 0}</td>
                  <td className="td text-xs text-slate-400">
                    {client.lastActionAt ? formatRelative(client.lastActionAt) : 'never'}
                  </td>
                  <td className="td text-right">
                    {isAdmin && (
                    <button
                      onClick={() => setPendingDelete(client)}
                      className="rounded p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950"
                      aria-label={`Remove ${client.name}`}
                      title={`Remove ${client.name}`}
                    >
                      <TrashIcon />
                    </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="mt-4 text-xs text-slate-500 dark:text-slate-400">
        <Badge tone="info">How matching works</Badge> Swoop matches a ticket to a client by SuperOps company ID,
        then by exact client name, then by the requester's email domain. Domains also let Swoop notice a request
        from one client about another client's user — a common social-engineering pattern — and escalate it.
      </p>

      <ConfirmDialog
        open={pendingDelete !== null}
        title={`Remove ${pendingDelete?.name ?? 'this client'}?`}
        description="Swoop will stop reading their tickets. Their classification history is kept for your records."
        confirmLabel="Remove client"
        destructive
        onConfirm={() => pendingDelete && remove.mutate(pendingDelete.id)}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}

function ClientForm({
  tenantId,
  client,
  existing,
  onClose,
  onSaved,
}: {
  tenantId: string;
  client?: Client;
  existing: Client[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(client?.name ?? '');
  const [companyId, setCompanyId] = useState(client?.superopsCompanyId ?? '');
  const [contextNotes, setContextNotes] = useState(client?.contextNotes ?? '');
  const [promptOverride, setPromptOverride] = useState(client?.systemPromptOverride ?? '');
  const [showPrompt, setShowPrompt] = useState(Boolean(client?.systemPromptOverride));
  const [enabled, setEnabled] = useState(client?.automationEnabled ?? false);
  const [domains, setDomains] = useState((client?.emailDomains ?? []).join(', '));
  const [m365Domain, setM365Domain] = useState(client?.m365DefaultDomain ?? '');
  const [m365TenantId, setM365TenantId] = useState(client?.m365TenantId ?? '');
  const [vips, setVips] = useState((client?.vipEmails ?? []).join('\n'));
  const [error, setError] = useState('');

  // Domains already seen on this client's tickets — one click to add them.
  const { data: suggested } = useQuery({
    queryKey: ['suggested-domains', client?.id],
    queryFn: () => getSuggestedDomains(client!.id).then((r) => r.data.suggestions),
    enabled: Boolean(client),
  });
  const currentDomains = splitList(domains).map((d) => d.toLowerCase());
  const suggestions = (suggested ?? []).filter((s) => !currentDomains.includes(s.domain));

  // Offered as a picker when the SuperOps schema exposes a client list, which
  // saves the operator hunting for a company ID. Falls back to typing.
  const { data: psa, isLoading: psaLoading } = useQuery({
    queryKey: ['psa-clients', tenantId],
    queryFn: () => getPsaClients(tenantId).then((r) => r.data),
    // A wrong company ID is silent — the client simply never matches — so it is
    // worth one request, but not worth retrying if SuperOps is unhappy.
    retry: false,
    staleTime: 5 * 60_000,
  });

  const alreadyAdded = new Set(
    existing.filter((c) => c.id !== client?.id).map((c) => c.superopsCompanyId ?? ''),
  );
  const pickable = (psa?.companies ?? []).filter((c) => !alreadyAdded.has(c.id));

  const save = useMutation({
    mutationFn: () =>
      client
        ? updateClient(client.id, {
            name: name.trim(),
            superopsCompanyId: companyId.trim() || null,
            contextNotes: contextNotes.trim() || null,
            systemPromptOverride: promptOverride.trim() || null,
            automationEnabled: enabled,
            emailDomains: splitList(domains),
            m365DefaultDomain: m365Domain.trim() || null,
            m365TenantId: m365TenantId.trim() || null,
            vipEmails: splitList(vips),
          })
        : createClient({
            tenantId,
            name: name.trim(),
            superopsCompanyId: companyId.trim() || undefined,
            contextNotes: contextNotes.trim() || undefined,
            systemPromptOverride: promptOverride.trim() || undefined,
            automationEnabled: enabled,
            emailDomains: splitList(domains),
            m365DefaultDomain: m365Domain.trim() || null,
            m365TenantId: m365TenantId.trim() || null,
            vipEmails: splitList(vips),
          }),
    onSuccess: onSaved,
    onError: (err) => setError(errorMessage(err, 'Could not save the client')),
  });

  return (
    <div className="card mb-5 p-5">
      <h3 className="mb-4 text-sm font-semibold text-slate-900 dark:text-slate-100">
        {client ? `Edit ${client.name}` : 'Add client'}
      </h3>

      {error && (
        <div className="mb-4">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError('');
          if (!name.trim()) return;
          save.mutate();
        }}
        className="space-y-4"
      >
        {psa?.available && pickable.length > 0 && (
          <div>
            <label className="label">Pick from SuperOps</label>
            <select
              value=""
              onChange={(e) => {
                const chosen = pickable.find((c) => c.id === e.target.value);
                if (!chosen) return;
                setName(chosen.name);
                setCompanyId(chosen.id);
              }}
              className="input"
            >
              <option value="">
                {psaLoading ? 'Loading your SuperOps clients…' : 'Choose a client…'}
              </option>
              {pickable.map((company) => (
                <option key={company.id} value={company.id}>
                  {company.name}
                </option>
              ))}
            </select>
            <p className="hint">
              Fills in the name and company ID for you. Clients you have already added are left out.
            </p>
          </div>
        )}

        {psa && !psa.available && (
          <p className="hint !mt-0">
            {psa.error
              ? `Could not list your SuperOps clients: ${psa.error}`
              : (psa.reason ?? 'Enter the company ID by hand.')}
          </p>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label">Client name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoFocus
              placeholder="Acme Corp"
              className="input"
            />
            <p className="hint">Used as a fallback match, so spell it as SuperOps does.</p>
          </div>
          <div>
            <label className="label">SuperOps company ID</label>
            <input
              value={companyId}
              onChange={(e) => setCompanyId(e.target.value)}
              placeholder="Optional but recommended"
              className="input font-mono"
            />
            <p className="hint">Find it in the URL when you open the client in SuperOps.</p>
          </div>
        </div>

        <fieldset className="rounded-lg border border-slate-200 p-4 dark:border-slate-800">
          <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Recognition</legend>
          <div className="space-y-4">
            <div>
              <label className="label">Email domains</label>
              <input
                value={domains}
                onChange={(e) => setDomains(e.target.value)}
                placeholder="acme.com, acme.co.uk"
                className="input"
              />
              <p className="hint">
                Every domain this client's staff send from. Tickets are matched on these when SuperOps has no
                company, and a request that names a user on another client's domain is escalated.
              </p>
              {suggestions.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
                  <span className="text-slate-500">Seen on this client's tickets:</span>
                  {suggestions.map((s) => (
                    <button
                      type="button"
                      key={s.domain}
                      onClick={() => setDomains(currentDomains.concat(s.domain).join(', '))}
                      className="rounded-full bg-sheen-soft px-2 py-0.5 font-medium text-slate-700 hover:ring-1 hover:ring-swoop-400 dark:text-slate-200"
                    >
                      + {s.domain} <span className="text-slate-400">({s.tickets})</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="label">Microsoft 365 default domain</label>
                <input
                  value={m365Domain}
                  onChange={(e) => setM365Domain(e.target.value)}
                  placeholder="acme.onmicrosoft.com"
                  className="input font-mono"
                />
                <p className="hint">What CIPP calls the tenant filter. Needed for user lookups and plans.</p>
              </div>
              <div>
                <label className="label">Microsoft 365 tenant ID</label>
                <input
                  value={m365TenantId}
                  onChange={(e) => setM365TenantId(e.target.value)}
                  placeholder="Optional GUID"
                  className="input font-mono"
                />
              </div>
            </div>
            <div>
              <label className="label">VIPs</label>
              <textarea
                value={vips}
                onChange={(e) => setVips(e.target.value)}
                rows={2}
                placeholder="ceo@acme.com&#10;cfo@acme.com"
                className="input font-mono text-xs"
              />
              <p className="hint">Tickets from these addresses are raised one priority level.</p>
            </div>
          </div>
        </fieldset>

        <div>
          <label className="label">Client context for the AI (optional)</label>
          <textarea
            value={contextNotes}
            onChange={(e) => setContextNotes(e.target.value)}
            rows={3}
            placeholder="e.g. Email addresses are firstname.lastname@acme.com. Their finance team are all VIPs — treat anything from them as high sensitivity. They use Duo, not Microsoft Authenticator."
            className="input"
          />
          <p className="hint">
            Added to the prompt for this client's tickets. Naming conventions and VIP groups are the two that
            change classifications the most.
          </p>
        </div>

        {/* Context is the right tool for almost every client; a full prompt
            override is for the rare one whose ticket mix is genuinely
            different, so it stays behind a disclosure. */}
        <div>
          {!showPrompt ? (
            <button
              type="button"
              onClick={() => setShowPrompt(true)}
              className="text-xs text-slate-500 underline hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
            >
              Use a custom prompt for this client
            </button>
          ) : (
            <>
              <label className="label">Custom prompt for this client</label>
              <textarea
                value={promptOverride}
                onChange={(e) => setPromptOverride(e.target.value)}
                rows={8}
                placeholder="Leave blank to use the tenant prompt from Settings."
                className="input font-mono text-xs"
                spellCheck={false}
              />
              <p className="hint">
                Replaces the tenant prompt entirely for this client, rather than being added to it — two
                prompts stacked together tend to contradict each other. It must still ask for the same JSON
                shape, and the context notes above are not injected into it. Accuracy for this client is
                tracked as its own version on the Calibration page.
              </p>
              {promptOverride && (
                <button
                  type="button"
                  onClick={() => {
                    setPromptOverride('');
                    setShowPrompt(false);
                  }}
                  className="mt-1 text-xs text-slate-500 underline hover:text-slate-700 dark:text-slate-400"
                >
                  Remove the custom prompt
                </button>
              )}
            </>
          )}
        </div>

        <Toggle
          checked={enabled}
          onChange={setEnabled}
          label="Enable automation"
          description="Swoop starts classifying this client's tickets on the next poll."
        />

        <div className="flex gap-2 pt-1">
          <button type="button" onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          <button type="submit" disabled={save.isPending || !name.trim()} className="btn-primary">
            {save.isPending ? 'Saving…' : client ? 'Save changes' : 'Add client'}
          </button>
        </div>
      </form>
    </div>
  );
}
