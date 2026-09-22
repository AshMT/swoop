import type { InferSelectModel } from 'drizzle-orm';
import type { actionLogs, clients, processedTickets, tenants, users } from './db/schema';

/**
 * Row types are inferred from the Drizzle schema rather than hand-written, so a
 * column rename cannot leave a stale interface behind.
 */
export type User = InferSelectModel<typeof users>;
export type Tenant = InferSelectModel<typeof tenants>;
export type Client = InferSelectModel<typeof clients>;
export type ActionLog = InferSelectModel<typeof actionLogs>;
export type ProcessedTicket = InferSelectModel<typeof processedTickets>;

/**
 * A tenant safe to return over the API: secrets removed, and the large
 * discovered-schema blob left to its own endpoint.
 */
export type PublicTenant = Omit<Tenant, 'superopsApiKey' | 'aiApiKey' | 'psaCapabilities'> & {
  hasSuperopsApiKey: boolean;
  hasAiApiKey: boolean;
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
}

export type ReviewVerdict = 'correct' | 'incorrect';

export interface JwtPayload {
  userId: string;
  email: string;
}
