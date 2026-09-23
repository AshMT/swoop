import { sqliteTable, text, integer, real, primaryKey, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').unique().notNull(),
  passwordHash: text('password_hash').notNull(),
  /** 'admin' | 'approver' | 'reviewer' | 'viewer' — see domain/roles.ts. */
  role: text('role').default('admin'),
  displayName: text('display_name'),
  disabled: integer('disabled', { mode: 'boolean' }).default(false),
  /** Bumped to revoke every token issued before the bump. */
  tokenVersion: integer('token_version').default(0),
  invitedBy: text('invited_by'),
  createdAt: integer('created_at').default(sql`(unixepoch())`),
  lastLoginAt: integer('last_login_at'),
});

export const invites = sqliteTable('invites', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  role: text('role').notNull(),
  /** SHA-256 of the one-time token; the token itself is never stored. */
  tokenHash: text('token_hash').notNull().unique(),
  createdBy: text('created_by'),
  expiresAt: integer('expires_at').notNull(),
  acceptedAt: integer('accepted_at'),
  revokedAt: integer('revoked_at'),
  createdAt: integer('created_at').default(sql`(unixepoch())`),
});

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    userId: text('user_id'),
    userEmail: text('user_email'),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    tenantId: text('tenant_id'),
    /** JSON detail — never secrets. */
    detail: text('detail'),
    ip: text('ip'),
    createdAt: integer('created_at').default(sql`(unixepoch())`),
  },
  (table) => ({
    createdIdx: index('audit_log_created_idx').on(table.createdAt),
    targetIdx: index('audit_log_target_idx').on(table.targetType, table.targetId),
  }),
);

export const tenants = sqliteTable('tenants', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').unique().notNull(),
  superopsSubdomain: text('superops_subdomain').notNull(),
  superopsApiKey: text('superops_api_key').notNull(),
  superopsRegion: text('superops_region').default('us'),
  aiBaseUrl: text('ai_base_url'),
  aiApiKey: text('ai_api_key'),
  aiModel: text('ai_model'),
  lastPolledAt: integer('last_polled_at'),

  // ─── Operator controls ──────────────────────────────────────────────────────
  pollIntervalSeconds: integer('poll_interval_seconds').default(60),
  /** Tickets classified in parallel. 1 keeps the old sequential behaviour. */
  classifyConcurrency: integer('classify_concurrency').default(1),
  confidenceThreshold: real('confidence_threshold').default(0.75),
  /** Master switch — pauses classification without touching per-client toggles. */
  automationPaused: integer('automation_paused', { mode: 'boolean' }).default(false),
  /** Classify and log, but never write a note back to SuperOps. */
  dryRun: integer('dry_run', { mode: 'boolean' }).default(false),
  /** How the internal note is rendered: 'plain' | 'markdown' | 'html'. */
  noteFormat: text('note_format').default('plain'),
  /** Operator-tuned replacement for the built-in classifier prompt. */
  systemPromptOverride: text('system_prompt_override'),
  /**
   * Days to keep action log rows. 0 means keep forever. Ticket bodies and raw
   * model responses are pruned first, at a third of this age, because they are
   * the bulk of the storage and the least useful to keep.
   */
  logRetentionDays: integer('log_retention_days').default(0),
  /** JSON, see services/triage/settings.ts. */
  triageSettings: text('triage_settings'),
  /** JSON, see services/approvals/policy.ts. */
  approvalPolicy: text('approval_policy'),

  // ─── CIPP, for read-only lookups of the user a ticket is about ─────────────
  cippEnabled: integer('cipp_enabled', { mode: 'boolean' }).default(false),
  cippApiUrl: text('cipp_api_url'),
  /** The MSP's own Entra tenant, where the CIPP-API app registration lives. */
  cippTenantId: text('cipp_tenant_id'),
  cippClientId: text('cipp_client_id'),
  /** Encrypted at rest like the other credentials. */
  cippClientSecret: text('cipp_client_secret'),

  // ─── Discovered SuperOps schema (see services/psa/schema-probe.ts) ──────────
  psaCapabilities: text('psa_capabilities'),
  psaCapabilitiesProbedAt: integer('psa_capabilities_probed_at'),

  // ─── Poll health, surfaced in the dashboard ─────────────────────────────────
  lastPollStatus: text('last_poll_status'),
  lastPollError: text('last_poll_error'),
  lastPollFinishedAt: integer('last_poll_finished_at'),
  lastPollDurationMs: integer('last_poll_duration_ms'),
  lastPollTicketCount: integer('last_poll_ticket_count'),

  createdAt: integer('created_at').default(sql`(unixepoch())`),
});

