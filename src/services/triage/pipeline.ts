import { and, eq, ne } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../../db';
import { actionLogs } from '../../db/schema';
import { TRIAGE_VERSION } from '../../domain/triage';
import { createLogger, describeError } from '../../lib/logger';
import type { Client, Tenant } from '../../types';
import { applyPolicy, classifyTicket, type ClassificationResult } from '../ai';
import { decideApproval, readApprovalPolicy, type ApprovalDecision } from '../approvals/policy';
import { buildExecutionPlan, type ExecutionPlan } from '../approvals/plan';
import { createCippClient } from '../cipp/client';
import { enrichUser, type UserEnrichment } from '../cipp/enrichment';
import { formatProposalNote, isNoteFormat } from '../note-format';
import type { PsaTicket } from '../psa/interface';
import type { SuperOpsClient } from '../psa/superops';
import { clusterTicket, type ClusterAssessment } from './clustering';
import { loadHistoryContext } from './history';
import { isWithinBusinessHours, readTriageSettings } from './settings';
import { detectSignals } from './signals';
import { assessTenancy, parseEmailList, type MatchMethod } from './tenancy';
import { factsForPrompt, finaliseTriage, type TriageOutcome } from './verdict';

const log = createLogger('Triage');

/**
 * One ticket, end to end: history, deterministic signals, the model, tenancy,
 * clustering, enrichment, the execution plan, the approval decision, the note
 * and the stored row.
 *
 * Shared by the poller and by "re-run" in the dashboard, which previously
 * carried two copies of this logic that had already begun to drift.
 *
 * Throws only when the model call fails, so the caller can apply its own
 * retry policy. Everything after the model is best-effort: a failed CIPP
 * lookup or cluster write is logged and recorded, never fatal.
 */
export interface TriageRunInput {
  tenant: Tenant;
  client: Client;
  matchMethod: MatchMethod;
  allClients: readonly Client[];
  ticket: PsaTicket;
  psa: SuperOpsClient;
  /** Post the note to the PSA. False in dry-run and for a preview re-run. */
  postNote: boolean;
  /** Show the preview-mode disclaimer in the note. */
  previewNote: boolean;
  now?: number;
}

export interface TriageRunResult {
  logId: string;
  result: ClassificationResult;
  outcome: TriageOutcome;
  approval: ApprovalDecision;
  plan: ExecutionPlan | null;
  cluster: ClusterAssessment | null;
  notePosted: boolean;
  noteError: string | null;
}

