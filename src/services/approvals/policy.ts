import { z } from 'zod';
import { findActionType } from '../../domain/classifications';
import { createLogger } from '../../lib/logger';

const log = createLogger('Approvals');

/**
 * The approval policy: which proposed actions need a person to sign them off,
 * and how many people.
 *
 * Approving a proposal records a decision and produces an execution plan. It
 * does not change anything in a client's tenant — that stays a technician's
 * job until execution is deliberately switched on in a later release. The
 * policy is built now so the decisions, and the audit trail behind them, are
 * already in place when it is.
 */
export const approvalPolicySchema = z.object({
  /**
   * Auto-approval for low-risk, high-confidence proposals. Off by default:
   * an operator should see the accuracy figures before trusting it.
   */
  autoApprove: z
    .object({
      enabled: z.boolean().default(false),
      minConfidence: z.number().min(0.5).max(1).default(0.95),
      /** Action ids eligible. Inherently sensitive actions are never eligible. */
      actions: z.array(z.string()).default(['password_reset']),
      /** Client ids eligible; empty means every client. */
      clientIds: z.array(z.string()).default([]),
    })
    .default({}),
  /** Two different people for sensitive actions and high-sensitivity tickets. */
  dualApprovalForSensitive: z.boolean().default(true),
  /** A proposal not decided within this many hours expires. */
  expiryHours: z.number().int().min(1).max(24 * 30).default(72),
  /** Post each decision back to the ticket as a private note. */
  postDecisionNotes: z.boolean().default(true),
});

export type ApprovalPolicy = z.infer<typeof approvalPolicySchema>;
export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = approvalPolicySchema.parse({});

export function readApprovalPolicy(raw: string | null | undefined): ApprovalPolicy {
  if (!raw) return DEFAULT_APPROVAL_POLICY;
  try {
    const parsed = approvalPolicySchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
    log.warn(`Stored approval policy is invalid, using defaults: ${parsed.error.issues[0]?.message}`);
  } catch {
    log.warn('Stored approval policy is not valid JSON, using defaults');
  }
  return DEFAULT_APPROVAL_POLICY;
}

export type ApprovalState =
  | 'not_required'
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'auto_approved'
  | 'expired'
  | 'superseded';

export interface ApprovalDecision {
  state: ApprovalState;
  required: number;
  reason: string;
  expiresAt: number | null;
}

export interface ApprovalInput {
  classification: string;
  confidence: number;
  sensitivity: 'normal' | 'high';
  clientId: string;
  /** Any warn/critical signal blocks auto-approval. */
  hasRiskSignals: boolean;
  crossTenant: boolean;
  /** An execution-plan blocker (no tenant mapped, no target) blocks auto-approval. */
  planBlocked: boolean;
  now?: number;
}

export function decideApproval(input: ApprovalInput, policy: ApprovalPolicy): ApprovalDecision {
  const action = findActionType(input.classification);
  if (!action || input.classification === 'ESCALATE' || input.classification === 'FOLLOW_UP') {
    return { state: 'not_required', required: 0, reason: 'No action proposed', expiresAt: null };
  }

  const now = input.now ?? Math.floor(Date.now() / 1000);
  const expiresAt = now + policy.expiryHours * 3600;
  const sensitive = action.inherentlySensitive || input.sensitivity === 'high';

  const auto = policy.autoApprove;
  const autoBlockers: string[] = [];
  if (!auto.enabled) autoBlockers.push('auto-approval is off');
  else {
    if (action.inherentlySensitive) autoBlockers.push(`${action.label} always needs a person`);
    if (input.sensitivity === 'high') autoBlockers.push('the ticket is high sensitivity');
    if (!auto.actions.includes(action.id)) autoBlockers.push(`${action.label} is not on the auto-approve list`);
    if (auto.clientIds.length > 0 && !auto.clientIds.includes(input.clientId)) {
      autoBlockers.push('this client is not on the auto-approve list');
    }
    if (input.confidence < auto.minConfidence) {
      autoBlockers.push(
        `confidence ${Math.round(input.confidence * 100)}% is under ${Math.round(auto.minConfidence * 100)}%`,
      );
    }
    if (input.hasRiskSignals) autoBlockers.push('a risk signal fired');
    if (input.crossTenant) autoBlockers.push('the request crosses tenants');
    if (input.planBlocked) autoBlockers.push('the execution plan has blockers');
  }

  if (auto.enabled && autoBlockers.length === 0) {
    return {
      state: 'auto_approved',
      required: 0,
      reason: `Auto-approved: ${action.label} at ${Math.round(input.confidence * 100)}% confidence with no risk signals`,
      expiresAt: null,
    };
  }

  const required = sensitive && policy.dualApprovalForSensitive ? 2 : 1;
  const why = sensitive
    ? action.inherentlySensitive
      ? `${action.label} is a sensitive action`
      : 'the ticket is high sensitivity'
    : 'every proposed action needs a person';
  return {
    state: 'pending',
    required,
    reason: `${required === 2 ? 'Two approvals' : 'One approval'} needed — ${why}${
      auto.enabled && autoBlockers.length ? `; not auto-approved because ${autoBlockers.join(', ')}` : ''
    }`,
    expiresAt,
  };
}
