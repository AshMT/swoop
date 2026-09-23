import { and, desc, eq, gte } from 'drizzle-orm';
import { db } from '../../db';
import { actionLogs } from '../../db/schema';
import { describeError } from '../../lib/logger';
import type { Client, Tenant } from '../../types';
import type { CippClient } from '../cipp/client';
import { findGroups, getMfaState, getUser, getUserGroups, listLicences, recentSignIns } from '../cipp/directory';
import { readRunbook, searchKnowledge } from '../knowledge/runbooks';
import type { SimilarTicket } from '../triage/history';
import { clientDomains, domainBelongsTo, domainOf, parseEmailList } from '../triage/tenancy';

/**
 * The agent's tools. Read-only, and scoped to the ticket's own client:
 *
 * - Microsoft 365 lookups always use the client's mapped tenant — the model
 *   cannot name a tenant.
 * - A user can only be looked up on a domain the client owns (or, for a
 *   client with no domains set, an address that appears in the ticket).
 *
 * So a ticket that tries to talk the agent into reading another client's
 * directory gets a refusal, not data.
 */

export interface ToolContext {
  tenant: Tenant;
  client: Client;
  ticketText: string;
  requesterEmail: string | null;
  cipp: CippClient | null;
  m365Tenant: string | null;
  similar: SimilarTicket[];
}

export interface ToolDefinition {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

const emailArg = {
  type: 'object',
  properties: { email: { type: 'string', description: 'The user’s email address / UPN' } },
  required: ['email'],
  additionalProperties: false,
};

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  fn('lookup_user', 'Look up a Microsoft 365 user at this client: name, job, sign-in state, licences, whether synced from AD.', emailArg),
  fn('user_groups', 'List the groups a user at this client is a member of.', emailArg),
  fn('mfa_status', 'Show whether a user has MFA registered, and which methods (from a report that can lag by hours).', emailArg),
  fn('recent_signins', 'Show a user’s last sign-ins: time, app, location, success or the failure reason.', emailArg),
  fn('find_group', 'Find groups at this client by name or email address.', {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
    additionalProperties: false,
  }),
  fn('licence_stock', 'List this client’s Microsoft 365 licences with how many are free.', { type: 'object', properties: {}, additionalProperties: false }),
  fn('search_knowledge', 'Search the MSP’s runbooks and knowledge base for this client.', {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
    additionalProperties: false,
  }),
  fn('read_runbook', 'Read the full text of a runbook found by search_knowledge.', {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  }),
  fn('similar_tickets', 'List similar past tickets from this MSP and how they were triaged.', { type: 'object', properties: {}, additionalProperties: false }),
  fn('client_profile', 'Show what the MSP has recorded about this client: domains, VIPs, authorised contacts, notes.', { type: 'object', properties: {}, additionalProperties: false }),
  fn('requester_profile', 'Show who raised the ticket: whether they are an authorised contact or a VIP, and their recent tickets.', { type: 'object', properties: {}, additionalProperties: false }),
];

function fn(name: string, description: string, parameters: Record<string, unknown>): ToolDefinition {
  return { type: 'function', function: { name, description, parameters } };
}

/** Everything a tool returns is capped, so one big directory cannot flood the context. */
const MAX_RESULT_CHARS = 3_000;

export interface ToolRun {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  /** Short human summary for the ticket page. */
  summary: string;
  /** What the model saw, capped. */
  result: string;
  ms: number;
}

export async function runTool(name: string, rawArgs: string, ctx: ToolContext): Promise<ToolRun> {
  const started = Date.now();
  let args: Record<string, unknown> = {};
  try {
    args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
  } catch {
    return done(name, {}, false, 'Arguments were not valid JSON', { error: 'Arguments were not valid JSON' }, started);
  }
  try {
    const { summary, data } = await dispatch(name, args, ctx);
    return done(name, args, true, summary, data, started);
  } catch (err) {
    const message = describeError(err);
    return done(name, args, false, message, { error: message }, started);
  }
}

function done(tool: string, args: Record<string, unknown>, ok: boolean, summary: string, data: unknown, started: number): ToolRun {
  let result = JSON.stringify(data);
  if (result.length > MAX_RESULT_CHARS) result = `${result.slice(0, MAX_RESULT_CHARS)}… (truncated)`;
  return { tool, args, ok, summary: summary.slice(0, 300), result, ms: Date.now() - started };
}

class ToolRefusal extends Error {}

function scopedEmail(args: Record<string, unknown>, ctx: ToolContext): string {
  const email = String(args.email ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(email)) throw new ToolRefusal('That is not an email address.');
  const owned = clientDomains(ctx.client);
  const domain = domainOf(email);
  if (owned.length > 0) {
    if (!domain || !domainBelongsTo(domain, owned)) {
      throw new ToolRefusal(`${email} is not on a domain ${ctx.client.name} owns (${owned.join(', ')}). Lookups are limited to this client.`);
    }
  } else if (!ctx.ticketText.toLowerCase().includes(email)) {
    throw new ToolRefusal(`${ctx.client.name} has no domains configured, so only addresses in the ticket can be looked up.`);
  }
  return email;
}

function needCipp(ctx: ToolContext): { cipp: CippClient; tenant: string } {
  if (!ctx.cipp) throw new ToolRefusal('CIPP is not connected, so Microsoft 365 cannot be checked.');
  if (!ctx.m365Tenant) throw new ToolRefusal(`No Microsoft 365 tenant is mapped to ${ctx.client.name}.`);
  return { cipp: ctx.cipp, tenant: ctx.m365Tenant };
}

