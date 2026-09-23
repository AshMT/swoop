import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { errorMessage, investigateAction, type ActionDetail, type Investigation, type KbRef, type ToolRun } from '../api';
import { formatDuration, formatRelative } from '../lib/format';
import { actionLabel, useCan, useVocabulary } from '../lib/session';
import { Badge, Spinner, useToast } from './ui';
import { ChevronDownIcon, ChevronRightIcon, SearchIcon } from './Icons';
import { Callout, Card, CopyButton, Fact } from './Panel';

/**
 * What the investigation agent found: the lookups it ran against Microsoft
 * 365, the runbooks and past tickets, and what it would do. Read-only — the
 * recommendation only ever informs the proposal.
 */
export function InvestigationCard({ log }: { log: ActionDetail }) {
  const canReview = useCan('reviewer');
  const toast = useToast();
  const queryClient = useQueryClient();
  const inv = log.investigation;

  const run = useMutation({
    mutationFn: () => investigateAction(log.id).then((r) => r.data),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['action', log.id] });
      if (result.status === 'completed') toast.success(`Investigated with ${result.steps.length} lookup${result.steps.length === 1 ? '' : 's'}`);
      else toast.error(result.error ?? 'The investigation did not finish');
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not investigate')),
  });

  if (!inv && !log.agentEnabled) return null;
  if (log.crossTenant) return null;

  const button = canReview && log.agentEnabled && (
    <button className="btn-ghost text-xs" onClick={() => run.mutate()} disabled={run.isPending}>
      {run.isPending ? <Spinner /> : <SearchIcon />} {inv ? 'Re-investigate' : 'Investigate'}
    </button>
  );

  if (!inv) {
    return (
      <Card title="Investigation" action={button}>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          {run.isPending
            ? 'Looking the user up, checking the runbooks and past tickets… this can take a minute.'
            : 'Not investigated yet. Swoop can look the people involved up in Microsoft 365, read this client’s runbooks and similar tickets, and suggest a fix. It only reads.'}
        </p>
      </Card>
    );
  }

  return (
    <Card title="Investigation" action={button}>
      <InvestigationBody inv={inv} log={log} />
    </Card>
  );
}

