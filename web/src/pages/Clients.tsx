import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getClients, getTenants, createClient, updateClient, deleteClient, type Client } from '../api';

export default function Clients() {
  const queryClient = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState('');
  const [newCompanyId, setNewCompanyId] = useState('');
  const [newEnabled, setNewEnabled] = useState(false);
  const [addError, setAddError] = useState('');

  const { data: tenants } = useQuery({ queryKey: ['tenants'], queryFn: () => getTenants().then((r) => r.data) });
  const tenantId = tenants?.[0]?.id || '';

  const { data: clients = [], isLoading } = useQuery({
    queryKey: ['clients', tenantId],
    queryFn: () => getClients(tenantId).then((r) => r.data),
    enabled: !!tenantId,
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      updateClient(id, { automationEnabled: enabled }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['clients'] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteClient(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['clients'] }),
  });

  const createMutation = useMutation({
    mutationFn: () =>
      createClient({
        tenantId,
        name: newName,
        superopsCompanyId: newCompanyId || undefined,
        automationEnabled: newEnabled,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['clients'] });
      setShowAdd(false);
      setNewName('');
      setNewCompanyId('');
      setNewEnabled(false);
      setAddError('');
    },
    onError: (err: any) => {
      setAddError(err.response?.data?.error || 'Failed to add client');
    },
  });

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    createMutation.mutate();
  };

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Clients</h1>
          <p className="text-gray-500 text-sm mt-1">Enable/disable ticket automation per client (allowlist model)</p>
        </div>
        <button
          onClick={() => setShowAdd(true)}
          className="bg-swoop-600 hover:bg-swoop-700 text-white font-medium px-4 py-2 rounded-lg text-sm"
        >
          Add client
        </button>
      </div>

      {/* Add client form */}
      {showAdd && (
        <div className="bg-white rounded-xl border border-gray-200 p-5 mb-6">
          <h3 className="font-semibold text-gray-900 mb-4">Add client</h3>
          {addError && (
            <div className="bg-red-50 text-red-700 border border-red-200 rounded p-3 text-sm mb-3">{addError}</div>
          )}
          <form onSubmit={handleCreate} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Client name *</label>
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
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
                  value={newCompanyId}
                  onChange={(e) => setNewCompanyId(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-swoop-500"
                  placeholder="Optional"
                />
              </div>
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={newEnabled}
                onChange={(e) => setNewEnabled(e.target.checked)}
                className="w-4 h-4 rounded text-swoop-600"
              />
              <span className="text-sm text-gray-700">Enable automation (classify tickets immediately)</span>
            </label>
            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={() => { setShowAdd(false); setAddError(''); }}
                className="px-4 py-2 border border-gray-300 text-sm font-medium rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={createMutation.isPending}
                className="px-4 py-2 bg-swoop-600 hover:bg-swoop-700 disabled:opacity-60 text-white text-sm font-medium rounded-lg"
              >
                {createMutation.isPending ? 'Adding...' : 'Add client'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Clients table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
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
                <th className="px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Automation</th>
                <th className="px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Added</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {clients.map((client) => (
                <tr key={client.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-sm font-medium text-gray-900">{client.name}</td>
                  <td className="px-4 py-3 text-sm text-gray-500 font-mono">
                    {client.superopsCompanyId || <span className="text-gray-400 font-sans">—</span>}
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() =>
                        toggleMutation.mutate({ id: client.id, enabled: !client.automationEnabled })
                      }
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
                  <td className="px-4 py-3 text-right">
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
