import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  errorMessage,
  executeAction,
  getExecutions,
  resolveExecution,
  revealExecutionSecret,
  type ActionDetail,
  type ExecutionRun,
  type ExecutionStep,
} from '../api';
import { formatDateTime, formatDuration, formatRelative, formatUntil } from '../lib/format';
import { useCan } from '../lib/session';
import { Badge, ConfirmDialog, Spinner, useToast } from './ui';
import { ChevronDownIcon, ChevronRightIcon, PlayIcon } from './Icons';
import { Card, CopyButton } from './Panel';

/** The runs of a proposal and whether another can start, polled while one is running. */
export function useExecutions(logId: string, enabled = true) {
  return useQuery({
    queryKey: ['executions', logId],
    queryFn: () => getExecutions(logId).then((r) => r.data),
    enabled,
    refetchInterval: (query) => (query.state.data?.runs.some((r) => r.status === 'running') ? 2000 : false),
  });
}

const STATUS: Record<ExecutionRun['status'], { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' | 'info' }> = {
  running: { label: 'Running', tone: 'info' },
  dry_run_ok: { label: 'Dry run passed', tone: 'success' },
  succeeded: { label: 'Done', tone: 'success' },
  noop: { label: 'Already done', tone: 'neutral' },
  failed: { label: 'Failed', tone: 'danger' },
  blocked: { label: 'Stopped before sending', tone: 'warning' },
  uncertain: { label: 'Outcome unknown', tone: 'warning' },
};

const VERIFICATION: Record<string, string> = {
  verified: 'Read back from the tenant and confirmed',
  reported: 'CIPP reported success; this cannot be read back',
  pending: 'Sent; not yet visible in the tenant (sync can take a few minutes)',
  failed: 'Read back from the tenant and it did not match',
  skipped: 'Not checked',
};

const MODE_LABEL = { off: 'Off', dry_run: 'Dry runs only', live: 'Live' } as const;

/**
 * Carrying out an approved proposal through CIPP: dry run, live run, the
 * result read back from the tenant, and any one-time secret it produced.
 */