async function dispatch(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<{ summary: string; data: unknown }> {
  switch (name) {
    case 'lookup_user': {
      const email = scopedEmail(args, ctx);
      const { cipp, tenant } = needCipp(ctx);
      const u = await getUser(cipp, tenant, email);
      return {
        summary: `${u.displayName ?? email}: ${u.accountEnabled === false ? 'sign-in blocked' : 'sign-in allowed'}, ${u.licences.length} licence(s)${u.onPremisesSync ? ', synced from AD' : ''}`,
        data: {
          upn: u.upn,
          displayName: u.displayName,
          jobTitle: u.jobTitle,
          department: u.department,
          userType: u.userType,
          signInAllowed: u.accountEnabled,
          syncedFromOnPremAD: u.onPremisesSync,
          licences: u.licences,
          lastPasswordChange: u.lastPasswordChange,
        },
      };
    }
    case 'user_groups': {
      const email = scopedEmail(args, ctx);
      const { cipp, tenant } = needCipp(ctx);
      const groups = await getUserGroups(cipp, tenant, email);
      return {
        summary: `${groups.length} group(s)`,
        data: groups.map((g) => ({ name: g.displayName, type: g.kind, dynamic: g.dynamic, syncedFromAD: g.onPremisesSync })),
      };
    }
    case 'mfa_status': {
      const email = scopedEmail(args, ctx);
      const { cipp, tenant } = needCipp(ctx);
      const mfa = await getMfaState(cipp, tenant, email);
      return {
        summary: mfa ? (mfa.registered ? `Registered: ${mfa.methods.join(', ') || 'methods unknown'}` : 'Not registered') : 'Not in the MFA report',
        data: mfa ?? { note: 'User not found in the MFA report, which can lag behind new accounts.' },
      };
    }
    case 'recent_signins': {
      const email = scopedEmail(args, ctx);
      const { cipp, tenant } = needCipp(ctx);
      const user = await getUser(cipp, tenant, email);
      const signins = await recentSignIns(cipp, tenant, user.id, 10);
      const failures = signins.filter((s) => !s.ok).length;
      return { summary: `${signins.length} recent sign-in(s), ${failures} failed`, data: signins };
    }
    case 'find_group': {
      const query = String(args.name ?? '').trim();
      if (query.length < 2) throw new ToolRefusal('Give at least two characters of the group name.');
      const { cipp, tenant } = needCipp(ctx);
      const groups = (await findGroups(cipp, tenant, query)).slice(0, 10);
      return {
        summary: groups.length ? groups.map((g) => g.displayName).join(', ') : 'No matching groups',
        data: groups.map((g) => ({ name: g.displayName, email: g.mail, type: g.kind, dynamic: g.dynamic, syncedFromAD: g.onPremisesSync, canHoldAdminRoles: g.roleAssignable })),
      };
    }
    case 'licence_stock': {
      const { cipp, tenant } = needCipp(ctx);
      const licences = await listLicences(cipp, tenant);
      return {
        summary: licences.map((l) => `${l.name}: ${l.available} free`).join('; ') || 'No licences',
        data: licences.map((l) => ({ name: l.name, total: l.total, used: l.used, free: l.available })),
      };
    }
    case 'search_knowledge': {
      const query = String(args.query ?? '').trim();
      const hits = await searchKnowledge({ tenantId: ctx.tenant.id, clientId: ctx.client.id, query, limit: 5, minScore: 0.08 });
      return {
        summary: hits.length ? hits.map((h) => h.title).join(', ') : 'Nothing relevant',
        data: hits.map((h) => ({ id: h.id, title: h.title, snippet: h.snippet, clientSpecific: h.clientSpecific })),
      };
    }
    case 'read_runbook': {
      const doc = await readRunbook(ctx.tenant.id, ctx.client.id, String(args.id ?? ''));
      if (!doc) throw new ToolRefusal('No runbook with that id for this client.');
      return { summary: doc.title, data: { title: doc.title, body: doc.body } };
    }
    case 'similar_tickets':
      return {
        summary: `${ctx.similar.length} similar ticket(s)`,
        data: ctx.similar.map((s) => ({ subject: s.subject, category: s.category, action: s.classification, priority: s.priority, similarity: s.similarity, sameRequester: s.sameRequester })),
      };
    case 'client_profile': {
      const c = ctx.client;
      return {
        summary: c.name,
        data: {
          name: c.name,
          domains: clientDomains(c),
          microsoft365Tenant: ctx.m365Tenant,
          vipCount: parseEmailList(c.vipEmails).length,
          authorisedContacts: parseEmailList(c.authorisedContacts),
          notes: c.contextNotes ?? null,
        },
      };
    }
    case 'requester_profile': {
      const email = ctx.requesterEmail?.toLowerCase() ?? null;
      if (!email) return { summary: 'Unknown requester', data: { requester: null } };
      const since = Math.floor(Date.now() / 1000) - 30 * 86400;
      const recent = await db
        .select({ subject: actionLogs.ticketSubject, category: actionLogs.category, createdAt: actionLogs.createdAt })
        .from(actionLogs)
        .where(and(eq(actionLogs.tenantId, ctx.tenant.id), eq(actionLogs.requesterEmail, email), gte(actionLogs.createdAt, since)))
        .orderBy(desc(actionLogs.createdAt))
        .limit(5);
      const authorised = parseEmailList(ctx.client.authorisedContacts).includes(email);
      const vip = parseEmailList(ctx.client.vipEmails).includes(email);
      return {
        summary: `${email}${authorised ? ', authorised contact' : ''}${vip ? ', VIP' : ''}`,
        data: { email, authorisedContact: authorised, vip, recentTickets: recent.map((r) => ({ subject: r.subject, category: r.category })) },
      };
    }
    default:
      throw new ToolRefusal(`Unknown tool ${name}.`);
  }
}