export const clients = sqliteTable('clients', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').references(() => tenants.id),
  name: text('name').notNull(),
  superopsCompanyId: text('superops_company_id'),
  automationEnabled: integer('automation_enabled', { mode: 'boolean' }).default(false),
  /** Free-text context injected into the prompt, e.g. naming conventions. */
  contextNotes: text('context_notes'),
  /**
   * Replaces the tenant prompt entirely for this client's tickets. For a client
   * whose ticket mix differs enough that shared wording cannot serve both.
   */
  systemPromptOverride: text('system_prompt_override'),
  /** JSON array of email domains that belong to this client. */
  emailDomains: text('email_domains'),
  /** The client's Microsoft 365 tenant, as a GUID. */
  m365TenantId: text('m365_tenant_id'),
  /** e.g. contoso.onmicrosoft.com — what CIPP calls the tenantFilter. */
  m365DefaultDomain: text('m365_default_domain'),
  /** JSON array of addresses whose tickets get a priority bump. */
  vipEmails: text('vip_emails'),
  createdAt: integer('created_at').default(sql`(unixepoch())`),
});

export const actionLogs = sqliteTable(
  'action_logs',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').references(() => tenants.id),
    clientId: text('client_id').references(() => clients.id),
    ticketId: text('ticket_id').notNull(),
    /** Human-facing ticket number, used to build a deep link into SuperOps. */
    ticketDisplayId: text('ticket_display_id'),
    ticketSubject: text('ticket_subject'),
    ticketBody: text('ticket_body'),
    requesterEmail: text('requester_email'),

    classification: text('classification'),
    confidence: real('confidence'),
    sensitivity: text('sensitivity'),
    entities: text('entities'),
    reasoning: text('reasoning'),
    followUpQuestion: text('follow_up_question'),
    escalationReason: text('escalation_reason'),
    proposedPsaNote: text('proposed_psa_note'),
    rawAiResponse: text('raw_ai_response'),

    /** 'classified' | 'ai_failed' | 'note_failed' — distinguishes a real
     * ESCALATE verdict from the fallback written when the model errored. */
    status: text('status').default('classified'),
    /** Populated only when the AI call or its JSON parse failed. */
    errorMessage: text('error_message'),

    aiModel: text('ai_model'),
    /**
     * Identifies the prompt-and-model combination that produced this row, so
     * accuracy figures from different prompts are not silently averaged.
     */
    promptFingerprint: text('prompt_fingerprint'),
    aiLatencyMs: integer('ai_latency_ms'),
    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),
    /** Whether the internal note actually landed in SuperOps. */
    notePosted: integer('note_posted', { mode: 'boolean' }).default(false),
    noteError: text('note_error'),
    /** Write-back attempts, so a failed note is retried without re-classifying. */
    noteAttempts: integer('note_attempts').default(0),

    // ─── Calibration: the technician's verdict on the AI's answer ─────────────
    reviewVerdict: text('review_verdict'),
    reviewCorrectClassification: text('review_correct_classification'),
    reviewNote: text('review_note'),
    reviewedBy: text('reviewed_by'),
    reviewedAt: integer('reviewed_at'),
    reviewCorrectCategory: text('review_correct_category'),
    reviewCorrectPriority: text('review_correct_priority'),

    // ─── Triage verdict ───────────────────────────────────────────────────────
    category: text('category'),
    subcategory: text('subcategory'),
    impact: text('impact'),
    urgency: text('urgency'),
    /** P1–P4, computed from impact × urgency then adjusted by signals. */
    priority: text('priority'),
    summary: text('summary'),
    sentiment: text('sentiment'),
    suggestedQueue: text('suggested_queue'),
    firstResponse: text('first_response'),
    /** JSON string[] of suggested technician steps. */
    nextSteps: text('next_steps'),
    /** JSON TriageSignal[] — the deterministic checks that fired. */
    signals: text('signals'),
    triageVersion: integer('triage_version'),

    // ─── Tenant recognition ───────────────────────────────────────────────────
    /** 'company_id' | 'company_name' | 'email_domain' */
    matchMethod: text('match_method'),
    requesterDomain: text('requester_domain'),
    crossTenant: integer('cross_tenant', { mode: 'boolean' }).default(false),
    /** JSON TenancyAssessment. */
    tenancy: text('tenancy'),

    // ─── Similarity ───────────────────────────────────────────────────────────
    duplicateOfLogId: text('duplicate_of_log_id'),
    /** JSON SimilarTicket[]. */
    similar: text('similar'),
    clusterId: text('cluster_id'),

    // ─── Approval ─────────────────────────────────────────────────────────────
    /** 'not_required' | 'pending' | 'approved' | 'rejected' | 'auto_approved' | 'expired' | 'superseded' */
    approvalState: text('approval_state'),
    approvalsRequired: integer('approvals_required').default(0),
    /** Why the policy asked for this many approvals. */
    approvalReason: text('approval_reason'),
    approvalExpiresAt: integer('approval_expires_at'),
    /** JSON ExecutionPlan — what would run, never run by Swoop today. */
    executionPlan: text('execution_plan'),
    /** Set when a reclassification replaces this row. */
    supersededBy: text('superseded_by'),

    /** JSON UserEnrichment from CIPP, when configured. */
    enrichment: text('enrichment'),

    createdAt: integer('created_at').default(sql`(unixepoch())`),
  },
  (table) => ({
    tenantCreatedIdx: index('action_logs_tenant_created_idx').on(table.tenantId, table.createdAt),
    ticketIdx: index('action_logs_ticket_idx').on(table.ticketId),
    reviewIdx: index('action_logs_review_idx').on(table.reviewVerdict),
    noteRetryIdx: index('action_logs_note_retry_idx').on(table.status, table.noteAttempts),
    promptIdx: index('action_logs_prompt_idx').on(table.promptFingerprint),
    priorityIdx: index('action_logs_priority_idx').on(table.tenantId, table.priority),
    categoryIdx: index('action_logs_category_idx').on(table.tenantId, table.category),
    clusterIdx: index('action_logs_cluster_idx').on(table.clusterId),
    approvalIdx: index('action_logs_approval_idx').on(table.tenantId, table.approvalState),
  }),
);

