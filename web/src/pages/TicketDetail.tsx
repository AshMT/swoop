import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  approveAction,
  errorMessage,
  getAction,
  getClients,
  reclassifyAction,
  rejectAction,
  reviewAction,
  type ActionDetail,
  type Priority,
  type ReviewVerdict,
} from '../api';
import {
  ApprovalBadge,
  Badge,
  ConfidenceBar,
  EmptyState,
  LoadingState,
  PriorityBadge,
  SignalList,
  Spinner,
  useToast,
} from '../components/ui';
import { ArrowLeftIcon, CheckIcon, ExternalIcon, RefreshIcon, XIcon } from '../components/Icons';
import { Callout, Card, CopyButton, Fact } from '../components/Panel';
import { InvestigationCard, RunbooksCard } from '../components/InvestigationPanel';
import { ExecutionCard } from '../components/ExecutionPanel';
import { formatDateTime, formatRelative, formatUntil, parseEntities } from '../lib/format';
import { actionLabel, categoryLabel, useCan, useMe, useVocabulary } from '../lib/session';

/**
 * One ticket, everything Swoop knows about it: the triage, why, what it
 * checked, what it would do, and who has signed that off.
 */
export default function TicketDetail() {
  const { id = '' } = useParams();
  const { data, isLoading, error } = useQuery({
    queryKey: ['action', id],
    queryFn: () => getAction(id).then((r) => r.data),
    enabled: Boolean(id),
  });
  const { data: clients } = useQuery({ queryKey: ['clients', 'all'], queryFn: () => getClients().then((r) => r.data) });

  if (isLoading) return <LoadingState label="Fetching the ticket" />;
  if (error || !data) {
    return (
      <EmptyState
        title="That ticket flew off"
        description={errorMessage(error, 'It may have been pruned by log retention.')}
        action={
          <Link to="/queue" className="btn-secondary">
            Back to the queue
          </Link>
        }
      />
    );
  }

  const clientName = clients?.find((c) => c.id === data.clientId)?.name;
  return <Detail log={data} clientName={clientName} />;
}

