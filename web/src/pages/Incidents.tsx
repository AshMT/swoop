import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { errorMessage, getClients, getIncidents, getTenants, setIncidentStatus, type IncidentCluster } from '../api';
import { Badge, EmptyState, LoadingState, PageHeader, PriorityBadge, useToast } from '../components/ui';
import { formatDateTime, formatRelative } from '../lib/format';
import { categoryLabel, useCan, useVocabulary } from '../lib/session';

/**
 * Bursts of similar tickets Swoop grouped together. One owner fixes the cause;
 * the rest of the tickets get a status update instead of five investigations.
 */
export default function Incidents() {
  const [status, setStatus] = useState<'active' | 'resolved'>('active');
  const { data: vocabulary } = useVocabulary();
  const canAct = useCan('reviewer');
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
    queryKey: ['incidents', tenantId, status],
    queryFn: () => getIncidents({ tenantId, status, days: 30 }).then((r) => r.data),
    enabled: Boolean(tenantId),
    refetchInterval: 30_000,
  });

  const update = useMutation({
    mutationFn: ({ id, next }: { id: string; next: 'open' | 'acknowledged' | 'resolved' }) => setIncidentStatus(id, next),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['incidents'] });
      void queryClient.invalidateQueries({ queryKey: ['queue-summary'] });
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not update the incident')),
  });

  return (
    <div>
      <PageHeader
        title="Incidents"
        description="Similar tickets arriving together. Several clients at once usually means something upstream — Microsoft 365, an ISP, a vendor."
        actions={
          <div className="flex rounded-lg border border-slate-300 p-0.5 dark:border-slate-700">
            {(['active', 'resolved'] as const).map((s) => (
              <button
                key={s}
                onClick={() => setStatus(s)}
                className={`rounded-md px-3 py-1 text-sm capitalize ${status === s ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900' : 'text-slate-600 dark:text-slate-300'}`}
              >
                {s}
              </button>
            ))}
          </div>
        }
      />
      {isLoading ? (
        <LoadingState />
      ) : !data || data.length === 0 ? (
        <div className="card">
          <EmptyState
            title={status === 'active' ? 'No flocks forming' : 'No resolved incidents in the last 30 days'}
            description="When several tickets describe the same problem within the window set in Settings, they are grouped here."
          />
        </div>
      ) : (
        <div className="space-y-4">
          {data.map((incident) => (
            <IncidentCard
              key={incident.id}
              incident={incident}
              categoryText={categoryLabel(vocabulary, incident.category)}
              clientNames={clientNames}
              canAct={canAct}
              onStatus={(next) => update.mutate({ id: incident.id, next })}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function IncidentCard({
  incident,
  categoryText,
  clientNames,
  canAct,
  onStatus,
}: {
  incident: IncidentCluster;
  categoryText: string;
  clientNames: Map<string, string>;
  canAct: boolean;
  onStatus: (next: 'open' | 'acknowledged' | 'resolved') => void;
}) {
  const multi = (incident.clientCount ?? 0) > 1;
  return (
    <section className={`card overflow-hidden ${incident.status === 'open' ? 'ring-1 ring-eye-300 dark:ring-eye-800' : ''}`}>
      {incident.status === 'open' && <div className="h-1 bg-sheen" />}
      <div className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              {multi ? <Badge tone="danger">{incident.clientCount} clients</Badge> : <Badge>{clientNames.get(incident.clientId ?? '') ?? 'One client'}</Badge>}
              <Badge>{categoryText}</Badge>
              <Badge tone={incident.status === 'open' ? 'warning' : incident.status === 'acknowledged' ? 'info' : 'success'}>
                {incident.status}
              </Badge>
            </div>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">{incident.label}</h2>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {incident.ticketCount} tickets · first {formatDateTime(incident.firstSeenAt)} · latest {formatRelative(incident.lastSeenAt)}
              {incident.acknowledgedBy && ` · ${incident.status} by ${incident.acknowledgedBy}`}
            </p>
            {incident.terms.length > 0 && <p className="mt-1 text-xs text-slate-400">Shared words: {incident.terms.join(', ')}</p>}
          </div>
          {canAct && (
            <div className="flex gap-2">
              {incident.status === 'open' && (
                <button className="btn-secondary" onClick={() => onStatus('acknowledged')}>
                  Acknowledge
                </button>
              )}
              {incident.status !== 'resolved' ? (
                <button className="btn-primary" onClick={() => onStatus('resolved')}>
                  Resolve
                </button>
              ) : (
                <button className="btn-secondary" onClick={() => onStatus('open')}>
                  Reopen
                </button>
              )}
            </div>
          )}
        </div>
        {incident.tickets && incident.tickets.length > 0 && (
          <ul className="mt-3 divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
            {incident.tickets.map((t) => (
              <li key={t.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <PriorityBadge value={t.priority} />
                <Link to={`/tickets/${t.id}`} className="min-w-0 flex-1 truncate hover:underline">
                  {t.ticketSubject}
                </Link>
                <span className="hidden text-xs text-slate-500 sm:inline">{clientNames.get(t.clientId ?? '') ?? ''}</span>
                <span className="text-xs text-slate-400">{formatRelative(t.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
