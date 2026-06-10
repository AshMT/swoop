import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getActions, getActionStats, getClients, getTenants, getPolicies, approveAction, rejectAction, getExecutionLog,
  type ActionLog, type ActionPolicy, type Client, type ExecutionLog,
} from '../api';

const VERIFICATION_METHODS = [
  { value: 'phone_callback', label: 'Phone callback to known number' },
  { value: 'video_call', label: 'Video call / Teams' },
  { value: 'known_email_reply', label: 'Reply from known email address' },
  { value: 'manager_confirmed', label: 'Manager confirmation in writing' },
  { value: 'in_person', label: 'Verified in person' },
  { value: 'other', label: 'Other' },
];

const verificationLabel = (value: string | null) =>
  VERIFICATION_METHODS.find((m) => m.value === value)?.label || value || '';

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

const STATUS_COLORS: Record<string, string> = {
  awaiting_approval: 'bg-amber-100 text-amber-700',
  executing: 'bg-blue-100 text-blue-700',
  executed: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
  rejected: 'bg-gray-100 text-gray-500',
  escalated: 'bg-red-100 text-red-800',
  follow_up: 'bg-amber-100 text-amber-800',
};

function ClassificationBadge({ cls }: { cls: string | null }) {
  const color = cls ? (CLASSIFICATION_COLORS[cls] || 'bg-gray-100 text-gray-700') : 'bg-gray-100 text-gray-500';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${color}`}>
      {cls || 'unknown'}
    </span>
  );
}

function StatusBadge({ status }: { status: string | null }) {
  const s = status || 'unknown';
  const color = STATUS_COLORS[s] || 'bg-gray-100 text-gray-600';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${color}`}>
      {s.replace(/_/g, ' ')}
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