export function ExecutionCard({ log }: { log: ActionDetail }) {
  const canApprove = useCan('approver');
  const isAdmin = useCan('admin');
  const toast = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading } = useExecutions(log.id);
  const [confirmLive, setConfirmLive] = useState(false);

  // When a run finishes, the proposal's own state (and the queue) changes too.
  const running = data?.runs.some((r) => r.status === 'running') ?? false;
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) {
      void queryClient.invalidateQueries({ queryKey: ['action', log.id] });
      void queryClient.invalidateQueries({ queryKey: ['actions'] });
    }
    wasRunning.current = running;
  }, [running, log.id, queryClient]);

  const start = useMutation({
    mutationFn: (mode: 'dry_run' | 'live') => executeAction(log.id, mode),
    onSuccess: (_r, mode) => {
      void queryClient.invalidateQueries({ queryKey: ['executions', log.id] });
      toast.info(mode === 'live' ? 'Running — Swoop will check the tenant afterwards' : 'Dry run started');
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not start the run')),
  });

  if (isLoading || !data) return null;
  const { runs, readiness } = data;
  const plan = log.executionPlan;
  const where = plan?.tenant ? ` in ${plan.tenant}` : '';
  const done = runs.some((r) => r.mode === 'live' && (r.status === 'succeeded' || r.status === 'noop'));
  // Once the change is made there is nothing left to unblock.
  const reasons = done ? [] : readiness.reasons;

  if (readiness.mode === 'off' && runs.length === 0) {
    return (
      <Card title="Carry it out" action={<Badge>Execution off</Badge>}>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          A technician carries out this plan in CIPP.
          {isAdmin && (
            <>
              {' '}
              Swoop can run approved changes itself —{' '}
              <Link to="/settings?tab=execution" className="font-medium text-swoop-700 hover:underline dark:text-swoop-300">
                set that up under Settings → Execution
              </Link>
              .
            </>
          )}
        </p>
      </Card>
    );
  }

  return (
    <Card title="Carry it out" action={<Badge tone={readiness.mode === 'live' ? 'danger' : 'info'}>{MODE_LABEL[readiness.mode]}</Badge>}>
      {reasons.length > 0 && (
        <div className="mb-3 rounded-lg bg-slate-50 px-3 py-2 text-sm dark:bg-slate-800/60">
          <div className="text-xs font-semibold text-slate-500">{readiness.canDryRun ? 'Before it can run live' : 'Why it cannot run'}</div>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-slate-700 dark:text-slate-300">
            {reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      )}

      {canApprove ? (
        <div className="flex flex-wrap gap-2">
          <button className="btn-secondary" disabled={!readiness.canDryRun || start.isPending} onClick={() => start.mutate('dry_run')}>
            {start.isPending && start.variables === 'dry_run' ? <Spinner /> : null} Dry run
          </button>
          {readiness.mode === 'live' && !done && (
            <button className="btn-danger" disabled={!readiness.canRunLive || start.isPending} onClick={() => setConfirmLive(true)}>
              {start.isPending && start.variables === 'live' ? <Spinner /> : <PlayIcon />} Run{where}
            </button>
          )}
        </div>
      ) : (
        <p className="text-xs text-slate-500">Approvers and admins can run changes.</p>
      )}
      <p className="mt-2 text-xs text-slate-400">
        A dry run resolves every value against the live tenant and shows exactly what would be sent, without sending it.
      </p>

      {runs.length > 0 && (
        <ul className="mt-4 space-y-3">
          {runs.map((run) => (
            <RunItem key={run.id} run={run} logId={log.id} />
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={confirmLive}
        destructive
        title={`Make this change${where}?`}
        description={`Swoop will ${plan?.actionLabel.toLowerCase() ?? 'make the change'}${plan?.target ? ` for ${plan.target}` : ''}${where} through CIPP, then read the tenant back to check it took effect. This changes a live Microsoft 365 tenant and can run only once.`}
        confirmLabel="Run it"
        onConfirm={() => {
          setConfirmLive(false);
          start.mutate('live');
        }}
        onCancel={() => setConfirmLive(false)}
      />
    </Card>
  );
}

function RunItem({ run, logId }: { run: ExecutionRun; logId: string }) {
  const [open, setOpen] = useState(run.status !== 'dry_run_ok' && run.status !== 'succeeded' && run.status !== 'noop');
  const status = STATUS[run.status] ?? { label: run.status, tone: 'neutral' as const };
  return (
    <li className="rounded-lg border border-slate-200 dark:border-slate-800">
      <button className="flex w-full items-center gap-2 px-3 py-2 text-left" onClick={() => setOpen(!open)}>
        {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
        <Badge tone={run.mode === 'live' ? 'danger' : 'neutral'}>{run.mode === 'live' ? 'Live' : 'Dry run'}</Badge>
        <Badge tone={status.tone}>
          {run.status === 'running' && <Spinner className="mr-1 h-3 w-3" />}
          {status.label}
        </Badge>
        <span className="min-w-0 flex-1 truncate text-xs text-slate-500">
          {run.startedBy ?? 'Swoop'} · <span title={formatDateTime(run.startedAt)}>{formatRelative(run.startedAt)}</span>
          {run.finishedAt && run.startedAt ? ` · ${formatDuration((run.finishedAt - run.startedAt) * 1000)}` : ''}
        </span>
      </button>
      {run.summary && <p className="px-3 pb-2 text-sm text-slate-800 dark:text-slate-200">{run.summary}</p>}
      {open && (
        <div className="space-y-3 border-t border-slate-200 px-3 py-3 dark:border-slate-800">
          <StepList steps={run.steps} />
          {run.verification && (
            <p className={`text-xs ${run.verification === 'failed' ? 'text-eye-700 dark:text-eye-300' : run.verification === 'verified' ? 'text-emerald-700 dark:text-emerald-300' : 'text-slate-500'}`}>
              {VERIFICATION[run.verification] ?? run.verification}
              {run.verificationDetail ? ` — ${run.verificationDetail}` : ''}
            </p>
          )}
          {run.rollback && run.mode === 'live' && <p className="text-xs text-slate-500">To undo: {run.rollback}</p>}
          {run.mode === 'live' && run.status !== 'running' && (
            <p className="text-xs text-slate-400">
              Result note {run.notePosted ? 'posted to the ticket' : 'not posted'}
              {run.replyPosted ? ' · requester told' : ''}
            </p>
          )}
        </div>
      )}
      <SecretReveal run={run} logId={logId} />
      {run.status === 'uncertain' && <ResolveUncertain run={run} logId={logId} />}
    </li>
  );
}

const STEP_DOT: Record<ExecutionStep['status'], string> = {
  ok: 'bg-emerald-500',
  failed: 'bg-eye-500',
  uncertain: 'bg-amber-500',
  planned: 'bg-sky-400',
  skipped: 'bg-slate-300 dark:bg-slate-600',
};

function StepList({ steps }: { steps: ExecutionStep[] }) {
  const [open, setOpen] = useState<number | null>(null);
  if (steps.length === 0) return null;
  return (
    <ol className="space-y-1.5">
      {steps.map((s) => (
        <li key={s.order} className="text-sm">
          <button className="flex w-full items-start gap-2 text-left" onClick={() => setOpen(open === s.order ? null : s.order)}>
            <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${STEP_DOT[s.status] ?? 'bg-slate-300'}`} title={s.status} />
            <span className="min-w-0 flex-1">
              <span className="text-slate-800 dark:text-slate-200">{s.description}</span>
              {s.result && <span className="block text-xs text-slate-500">{s.result}</span>}
            </span>
            <code className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] ${s.method === 'POST' ? 'bg-eye-50 text-eye-800 dark:bg-eye-900/40 dark:text-eye-200' : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'}`}>
              {s.method} {s.endpoint.replace(/^\/api\//, '')}
            </code>
          </button>
          {open === s.order && s.payload != null && (
            <pre className="mt-1 overflow-x-auto rounded bg-slate-50 px-2 py-1 text-[11px] text-slate-600 dark:bg-slate-950 dark:text-slate-400">
              {JSON.stringify(s.payload, null, 2)}
            </pre>
          )}
        </li>
      ))}
    </ol>
  );
}

/** A temporary password, shown once to an approver and never again. */
function SecretReveal({ run, logId }: { run: ExecutionRun; logId: string }) {
  const canApprove = useCan('approver');
  const toast = useToast();
  const queryClient = useQueryClient();
  const [secret, setSecret] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);

  const reveal = useMutation({
    mutationFn: () => revealExecutionSecret(run.id).then((r) => r.data.secret),
    onSuccess: (value) => {
      setSecret(value);
      void queryClient.invalidateQueries({ queryKey: ['executions', logId] });
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not reveal it')),
  });

  // Never leave a password on screen after navigating away.
  useEffect(() => () => setSecret(null), []);

  if (secret) {
    return (
      <div className="mx-3 mb-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 dark:border-amber-800 dark:bg-amber-950/50">
        <div className="flex items-center justify-between gap-2">
          <code className="select-all break-all font-mono text-sm text-slate-900 dark:text-slate-50">{secret}</code>
          <div className="flex shrink-0 gap-1">
            <CopyButton text={secret} />
            <button className="btn-ghost text-xs" onClick={() => setSecret(null)}>
              Hide
            </button>
          </div>
        </div>
        <p className="mt-1 text-xs text-amber-800 dark:text-amber-200">
          Shown once — Swoop has now deleted its copy. Give it to the user over a channel you have verified, not by replying to the ticket.
        </p>
      </div>
    );
  }

  if (run.secretRevealedAt) {
    return (
      <p className="px-3 pb-2 text-xs text-slate-500">
        Temporary password revealed by {run.secretRevealedBy ?? 'someone'} {formatRelative(run.secretRevealedAt)}.
      </p>
    );
  }
  if (!run.hasSecret) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 px-3 pb-3">
      {canApprove ? (
        <button className="btn-secondary text-xs" onClick={() => setConfirm(true)} disabled={reveal.isPending}>
          {reveal.isPending ? <Spinner /> : null} Reveal temporary password
        </button>
      ) : (
        <span className="text-xs text-slate-500">An approver can reveal the temporary password.</span>
      )}
      {run.secretExpiresAt && <span className="text-xs text-slate-400">deleted {formatUntil(run.secretExpiresAt)} if not revealed</span>}
      <ConfirmDialog
        open={confirm}
        title="Reveal the temporary password?"
        description="It is shown once and then deleted from Swoop. Your name is recorded against the reveal. Have a verified way to give it to the user before you continue."
        confirmLabel="Reveal"
        onConfirm={() => {
          setConfirm(false);
          reveal.mutate();
        }}
        onCancel={() => setConfirm(false)}
      />
    </div>
  );
}

/** For a run whose outcome Swoop could not learn: a person checks and records it. */
function ResolveUncertain({ run, logId }: { run: ExecutionRun; logId: string }) {
  const canApprove = useCan('approver');
  const toast = useToast();
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');
  const resolve = useMutation({
    mutationFn: (outcome: 'succeeded' | 'failed') => resolveExecution(run.id, outcome, note || undefined),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['executions', logId] });
      void queryClient.invalidateQueries({ queryKey: ['action', logId] });
      toast.success('Outcome recorded');
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not record the outcome')),
  });
  if (!canApprove) return null;
  return (
    <div className="space-y-2 border-t border-amber-200 bg-amber-50/60 px-3 py-3 dark:border-amber-900 dark:bg-amber-950/30">
      <p className="text-xs text-amber-900 dark:text-amber-200">
        The request was sent but Swoop could not confirm what happened. Check {run.target ?? 'the user'} in CIPP or the admin centre, then record it.
        Swoop will not run this again until you do.
      </p>
      <input className="input" placeholder="What you found (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="flex gap-2">
        <button className="btn-secondary flex-1" disabled={resolve.isPending} onClick={() => resolve.mutate('succeeded')}>
          It worked
        </button>
        <button className="btn-secondary flex-1" disabled={resolve.isPending} onClick={() => resolve.mutate('failed')}>
          It did not
        </button>
      </div>
    </div>
  );
}
