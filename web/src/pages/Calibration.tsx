import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getCalibration, getClients, getTenants } from '../api';
import { Alert, ClassificationBadge, EmptyState, LoadingState, PageHeader, StatCard } from '../components/ui';
import { formatDuration, formatPercent, humanClassification } from '../lib/format';

const RANGES = [
  { label: 'Last 7 days', days: 7 },
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 90 days', days: 90 },
  { label: 'All time', days: undefined },
];

const READINESS: Record<
  string,
  { tone: 'info' | 'warning' | 'danger' | 'success'; title: string; body: string }
> = {
  'insufficient-data': {
    tone: 'info',
    title: 'Not enough reviews yet',
    body: 'Mark classifications correct or incorrect on the Dashboard. Until there are at least 20 reviews, the agreement rate moves too much to mean anything.',
  },
  'below-floor': {
    tone: 'danger',
    title: 'Agreement is below 85%',
    body: 'This is a prompt or model problem, not something to tune around. Look at the confusion table below for the pairs being mixed up, add the distinction to the system prompt in Settings, then re-run a few tickets.',
  },
  'approaching-target': {
    tone: 'warning',
    title: 'Agreement is between 85% and 90%',
    body: 'Close. Work through the remaining disagreements — they usually cluster in one or two label pairs — before widening the set of clients with automation enabled.',
  },
  'at-target': {
    tone: 'success',
    title: 'Agreement is at or above 90%',
    body: 'Classification is tracking what your technicians would have done. Enable another client, and keep reviewing a sample so the figure stays honest as ticket mix changes.',
  },
};

