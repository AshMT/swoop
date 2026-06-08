import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').unique().notNull(),
  passwordHash: text('password_hash').notNull(),
  createdAt: integer('created_at').default(sql`(unixepoch())`),
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
  cippBaseUrl: text('cipp_base_url'),
  cippClientId: text('cipp_client_id'),
  cippClientSecret: text('cipp_client_secret'), // encrypted at rest
  cippOauthTenantId: text('cipp_oauth_tenant_id'), // MSP's Azure AD tenant ID for token requests
  lastPolledAt: integer('last_polled_at'),
  createdAt: integer('created_at').default(sql`(unixepoch())`),
});

export const clients = sqliteTable('clients', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').references(() => tenants.id),
  name: text('name').notNull(),
  superopsCompanyId: text('superops_company_id'),
  cippTenantId: text('cipp_tenant_id'), // e.g. "contoso.onmicrosoft.com"
  automationEnabled: integer('automation_enabled', { mode: 'boolean' }).default(false),
  createdAt: integer('created_at').default(sql`(unixepoch())`),
});

export const actionLogs = sqliteTable('action_logs', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').references(() => tenants.id),
  clientId: text('client_id').references(() => clients.id),
  ticketId: text('ticket_id').notNull(),
  ticketSubject: text('ticket_subject'),
  ticketBody: text('ticket_body'),
  requesterEmail: text('requester_email'),
  classification: text('classification'),
  confidence: real('confidence'),
  sensitivity: text('sensitivity'),
  entities: text('entities'),
  reasoning: text('reasoning'),
  followUpQuestion: text('follow_up_question'),
  proposedPsaNote: text('proposed_psa_note'),
  rawAiResponse: text('raw_ai_response'),
  status: text('status').default('awaiting_approval'),
  approvedBy: text('approved_by'),
  approvedAt: integer('approved_at'),
  rejectionReason: text('rejection_reason'),
  createdAt: integer('created_at').default(sql`(unixepoch())`),
});

export const executionLogs = sqliteTable('execution_logs', {
  id: text('id').primaryKey(),
  actionLogId: text('action_log_id').references(() => actionLogs.id),
  executedAt: integer('executed_at').default(sql`(unixepoch())`),
  result: text('result'), // 'success' | 'failure'
  response: text('response'), // raw JSON from CIPP
  error: text('error'),
});

export const processedTickets = sqliteTable('processed_tickets', {
  ticketId: text('ticket_id').primaryKey(),
  tenantId: text('tenant_id'),
  lastCommentId: text('last_comment_id'),
  processedAt: integer('processed_at').default(sql`(unixepoch())`),
});
