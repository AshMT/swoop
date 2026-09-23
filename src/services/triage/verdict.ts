import {
  atLeast,
  findCategory,
  priorityFor,
  priorityRank,
  raisePriority,
  type Impact,
  type Priority,
} from '../../domain/triage';
import type { AiClassification } from '../../types';
import type { ClusterAssessment } from './clustering';
import type { HistoryContext } from './history';
import type { TriageSettings } from './settings';
import type { SignalAssessment, TriageSignal } from './signals';
import type { TenancyAssessment } from './tenancy';

/**
 * Combines the model's verdict with everything Swoop established itself.
 *
 * The rule throughout: deterministic evidence can raise priority, sensitivity
 * and scrutiny, but never lower them. A keyword match that is wrong costs a
 * technician a second look; a keyword match that talked the model *down*
 * would cost a missed incident.
 */

export interface TriageOutcome {
  classification: AiClassification;
  impact: Impact;
  /** From the matrix before any signal adjusted it. */
  basePriority: Priority;
  priority: Priority;
  queue: string;
  signals: TriageSignal[];
  adjustments: string[];
}

const IMPACT_ORDER: Impact[] = ['individual', 'team', 'organisation'];

export function finaliseTriage(input: {
  classification: AiClassification;
  signals: SignalAssessment;
  tenancy: TenancyAssessment;
  history: HistoryContext;
  cluster: ClusterAssessment | null;
  settings: TriageSettings;
}): TriageOutcome {
  const adjustments: string[] = [];
  const signals: TriageSignal[] = [...input.signals.signals];
  const c: AiClassification = {
    ...input.classification,
    entities: { ...input.classification.entities },
    triage: { ...input.classification.triage, next_steps: [...input.classification.triage.next_steps] },
  };

  // ─── Impact ─────────────────────────────────────────────────────────────────
  let impact = c.triage.impact;
  const floor = input.signals.impactFloor;
  if (floor && IMPACT_ORDER.indexOf(floor) > IMPACT_ORDER.indexOf(impact)) {
    adjustments.push(`Raised impact from ${impact} to ${floor} — the ticket describes more than one person affected`);
    impact = floor;
  }
  if (input.cluster && impact === 'individual') {
    impact = 'team';
    adjustments.push(`Raised impact to team — part of a burst of ${input.cluster.size} similar tickets`);
  }
  c.triage.impact = impact;

  const basePriority = priorityFor(impact, c.triage.urgency);
  let priority = basePriority;
  const bump = (to: Priority, why: string) => {
    if (priorityRank(to) < priorityRank(priority)) {
      adjustments.push(`Raised priority from ${priority} to ${to} — ${why}`);
      priority = to;
    }
  };

  // ─── Security ───────────────────────────────────────────────────────────────
  if (input.signals.security) {
    if (c.triage.category !== 'security') {
      adjustments.push(`Re-categorised from ${c.triage.category} to security — matched a security pattern`);
      c.triage.category = 'security';
    }
    if (c.sensitivity !== 'high') {
      c.sensitivity = 'high';
      adjustments.push('Marked high sensitivity — possible security incident');
    }
    bump(atLeast(priority, 'P2'), 'possible security incident');
  } else if (c.triage.category === 'security') {
    bump(atLeast(priority, 'P2'), 'the model judged this a security issue');
  }

  // ─── Tenancy ────────────────────────────────────────────────────────────────
  const t = input.tenancy;
  if (t.flags.includes('requester_other_client')) {
    signals.push({
      id: 'tenancy_requester_other_client',
      label: 'Requester belongs to another client',
      detail: `${t.requesterDomain} belongs to ${t.requesterClient?.name}, but the ticket is filed under ${t.clientName}`,
      severity: 'critical',
    });
  }
  if (t.flags.includes('target_other_client')) {
    signals.push({
      id: 'tenancy_target_other_client',
      label: 'Targets another client’s user',
      detail: `${t.targetEmail} belongs to ${t.targetClient?.name}, but the request came through ${t.clientName}`,
      severity: 'critical',
    });
  }
  if (t.flags.includes('requester_free_mail')) {
    signals.push({
      id: 'tenancy_free_mail',
      label: 'Personal email address',
      detail: `Raised from ${t.requesterDomain}, which anyone can register — the requester's identity is unverified`,
      severity: 'warn',
    });
  }
  if (t.flags.includes('requester_external')) {
    signals.push({
      id: 'tenancy_external',
      label: 'Requester outside the client',
      detail: `${t.requesterDomain} is not one of ${t.clientName}'s domains`,
      severity: 'warn',
    });
  }
  if (t.flags.includes('target_unrecognised_domain')) {
    signals.push({
      id: 'tenancy_target_unrecognised',
      label: 'Target on an unknown domain',
      detail: `${t.targetEmail} is not on a domain ${t.clientName} owns`,
      severity: 'warn',
    });
  }

  const isAction = c.classification !== 'ESCALATE' && c.classification !== 'FOLLOW_UP';
  if (t.crossTenant) {
    if (isAction) {
      adjustments.push(`Escalated instead of proposing ${c.classification} — the request reaches across clients`);
      c.escalation_reason =
        'The request involves more than one client. Verify it with a known contact before changing anything — this is a common social-engineering pattern.';
      c.classification = 'ESCALATE';
      c.follow_up_question = null;
    }
    c.sensitivity = 'high';
    bump(atLeast(priority, 'P2'), 'cross-client request');
  } else if (isAction && (t.flags.includes('requester_free_mail') || t.flags.includes('target_unrecognised_domain'))) {
    if (c.sensitivity !== 'high') {
      c.sensitivity = 'high';
      adjustments.push('Marked high sensitivity — the requester or target could not be tied to the client');
    }
  }

  // ─── VIP ────────────────────────────────────────────────────────────────────
  if (input.signals.vipRequester) bump(raisePriority(priority), 'VIP requester');

  // ─── History ────────────────────────────────────────────────────────────────
  const dup = input.history.duplicateOf;
  if (dup) {
    signals.push({
      id: 'possible_duplicate',
      label: 'Possible duplicate',
      detail: `Same requester raised ${dup.displayId ? `#${dup.displayId}` : dup.ticketId} ("${dup.subject.slice(0, 60)}"), ${Math.round(dup.similarity * 100)}% similar`,
      severity: 'warn',
    });
  }
  const recurring = input.history.similar.filter((s) => s.clientId === input.tenancy.clientId && s.logId !== dup?.logId);
  if (recurring.length >= 2) {
    signals.push({
      id: 'recurring_issue',
      label: 'Recurring issue',
      detail: `${recurring.length} similar tickets from ${t.clientName} in the last 30 days — may need a root-cause fix`,
      severity: 'info',
    });
  }

  // ─── Cluster ────────────────────────────────────────────────────────────────
  if (input.cluster) {
    signals.push({
      id: 'incident_cluster',
      label: input.cluster.crossClient ? 'Multi-client incident' : 'Possible incident',
      detail: input.cluster.crossClient
        ? `${input.cluster.size} similar tickets from ${input.cluster.clientCount} clients — likely upstream (vendor, ISP or Microsoft)`
        : `${input.cluster.size} similar tickets from ${t.clientName} within ${input.settings.clusterWindowMinutes} minutes`,
      severity: 'critical',
    });
    bump(atLeast(priority, 'P2'), 'part of a possible incident');
  }

  // ─── Queue ──────────────────────────────────────────────────────────────────
  const category = findCategory(c.triage.category);
  let queue = input.settings.queueRouting[c.triage.category] ?? category?.defaultQueue ?? 'Service desk';
  if (input.signals.security || c.triage.category === 'security' || t.crossTenant) {
    queue = input.settings.queueRouting.security ?? 'Security';
  }
  if (input.signals.afterHours && priorityRank(priority) <= 1 && input.settings.afterHoursQueue.trim()) {
    adjustments.push(`Routed to ${input.settings.afterHoursQueue} — ${priority} raised out of hours`);
    queue = input.settings.afterHoursQueue.trim();
  }

  return { classification: c, impact, basePriority, priority, queue, signals, adjustments };
}

/** Facts established before the model runs, phrased for the prompt. */
export function factsForPrompt(input: {
  signals: SignalAssessment;
  tenancy: TenancyAssessment;
  clientName: string;
}): string[] {
  const facts: string[] = [];
  if (input.signals.vipRequester) facts.push(`The requester is on ${input.clientName}'s VIP list.`);
  for (const s of input.signals.signals.filter((x) => x.id.startsWith('security_'))) {
    facts.push(`Keyword check flagged: ${s.label.toLowerCase()} (${s.detail}).`);
  }
  if (input.tenancy.flags.includes('requester_other_client')) {
    facts.push(
      `The requester's email domain belongs to a different client (${input.tenancy.requesterClient?.name}), not ${input.clientName}.`,
    );
  }
  if (input.tenancy.flags.includes('requester_free_mail')) {
    facts.push('The requester wrote from a personal email address, so their identity is not verified.');
  }
  return facts;
}