export default function Calibration() {
  const [days, setDays] = useState<number | undefined>(30);
  const [clientId, setClientId] = useState('');

  const { data: tenants } = useQuery({ queryKey: ['tenants'], queryFn: () => getTenants().then((r) => r.data) });
  const tenantId = tenants?.[0]?.id;

  const { data: clients = [] } = useQuery({
    queryKey: ['clients', tenantId],
    queryFn: () => getClients(tenantId).then((r) => r.data),
    enabled: Boolean(tenantId),
  });

  const { data: report, isLoading } = useQuery({
    queryKey: ['calibration', tenantId, clientId, days],
    queryFn: () => getCalibration({ tenantId, clientId: clientId || undefined, days }).then((r) => r.data),
    enabled: Boolean(tenantId),
    refetchInterval: 60_000,
  });

  if (isLoading || !report) {
    return (
      <div>
        <PageHeader title="Calibration" />
        <div className="card">
          <LoadingState label="Building the calibration report" />
        </div>
      </div>
    );
  }

  const readiness = READINESS[report.readiness];
  const maxDaily = Math.max(1, ...report.daily.map((d) => d.total));
  // A well-calibrated model is more confident when it is right than when it is
  // wrong. If the two averages are close, confidence is not carrying signal.
  const confidenceGap =
    report.avgConfidenceWhenCorrect !== null && report.avgConfidenceWhenIncorrect !== null
      ? report.avgConfidenceWhenCorrect - report.avgConfidenceWhenIncorrect
      : null;

  return (
    <div>
      <PageHeader
        title="Calibration"
        description="How often Swoop's classification matches what a technician would have chosen. This is the number that decides whether it is safe to widen its scope."
        actions={
          <>
            <select value={clientId} onChange={(e) => setClientId(e.target.value)} className="input w-auto">
              <option value="">All clients</option>
              {clients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </select>
            <select
              value={String(days ?? '')}
              onChange={(e) => setDays(e.target.value ? Number(e.target.value) : undefined)}
              className="input w-auto"
            >
              {RANGES.map((range) => (
                <option key={range.label} value={String(range.days ?? '')}>
                  {range.label}
                </option>
              ))}
            </select>
          </>
        }
      />

      <div className="mb-6">
        <Alert tone={readiness.tone} title={readiness.title}>
          {readiness.body}
        </Alert>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard
          label="Agreement rate"
          value={formatPercent(report.agreement, 1)}
          hint={`${report.correct}/${report.reviewed} reviewed`}
          tone={
            report.agreement === null
              ? 'neutral'
              : report.agreement >= 0.9
                ? 'success'
                : report.agreement >= 0.85
                  ? 'warning'
                  : 'danger'
          }
        />
        <StatCard
          label="Review coverage"
          value={formatPercent(report.reviewCoverage)}
          hint={`of ${report.totalClassified} classified`}
        />
        <StatCard label="Avg confidence" value={formatPercent(report.avgConfidence)} />
        <StatCard
          label="AI failures"
          value={report.totalFailed}
          tone={report.totalFailed > 0 ? 'danger' : 'neutral'}
          hint="Not counted as errors"
        />
        <StatCard label="Median latency" value={formatDuration(report.latency.p50)} hint={`p95 ${formatDuration(report.latency.p95)}`} />
        <StatCard
          label="Notes delivered"
          value={report.noteDelivery.posted}
          hint={report.noteDelivery.failed > 0 ? `${report.noteDelivery.failed} failed` : undefined}
          tone={report.noteDelivery.failed > 0 ? 'warning' : 'neutral'}
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* ─── Per-label accuracy ───────────────────────────────────────────── */}
        <div className="card">
          <header className="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Accuracy by classification</h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Where the disagreements are concentrated.
            </p>
          </header>
          {report.byClassification.length === 0 ? (
            <EmptyState title="Nothing classified in this window" />
          ) : (
            <table className="w-full">
              <thead className="border-b border-slate-200 dark:border-slate-800">
                <tr>
                  <th className="th">Classification</th>
                  <th className="th text-right">Volume</th>
                  <th className="th text-right">Reviewed</th>
                  <th className="th text-right">Agreement</th>
                  <th className="th text-right">Avg conf.</th>
                </tr>
              </thead>
              <tbody>
                {report.byClassification.map((row) => (
                  <tr key={row.classification} className="border-b border-slate-100 dark:border-slate-800/60">
                    <td className="td">
                      <ClassificationBadge
                        value={row.classification}
                        label={humanClassification(row.classification)}
                      />
                    </td>
                    <td className="td tnum text-right">{row.total}</td>
                    <td className="td tnum text-right text-slate-500">{row.reviewed}</td>
                    <td
                      className={`td tnum text-right font-medium ${
                        row.agreement === null
                          ? 'text-slate-400'
                          : row.agreement >= 0.9
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : row.agreement >= 0.85
                              ? 'text-amber-600 dark:text-amber-400'
                              : 'text-red-600 dark:text-red-400'
                      }`}
                    >
                      {formatPercent(row.agreement)}
                    </td>
                    <td className="td tnum text-right text-slate-500">{formatPercent(row.avgConfidence)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* ─── Confusion pairs ──────────────────────────────────────────────── */}
        <div className="card">
          <header className="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">What it got wrong</h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Swoop's answer against the one your technician chose. Repeated pairs are prompt fixes.
            </p>
          </header>
          {report.confusion.length === 0 ? (
            <EmptyState
              title="No recorded disagreements"
              description="Either nothing has been marked incorrect, or every review has agreed so far."
            />
          ) : (
            <table className="w-full">
              <thead className="border-b border-slate-200 dark:border-slate-800">
                <tr>
                  <th className="th">Swoop said</th>
                  <th className="th">Should have been</th>
                  <th className="th text-right">Count</th>
                </tr>
              </thead>
              <tbody>
                {report.confusion.map((cell) => (
                  <tr
                    key={`${cell.predicted}-${cell.actual}`}
                    className="border-b border-slate-100 dark:border-slate-800/60"
                  >
                    <td className="td">
                      <ClassificationBadge value={cell.predicted} label={humanClassification(cell.predicted)} />
                    </td>
                    <td className="td">
                      {cell.actual === '(unspecified)' ? (
                        <span className="text-xs italic text-slate-400">not specified</span>
                      ) : (
                        <ClassificationBadge value={cell.actual} label={humanClassification(cell.actual)} />
                      )}
                    </td>
                    <td className="td tnum text-right font-medium">{cell.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* ─── Confidence calibration ───────────────────────────────────────── */}
        <div className="card p-4">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Is confidence meaningful?</h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            A useful confidence score is higher on the answers that turned out right. If the two bars are
            close, the threshold in Settings is not buying you much.
          </p>
          <div className="mt-4 space-y-3">
            <ConfidenceRow
              label="When correct"
              value={report.avgConfidenceWhenCorrect}
              colour="bg-emerald-500"
            />
            <ConfidenceRow
              label="When incorrect"
              value={report.avgConfidenceWhenIncorrect}
              colour="bg-red-500"
            />
          </div>
          {confidenceGap !== null && (
            <p className="mt-4 text-xs text-slate-500 dark:text-slate-400">
              {confidenceGap >= 0.1
                ? `Confidence separates right from wrong by ${formatPercent(confidenceGap, 1)} — the threshold is doing real work.`
                : confidenceGap >= 0
                  ? `Only ${formatPercent(confidenceGap, 1)} of separation. The model is nearly as confident when wrong, so raising the threshold will mostly just escalate more correct answers.`
                  : 'The model is more confident when it is wrong. Treat its confidence as noise and rely on the sensitivity flag instead.'}
            </p>
          )}
        </div>

        {/* ─── Volume and review progress ───────────────────────────────────── */}
        <div className="card p-4">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Daily volume</h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            Classified tickets per day, with the reviewed share filled in.
          </p>
          {report.daily.length === 0 ? (
            <p className="py-8 text-center text-xs text-slate-400">No activity in this window.</p>
          ) : (
            <div className="mt-4">
              <div className="flex h-32 items-end gap-1">
                {report.daily.slice(-30).map((day) => (
                  <div
                    key={day.date}
                    className="group relative flex-1"
                    title={`${day.date}: ${day.total} classified, ${day.reviewed} reviewed`}
                  >
                    <div
                      className="w-full rounded-t bg-slate-200 dark:bg-slate-700"
                      style={{ height: `${Math.max(2, (day.total / maxDaily) * 100)}%` }}
                    >
                      <div
                        className="w-full rounded-t bg-swoop-500"
                        style={{
                          height: `${day.total > 0 ? (day.reviewed / day.total) * 100 : 0}%`,
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-2 flex items-center justify-between text-xs text-slate-400">
                <span>{report.daily.slice(-30)[0]?.date}</span>
                <span className="flex items-center gap-3">
                  <span className="flex items-center gap-1">
                    <span className="h-2 w-2 rounded-sm bg-swoop-500" /> reviewed
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="h-2 w-2 rounded-sm bg-slate-200 dark:bg-slate-700" /> unreviewed
                  </span>
                </span>
                <span>{report.daily[report.daily.length - 1]?.date}</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ConfidenceRow({
  label,
  value,
  colour,
}: {
  label: string;
  value: number | null;
  colour: string;
}) {
  return (
    <div>
      <div className="mb-1 flex justify-between text-xs">
        <span className="text-slate-600 dark:text-slate-400">{label}</span>
        <span className="tnum font-medium text-slate-700 dark:text-slate-300">{formatPercent(value, 1)}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
        <div className={`h-full rounded-full ${colour}`} style={{ width: `${(value ?? 0) * 100}%` }} />
      </div>
    </div>
  );
}
