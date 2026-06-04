import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getActions, getActionStats, getClients, getTenants, type ActionLog, type Client } from '../api';

const CLASSIFICATION_COLORS: Record<string, string> = {
  password_reset: 'bg-blue-100 text-blue-700',
  group_add: 'bg-green-100 text-green-700',
  group_remove: 'bg-orange-100 text-orange-700',
  license_assign: 'bg-purple-100 text-purple-700',
  license_remove: 'bg-pink-100 text-pink-700',
  account_disable: 'bg-red-100 text-red-700',
  account_enable: 'bg-green-100 text-green-700',
  mfa_reset: 'bg-yellow-100 text-yellow-700',
  mailbox_permission: 'bg-indigo-100 text-indigo-700',
  ESCALATE: 'bg-red-100 text-red-800',
  FOLLOW_UP: 'bg-amber-100 text-amber-800',
};

function ClassificationBadge({ cls }: { cls: string | null }) {
  const color = cls ? (CLASSIFICATION_COLORS[cls] || 'bg-gray-100 text-gray-700') : 'bg-gray-100 text-gray-500';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${color}`}>
      {cls || 'unknown'}
    </span>
  );
}

function ConfidenceBar({ value }: { value: number | null }) {
  if (value === null) return <span className="text-gray-400 text-xs">—</span>;
  const pct = Math.round(value * 100);
  const color = pct >= 80 ? 'bg-green-500' : pct >= 60 ? 'bg-yellow-500' : 'bg-red-500';
  return (
    <div className="flex items-center gap-2">
      <div className="w-16 bg-gray-200 rounded-full h-1.5">
        <div className={`h-1.5 rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-gray-600">{pct}%</span>
    </div>
  );
}

