import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getClients, getTenants, createClient, updateClient, deleteClient, type Client } from '../api';

export default function Clients() {
  const queryClient = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [cippTenantId, setCippTenantId] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [formError, setFormError] = useState('');

  const { data: tenants } = useQuery({ queryKey: ['tenants'], queryFn: () => getTenants().then((r) => r.data) });
  const tenantId = tenants?.[0]?.id || '';

  const { data: clients = [], isLoading } = useQuery({
    queryKey: ['clients', tenantId],
    queryFn: () => getClients(tenantId).then((r) => r.data),
    enabled: !!tenantId,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['clients'] });

  const toggleMutation = useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) => updateClient(id, { automationEnabled: on }),
    onSuccess: invalidate,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteClient(id),
    onSuccess: invalidate,
  });

  const formOpen = showAdd || editingId !== null;
  const isEditing = editingId !== null;

  const resetForm = () => {
    setShowAdd(false);
    setEditingId(null);
    setName('');
    setCompanyId('');
    setCippTenantId('');
    setEnabled(false);
    setFormError('');
  };

  const startAdd = () => {
    resetForm();
    setShowAdd(true);
  };

  const startEdit = (c: Client) => {
    setEditingId(c.id);
    setShowAdd(false);
    setName(c.name);
    setCompanyId(c.superopsCompanyId || '');
    setCippTenantId(c.cippTenantId || '');
    setEnabled(c.automationEnabled);
    setFormError('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const onError = (err: any) => setFormError(err.response?.data?.error || 'Failed to save client');

  const createMutation = useMutation({
    mutationFn: () =>
      createClient({
        tenantId,
        name,
        superopsCompanyId: companyId || undefined,
        cippTenantId: cippTenantId || undefined,
        automationEnabled: enabled,
      }),
    onSuccess: () => { invalidate(); resetForm(); },
    onError,
  });

  const updateMutation = useMutation({
    mutationFn: () =>
      updateClient(editingId!, {
        name,
        superopsCompanyId: companyId || null,
        cippTenantId: cippTenantId || null,
        automationEnabled: enabled,
      } as Partial<Client>),
    onSuccess: () => { invalidate(); resetForm(); },
    onError,
  });

  const saving = createMutation.isPending || updateMutation.isPending;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    if (isEditing) updateMutation.mutate();
    else createMutation.mutate();
  };

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Clients</h1>
          <p className="text-gray-500 text-sm mt-1">Enable/disable ticket automation per client (allowlist model)</p>
        </div>
        <button
          onClick={startAdd}
          className="bg-swoop-600 hover:bg-swoop-700 text-white font-medium px-4 py-2 rounded-lg text-sm"
        >
          Add client
        </button>
      </div>

      {/* Add / Edit client form */}
      {formOpen && (
        <div className="sticker p-5 mb-6">
          <h3 className="font-semibold text-gray-900 mb-4">{isEditing ? 'Edit client' : 'Add client'}</h3>
          {formError && (
            <div className="bg-red-50 text-red-700 border border-red-200 rounded p-3 text-sm mb-3">{formError}</div>
          )}
          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Client name *</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  autoFocus
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-swoop-500"
                  placeholder="Acme Corp"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">SuperOps Company ID</label>
                <input
                  type="text"
                  value={companyId}
                  onChange={(e) => setCompanyId(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-swoop-500"
                  placeholder="Optional"
                />
              </div>
              <div className="col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-1">CIPP Tenant ID</label>
                <input
                  type="text"
                  value={cippTenantId}
                  onChange={(e) => setCippTenantId(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-swoop-500"
                  placeholder="contoso.onmicrosoft.com"
                />
                <p className="text-xs text-gray-400 mt-1">The M365 tenant domain used by CIPP (e.g. contoso.onmicrosoft.com) — required for action execution</p>
              </div>
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                className="w-4 h-4 rounded text-swoop-600"
              />
              <span className="text-sm text-gray-700">Enable automation (classify tickets immediately)</span>
            </label>
            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={resetForm}
                className="px-4 py-2 border border-gray-300 text-sm font-medium rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-2 bg-swoop-600 hover:bg-swoop-700 disabled:opacity-60 text-white text-sm font-medium rounded-lg"
              >
                {isEditing
                  ? (saving ? 'Saving...' : 'Save changes')
                  : (saving ? 'Adding...' : 'Add client')}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Clients table */}
      <div className="sticker overflow-hidden">
        {isLoading ? (
          <div className="text-center py-12 text-gray-400 text-sm">Loading clients...</div>
        ) : clients.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-gray-500 text-sm">No clients yet.</p>
            <p className="text-gray-400 text-xs mt-1">Add a client and enable automation to start classifying their tickets.</p>
          </div>
        ) : (
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                <th className="px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Client name</th>
                <th className="px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">SuperOps Company ID</th>
                <th className="px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">CIPP Tenant ID</th>
                <th className="px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Automation</th>
                <th className="px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Added</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {clients.map((client) => (
                <tr key={client.id} className={`hover:bg-gray-50 ${editingId === client.id ? 'bg-swoop-50' : ''}`}>
                  <td className="px-4 py-3 text-sm font-medium text-gray-900">{client.name}</td>
                  <td className="px-4 py-3 text-sm text-gray-500 font-mono">
                    {client.superopsCompanyId || <span className="text-gray-400 font-sans">—</span>}
                  </td>
                  <td className="px-4 py-3 text-sm font-mono">
                    {client.cippTenantId
                      ? <span className="text-gray-500">{client.cippTenantId}</span>
                      : <span className="text-amber-600 font-sans text-xs">Not set — actions can't run</span>}
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => toggleMutation.mutate({ id: client.id, on: !client.automationEnabled })}
                      disabled={toggleMutation.isPending}
                      className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${
                        client.automationEnabled ? 'bg-swoop-600' : 'bg-gray-200'
                      }`}
                    >
                      <span
                        className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                          client.automationEnabled ? 'translate-x-4' : 'translate-x-0'
                        }`}
                      />
                    </button>
                    <span className="ml-2 text-xs text-gray-500">
                      {client.automationEnabled ? 'Enabled' : 'Disabled'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-400">
                    {client.createdAt ? new Date(client.createdAt * 1000).toLocaleDateString() : '—'}
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    <button
                      onClick={() => startEdit(client)}
                      className="text-xs text-swoop-600 hover:text-swoop-700 font-medium mr-4"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => {
                        if (confirm(`Remove ${client.name}?`)) {
                          deleteMutation.mutate(client.id);
                        }
                      }}
                      className="text-xs text-red-500 hover:text-red-700"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