function Detail({ log, clientName }: { log: ActionDetail; clientName?: string }) {
  const { data: vocabulary } = useVocabulary();
  const canReview = useCan('reviewer');
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const entities = parseEntities(log.entities);
  const isAction = log.classification !== 'ESCALATE' && log.classification !== 'FOLLOW_UP';
  const superseded = Boolean(log.supersededBy) || (log.history[0] && log.history[0].id !== log.id);

  const rerun = useMutation({
    mutationFn: () => reclassifyAction(log.id, false),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ['actions'] });
      toast.success('Re-triaged — showing the new result');
      if (res.data.actionLogId) navigate(`/tickets/${res.data.actionLogId}`);
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not re-run the triage')),
  });

  return (
    <div className="animate-fade-in">
      <div className="mb-4 flex items-center gap-2 text-sm">
        <Link to="/queue" className="inline-flex items-center gap-1 text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">
          <ArrowLeftIcon /> Queue
        </Link>
      </div>

      {superseded && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-200">
          This is an older triage of this ticket.{' '}
          {log.history[0] && (
            <Link className="font-medium underline" to={`/tickets/${log.history[0].id}`}>
              See the latest
            </Link>
          )}
        </div>
      )}

      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <PriorityBadge value={log.priority} showLabel />
            <Badge>{categoryLabel(vocabulary, log.category)}</Badge>
            {log.subcategory && <span className="text-sm text-slate-500">{log.subcategory}</span>}
            <ApprovalBadge state={log.approvalState} required={log.approvalsRequired} />
            {log.crossTenant && <Badge tone="danger">Cross-client</Badge>}
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">
            {log.ticketSubject || '(no subject)'}
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            #{log.ticketDisplayId ?? log.ticketId} · {clientName ?? 'Unknown client'} · {log.requesterEmail ?? 'unknown requester'} ·{' '}
            <span title={formatDateTime(log.createdAt)}>{formatRelative(log.createdAt)}</span>
          </p>
        </div>
        <div className="flex gap-2">
          {log.ticketUrl && (
            <a href={log.ticketUrl} target="_blank" rel="noreferrer" className="btn-secondary">
              <ExternalIcon /> Open in SuperOps
            </a>
          )}
          {canReview && (
            <button className="btn-secondary" onClick={() => rerun.mutate()} disabled={rerun.isPending}>
              {rerun.isPending ? <Spinner /> : <RefreshIcon />} Re-run triage
            </button>
          )}
        </div>
      </header>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card title="Swoop's read">
            <p className="text-[15px] leading-relaxed text-slate-800 dark:text-slate-200">{log.summary ?? log.reasoning}</p>
            <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
              <Fact label="Impact" value={log.impact ?? '—'} />
              <Fact label="Urgency" value={log.urgency ?? '—'} />
              <Fact label="Queue" value={log.suggestedQueue ?? '—'} />
              <Fact label="Tone" value={log.sentiment ?? '—'} />
              <Fact label="Proposes" value={actionLabel(vocabulary, log.classification)} />
              <Fact label="Sensitivity" value={log.sensitivity ?? '—'} />
              <div className="col-span-2">
                <dt className="text-xs text-slate-500 dark:text-slate-400">Confidence</dt>
                <dd className="mt-1">
                  <ConfidenceBar value={log.confidence} />
                </dd>
              </div>
            </dl>
            {log.escalationReason && <Callout title="Why a technician">{log.escalationReason}</Callout>}
            {log.followUpQuestion && <Callout title="Question for the requester">{log.followUpQuestion}</Callout>}
          </Card>

          {log.firstResponse && (
            <Card
              title="Suggested reply to the requester"
              action={<CopyButton text={log.firstResponse} />}
            >
              <p className="whitespace-pre-wrap rounded-lg bg-sheen-soft px-4 py-3 text-sm leading-relaxed text-slate-800 dark:text-slate-100">
                {log.firstResponse}
              </p>
            </Card>
          )}

          {log.nextSteps && log.nextSteps.length > 0 && (
            <Card title="Next steps">
              <ol className="space-y-2">
                {log.nextSteps.map((step, i) => (
                  <li key={i} className="flex gap-3 text-sm text-slate-700 dark:text-slate-300">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-900 text-[11px] font-semibold text-white dark:bg-slate-100 dark:text-slate-900">
                      {i + 1}
                    </span>
                    <span>{step}</span>
                  </li>
                ))}
              </ol>
            </Card>
          )}

          <InvestigationCard log={log} />

          {isAction && <PlanCard log={log} />}
          {isAction && log.executionPlan && <ExecutionCard log={log} />}

          <RunbooksCard refs={log.kbRefs} />

          <Card title="Reasoning">
            <p className="text-sm text-slate-700 dark:text-slate-300">{log.reasoning}</p>
            {(entities.target_user_email || entities.group_name || entities.license_sku) && (
              <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
                {entities.target_user_email && <Fact label="User" value={entities.target_user_email} mono />}
                {entities.target_user_display_name && <Fact label="Name" value={entities.target_user_display_name} />}
                {entities.group_name && <Fact label="Group or mailbox" value={entities.group_name} />}
                {entities.license_sku && <Fact label="Licence" value={entities.license_sku} />}
              </dl>
            )}
          </Card>

          <TicketBody body={log.ticketBody} />

          {log.cluster && (
            <Card title={log.cluster.clientCount && log.cluster.clientCount > 1 ? 'Multi-client incident' : 'Possible incident'}>
              <p className="text-sm text-slate-700 dark:text-slate-300">
                {log.cluster.ticketCount} similar tickets
                {log.cluster.clientCount && log.cluster.clientCount > 1 ? ` from ${log.cluster.clientCount} clients` : ''} since{' '}
                {formatDateTime(log.cluster.firstSeenAt)}.
              </p>
              {log.cluster.terms.length > 0 && (
                <p className="mt-1 text-xs text-slate-500">Shared: {log.cluster.terms.join(', ')}</p>
              )}
              <Link to="/incidents" className="mt-3 inline-block text-sm font-medium text-swoop-700 hover:underline dark:text-swoop-300">
                See the incident →
              </Link>
            </Card>
          )}

          {log.similar && log.similar.length > 0 && (
            <Card title="Similar tickets">
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {log.similar.map((s) => (
                  <li key={s.logId} className="flex items-center gap-3 py-2 text-sm">
                    <PriorityBadge value={s.priority} />
                    <Link to={`/tickets/${s.logId}`} className="min-w-0 flex-1 truncate hover:underline">
                      {s.subject}
                    </Link>
                    {s.logId === log.duplicateOfLogId && <Badge tone="warning">Possible duplicate</Badge>}
                    {s.sameRequester && s.logId !== log.duplicateOfLogId && <Badge>Same requester</Badge>}
                    <span className="tnum text-xs text-slate-400">{Math.round(s.similarity * 100)}%</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>

        <div className="space-y-5">
          <ApprovalCard log={log} />
          <Card title="Flags">
            <SignalList signals={log.signals} />
          </Card>
          <TenancyCard log={log} />
          <EnrichmentCard log={log} />
          <ReviewCard log={log} />
          {log.history.length > 1 && (
            <Card title="Triage history">
              <ul className="space-y-1.5 text-sm">
                {log.history.map((h) => (
                  <li key={h.id} className="flex items-center gap-2">
                    <PriorityBadge value={h.priority} />
                    <Link to={`/tickets/${h.id}`} className={`flex-1 truncate hover:underline ${h.id === log.id ? 'font-semibold' : ''}`}>
                      {actionLabel(vocabulary, h.classification)}
                    </Link>
                    <span className="text-xs text-slate-400">{formatRelative(h.createdAt)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <p className="px-1 text-xs text-slate-400">
            {log.aiModel ?? 'unknown model'} · {log.aiLatencyMs ? `${(log.aiLatencyMs / 1000).toFixed(1)}s` : '—'} ·
            note {log.notePosted ? 'posted' : 'not posted'}
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── Panels ────────────────────────────────────────────────────────────────────

function ApprovalCard({ log }: { log: ActionDetail }) {
  const canApprove = useCan('approver');
  const { data: me } = useMe();
  const { data: vocabulary } = useVocabulary();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [comment, setComment] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [method, setMethod] = useState('');
  const [methodNote, setMethodNote] = useState('');
  const attestation = Boolean(log.classification && vocabulary?.attestationActions?.includes(log.classification));
  const attestationReady = !attestation || (Boolean(method) && (method !== 'other' || methodNote.trim().length > 0));

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['action', log.id] });
    void queryClient.invalidateQueries({ queryKey: ['actions'] });
    void queryClient.invalidateQueries({ queryKey: ['queue-summary'] });
  };
  const approve = useMutation({
    mutationFn: () =>
      approveAction(log.id, {
        comment: comment || undefined,
        verificationMethod: attestation ? method : undefined,
        verificationNote: attestation ? methodNote.trim() || null : undefined,
      }),
    onSuccess: (res) => {
      refresh();
      toast.success(res.data.state === 'approved' ? 'Approved' : `Approval recorded — ${res.data.required - res.data.approvals} more needed`);
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not approve')),
  });
  const reject = useMutation({
    mutationFn: () => rejectAction(log.id, reason, comment || undefined),
    onSuccess: () => {
      refresh();
      toast.success('Rejected');
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not reject')),
  });

  if (!log.approvalState || log.approvalState === 'not_required') return null;
  const alreadyDecided = log.decisions.some((d) => d.userId === me?.id);
  const approvals = log.decisions.filter((d) => d.decision === 'approved').length;
  const pending = log.approvalState === 'pending';

  return (
    <div className={`card overflow-hidden ${pending ? 'ring-1 ring-amber-300 dark:ring-amber-800' : ''}`}>
      {pending && <div className="h-1 bg-sheen" />}
      <div className="p-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Approval</h2>
          <ApprovalBadge state={log.approvalState} required={log.approvalsRequired} />
        </div>
        {log.approvalReason && <p className="text-xs text-slate-500 dark:text-slate-400">{log.approvalReason}</p>}
        {pending && (
          <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">
            {approvals} of {log.approvalsRequired ?? 1} approvals · expires{' '}
            <span title={formatDateTime(log.approvalExpiresAt)}>{formatUntil(log.approvalExpiresAt)}</span>
          </p>
        )}

        {log.decisions.length > 0 && (
          <ul className="mt-3 space-y-2">
            {log.decisions.map((d) => (
              <li key={d.id} className="flex gap-2 text-sm">
                {d.decision === 'approved' ? (
                  <CheckIcon className="mt-0.5 h-4 w-4 text-emerald-600" />
                ) : (
                  <XIcon className="mt-0.5 h-4 w-4 text-eye-600" />
                )}
                <div className="min-w-0">
                  <div className="text-slate-800 dark:text-slate-200">
                    {d.userEmail} <span className="text-xs text-slate-400">{formatRelative(d.createdAt)}</span>
                  </div>
                  {d.reason && (
                    <div className="text-xs text-slate-500">
                      {vocabulary?.rejectionReasons.find((r) => r.id === d.reason)?.label ?? d.reason}
                    </div>
                  )}
                  {d.verificationMethod && (
                    <div className="text-xs text-slate-500">
                      Identity: {vocabulary?.verificationMethods.find((m) => m.id === d.verificationMethod)?.label ?? d.verificationMethod}
                      {d.verificationNote ? ` — ${d.verificationNote}` : ''}
                    </div>
                  )}
                  {d.comment && <div className="text-xs text-slate-500">“{d.comment}”</div>}
                </div>
              </li>
            ))}
          </ul>
        )}

        {pending && log.executionPlan?.identity && (
          <p className={`mt-2 text-xs ${log.executionPlan.identity.blocker ? 'text-eye-700 dark:text-eye-300' : 'text-slate-500'}`}>
            {log.executionPlan.identity.blocker ?? log.executionPlan.identity.note}
          </p>
        )}

        {pending && canApprove && !alreadyDecided && (
          <div className="mt-4 space-y-2">
            {attestation && !rejecting && (
              <div className="space-y-2 rounded-lg bg-amber-50 p-2 ring-1 ring-amber-200 dark:bg-amber-950/40 dark:ring-amber-900">
                <label className="block text-xs font-medium text-amber-900 dark:text-amber-200" htmlFor={`verify-${log.id}`}>
                  How did you confirm the requester is who they say?
                </label>
                <select id={`verify-${log.id}`} className="input" value={method} onChange={(e) => setMethod(e.target.value)}>
                  <option value="">Choose how…</option>
                  {vocabulary?.verificationMethods.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
                {method && (
                  <input
                    className="input"
                    placeholder={method === 'other' ? 'Describe how (required)' : 'Detail, e.g. the number you called (optional)'}
                    value={methodNote}
                    onChange={(e) => setMethodNote(e.target.value)}
                  />
                )}
                <p className="text-[11px] text-amber-800 dark:text-amber-300">
                  Password, MFA and sign-in changes are how attackers take over accounts. Replying to the ticket email is not verification.
                </p>
              </div>
            )}
            <textarea
              className="input min-h-[60px]"
              placeholder="Comment (optional)"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
            {rejecting ? (
              <div className="space-y-2">
                <select className="input" value={reason} onChange={(e) => setReason(e.target.value)}>
                  <option value="">Why reject it?</option>
                  {vocabulary?.rejectionReasons.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label}
                    </option>
                  ))}
                </select>
                <div className="flex gap-2">
                  <button className="btn-danger flex-1" disabled={!reason || reject.isPending} onClick={() => reject.mutate()}>
                    {reject.isPending ? <Spinner /> : <XIcon />} Reject
                  </button>
                  <button className="btn-ghost" onClick={() => setRejecting(false)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex gap-2">
                <button className="btn-primary flex-1" disabled={approve.isPending || !attestationReady} onClick={() => approve.mutate()}>
                  {approve.isPending ? <Spinner /> : <CheckIcon />} Approve
                </button>
                <button className="btn-secondary" onClick={() => setRejecting(true)}>
                  Reject
                </button>
              </div>
            )}
            <p className="text-xs text-slate-400">Approving signs off the plan. Whether Swoop then runs it depends on the Execution settings — see “Carry it out”.</p>
          </div>
        )}
        {pending && alreadyDecided && (
          <p className="mt-3 text-xs text-slate-500">You have decided on this one. The next approval must come from someone else.</p>
        )}
        {pending && !canApprove && <p className="mt-3 text-xs text-slate-500">Approvers and admins can decide on this.</p>}
      </div>
    </div>
  );
}

function PlanCard({ log }: { log: ActionDetail }) {
  const plan = log.executionPlan;
  const [open, setOpen] = useState<number | null>(null);
  if (!plan) return null;
  return (
    <Card title={`Plan: ${plan.actionLabel}${plan.tenant ? ` in ${plan.tenant}` : ''}`}>
      {plan.blockers.length > 0 && (
        <div className="mb-3 rounded-lg bg-eye-50 px-3 py-2 text-sm text-eye-900 ring-1 ring-eye-200 dark:bg-eye-900/30 dark:text-eye-100 dark:ring-eye-800">
          <div className="font-medium">Resolve before anyone acts</div>
          <ul className="mt-1 list-disc pl-5">
            {plan.blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </div>
      )}
      <ol className="space-y-2">
        {plan.steps.map((step) => (
          <li key={step.order} className="rounded-lg border border-slate-200 dark:border-slate-800">
            <button
              className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm"
              onClick={() => setOpen(open === step.order ? null : step.order)}
            >
              <span className="text-xs font-semibold text-slate-400">{step.order}</span>
              <span className="flex-1 text-slate-800 dark:text-slate-200">{step.description}</span>
              <code className={`rounded px-1.5 py-0.5 text-[11px] ${step.method === 'POST' ? 'bg-eye-50 text-eye-800 dark:bg-eye-900/40 dark:text-eye-200' : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'}`}>
                {step.method} {step.endpoint}
              </code>
            </button>
            {open === step.order && step.payload != null && (
              <pre className="overflow-x-auto border-t border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-300">
                {JSON.stringify(step.payload, null, 2)}
              </pre>
            )}
          </li>
        ))}
      </ol>
      {plan.prechecks.length > 0 && (
        <div className="mt-4">
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">Checked against CIPP</h3>
          <ul className="space-y-1 text-sm">
            {plan.prechecks.map((c) => (
              <li key={c.description} className="flex items-start gap-2">
                <span
                  className={`mt-1 h-2 w-2 shrink-0 rounded-full ${
                    c.status === 'pass' ? 'bg-emerald-500' : c.status === 'fail' ? 'bg-eye-500' : c.status === 'warn' ? 'bg-amber-500' : 'bg-slate-300 dark:bg-slate-600'
                  }`}
                />
                <span className="text-slate-700 dark:text-slate-300">
                  {c.description}
                  {c.detail && <span className="text-slate-400"> — {c.detail}</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="mt-4 text-xs text-slate-500">
        {plan.reversible ? 'Reversible.' : 'Not reversible.'} {plan.rollback}
      </p>
      <p className="mt-1 text-xs text-slate-400">{plan.note}</p>
    </Card>
  );
}

function TenancyCard({ log }: { log: ActionDetail }) {
  const t = log.tenancy;
  if (!t) return null;
  const method: Record<string, string> = {
    company_id: 'SuperOps company ID',
    company_name: 'SuperOps company name',
    email_domain: 'requester email domain',
  };
  return (
    <Card title="Tenant recognition">
      <dl className="space-y-2 text-sm">
        <Fact label="Matched to" value={`${t.clientName} by ${method[t.matchMethod] ?? t.matchMethod}`} />
        <Fact
          label="Requester domain"
          value={t.requesterDomain ? `${t.requesterDomain}${t.requesterClient ? ` → ${t.requesterClient.name}` : ' → no client'}` : '—'}
          tone={t.flags.includes('requester_other_client') ? 'danger' : t.flags.some((f) => f.startsWith('requester_')) ? 'warning' : undefined}
        />
        {t.targetEmail && (
          <Fact
            label="Target"
            value={`${t.targetEmail}${t.targetClient ? ` → ${t.targetClient.name}` : ''}`}
            tone={t.flags.includes('target_other_client') ? 'danger' : t.flags.includes('target_unrecognised_domain') ? 'warning' : undefined}
          />
        )}
        <Fact label="Microsoft 365" value={t.m365?.defaultDomain ?? t.m365?.tenantId ?? 'Not mapped'} />
      </dl>
      {!t.domainsConfigured && (
        <p className="mt-3 text-xs text-slate-500">
          {t.clientName} has no email domains set, so most recognition checks cannot run.{' '}
          <Link to="/clients" className="font-medium text-swoop-700 hover:underline dark:text-swoop-300">
            Add them
          </Link>
          .
        </p>
      )}
    </Card>
  );
}

function EnrichmentCard({ log }: { log: ActionDetail }) {
  const e = log.enrichment;
  if (!e) return null;
  return (
    <Card title="User in Microsoft 365">
      {!e.found ? (
        <p className="text-sm text-eye-700 dark:text-eye-300">{e.error ?? `${e.upn} was not found in ${e.tenant}.`}</p>
      ) : (
        <dl className="space-y-2 text-sm">
          <Fact label="Name" value={[e.displayName, e.jobTitle].filter(Boolean).join(' · ') || '—'} />
          <Fact
            label="Sign-in"
            value={e.accountEnabled === false ? 'Blocked' : e.accountEnabled ? 'Allowed' : 'Unknown'}
            tone={e.accountEnabled === false ? 'warning' : undefined}
          />
          {e.onPremisesSync && <Fact label="Source" value="Synced from on-premises AD" tone="warning" />}
          <Fact label="Licences" value={e.licences.join(', ') || 'None'} />
          {e.mfa && (
            <Fact
              label="MFA"
              value={e.mfa.registered ? `Registered${e.mfa.methods.length ? ` (${e.mfa.methods.join(', ')})` : ''}` : 'Not registered'}
              tone={e.mfa.registered ? undefined : 'warning'}
            />
          )}
          {e.groups && <Fact label="Groups" value={e.groups.length ? `${e.groups.slice(0, 6).join(', ')}${e.groups.length > 6 ? ` +${e.groups.length - 6}` : ''}` : 'None'} />}
        </dl>
      )}
      {e.error && e.found && <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">Partial lookup: {e.error}</p>}
      <p className="mt-3 text-xs text-slate-400">Read from CIPP {formatRelative(e.fetchedAt)}. Nothing was changed.</p>
    </Card>
  );
}

function ReviewCard({ log }: { log: ActionDetail }) {
  const canReview = useCan('reviewer');
  const { data: vocabulary } = useVocabulary();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [verdict, setVerdict] = useState<ReviewVerdict | null>(log.reviewVerdict);
  const [action, setAction] = useState(log.reviewCorrectClassification ?? '');
  const [category, setCategory] = useState(log.reviewCorrectCategory ?? '');
  const [priority, setPriority] = useState<Priority | ''>((log.reviewCorrectPriority as Priority) ?? '');
  const [note, setNote] = useState(log.reviewNote ?? '');

  useEffect(() => setVerdict(log.reviewVerdict), [log.reviewVerdict]);

  const save = useMutation({
    mutationFn: (next: ReviewVerdict | null) =>
      reviewAction(log.id, {
        verdict: next,
        correctClassification: next === 'incorrect' ? action || null : null,
        correctCategory: next === 'incorrect' ? category || null : null,
        correctPriority: next === 'incorrect' ? priority || null : null,
        note: next ? note || null : null,
      }),
    onSuccess: (_r, next) => {
      void queryClient.invalidateQueries({ queryKey: ['action', log.id] });
      void queryClient.invalidateQueries({ queryKey: ['actions'] });
      void queryClient.invalidateQueries({ queryKey: ['calibration'] });
      toast.success(next ? `Marked ${next}` : 'Review cleared');
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not save the review')),
  });

  if (log.status === 'ai_failed') return null;

  return (
    <Card title="Was this triage right?">
      {log.reviewVerdict && (
        <p className="mb-2 text-xs text-slate-500">
          Marked {log.reviewVerdict} by {log.reviewedBy} {formatRelative(log.reviewedAt)}
        </p>
      )}
      {!canReview ? (
        <p className="text-sm text-slate-500">Reviewers and admins can record a verdict.</p>
      ) : (
        <>
          <div className="flex gap-2">
            <button
              className={`btn flex-1 border ${verdict === 'correct' ? 'border-emerald-500 bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200' : 'border-slate-300 dark:border-slate-700'}`}
              onClick={() => {
                setVerdict('correct');
                save.mutate('correct');
              }}
            >
              <CheckIcon /> Right
            </button>
            <button
              className={`btn flex-1 border ${verdict === 'incorrect' ? 'border-eye-500 bg-eye-50 text-eye-800 dark:bg-eye-900/40 dark:text-eye-200' : 'border-slate-300 dark:border-slate-700'}`}
              onClick={() => setVerdict('incorrect')}
            >
              <XIcon /> Something's off
            </button>
          </div>
          {verdict === 'incorrect' && (
            <div className="mt-3 space-y-2">
              <p className="text-xs text-slate-500">Correct only what was wrong — each part is scored on its own.</p>
              <select className="input" value={priority} onChange={(e) => setPriority(e.target.value as Priority | '')}>
                <option value="">Priority was right ({log.priority ?? '—'})</option>
                {vocabulary?.priorities.map((p) => (
                  <option key={p.id} value={p.id}>
                    Should be {p.id} {p.label}
                  </option>
                ))}
              </select>
              <select className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="">Category was right ({categoryLabel(vocabulary, log.category)})</option>
                {vocabulary?.categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    Should be {c.label}
                  </option>
                ))}
              </select>
              <select className="input" value={action} onChange={(e) => setAction(e.target.value)}>
                <option value="">Action was right ({actionLabel(vocabulary, log.classification)})</option>
                {vocabulary?.actions.map((a) => (
                  <option key={a.id} value={a.id}>
                    Should be {a.id === 'ESCALATE' ? 'For a technician' : a.label}
                  </option>
                ))}
              </select>
              <textarea className="input min-h-[60px]" placeholder="What was off? (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
              <button className="btn-primary w-full" disabled={save.isPending} onClick={() => save.mutate('incorrect')}>
                {save.isPending ? <Spinner /> : null} Save correction
              </button>
            </div>
          )}
          {log.reviewVerdict && (
            <button className="btn-ghost mt-2 w-full text-xs" onClick={() => save.mutate(null)}>
              Clear review
            </button>
          )}
        </>
      )}
    </Card>
  );
}

function TicketBody({ body }: { body: string | null }) {
  const [open, setOpen] = useState(false);
  if (!body) return null;
  const long = body.length > 600;
  return (
    <Card title="The ticket" action={long ? <button className="btn-ghost text-xs" onClick={() => setOpen(!open)}>{open ? 'Show less' : 'Show all'}</button> : undefined}>
      <pre className="whitespace-pre-wrap font-sans text-sm text-slate-700 dark:text-slate-300">
        {long && !open ? `${body.slice(0, 600)}…` : body}
      </pre>
    </Card>
  );
}
