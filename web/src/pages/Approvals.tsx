import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { approveAction, errorMessage, getActions, getClients, getTenants, type ActionLog, type ApprovalState } from '../api';
import { ApprovalBadge, Badge, EmptyState, LoadingState, PageHeader, PriorityBadge, SignalChips, Spinner, useToast } from '../components/ui';
import { CheckIcon } from '../components/Icons';
import { formatRelative, formatUntil, parseEntities } from '../lib/format';
import { actionLabel, useCan, useVocabulary } from '../lib/session';

const TABS: Array<{ id: ApprovalState; label: string }> = [
  { id: 'pending', label: 'Waiting' },
  { id: 'approved', label: 'Approved' },
  { id: 'auto_approved', label: 'Auto-approved' },
  { id: 'rejected', label: 'Rejected' },
  { id: 'expired', label: 'Expired' },
];

/**
 * Proposals waiting on a person. Approving records the decision and the plan;
 * Execution settings decide whether Swoop then carries it out.
 */
export default function Approvals() {
  const [tab, setTab] = useState<ApprovalState>('pending');
  const canApprove = useCan('approver');
  const { data: vocabulary } = useVocabulary();
  const toast = useToast();
  const queryClient = useQueryClient();

  const { data: tenants } = useQuery({ queryKey: ['tenants'], queryFn: () => getTenants().then((r) => r.data) });
  const tenantId = tenants?.[0]?.id;
  const { data: clients } = useQuery({
    queryKey: ['clients', tenantId],
    queryFn: () => getClients(tenantId).then((r) => r.data),
    enabled: Boolean(tenantId),
  });
  const clientNames = useMemo(() => new Map((clients ?? []).map((c) => [c.id, c.name])), [clients]);

  const { data, isLoading } = useQuery({
    queryKey: ['actions', 'approvals', tenantId, tab],
    queryFn: () => getActions({ tenantId, approval: tab, sort: 'priority', limit: 100 }).then((r) => r.data),
    enabled: Boolean(tenantId),
    refetchInterval: 20_000,
  });

  const quickApprove = useMutation({
    mutationFn: (id: string) => approveAction(id),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ['actions'] });
      void queryClient.invalidateQueries({ queryKey: ['queue-summary'] });
      toast.success(res.data.state === 'approved' ? 'Approved' : 'Approval recorded — one more needed');
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not approve')),
  });

  const items = data?.items ?? [];

  return (
    <div>
      <PageHeader
        title="Approvals"
        description="Proposed changes waiting for sign-off. Identity-sensitive changes open the ticket so you can record how the requester was verified."
      />
      <div className="mb-4 flex gap-1 border-b border-slate-200 dark:border-slate-800">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${
              tab === t.id
                ? 'border-swoop-600 text-slate-900 dark:text-slate-100'
                : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="card overflow-hidden">
        {isLoading ? (
          <LoadingState />
        ) : items.length === 0 ? (
          <EmptyState
            title={tab === 'pending' ? 'The nest is clear' : 'Nothing here yet'}
            description={tab === 'pending' ? 'No proposals are waiting for a decision.' : undefined}
          />
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {items.map((item) => (
              <ApprovalRow
                key={item.id}
                item={item}
                clientName={item.clientId ? clientNames.get(item.clientId) : undefined}
                actionText={actionLabel(vocabulary, item.classification)}
                canQuickApprove={
                  canApprove &&
                  tab === 'pending' &&
                  (item.approvalsRequired ?? 1) === 1 &&
                  !vocabulary?.attestationActions?.includes(item.classification ?? '')
                }
                approving={quickApprove.isPending && quickApprove.variables === item.id}
                onApprove={() => quickApprove.mutate(item.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ApprovalRow({
  item,
  clientName,
  actionText,
  canQuickApprove,
  approving,
  onApprove,
}: {
  item: ActionLog;
  clientName: string | undefined;
  actionText: string;
  canQuickApprove: boolean;
  approving: boolean;
  onApprove: () => void;
}) {
  const entities = parseEntities(item.entities);
  const target = entities.target_user_email ?? entities.target_user_display_name;
  const risky = (item.signals ?? []).some((s) => s.severity !== 'info');
  return (
    <li className="flex items-center gap-4 px-4 py-3">
      <PriorityBadge value={item.priority} />
      <div className="min-w-0 flex-1">
        <Link to={`/tickets/${item.id}`} className="font-medium text-slate-900 hover:text-swoop-700 dark:text-slate-100 dark:hover:text-swoop-300">
          {actionText}
          {target ? ` for ${target}` : ''}
          {entities.group_name ? ` → ${entities.group_name}` : ''}
          {entities.license_sku ? ` (${entities.license_sku})` : ''}
        </Link>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
          <span className="font-medium text-slate-700 dark:text-slate-300">{clientName ?? 'Unknown client'}</span>
          <span className="truncate">{item.ticketSubject}</span>
          <span>{Math.round((item.confidence ?? 0) * 100)}% confident</span>
          {item.approvalState === 'pending' && <span>expires {formatUntil(item.approvalExpiresAt)}</span>}
          {item.approvalState !== 'pending' && <span>{formatRelative(item.createdAt)}</span>}
          <SignalChips signals={item.signals} minSeverity="warn" />
        </div>
      </div>
      {item.executionState && <ExecutionStateBadge state={item.executionState} />}
      <ApprovalBadge state={item.approvalState} required={item.approvalsRequired} />
      {canQuickApprove && !risky ? (
        <button className="btn-primary" onClick={onApprove} disabled={approving}>
          {approving ? <Spinner /> : <CheckIcon />} Approve
        </button>
      ) : (
        <Link to={`/tickets/${item.id}`} className="btn-secondary">
          Review
        </Link>
      )}
    </li>
  );
}

const EXECUTION_STATES: Record<string, { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' | 'info' }> = {
  running: { label: 'Running', tone: 'info' },
  succeeded: { label: 'Done by Swoop', tone: 'success' },
  noop: { label: 'Already done', tone: 'neutral' },
  failed: { label: 'Run failed', tone: 'danger' },
  uncertain: { label: 'Check outcome', tone: 'warning' },
  blocked: { label: 'Run stopped', tone: 'warning' },
};

function ExecutionStateBadge({ state }: { state: string }) {
  const style = EXECUTION_STATES[state];
  if (!style) return null;
  return <Badge tone={style.tone}>{style.label}</Badge>;
}
