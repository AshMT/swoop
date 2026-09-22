import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  bulkReview,
  downloadCsv,
  errorMessage,
  getActionStats,
  getActions,
  getClassifications,
  getClients,
  getTenants,
  pollNow,
  type ActionQuery,
  type Client,
} from '../api';
import ActionRow from '../components/ActionRow';
import {
  Badge,
  EmptyState,
  LoadingState,
  PageHeader,
  Spinner,
  StatCard,
  useToast,
} from '../components/ui';
import { DownloadIcon, RefreshIcon, SearchIcon } from '../components/Icons';
import { formatPercent, humanClassification } from '../lib/format';

const PAGE_SIZE = 25;

export default function Dashboard() {
  const queryClient = useQueryClient();
  const toast = useToast();

  const [filterClient, setFilterClient] = useState('');
  const [filterClassification, setFilterClassification] = useState('');
  const [filterReview, setFilterReview] = useState<'' | 'unreviewed' | 'correct' | 'incorrect'>('');
  const [filterSensitivity, setFilterSensitivity] = useState<'' | 'high'>('');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);

  // Debounced so typing does not fire a request per keystroke.
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  // Any filter change invalidates the current page offset.
  useEffect(() => {
    setPage(0);
    setSelected([]);
  }, [filterClient, filterClassification, filterReview, filterSensitivity, debouncedSearch]);

  const { data: tenants } = useQuery({ queryKey: ['tenants'], queryFn: () => getTenants().then((r) => r.data) });
  const tenant = tenants?.[0];
  const tenantId = tenant?.id;

  const { data: classifications = [] } = useQuery({
    queryKey: ['classifications'],
    queryFn: () => getClassifications().then((r) => r.data.classifications),
    staleTime: Infinity,
  });

  const { data: clients = [] } = useQuery({
    queryKey: ['clients', tenantId],
    queryFn: () => getClients(tenantId).then((r) => r.data),
    enabled: Boolean(tenantId),
  });

  const { data: stats } = useQuery({
    queryKey: ['stats', tenantId],
    queryFn: () => getActionStats({ tenantId }).then((r) => r.data),
    enabled: Boolean(tenantId),
    refetchInterval: 30_000,
  });

  const query: ActionQuery = useMemo(
    () => ({
      tenantId,
      clientId: filterClient || undefined,
      classification: filterClassification || undefined,
      review: filterReview || undefined,
      sensitivity: filterSensitivity || undefined,
      q: debouncedSearch || undefined,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    }),
    [tenantId, filterClient, filterClassification, filterReview, filterSensitivity, debouncedSearch, page],
  );

  const { data: actions, isLoading, isFetching } = useQuery({
    queryKey: ['actions', query],
    queryFn: () => getActions(query).then((r) => r.data),
    enabled: Boolean(tenantId),
    refetchInterval: 30_000,
    placeholderData: (previous) => previous,
  });

  const clientMap = useMemo(() => {
    const map: Record<string, Client> = {};
    for (const client of clients) map[client.id] = client;
    return map;
  }, [clients]);

  const poll = useMutation({
    mutationFn: () => pollNow(tenantId!),
    onSuccess: (res) => {
      const summary = res.data.summary;
      void queryClient.invalidateQueries({ queryKey: ['actions'] });
      void queryClient.invalidateQueries({ queryKey: ['stats'] });
      void queryClient.invalidateQueries({ queryKey: ['system-status'] });
      if (!summary || summary.outcome === 'error') {
        toast.error(summary?.error ?? res.data.error ?? 'The poll did not complete');
      } else if (summary.outcome === 'paused' || summary.outcome === 'idle') {
        toast.info(summary.error ?? 'Nothing to poll');
      } else if (summary.classified > 0) {
        toast.success(
          `Classified ${summary.classified} new ticket(s)` +
            (summary.failed > 0 ? `, ${summary.failed} failed and will be retried` : ''),
        );
      } else if (summary.failed > 0) {
        toast.error(summary.error ?? `${summary.failed} ticket(s) failed classification`);
      } else {
        toast.info(`Fetched ${summary.fetched} ticket(s); nothing new to classify`);
      }
    },
    onError: (err) => toast.error(errorMessage(err, 'The poll failed')),
  });

  const markSelected = useMutation({
    mutationFn: (verdict: 'correct' | 'incorrect' | null) => bulkReview(selected, verdict),
    onSuccess: (res) => {
      setSelected([]);
      void queryClient.invalidateQueries({ queryKey: ['actions'] });
      void queryClient.invalidateQueries({ queryKey: ['stats'] });
      void queryClient.invalidateQueries({ queryKey: ['calibration'] });
      toast.success(`Updated ${res.data.updated} row(s)`);
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not update the reviews')),
  });

  const items = actions?.items ?? [];
  const total = actions?.total ?? 0;
  const allOnPageSelected = items.length > 0 && items.every((item) => selected.includes(item.id));

  const handleExport = async () => {
    try {
      await downloadCsv({ ...query, limit: undefined, offset: undefined });
    } catch (err) {
      toast.error(errorMessage(err, 'Could not export the log'));
    }
  };

  if (!tenant) {
    return (
      <div>
        <PageHeader title="Dashboard" />
        <div className="card">
          <EmptyState
            title="No SuperOps connection yet"
            description="Add your SuperOps credentials in Settings before Swoop can start reading tickets."
          />
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Dashboard"
        description={
          tenant.dryRun
            ? 'Preview mode — tickets are classified and logged, but no notes are written back to SuperOps.'
            : 'Swoop classifies tickets and posts a private note proposing an action. It never executes anything.'
        }
        actions={
          <>
            <button onClick={handleExport} className="btn-secondary">
              <DownloadIcon /> Export CSV
            </button>
            <button onClick={() => poll.mutate()} disabled={poll.isPending} className="btn-primary">
              {poll.isPending ? <Spinner /> : <RefreshIcon />}
              Poll now
            </button>
          </>
        }
      />

      {/* ─── Headline numbers ─────────────────────────────────────────────── */}
      {stats && (
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <StatCard label="Tickets classified" value={stats.total} />
          <StatCard
            label="Agreement rate"
            value={formatPercent(stats.agreement)}
            hint={stats.reviewed > 0 ? `${stats.reviewed} reviewed` : 'Review some tickets'}
            tone={
              stats.agreement === null
                ? 'neutral'
                : stats.agreement >= 0.9
                  ? 'success'
                  : stats.agreement >= 0.85
                    ? 'warning'
                    : 'danger'
            }
          />
          <StatCard
            label="Awaiting review"
            value={stats.awaitingReview}
            tone={stats.awaitingReview > 0 ? 'warning' : 'neutral'}
          />
          <StatCard label="High sensitivity" value={stats.highSensitivity} />
          <StatCard
            label="AI failures"
            value={stats.failures}
            tone={stats.failures > 0 ? 'danger' : 'neutral'}
            hint={stats.failures > 0 ? 'Excluded from accuracy' : undefined}
          />
        </div>
      )}

      {/* ─── Filters ──────────────────────────────────────────────────────── */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search subject, body, ticket or requester"
            className="input w-72 pl-8"
            aria-label="Search the action log"
          />
        </div>

        <select value={filterClient} onChange={(e) => setFilterClient(e.target.value)} className="input w-auto">
          <option value="">All clients</option>
          {clients.map((client) => (
            <option key={client.id} value={client.id}>
              {client.name}
            </option>
          ))}
        </select>

        <select
          value={filterClassification}
          onChange={(e) => setFilterClassification(e.target.value)}
          className="input w-auto"
        >
          <option value="">All classifications</option>
          {classifications.map((id) => (
            <option key={id} value={id}>
              {humanClassification(id)}
            </option>
          ))}
        </select>

        <select
          value={filterReview}
          onChange={(e) => setFilterReview(e.target.value as typeof filterReview)}
          className="input w-auto"
        >
          <option value="">Any review state</option>
          <option value="unreviewed">Not yet reviewed</option>
          <option value="correct">Marked correct</option>
          <option value="incorrect">Marked incorrect</option>
        </select>

        <button
          onClick={() => setFilterSensitivity(filterSensitivity ? '' : 'high')}
          className={filterSensitivity ? 'btn-primary' : 'btn-secondary'}
        >
          High sensitivity only
        </button>

        {(filterClient || filterClassification || filterReview || filterSensitivity || search) && (
          <button
            onClick={() => {
              setFilterClient('');
              setFilterClassification('');
              setFilterReview('');
              setFilterSensitivity('');
              setSearch('');
            }}
            className="btn-ghost"
          >
            Clear filters
          </button>
        )}

        {isFetching && !isLoading && <Spinner className="h-4 w-4 text-slate-400" />}
      </div>

      {/* ─── Bulk review bar ──────────────────────────────────────────────── */}
      {selected.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-swoop-200 bg-swoop-50 px-4 py-2.5 dark:border-swoop-900 dark:bg-swoop-950/50">
          <span className="text-sm font-medium text-swoop-900 dark:text-swoop-200">
            {selected.length} selected
          </span>
          <button
            onClick={() => markSelected.mutate('correct')}
            disabled={markSelected.isPending}
            className="btn-secondary !py-1 text-xs"
          >
            Mark all correct
          </button>
          <button
            onClick={() => markSelected.mutate(null)}
            disabled={markSelected.isPending}
            className="btn-ghost !py-1 text-xs"
          >
            Clear reviews
          </button>
          <button onClick={() => setSelected([])} className="btn-ghost !py-1 text-xs">
            Deselect
          </button>
        </div>
      )}

      {/* ─── Log ──────────────────────────────────────────────────────────── */}
      <div className="card overflow-hidden">
        {isLoading ? (
          <LoadingState label="Loading the action log" />
        ) : items.length === 0 ? (
          <EmptyState
            title={total === 0 ? 'Nothing classified yet' : 'No rows match these filters'}
            description={
              total === 0
                ? 'Swoop polls SuperOps on a schedule and classifies tickets from clients with automation enabled. Use "Poll now" to check immediately.'
                : 'Try widening the filters or clearing the search.'
            }
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/60">
                  <tr>
                    <th className="px-3 py-2.5">
                      <input
                        type="checkbox"
                        checked={allOnPageSelected}
                        onChange={(e) =>
                          setSelected(
                            e.target.checked
                              ? [...new Set([...selected, ...items.map((i) => i.id)])]
                              : selected.filter((id) => !items.some((i) => i.id === id)),
                          )
                        }
                        aria-label="Select every row on this page"
                        className="h-4 w-4 rounded border-slate-300 text-swoop-600 dark:border-slate-600 dark:bg-slate-800"
                      />
                    </th>
                    <th className="th">Ticket</th>
                    <th className="th">Subject</th>
                    <th className="th">Client</th>
                    <th className="th">Classification</th>
                    <th className="th">Confidence</th>
                    <th className="th">Correct?</th>
                    <th className="th">When</th>
                    <th className="th" />
                  </tr>
                </thead>
                <tbody>
                  {items.map((log) => (
                    <ActionRow
                      key={log.id}
                      log={log}
                      client={log.clientId ? clientMap[log.clientId] : undefined}
                      classifications={classifications}
                      confidenceThreshold={tenant.confidenceThreshold}
                      selected={selected.includes(log.id)}
                      onSelect={(id, isSelected) =>
                        setSelected((current) =>
                          isSelected ? [...current, id] : current.filter((x) => x !== id),
                        )
                      }
                    />
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex items-center justify-between border-t border-slate-200 px-4 py-3 text-sm dark:border-slate-800">
              <span className="text-slate-500 dark:text-slate-400">
                {page * PAGE_SIZE + 1}–{page * PAGE_SIZE + items.length} of {total}
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                  className="btn-secondary !py-1 text-xs"
                >
                  Previous
                </button>
                <button
                  onClick={() => setPage((p) => p + 1)}
                  disabled={!actions?.hasMore}
                  className="btn-secondary !py-1 text-xs"
                >
                  Next
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {stats && stats.awaitingReview > 0 && (
        <p className="mt-4 text-xs text-slate-500 dark:text-slate-400">
          <Badge tone="warning">Tip</Badge>{' '}
          Marking classifications correct or incorrect is what produces the agreement rate on the Calibration
          page. Aim for at least 20 reviews before reading much into the number.
        </p>
      )}
    </div>
  );
}