function ActionRow({ log, client, policy }: { log: ActionLog; client?: Client; policy?: ActionPolicy }) {
  const [expanded, setExpanded] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [showRejectForm, setShowRejectForm] = useState(false);
  const [showVerifyForm, setShowVerifyForm] = useState(false);
  const [verifyMethod, setVerifyMethod] = useState('phone_callback');
  const [verifyConfirmed, setVerifyConfirmed] = useState(false);
  const queryClient = useQueryClient();
  const entities = log.entities ? (() => { try { return JSON.parse(log.entities!); } catch { return {}; } })() : {};

  const { data: executionLog } = useQuery<ExecutionLog>({
    queryKey: ['execution', log.id],
    queryFn: () => getExecutionLog(log.id).then((r) => r.data),
    enabled: expanded && (log.status === 'executed' || log.status === 'failed'),
    retry: false,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['actions'] });
    void queryClient.invalidateQueries({ queryKey: ['stats'] });
  };

  const approveMutation = useMutation({
    mutationFn: (verificationMethod?: string) => approveAction(log.id, verificationMethod),
    onSuccess: () => { invalidate(); setShowVerifyForm(false); setVerifyConfirmed(false); },
  });

  const rejectMutation = useMutation({
    mutationFn: () => rejectAction(log.id, rejectReason || undefined),
    onSuccess: () => { invalidate(); setShowRejectForm(false); setRejectReason(''); },
  });

  const isActionable = log.status === 'awaiting_approval';

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
        <td className="px-4 py-3 whitespace-nowrap"><StatusBadge status={log.status} /></td>
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

              {/* Execution result */}
              {executionLog && (
                <div className="md:col-span-2">
                  <h4 className="font-medium text-gray-700 mb-1">Execution result</h4>
                  <div className={`rounded-lg border p-3 text-xs ${executionLog.result === 'success' ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
                    <div className="font-medium mb-1">{executionLog.result === 'success' ? 'Success' : 'Failed'}</div>
                    {executionLog.error && <div className="text-red-700">Error: {executionLog.error}</div>}
                    {executionLog.response && (
                      <pre className="mt-1 text-gray-600 whitespace-pre-wrap overflow-auto max-h-32">{executionLog.response}</pre>
                    )}
                  </div>
                </div>
              )}

              {/* Rejection info */}
              {log.status === 'rejected' && (
                <div className="md:col-span-2 text-xs text-gray-500">
                  Rejected by {log.approvedBy || 'unknown'}
                  {log.rejectionReason && <> — <span className="italic">{log.rejectionReason}</span></>}
                </div>
              )}

              {/* Verification audit trail */}
              {log.verificationMethod && (
                <div className="md:col-span-2 text-xs text-gray-600 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
                  🔐 Identity verified via <strong>{verificationLabel(log.verificationMethod)}</strong>
                  {log.verifiedBy && <> by {log.verifiedBy}</>}
                  {log.verifiedAt && <> — {new Date(log.verifiedAt * 1000).toLocaleString()}</>}
                </div>
              )}
              {log.approvedBy === 'swoop:auto-policy' && (
                <div className="md:col-span-2 text-xs text-green-800 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
                  ⚡ Auto-approved by policy — this action type is pre-approved and passed the confidence/sensitivity guardrails.
                </div>
              )}

              {/* Approve / Reject actions */}
              {isActionable && (
                <div className="md:col-span-2" onClick={(e) => e.stopPropagation()}>
                  {showVerifyForm ? (
                    <div className="flex flex-col gap-3 max-w-md bg-blue-50 border border-blue-200 rounded-lg p-4">
                      <div className="text-sm font-medium text-gray-800">🔐 Identity verification required</div>
                      <p className="text-xs text-gray-600">
                        Policy requires verifying the requester's identity before executing <strong>{log.classification}</strong>.
                        Record how you verified them:
                      </p>
                      <select
                        value={verifyMethod}
                        onChange={(e) => setVerifyMethod(e.target.value)}
                        className="px-3 py-2 text-sm border border-gray-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-swoop-500"
                      >
                        {VERIFICATION_METHODS.map((m) => (
                          <option key={m.value} value={m.value}>{m.label}</option>
                        ))}
                      </select>
                      <label className="flex items-start gap-2 cursor-pointer text-xs text-gray-700">
                        <input
                          type="checkbox"
                          checked={verifyConfirmed}
                          onChange={(e) => setVerifyConfirmed(e.target.checked)}
                          className="w-4 h-4 mt-0.5 rounded accent-swoop-600"
                        />
                        <span>
                          I have verified the identity of <strong>{log.requesterEmail || 'the requester'}</strong> using
                          the method above. This is recorded in the audit log.
                        </span>
                      </label>
                      <div className="flex gap-2">
                        <button
                          onClick={() => approveMutation.mutate(verifyMethod)}
                          disabled={!verifyConfirmed || approveMutation.isPending}
                          className="px-4 py-2 bg-green-600 text-white text-sm rounded-lg hover:bg-green-700 disabled:opacity-50 font-medium"
                        >
                          {approveMutation.isPending ? 'Executing...' : 'Confirm & Execute'}
                        </button>
                        <button
                          onClick={() => { setShowVerifyForm(false); setVerifyConfirmed(false); }}
                          className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : !showRejectForm ? (
                    <div className="flex gap-2 items-center">
                      <button
                        onClick={() => {
                          if (policy?.requireVerification) setShowVerifyForm(true);
                          else approveMutation.mutate(undefined);
                        }}
                        disabled={approveMutation.isPending}
                        className="px-4 py-2 bg-green-600 text-white text-sm rounded-lg hover:bg-green-700 disabled:opacity-50 font-medium"
                      >
                        {approveMutation.isPending ? 'Executing...' : policy?.requireVerification ? 'Verify & Execute' : 'Approve & Execute'}
                      </button>
                      <button
                        onClick={() => setShowRejectForm(true)}
                        className="px-4 py-2 bg-white text-gray-700 text-sm rounded-lg border border-gray-300 hover:bg-gray-50 font-medium"
                      >
                        Reject
                      </button>
                      {policy?.requireVerification && (
                        <span className="text-xs text-gray-400">🔐 Identity verification required by policy</span>
                      )}
                    </div>
                  ) : (
                    <div className="flex flex-col gap-2 max-w-sm">
                      <input
                        type="text"
                        placeholder="Rejection reason (optional)"
                        value={rejectReason}
                        onChange={(e) => setRejectReason(e.target.value)}
                        className="px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-swoop-500"
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={() => rejectMutation.mutate()}
                          disabled={rejectMutation.isPending}
                          className="px-4 py-2 bg-red-600 text-white text-sm rounded-lg hover:bg-red-700 disabled:opacity-50 font-medium"
                        >
                          {rejectMutation.isPending ? 'Rejecting...' : 'Confirm Reject'}
                        </button>
                        <button
                          onClick={() => { setShowRejectForm(false); setRejectReason(''); }}
                          className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                  {approveMutation.isError && (
                    <p className="text-red-600 text-xs mt-2">
                      {(approveMutation.error as Error)?.message || 'Failed to execute action'}
                    </p>
                  )}
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

const STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'awaiting_approval', label: 'Awaiting approval' },
  { value: 'executed', label: 'Executed' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'failed', label: 'Failed' },
  { value: 'escalated', label: 'Escalated' },
  { value: 'follow_up', label: 'Follow-up' },
];

export default function Dashboard() {
  const [filterClient, setFilterClient] = useState('');
  const [filterClassification, setFilterClassification] = useState('');
  const [filterStatus, setFilterStatus] = useState('');

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

  const { data: policies = [] } = useQuery({
    queryKey: ['policies', tenantId],
    queryFn: () => getPolicies(tenantId!).then((r) => r.data),
    enabled: !!tenantId,
  });

  const { data: actions = [], isLoading } = useQuery({
    queryKey: ['actions', tenantId, filterClient, filterClassification, filterStatus],
    queryFn: () =>
      getActions({
        tenantId,
        clientId: filterClient || undefined,
        classification: filterClassification || undefined,
        status: filterStatus || undefined,
        limit: 100,
      }).then((r) => r.data),
    enabled: !!tenantId,
    refetchInterval: 30_000,
  });

  const clientMap: Record<string, Client> = {};
  for (const c of clients) clientMap[c.id] = c;

  const policyMap: Record<string, ActionPolicy> = {};
  for (const p of policies) policyMap[p.actionType] = p;

  const classifications = Object.keys(stats?.byClassification || {});
  const byStatus = stats?.byStatus || {};

  return (
    <div className="p-6">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
        <p className="text-gray-500 text-sm mt-1">AI-classified tickets — review and approve M365 actions</p>
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-6">
          <div className="sticker p-4">
            <div className="text-2xl font-bold text-gray-900">{stats.total}</div>
            <div className="text-xs text-gray-500 mt-1">Total processed</div>
          </div>
          <button
            onClick={() => setFilterStatus(filterStatus === 'awaiting_approval' ? '' : 'awaiting_approval')}
            className={`sticker p-4 text-left transition-all ${filterStatus === 'awaiting_approval' ? 'ring-2 ring-amber-400' : 'hover:scale-[1.01]'}`}
          >
            <div className="text-2xl font-bold text-amber-600">{byStatus['awaiting_approval'] || 0}</div>
            <div className="text-xs text-gray-500 mt-1">Awaiting approval</div>
          </button>
          <button
            onClick={() => setFilterStatus(filterStatus === 'executed' ? '' : 'executed')}
            className={`sticker p-4 text-left transition-all ${filterStatus === 'executed' ? 'ring-2 ring-green-400' : 'hover:scale-[1.01]'}`}
          >
            <div className="text-2xl font-bold text-green-600">{byStatus['executed'] || 0}</div>
            <div className="text-xs text-gray-500 mt-1">Executed</div>
          </button>
          <button
            onClick={() => setFilterStatus(filterStatus === 'escalated' ? '' : 'escalated')}
            className={`sticker p-4 text-left transition-all ${filterStatus === 'escalated' ? 'ring-2 ring-red-400' : 'hover:scale-[1.01]'}`}
          >
            <div className="text-2xl font-bold text-red-600">{byStatus['escalated'] || 0}</div>
            <div className="text-xs text-gray-500 mt-1">Escalated</div>
          </button>
          <div className="sticker p-4">
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
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="px-3 py-2 text-sm border border-gray-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-swoop-500"
        >
          {STATUS_OPTIONS.map(({ value, label }) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
        {(filterClient || filterClassification || filterStatus) && (
          <button
            onClick={() => { setFilterClient(''); setFilterClassification(''); setFilterStatus(''); }}
            className="px-3 py-2 text-sm text-gray-500 hover:text-gray-800 border border-gray-200 rounded-lg bg-white hover:bg-gray-50 transition-colors"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Table */}
      <div className="sticker overflow-hidden">
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
                  <ActionRow
                    key={log.id}
                    log={log}
                    client={clientMap[log.clientId]}
                    policy={log.classification ? policyMap[log.classification] : undefined}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