function ActionRow({ log, client }: { log: ActionLog; client?: Client }) {
  const [expanded, setExpanded] = useState(false);
  const entities = log.entities ? JSON.parse(log.entities) : {};

  return (
    <>
      <tr
        className="hover:bg-gray-50 cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        <td className="px-4 py-3 text-xs text-gray-500 font-mono whitespace-nowrap">{log.ticketId}</td>
        <td className="px-4 py-3 text-sm text-gray-900 max-w-xs">
          <div className="truncate">{log.ticketSubject || '(no subject)'}</div>
          {log.sensitivity === 'high' && (
            <span className="inline-block mt-0.5 text-xs text-red-600 font-medium">HIGH SENSITIVITY</span>
          )}
        </td>
        <td className="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">{client?.name || '—'}</td>
        <td className="px-4 py-3 whitespace-nowrap"><ClassificationBadge cls={log.classification} /></td>
        <td className="px-4 py-3 whitespace-nowrap"><ConfidenceBar value={log.confidence} /></td>
        <td className="px-4 py-3 whitespace-nowrap">
          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
            log.status === 'pending' ? 'bg-gray-100 text-gray-600' : 'bg-blue-100 text-blue-700'
          }`}>
            {log.status || 'pending'}
          </span>
        </td>
        <td className="px-4 py-3 text-xs text-gray-400 whitespace-nowrap">
          {log.createdAt ? new Date(log.createdAt * 1000).toLocaleString() : '—'}
        </td>
        <td className="px-4 py-3 text-gray-400 text-xs">{expanded ? '▲' : '▼'}</td>
      </tr>
      {expanded && (
        <tr className="bg-gray-50">
          <td colSpan={8} className="px-4 py-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
              <div>
                <h4 className="font-medium text-gray-700 mb-1">AI Reasoning</h4>
                <p className="text-gray-600 text-xs leading-relaxed">{log.reasoning || '—'}</p>
                {log.followUpQuestion && (
                  <div className="mt-2">
                    <span className="text-amber-700 font-medium text-xs">Follow-up needed: </span>
                    <span className="text-gray-600 text-xs">{log.followUpQuestion}</span>
                  </div>
                )}
              </div>
              <div>
                <h4 className="font-medium text-gray-700 mb-1">Entities extracted</h4>
                <div className="space-y-0.5 text-xs text-gray-600">
                  {entities.target_user_email && <div>User email: <span className="font-mono">{entities.target_user_email}</span></div>}
                  {entities.target_user_display_name && <div>Display name: {entities.target_user_display_name}</div>}
                  {entities.group_name && <div>Group: {entities.group_name}</div>}
                  {entities.license_sku && <div>License: {entities.license_sku}</div>}
                  {!entities.target_user_email && !entities.target_user_display_name && !entities.group_name && !entities.license_sku && (
                    <span className="text-gray-400">None extracted</span>
                  )}
                </div>
              </div>
              {log.proposedPsaNote && (
                <div className="md:col-span-2">
                  <h4 className="font-medium text-gray-700 mb-1">Proposed internal note</h4>
                  <pre className="text-xs text-gray-600 bg-white border border-gray-200 rounded-lg p-3 whitespace-pre-wrap font-mono leading-relaxed overflow-auto max-h-48">
                    {log.proposedPsaNote}
                  </pre>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export default function Dashboard() {
  const [filterClient, setFilterClient] = useState('');
  const [filterClassification, setFilterClassification] = useState('');

  const { data: tenants } = useQuery({ queryKey: ['tenants'], queryFn: () => getTenants().then((r) => r.data) });
  const tenantId = tenants?.[0]?.id;

  const { data: stats } = useQuery({
    queryKey: ['stats', tenantId],
    queryFn: () => getActionStats(tenantId).then((r) => r.data),
    enabled: !!tenantId,
    refetchInterval: 30_000,
  });

  const { data: clients = [] } = useQuery({
    queryKey: ['clients', tenantId],
    queryFn: () => getClients(tenantId).then((r) => r.data),
    enabled: !!tenantId,
  });

  const { data: actions = [], isLoading } = useQuery({
    queryKey: ['actions', tenantId, filterClient, filterClassification],
    queryFn: () =>
      getActions({
        tenantId,
        clientId: filterClient || undefined,
        classification: filterClassification || undefined,
        limit: 50,
      }).then((r) => r.data),
    enabled: !!tenantId,
    refetchInterval: 30_000,
  });

  const clientMap: Record<string, Client> = {};
  for (const c of clients) clientMap[c.id] = c;

  const classifications = Object.keys(stats?.byClassification || {});

  return (
    <div className="p-6">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
        <p className="text-gray-500 text-sm mt-1">Recent AI classifications — read-only Phase 1</p>
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
          <div className="bg-white rounded-xl border border-gray-200 p-4">
            <div className="text-2xl font-bold text-gray-900">{stats.total}</div>
            <div className="text-xs text-gray-500 mt-1">Total tickets processed</div>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 p-4">
            <div className="text-2xl font-bold text-red-600">{stats.byClassification['ESCALATE'] || 0}</div>
            <div className="text-xs text-gray-500 mt-1">Escalated</div>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 p-4">
            <div className="text-2xl font-bold text-amber-600">{stats.byClassification['FOLLOW_UP'] || 0}</div>
            <div className="text-xs text-gray-500 mt-1">Need follow-up</div>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 p-4">
            <div className="text-2xl font-bold text-red-700">{stats.highSensitivity}</div>
            <div className="text-xs text-gray-500 mt-1">High sensitivity</div>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-4">
        <select
          value={filterClient}
          onChange={(e) => setFilterClient(e.target.value)}
          className="px-3 py-2 text-sm border border-gray-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-swoop-500"
        >
          <option value="">All clients</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <select
          value={filterClassification}
          onChange={(e) => setFilterClassification(e.target.value)}
          className="px-3 py-2 text-sm border border-gray-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-swoop-500"
        >
          <option value="">All classifications</option>
          {classifications.map((cls) => (
            <option key={cls} value={cls}>{cls}</option>
          ))}
        </select>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {isLoading ? (
          <div className="text-center py-12 text-gray-400 text-sm">Loading action logs...</div>
        ) : actions.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-gray-500 text-sm">No action logs yet.</p>
            <p className="text-gray-400 text-xs mt-1">Swoop will start classifying tickets on the next poll cycle (every 60s).</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50">
                  <th className="px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Ticket ID</th>
                  <th className="px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Subject</th>
                  <th className="px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Client</th>
                  <th className="px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Classification</th>
                  <th className="px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Confidence</th>
                  <th className="px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                  <th className="px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Time</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {actions.map((log) => (
                  <ActionRow key={log.id} log={log} client={clientMap[log.clientId]} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