function InvestigationBody({ inv, log }: { inv: Investigation; log: ActionDetail }) {
  const { data: vocabulary } = useVocabulary();
  const meta = `${inv.model ?? 'unknown model'} · ${inv.steps.length} lookup${inv.steps.length === 1 ? '' : 's'} · ${formatDuration(inv.durationMs)} · ${formatRelative(inv.startedAt)}`;

  if (inv.status !== 'completed') {
    return (
      <>
        <p className={`text-sm ${inv.status === 'unavailable' ? 'text-amber-700 dark:text-amber-300' : 'text-eye-700 dark:text-eye-300'}`}>
          {inv.error ?? 'The investigation did not finish.'}
        </p>
        {inv.steps.length > 0 && <ToolTimeline steps={inv.steps} />}
        <p className="mt-3 text-xs text-slate-400">{meta}</p>
      </>
    );
  }

  const rec = inv.recommendation;
  const disagrees = rec?.action && log.classification && rec.action !== log.classification;
  return (
    <>
      {inv.steps.filter((s) => s.ok).length === 0 && (
        <p className="mb-2 rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          No lookup succeeded, so this is the model’s opinion rather than anything checked in the tenant.
        </p>
      )}
      {inv.diagnosis && <p className="text-[15px] leading-relaxed text-slate-800 dark:text-slate-200">{inv.diagnosis}</p>}

      {rec && (rec.action || rec.targetUserEmail || rec.groupName || rec.licenceName) && (
        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
          <Fact label="Would do" value={rec.action ? actionLabel(vocabulary, rec.action) : 'Nothing Swoop can run'} tone={disagrees ? 'warning' : undefined} />
          {rec.targetUserEmail && <Fact label="User" value={rec.targetUserEmail} mono />}
          {rec.groupName && <Fact label="Group" value={rec.groupName} />}
          {rec.licenceName && <Fact label="Licence" value={rec.licenceName} />}
          {inv.confidence != null && <Fact label="Confidence" value={`${Math.round(inv.confidence * 100)}%`} />}
        </dl>
      )}
      {disagrees && (
        <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
          This differs from the triage ({actionLabel(vocabulary, log.classification)}). Swoop kept the triage’s proposal — re-run the triage or
          record a correction if the investigation is right.
        </p>
      )}

      {inv.ungrounded.length > 0 && (
        <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
          Dropped because no lookup confirmed it: {inv.ungrounded.join(', ')}.
        </p>
      )}

      {inv.findings.length > 0 && (
        <div className="mt-4">
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">Found</h3>
          <ul className="space-y-1 text-sm text-slate-700 dark:text-slate-300">
            {inv.findings.map((f, i) => (
              <li key={i} className="flex gap-2">
                <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-slate-400" />
                <span>{f}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {inv.technicianSteps.length > 0 && (
        <div className="mt-4">
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">Steps for a technician</h3>
          <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-700 dark:text-slate-300">
            {inv.technicianSteps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        </div>
      )}

      {inv.missingInformation && <Callout title="Still needed">{inv.missingInformation}</Callout>}

      {inv.replyToRequester && (
        <div className="mt-4">
          <div className="mb-1 flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Reply to the requester</h3>
            <CopyButton text={inv.replyToRequester} />
          </div>
          <p className="whitespace-pre-wrap rounded-lg bg-sheen-soft px-3 py-2 text-sm text-slate-800 dark:text-slate-100">{inv.replyToRequester}</p>
        </div>
      )}

      <ToolTimeline steps={inv.steps} />
      <p className="mt-3 text-xs text-slate-400">{meta}. Nothing was changed.</p>
    </>
  );
}

const TOOL_LABELS: Record<string, string> = {
  lookup_user: 'Looked up user',
  user_groups: 'Checked groups',
  mfa_status: 'Checked MFA',
  recent_signins: 'Read sign-ins',
  find_group: 'Found group',
  licence_stock: 'Checked licences',
  search_knowledge: 'Searched runbooks',
  read_runbook: 'Read runbook',
  similar_tickets: 'Checked past tickets',
  client_profile: 'Read client profile',
  requester_profile: 'Read requester history',
};

function ToolTimeline({ steps }: { steps: ToolRun[] }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<number | null>(null);
  if (steps.length === 0) return null;
  return (
    <div className="mt-4">
      <button className="flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-800 dark:hover:text-slate-200" onClick={() => setOpen(!open)}>
        {open ? <ChevronDownIcon /> : <ChevronRightIcon />} What it looked at ({steps.length})
      </button>
      {open && (
        <ol className="mt-2 space-y-1.5 border-l border-slate-200 pl-3 dark:border-slate-800">
          {steps.map((s, i) => (
            <li key={i} className="text-sm">
              <button className="flex w-full items-start gap-2 text-left" onClick={() => setDetail(detail === i ? null : i)}>
                <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${s.ok ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                <span className="min-w-0 flex-1">
                  <span className="font-medium text-slate-800 dark:text-slate-200">{TOOL_LABELS[s.tool] ?? s.tool}</span>
                  {argSummary(s.args) && <span className="text-slate-500"> · {argSummary(s.args)}</span>}
                  <span className="block text-xs text-slate-500">{s.summary}</span>
                </span>
                <span className="tnum shrink-0 text-xs text-slate-400">{formatDuration(s.ms)}</span>
              </button>
              {detail === i && (
                <pre className="mt-1 max-h-60 overflow-auto rounded bg-slate-50 px-2 py-1 text-[11px] text-slate-600 dark:bg-slate-950 dark:text-slate-400">
                  {prettyResult(s.result)}
                </pre>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function argSummary(args: Record<string, unknown>): string {
  return Object.values(args)
    .filter((v) => typeof v === 'string' || typeof v === 'number')
    .map(String)
    .join(', ')
    .slice(0, 80);
}

function prettyResult(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/** Runbooks that match this ticket, found by the triage. */
export function RunbooksCard({ refs }: { refs: KbRef[] | null }) {
  if (!refs || refs.length === 0) return null;
  return (
    <Card title="Relevant runbooks">
      <ul className="space-y-3">
        {refs.map((r) => (
          <li key={r.id} className="text-sm">
            <div className="flex flex-wrap items-center gap-1.5">
              <Link to={`/knowledge?open=${encodeURIComponent(r.id)}`} className="font-medium text-slate-800 hover:underline dark:text-slate-200">
                {r.title}
              </Link>
              {r.clientSpecific && <Badge tone="info">This client</Badge>}
              {r.source === 'superops' && <Badge>SuperOps KB</Badge>}
            </div>
            <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">{r.snippet}</p>
          </li>
        ))}
      </ul>
    </Card>
  );
}
