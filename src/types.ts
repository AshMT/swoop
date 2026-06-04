export interface User {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: number | null;
}

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  superopsSubdomain: string;
  superopsApiKey: string; // encrypted at rest
  superopsRegion: string | null;
  aiBaseUrl: string | null;
  aiApiKey: string | null; // encrypted at rest
  aiModel: string | null;
  lastPolledAt: number | null;
  createdAt: number | null;
}

export interface Client {
  id: string;
  tenantId: string | null;
  name: string;
  superopsCompanyId: string | null;
  automationEnabled: boolean | null;
  createdAt: number | null;
}

export interface ActionLog {
  id: string;
  tenantId: string | null;
  clientId: string | null;
  ticketId: string;
  ticketSubject: string | null;
  ticketBody: string | null;
  requesterEmail: string | null;
  classification: string | null;
  confidence: number | null;
  sensitivity: string | null;
  entities: string | null; // JSON string
  reasoning: string | null;
  followUpQuestion: string | null;
  proposedPsaNote: string | null;
  rawAiResponse: string | null;
  status: string | null;
  createdAt: number | null;
}

export interface ProcessedTicket {
  ticketId: string;
  tenantId: string | null;
  lastCommentId: string | null;
  processedAt: number | null;
}

export interface SuperOpsTicket {
  ticketId: string;
  subject: string;
  description?: string;
  status: string;
  priority?: string;
  createdTime: string; // ISO datetime string from SuperOps
  // client and requester may be plain strings or objects depending on query depth
  client?: string | { id?: string; name?: string; clientId?: string; clientName?: string };
  requester?: string | { email?: string; name?: string; emailId?: string };
}

export interface AiClassification {
  classification: string;
  confidence: number;
  sensitivity: 'normal' | 'high';
  entities: {
    target_user_email: string | null;
    target_user_display_name: string | null;
    group_name: string | null;
    license_sku: string | null;
  };
  reasoning: string;
  follow_up_question: string | null;
  escalation_reason: string | null;
  proposed_psa_note: string;
}

export interface JwtPayload {
  userId: string;
  email: string;
}