export async function runTriage(input: TriageRunInput): Promise<TriageRunResult> {
  const { tenant, client, ticket } = input;
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const settings = readTriageSettings(tenant.triageSettings);
  const threshold = tenant.confidenceThreshold ?? 0.75;

  // ─── Before the model ─────────────────────────────────────────────────────
  const history = await loadHistoryContext({
    tenantId: tenant.id,
    clientId: client.id,
    ticketId: ticket.ticketId,
    subject: ticket.subject,
    body: ticket.body,
    requesterEmail: ticket.requesterEmail,
    duplicateWindowHours: settings.duplicateWindowHours,
    useReviewedExamples: settings.useReviewedExamples,
    now,
  }).catch((err) => {
    log.warn(`Ticket ${ticket.ticketId}: could not load history — ${describeError(err)}`);
    return { similar: [], duplicateOf: null, references: [], recentFromRequester: 0 };
  });

  const receivedAt = new Date((ticket.createdAt ?? now) * 1000);
  const signals = detectSignals({
    subject: ticket.subject,
    body: ticket.body,
    requesterEmail: ticket.requesterEmail,
    vipEmails: parseEmailList(client.vipEmails),
    withinBusinessHours: isWithinBusinessHours(receivedAt, settings.businessHours),
    recentFromRequester: history.recentFromRequester,
    repeatThreshold: settings.repeatRequesterThreshold,
  });

  const requesterTenancy = assessTenancy({
    client,
    matchMethod: input.matchMethod,
    requesterEmail: ticket.requesterEmail,
    targetEmail: null,
    allClients: input.allClients,
  });

  // ─── The model ────────────────────────────────────────────────────────────
  const result = await classifyTicket(
    {
      subject: ticket.subject,
      body: ticket.body,
      requesterEmail: ticket.requesterEmail,
      requesterName: ticket.requesterName,
      priority: ticket.priority,
      status: ticket.status,
      references: history.references,
      facts: factsForPrompt({ signals, tenancy: requesterTenancy, clientName: client.name }),
    },
    {
      mspName: tenant.name,
      clientName: client.name,
      clientContext: client.contextNotes,
      confidenceThreshold: threshold,
    },
    tenant,
    client.systemPromptOverride,
  );

  // ─── After the model ──────────────────────────────────────────────────────
  const policy = applyPolicy(result.classification, {
    confidenceThreshold: threshold,
    sourceText: `${ticket.subject}\n${ticket.body}\n${ticket.requesterEmail ?? ''}`,
  });

  const tenancy = assessTenancy({
    client,
    matchMethod: input.matchMethod,
    requesterEmail: ticket.requesterEmail,
    targetEmail: policy.classification.entities.target_user_email,
    allClients: input.allClients,
  });

  let cluster: ClusterAssessment | null = null;
  try {
    cluster = await clusterTicket({
      tenantId: tenant.id,
      clientId: client.id,
      ticketId: ticket.ticketId,
      subject: ticket.subject,
      body: ticket.body,
      category: policy.classification.triage.category,
      classification: policy.classification.classification,
      windowMinutes: settings.clusterWindowMinutes,
      threshold: settings.clusterThreshold,
      now,
    });
    if (cluster?.isNew) {
      log.warn(`Possible incident: ${cluster.size} tickets like "${cluster.label}"${cluster.crossClient ? ` across ${cluster.clientCount} clients` : ''}`);
    }
  } catch (err) {
    log.warn(`Ticket ${ticket.ticketId}: clustering failed — ${describeError(err)}`);
  }

  const outcome = finaliseTriage({
    classification: policy.classification,
    signals,
    tenancy,
    history,
    cluster,
    settings,
  });
  const verdict = outcome.classification;

  // CIPP lookup of the target — only for a proposed action in this client's
  // own tenant. Never for a cross-client request: that is exactly the case
  // where looking the user up would be acting on an unverified instruction.
  let enrichment: UserEnrichment | null = null;
  const isAction = verdict.classification !== 'ESCALATE' && verdict.classification !== 'FOLLOW_UP';
  const target = verdict.entities.target_user_email;
  const tenantFilter = tenancy.m365?.defaultDomain || tenancy.m365?.tenantId;
  if (isAction && target && tenantFilter && !tenancy.crossTenant) {
    try {
      const cipp = createCippClient(tenant);
      if (cipp) enrichment = await enrichUser(cipp, tenantFilter, target);
    } catch (err) {
      log.warn(`Ticket ${ticket.ticketId}: CIPP lookup failed — ${describeError(err)}`);
      enrichment = null;
    }
  }
  if (enrichment && !enrichment.found && !enrichment.error?.startsWith('user lookup')) {
    outcome.signals.push({
      id: 'target_not_found',
      label: 'Target user not found',
      detail: `${target} does not exist in ${tenantFilter}`,
      severity: 'warn',
    });
  }

  const plan = isAction
    ? buildExecutionPlan({ classification: verdict.classification, entities: verdict.entities, tenancy, enrichment })
    : null;

  const approval = decideApproval(
    {
      classification: verdict.classification,
      confidence: verdict.confidence,
      sensitivity: verdict.sensitivity,
      clientId: client.id,
      hasRiskSignals: outcome.signals.some((s) => s.severity !== 'info'),
      crossTenant: tenancy.crossTenant,
      planBlocked: Boolean(plan && (plan.blockers.length > 0 || plan.prechecks.some((c) => c.status === 'fail'))),
      now,
    },
    readApprovalPolicy(tenant.approvalPolicy),
  );

  const adjustments = [...result.adjustments, ...policy.adjustments, ...outcome.adjustments];

  const note = formatProposalNote(verdict, {
    mspName: tenant.name,
    dryRun: input.previewNote,
    adjustments,
    format: isNoteFormat(tenant.noteFormat) ? tenant.noteFormat : 'plain',
    triage: {
      priority: outcome.priority,
      queue: outcome.queue,
      signals: outcome.signals.filter((s) => s.severity !== 'info' || s.id === 'repeat_requester' || s.id === 'recurring_issue'),
      related: history.similar.slice(0, 3).map((s) => ({
        label: `${s.displayId ? `#${s.displayId}` : s.ticketId} ${s.subject.slice(0, 60)}`,
        similarity: s.similarity,
      })),
      duplicateOf: history.duplicateOf
        ? history.duplicateOf.displayId
          ? `#${history.duplicateOf.displayId}`
          : history.duplicateOf.ticketId
        : null,
      approval: { state: approval.state, required: approval.required },
      planBlockers: plan?.blockers ?? [],
    },
  });

  let notePosted = false;
  let noteError: string | null = null;
  if (input.postNote) {
    try {
      await input.psa.addTicketNote(ticket.ticketId, note, true);
      notePosted = true;
    } catch (err) {
      noteError = describeError(err);
      log.error(`Ticket ${ticket.ticketId}: could not post the note — ${noteError}`);
    }
  }

  const logId = uuidv4();
  await db.insert(actionLogs).values({
    id: logId,
    tenantId: tenant.id,
    clientId: client.id,
    ticketId: ticket.ticketId,
    ticketDisplayId: ticket.displayId,
    ticketSubject: ticket.subject,
    ticketBody: ticket.body || null,
    requesterEmail: ticket.requesterEmail,
    classification: verdict.classification,
    confidence: verdict.confidence,
    sensitivity: verdict.sensitivity,
    entities: JSON.stringify(verdict.entities),
    reasoning: verdict.reasoning,
    followUpQuestion: verdict.follow_up_question,
    escalationReason: verdict.escalation_reason,
    proposedPsaNote: note,
    rawAiResponse: result.rawResponse,
    status: noteError ? 'note_failed' : 'classified',
    errorMessage: noteError,
    aiModel: result.model,
    promptFingerprint: result.promptFingerprint,
    aiLatencyMs: result.latencyMs,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    notePosted,
    noteError,
    noteAttempts: input.postNote ? 1 : 0,

    category: verdict.triage.category,
    subcategory: verdict.triage.subcategory,
    impact: outcome.impact,
    urgency: verdict.triage.urgency,
    priority: outcome.priority,
    summary: verdict.triage.summary,
    sentiment: verdict.triage.sentiment,
    suggestedQueue: outcome.queue,
    firstResponse: verdict.triage.first_response,
    nextSteps: JSON.stringify(verdict.triage.next_steps),
    signals: JSON.stringify(outcome.signals),
    triageVersion: TRIAGE_VERSION,

    matchMethod: input.matchMethod,
    requesterDomain: tenancy.requesterDomain,
    crossTenant: tenancy.crossTenant,
    tenancy: JSON.stringify(tenancy),

    duplicateOfLogId: history.duplicateOf?.logId ?? null,
    similar: JSON.stringify(history.similar),
    clusterId: cluster?.clusterId ?? null,

    approvalState: approval.state,
    approvalsRequired: approval.required,
    approvalReason: approval.reason,
    approvalExpiresAt: approval.expiresAt,
    executionPlan: plan ? JSON.stringify(plan) : null,
    enrichment: enrichment ? JSON.stringify(enrichment) : null,
  });

  // A newer triage of the same ticket replaces any proposal still waiting on
  // the old one — approving a stale proposal would sign off the wrong thing.
  await db
    .update(actionLogs)
    .set({ approvalState: 'superseded', supersededBy: logId })
    .where(
      and(
        eq(actionLogs.tenantId, tenant.id),
        eq(actionLogs.ticketId, ticket.ticketId),
        eq(actionLogs.approvalState, 'pending'),
        ne(actionLogs.id, logId),
      ),
    );

  return { logId, result, outcome, approval, plan, cluster, notePosted, noteError };
}
