import { and, asc, eq, lt } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../../db';
import { actionLogs, approvals, tenants } from '../../db/schema';
import { findActionType } from '../../domain/classifications';
import { createLogger, describeError } from '../../lib/logger';
import type { Approval, SessionUser } from '../../types';
import { recordAudit } from '../audit';
import { createPsaClient } from '../psa/factory';
import { readApprovalPolicy } from './policy';
import type { ExecutionPlan } from './plan';

const log = createLogger('Approvals');

export const REJECTION_REASONS = [
  { id: 'wrong_action', label: 'Wrong action — the triage is incorrect' },
  { id: 'wrong_target', label: 'Wrong user, group or licence' },
  { id: 'not_authorised', label: 'Requester is not authorised to ask for this' },
  { id: 'duplicate', label: 'Duplicate — already handled' },
  { id: 'handled_manually', label: 'Handled another way' },
  { id: 'other', label: 'Other' },
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number]['id'];

export class ApprovalError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'ApprovalError';
    this.status = status;
  }
}

/** Marks pending proposals past their deadline as expired. */
export async function expireStaleApprovals(tenantId?: string): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const where = and(
    eq(actionLogs.approvalState, 'pending'),
    lt(actionLogs.approvalExpiresAt, now),
    tenantId ? eq(actionLogs.tenantId, tenantId) : undefined,
  );
  const expired = await db.update(actionLogs).set({ approvalState: 'expired' }).where(where).returning({ id: actionLogs.id });
  if (expired.length > 0) log.info(`Expired ${expired.length} proposal(s) nobody decided on in time`);
  return expired.length;
}

export async function listDecisions(actionLogId: string): Promise<Approval[]> {
  return db.select().from(approvals).where(eq(approvals.actionLogId, actionLogId)).orderBy(asc(approvals.createdAt));
}

/**
 * Records one person's decision on a proposal.
 *
 * - A rejection from anyone ends it.
 * - Approvals accumulate until the required count; the same person cannot
 *   count twice, which is the whole point of dual approval.
 * - Reaching the count marks it approved, marks the triage correct if nobody
 *   has reviewed it, and posts the decision to the ticket.
 */
export async function decide(input: {
  actionLogId: string;
  user: SessionUser;
  decision: 'approved' | 'rejected';
  reason?: RejectionReason | null;
  comment?: string | null;
}): Promise<{ state: string; approvals: number; required: number }> {
  const [row] = await db.select().from(actionLogs).where(eq(actionLogs.id, input.actionLogId)).limit(1);
  if (!row) throw new ApprovalError('Proposal not found', 404);

  const now = Math.floor(Date.now() / 1000);
  if (row.approvalState === 'pending' && row.approvalExpiresAt && row.approvalExpiresAt < now) {
    await db.update(actionLogs).set({ approvalState: 'expired' }).where(eq(actionLogs.id, row.id));
    throw new ApprovalError('This proposal expired before it was decided. Re-run the ticket to get a fresh one.', 409);
  }
  if (row.approvalState !== 'pending') {
    const state = (row.approvalState ?? 'not_required').replace('_', ' ');
    throw new ApprovalError(`This proposal is ${state}, so it cannot be decided.`, 409);
  }

  const previous = await listDecisions(row.id);
  if (previous.some((p) => p.userId === input.user.userId)) {
    throw new ApprovalError('You have already decided on this proposal. A second approval must come from someone else.', 409);
  }

  const comment = input.comment?.trim().slice(0, 2000) || null;
  if (input.decision === 'rejected' && !input.reason) {
    throw new ApprovalError('Choose a reason for the rejection.');
  }

  await db.insert(approvals).values({
    id: uuidv4(),
    actionLogId: row.id,
    userId: input.user.userId,
    userEmail: input.user.email,
    decision: input.decision,
    reason: input.decision === 'rejected' ? (input.reason ?? 'other') : null,
    comment,
  });

  const required = Math.max(1, row.approvalsRequired ?? 1);
  const approvalsSoFar = previous.filter((p) => p.decision === 'approved').length + (input.decision === 'approved' ? 1 : 0);

  let state = 'pending';
  if (input.decision === 'rejected') state = 'rejected';
  else if (approvalsSoFar >= required) state = 'approved';

  const update: Partial<typeof actionLogs.$inferInsert> = { approvalState: state };
  // Approval is a stronger statement than a review: the approver read the
  // proposal and agreed. A "wrong action" rejection is likewise a verdict on
  // the triage. Neither overwrites a review somebody already recorded.
  if (!row.reviewVerdict && state === 'approved') {
    Object.assign(update, { reviewVerdict: 'correct', reviewedBy: input.user.email, reviewedAt: now });
  }
  if (!row.reviewVerdict && state === 'rejected' && input.reason === 'wrong_action') {
    Object.assign(update, {
      reviewVerdict: 'incorrect',
      reviewNote: comment ?? 'Rejected at approval: wrong action',
      reviewedBy: input.user.email,
      reviewedAt: now,
    });
  }
  await db.update(actionLogs).set(update).where(eq(actionLogs.id, row.id));

  await recordAudit({
    user: input.user,
    action: input.decision === 'approved' ? 'approval.approve' : 'approval.reject',
    targetType: 'action_log',
    targetId: row.id,
    tenantId: row.tenantId,
    detail: {
      ticketId: row.ticketId,
      classification: row.classification,
      state,
      approvals: approvalsSoFar,
      required,
      reason: input.reason ?? null,
    },
  });

  if (state !== 'pending') {
    await postDecisionNote(row.id).catch((err) =>
      log.warn(`Could not post the decision note for ${row.ticketId}: ${describeError(err)}`),
    );
  }

  return { state, approvals: approvalsSoFar, required };
}

/** Posts the final decision to the ticket as a private note. */
async function postDecisionNote(actionLogId: string): Promise<void> {
  const [row] = await db.select().from(actionLogs).where(eq(actionLogs.id, actionLogId)).limit(1);
  if (!row?.tenantId) return;
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, row.tenantId)).limit(1);
  if (!tenant || tenant.dryRun) return;
  if (!readApprovalPolicy(tenant.approvalPolicy).postDecisionNotes) return;

  const decisions = await listDecisions(row.id);
  const action = findActionType(row.classification)?.label ?? row.classification;
  const lines: string[] = [`Swoop — proposal ${row.approvalState}`, ''];

  for (const d of decisions) {
    lines.push(
      `${d.decision === 'approved' ? 'Approved' : 'Rejected'} by ${d.userEmail}` +
        (d.reason ? ` (${REJECTION_REASONS.find((r) => r.id === d.reason)?.label ?? d.reason})` : '') +
        (d.comment ? `: ${d.comment}` : ''),
    );
  }

  if (row.approvalState === 'approved' && row.executionPlan) {
    try {
      const plan = JSON.parse(row.executionPlan) as ExecutionPlan;
      lines.push('', `Plan for ${action}${plan.tenant ? ` in ${plan.tenant}` : ''}:`);
      for (const step of plan.steps) lines.push(`  ${step.order}. ${step.description} (${step.method} ${step.endpoint})`);
      if (plan.blockers.length > 0) {
        lines.push('', 'Resolve first:', ...plan.blockers.map((b) => `  - ${b}`));
      }
      if (plan.rollback) lines.push('', `To undo: ${plan.rollback}`);
    } catch {
      // A malformed stored plan just leaves the steps out of the note.
    }
  }

  lines.push('', '---', 'Swoop does not carry out actions. A technician makes this change.');
  await createPsaClient(tenant).addTicketNote(row.ticketId, lines.join('\n'), true);
}
