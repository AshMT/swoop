import type { InferSelectModel } from 'drizzle-orm';
import type {
  actionLogs,
  approvals,
  auditLog,
  clients,
  executions,
  incidentClusters,
  invites,
  processedTickets,
  runbooks,
  tenants,
  users,
} from './db/schema';

/**
 * Row types are inferred from the Drizzle schema rather than hand-written, so a
 * column rename cannot leave a stale interface behind.
 */
export type User = InferSelectModel<typeof users>;
export type Tenant = InferSelectModel<typeof tenants>;
export type Client = InferSelectModel<typeof clients>;
export type ActionLog = InferSelectModel<typeof actionLogs>;
export type ProcessedTicket = InferSelectModel<typeof processedTickets>;
export type IncidentCluster = InferSelectModel<typeof incidentClusters>;
export type Approval = InferSelectModel<typeof approvals>;
export type AuditEntry = InferSelectModel<typeof auditLog>;
export type Invite = InferSelectModel<typeof invites>;
export type Runbook = InferSelectModel<typeof runbooks>;
export type Execution = InferSelectModel<typeof executions>;

/**
 * A tenant safe to return over the API: secrets removed, and the large
 * discovered-schema blob left to its own endpoint.
 */
export type PublicTenant = Omit<
  Tenant,
  'superopsApiKey' | 'aiApiKey' | 'psaCapabilities' | 'cippClientSecret'
> & {
  hasSuperopsApiKey: boolean;
  hasAiApiKey: boolean;
  hasCippClientSecret: boolean;
};

export interface ClassificationEntities {
  target_user_email: string | null;
  target_user_display_name: string | null;
  group_name: string | null;
  license_sku: string | null;
}

/** The validated, normalised classifier verdict. */
export interface AiClassification {
  classification: string;
  confidence: number;
  sensitivity: 'normal' | 'high';
  entities: ClassificationEntities;
  reasoning: string;
  follow_up_question: string | null;
  escalation_reason: string | null;
  proposed_psa_note: string;
  /** The triage half of the verdict — what the ticket is and how urgent. */
  triage: AiTriage;
}

export interface AiTriage {
  category: string;
  subcategory: string | null;
  impact: 'organisation' | 'team' | 'individual';
  urgency: 'blocking' | 'degraded' | 'routine';
  summary: string;
  sentiment: 'positive' | 'neutral' | 'frustrated' | 'angry';
  /** A reply a technician could send the requester, unedited. */
  first_response: string | null;
  /** Concrete steps for the technician who picks the ticket up. */
  next_steps: string[];
}

export type ReviewVerdict = 'correct' | 'incorrect';

export interface JwtPayload {
  userId: string;
  email: string;
  /** Matched against users.token_version; absent on tokens from older builds. */
  tv?: number;
}

/** The signed-in user as loaded fresh on each request. */
export interface SessionUser {
  userId: string;
  email: string;
  role: string;
  displayName: string | null;
}
