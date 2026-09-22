import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createClient,
  deleteClient,
  errorMessage,
  getClients,
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

export default function Clients() {
  const queryClient = useQueryClient();
  const toast = useToast();

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
          <button onClick={() => setShowAdd(true)} className="btn-primary">
            Add client
          </button>
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
                      onClick={() => setEditing(client)}
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
                  </td>
                  <td className="td font-mono text-xs">
                    {client.superopsCompanyId || (
                      <span className="font-sans text-slate-400" title="Swoop will fall back to matching on the client name">
                        matching by name
                      </span>
                    )}
                  </td>
                  <td className="td">
                    <Toggle
                      checked={client.automationEnabled}
                      disabled={toggle.isPending}
                      label={client.automationEnabled ? 'Enabled' : 'Disabled'}
                      onChange={(enabled) => toggle.mutate({ id: client.id, enabled })}
                    />
                  </td>
                  <td className="td tnum text-right">{client.actionCount ?? 0}</td>
                  <td className="td text-xs text-slate-400">
                    {client.lastActionAt ? formatRelative(client.lastActionAt) : 'never'}
                  </td>
                  <td className="td text-right">
                    <button
                      onClick={() => setPendingDelete(client)}
                      className="rounded p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950"
                      aria-label={`Remove ${client.name}`}
                      title={`Remove ${client.name}`}
                    >
                      <TrashIcon />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="mt-4 text-xs text-slate-500 dark:text-slate-400">
        <Badge tone="info">How matching works</Badge> Swoop matches a ticket to a client by SuperOps company ID
        first, then by exact client name. The company ID is the reliable one — names get renamed.
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
  onClose,
  onSaved,
}: {
  tenantId: string;
  client?: Client;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(client?.name ?? '');
  const [companyId, setCompanyId] = useState(client?.superopsCompanyId ?? '');
  const [contextNotes, setContextNotes] = useState(client?.contextNotes ?? '');
  const [enabled, setEnabled] = useState(client?.automationEnabled ?? false);
  const [error, setError] = useState('');

  const save = useMutation({
    mutationFn: () =>
      client
        ? updateClient(client.id, {
            name: name.trim(),
            superopsCompanyId: companyId.trim() || null,
            contextNotes: contextNotes.trim() || null,
            automationEnabled: enabled,
          })
        : createClient({
            tenantId,
            name: name.trim(),
            superopsCompanyId: companyId.trim() || undefined,
            contextNotes: contextNotes.trim() || undefined,
            automationEnabled: enabled,
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
