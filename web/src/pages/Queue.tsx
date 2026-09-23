import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  errorMessage,
  getActions,
  getClients,
  getQueueSummary,
  getTenants,
  pollNow,
  type ActionLog,
  type Priority,
  type QueueSummary,
} from '../api';
import {
  ApprovalBadge,
  EmptyState,
  LoadingState,
  PageHeader,
  PriorityBadge,
  SignalChips,
  Spinner,
  useToast,
} from '../components/ui';
import { RefreshIcon, SearchIcon } from '../components/Icons';
import { formatRelative } from '../lib/format';
import { actionLabel, categoryLabel, useCan, useVocabulary } from '../lib/session';

const PAGE_SIZE = 50;

/**
 * The triage queue: every ticket's newest triage, most urgent first.
 *
 * This is the page a dispatcher leaves open. It answers "what needs a person
 * right now, and who should take it" — the log below it is for auditing.
 */
export default function Queue() {
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canPoll = useCan('reviewer');
  const { data: vocabulary } = useVocabulary();

  const [priority, setPriority] = useState<'' | Priority>('');
  const [category, setCategory] = useState('');
  const [clientId, setClientId] = useState('');
  const [queue, setQueue] = useState('');
  const [flagged, setFlagged] = useState(false);
  const [days, setDays] = useState(7);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);
  useEffect(() => setPage(0), [priority, category, clientId, queue, flagged, days, debounced]);

  const { data: tenants } = useQuery({ queryKey: ['tenants'], queryFn: () => getTenants().then((r) => r.data) });
  const tenantId = tenants?.[0]?.id;

  const { data: clients } = useQuery({
    queryKey: ['clients', tenantId],
    queryFn: () => getClients(tenantId).then((r) => r.data),
    enabled: Boolean(tenantId),
  });
  const clientNames = useMemo(() => new Map((clients ?? []).map((c) => [c.id, c.name])), [clients]);

  const { data: summary } = useQuery({
    queryKey: ['queue-summary', tenantId, days],
    queryFn: () => getQueueSummary({ tenantId, days }).then((r) => r.data),
    enabled: Boolean(tenantId),
    refetchInterval: 30_000,
  });

  const query = {
    tenantId,
    latest: 'true' as const,
    sort: 'priority' as const,
    days,
    priority: priority || undefined,
    category: category || undefined,
    clientId: clientId || undefined,
    queue: queue || undefined,
    crossTenant: flagged ? ('true' as const) : undefined,
    q: debounced || undefined,
    status: 'classified' as const,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  };

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['actions', 'queue', query],
    queryFn: () => getActions(query).then((r) => r.data),
    enabled: Boolean(tenantId),
    refetchInterval: 20_000,
    placeholderData: (previous) => previous,
  });

  // Tickets that arrive while the page is open swoop in; the first load does not.
  const seen = useRef<Set<string> | null>(null);
  const [arrived, setArrived] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!data) return;
    const ids = data.items.map((i) => i.id);
    if (seen.current === null) {
      seen.current = new Set(ids);
      return;
    }
    const fresh = ids.filter((id) => !seen.current!.has(id));
    fresh.forEach((id) => seen.current!.add(id));
    if (fresh.length > 0) setArrived(new Set(fresh));
  }, [data]);

  const queues = useMemo(() => {
    const names = new Set<string>(['Service desk', 'Security', 'Infrastructure', 'Account management', 'On-call']);
    for (const item of data?.items ?? []) if (item.suggestedQueue) names.add(item.suggestedQueue);
    return [...names].sort();
  }, [data]);

  const poll = useMutation({
    mutationFn: () => pollNow(tenantId!),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ['actions'] });
      void queryClient.invalidateQueries({ queryKey: ['queue-summary'] });
      const s = res.data.summary;
      if (!res.data.ok) toast.error(res.data.error ?? 'The poll failed');
      else toast.success(s ? `Fetched ${s.fetched}, triaged ${s.classified}` : 'Poll complete');
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not poll')),
  });

  const items = data?.items ?? [];
  const total = data?.total ?? 0;

  return (
    <div>
      <PageHeader
        title="Triage queue"
        description="Each ticket's latest triage, most urgent first. Nothing here has been changed in any tenant."
        actions={
          canPoll && tenantId ? (
            <button className="btn-secondary" onClick={() => poll.mutate()} disabled={poll.isPending}>
              {poll.isPending ? <Spinner /> : <RefreshIcon />} Poll now
            </button>
          ) : null
        }
      />

      <PriorityStrip summary={summary} active={priority} onPick={(p) => setPriority(p === priority ? '' : p)} />

      <div className="mb-3 mt-5 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[14rem] flex-1">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            className="input pl-9"
            placeholder="Search subject, summary, requester…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <select className="input w-auto" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">All categories</option>
          {vocabulary?.categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
        <select className="input w-auto" value={queue} onChange={(e) => setQueue(e.target.value)}>
          <option value="">All queues</option>
          {queues.map((q) => (
            <option key={q} value={q}>
              {q}
            </option>
          ))}
        </select>
        <select className="input w-auto" value={clientId} onChange={(e) => setClientId(e.target.value)}>
          <option value="">All clients</option>
          {clients?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select className="input w-auto" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={1}>Last 24 hours</option>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
        </select>
        <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
          <input type="checkbox" checked={flagged} onChange={(e) => setFlagged(e.target.checked)} />
          Cross-client only
        </label>
      </div>

      <div className="card overflow-hidden">
        {isLoading || !tenantId ? (
          <LoadingState />
        ) : items.length === 0 ? (
          <EmptyState
            title={priority || category || clientId || queue || flagged || debounced ? 'Nothing matches those filters' : 'All quiet on the fence line'}
            description="New tickets appear here as soon as they are triaged. Nothing to swoop on yet."
          />
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {items.map((item) => (
              <QueueRow
                key={item.id}
                item={item}
                clientName={item.clientId ? clientNames.get(item.clientId) : undefined}
                categoryText={categoryLabel(vocabulary, item.category)}
                actionText={actionLabel(vocabulary, item.classification)}
                fresh={arrived.has(item.id)}
                onOpen={() => navigate(`/tickets/${item.id}`)}
              />
            ))}
          </ul>
        )}
      </div>

      {total > PAGE_SIZE && (
        <div className="mt-3 flex items-center justify-between text-sm text-slate-500">
          <span>
            {page * PAGE_SIZE + 1}–{Math.min(total, (page + 1) * PAGE_SIZE)} of {total}
            {isFetching && <Spinner className="ml-2 inline h-3 w-3" />}
          </span>
          <div className="flex gap-2">
            <button className="btn-secondary" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
              Previous
            </button>
            <button className="btn-secondary" disabled={!data?.hasMore} onClick={() => setPage((p) => p + 1)}>
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function PriorityStrip({
  summary,
  active,
  onPick,
}: {
  summary: QueueSummary | undefined;
  active: string;
  onPick: (p: Priority) => void;
}) {
  const cells: Array<{ id: Priority; label: string; tone: string }> = [
    { id: 'P1', label: 'Critical', tone: 'text-eye-600 dark:text-eye-400' },
    { id: 'P2', label: 'High', tone: 'text-amber-600 dark:text-amber-400' },
    { id: 'P3', label: 'Medium', tone: 'text-swoop-700 dark:text-swoop-300' },
    { id: 'P4', label: 'Low', tone: 'text-slate-500 dark:text-slate-400' },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
      {cells.map((cell) => (
        <button
          key={cell.id}
          onClick={() => onPick(cell.id)}
          className={`card p-3 text-left transition-shadow hover:shadow-sm ${active === cell.id ? 'ring-2 ring-swoop-500' : ''}`}
        >
          <div className={`tnum text-2xl font-semibold ${cell.tone}`}>{summary?.priorities[cell.id] ?? '—'}</div>
          <div className="mt-0.5 text-xs font-medium text-slate-500 dark:text-slate-400">
            {cell.id} · {cell.label}
          </div>
        </button>
      ))}
      <Link to="/approvals" className="card p-3 transition-shadow hover:shadow-sm">
        <div className="tnum text-2xl font-semibold text-slate-900 dark:text-slate-50">{summary?.pendingApprovals ?? '—'}</div>
        <div className="mt-0.5 text-xs font-medium text-slate-500 dark:text-slate-400">Awaiting approval</div>
      </Link>
      <Link to="/incidents" className="card p-3 transition-shadow hover:shadow-sm">
        <div className={`tnum text-2xl font-semibold ${summary?.openIncidents ? 'text-eye-600 dark:text-eye-400' : 'text-slate-900 dark:text-slate-50'}`}>
          {summary?.openIncidents ?? '—'}
        </div>
        <div className="mt-0.5 text-xs font-medium text-slate-500 dark:text-slate-400">Open incidents</div>
      </Link>
      <div className="card p-3">
        <div className={`tnum text-2xl font-semibold ${summary?.crossTenant ? 'text-eye-600 dark:text-eye-400' : 'text-slate-900 dark:text-slate-50'}`}>
          {summary?.crossTenant ?? '—'}
        </div>
        <div className="mt-0.5 text-xs font-medium text-slate-500 dark:text-slate-400">Cross-client requests</div>
      </div>
    </div>
  );
}

function QueueRow({
  item,
  clientName,
  categoryText,
  actionText,
  fresh,
  onOpen,
}: {
  item: ActionLog;
  clientName: string | undefined;
  categoryText: string;
  actionText: string;
  fresh: boolean;
  onOpen: () => void;
}) {
  const isAction = item.classification !== 'ESCALATE' && item.classification !== 'FOLLOW_UP';
  return (
    <li
      className={`group cursor-pointer px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-800/40 ${fresh ? 'animate-swoop-in' : ''}`}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen();
      }}
      tabIndex={0}
      role="link"
      aria-label={`Open ticket ${item.ticketDisplayId ?? item.ticketId}`}
    >
      <div className="flex items-start gap-3">
        <div className="pt-0.5">
          <PriorityBadge value={item.priority} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="truncate font-medium text-slate-900 group-hover:text-swoop-700 dark:text-slate-100 dark:group-hover:text-swoop-300">
              {item.ticketSubject || '(no subject)'}
            </span>
            <span className="text-xs text-slate-400">#{item.ticketDisplayId ?? item.ticketId}</span>
          </div>
          {item.summary && (
            <p className="mt-0.5 line-clamp-1 text-sm text-slate-500 dark:text-slate-400">{item.summary}</p>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
            <span className="font-medium text-slate-700 dark:text-slate-300">{clientName ?? 'Unknown client'}</span>
            <span>
              {categoryText}
              {item.subcategory ? ` · ${item.subcategory}` : ''}
            </span>
            {item.suggestedQueue && (
              <span className="rounded bg-slate-100 px-1.5 py-0.5 dark:bg-slate-800">→ {item.suggestedQueue}</span>
            )}
            {isAction && <span className="text-swoop-700 dark:text-swoop-300">Proposes: {actionText}</span>}
            <SignalChips signals={item.signals} minSeverity="warn" max={3} />
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <ApprovalBadge state={item.approvalState} required={item.approvalsRequired} />
          <span className="text-xs text-slate-400">{formatRelative(item.createdAt)}</span>
        </div>
      </div>
    </li>
  );
}
