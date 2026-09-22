import { sqliteTable, text, integer, real, primaryKey, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').unique().notNull(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').default('admin'),
  createdAt: integer('created_at').default(sql`(unixepoch())`),
  lastLoginAt: integer('last_login_at'),
});

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
  confidenceThreshold: real('confidence_threshold').default(0.75),
  /** Master switch — pauses classification without touching per-client toggles. */
  automationPaused: integer('automation_paused', { mode: 'boolean' }).default(false),
  /** Classify and log, but never write a note back to SuperOps. */
  dryRun: integer('dry_run', { mode: 'boolean' }).default(false),
  /** Operator-tuned replacement for the built-in classifier prompt. */
  systemPromptOverride: text('system_prompt_override'),

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
    aiLatencyMs: integer('ai_latency_ms'),
    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),
    /** Whether the internal note actually landed in SuperOps. */
    notePosted: integer('note_posted', { mode: 'boolean' }).default(false),
    noteError: text('note_error'),

    // ─── Calibration: the technician's verdict on the AI's answer ─────────────
    reviewVerdict: text('review_verdict'),
    reviewCorrectClassification: text('review_correct_classification'),
    reviewNote: text('review_note'),
    reviewedBy: text('reviewed_by'),
    reviewedAt: integer('reviewed_at'),

    createdAt: integer('created_at').default(sql`(unixepoch())`),
  },
  (table) => ({
    tenantCreatedIdx: index('action_logs_tenant_created_idx').on(table.tenantId, table.createdAt),
    ticketIdx: index('action_logs_ticket_idx').on(table.ticketId),
    reviewIdx: index('action_logs_review_idx').on(table.reviewVerdict),
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