export const incidentClusters = sqliteTable(
  'incident_clusters',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').references(() => tenants.id),
    /** Null for a cluster spanning several clients — a vendor or upstream outage. */
    clientId: text('client_id'),
    label: text('label').notNull(),
    category: text('category'),
    /** JSON string[] of the terms the tickets share. */
    terms: text('terms'),
    ticketCount: integer('ticket_count').default(0),
    clientCount: integer('client_count').default(0),
    /** 'open' | 'acknowledged' | 'resolved' */
    status: text('status').default('open'),
    firstSeenAt: integer('first_seen_at'),
    lastSeenAt: integer('last_seen_at'),
    acknowledgedBy: text('acknowledged_by'),
    acknowledgedAt: integer('acknowledged_at'),
    createdAt: integer('created_at').default(sql`(unixepoch())`),
  },
  (table) => ({
    tenantIdx: index('incident_clusters_tenant_idx').on(table.tenantId, table.status, table.lastSeenAt),
  }),
);

export const approvals = sqliteTable(
  'approvals',
  {
    id: text('id').primaryKey(),
    actionLogId: text('action_log_id')
      .notNull()
      .references(() => actionLogs.id, { onDelete: 'cascade' }),
    userId: text('user_id'),
    userEmail: text('user_email'),
    /** 'approved' | 'rejected' */
    decision: text('decision').notNull(),
    /** For a rejection: 'wrong_action' | 'wrong_target' | 'not_authorised' | 'duplicate' | 'other'. */
    reason: text('reason'),
    comment: text('comment'),
    createdAt: integer('created_at').default(sql`(unixepoch())`),
  },
  (table) => ({
    logIdx: index('approvals_log_idx').on(table.actionLogId),
  }),
);

/**
 * The deduplication ledger. Composite key because a ticket id is only unique
 * within one SuperOps instance — with a bare `ticket_id` primary key, a second
 * tenant whose numbering overlapped would have its tickets silently swallowed.
 */
export const processedTickets = sqliteTable(
  'processed_tickets',
  {
    tenantId: text('tenant_id').notNull(),
    ticketId: text('ticket_id').notNull(),
    /** 'done' | 'failed' — 'failed' rows are retried until maxAttempts. */
    status: text('status').default('done'),
    attempts: integer('attempts').default(1),
    lastError: text('last_error'),
    /** Earliest unix time at which a failed ticket may be retried. */
    nextAttemptAt: integer('next_attempt_at'),
    lastCommentId: text('last_comment_id'),
    processedAt: integer('processed_at').default(sql`(unixepoch())`),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.tenantId, table.ticketId] }),
    retryIdx: index('processed_tickets_retry_idx').on(table.status, table.nextAttemptAt),
  }),
);

/** Applied-migration ledger, managed by db/migrations.ts. */
export const schemaMigrations = sqliteTable('schema_migrations', {
  id: text('id').primaryKey(),
  appliedAt: integer('applied_at').default(sql`(unixepoch())`),
});
