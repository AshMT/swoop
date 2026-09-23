import { Router } from 'express';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../../db';
import { clients, tenants, actionLogs } from '../../db/schema';
import { requireAuth, requireRoleForWrites, type AuthRequest } from '../../middleware/auth';
import {
  clientDomains,
  domainOf,
  isFreeMailDomain,
  normaliseDomain,
  parseDomainList,
  parseEmailList,
} from '../../services/triage/tenancy';
import { recordAudit } from '../../services/audit';
import type { Client } from '../../types';

const router = Router();

router.use(requireAuth);
router.use(requireRoleForWrites('admin'));

router.get('/', async (req, res) => {
  const tenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined;

  // Join the classification count so the Clients page can show activity
  // without the UI issuing one request per row.
  const rows = await db
    .select({
      id: clients.id,
      tenantId: clients.tenantId,
      name: clients.name,
      superopsCompanyId: clients.superopsCompanyId,
      automationEnabled: clients.automationEnabled,
      contextNotes: clients.contextNotes,
      systemPromptOverride: clients.systemPromptOverride,
      emailDomains: clients.emailDomains,
      m365TenantId: clients.m365TenantId,
      m365DefaultDomain: clients.m365DefaultDomain,
      vipEmails: clients.vipEmails,
      authorisedContacts: clients.authorisedContacts,
      createdAt: clients.createdAt,
      actionCount: sql<number>`(select count(*) from ${actionLogs} where ${actionLogs.clientId} = ${clients.id})`,
      lastActionAt: sql<number | null>`(select max(${actionLogs.createdAt}) from ${actionLogs} where ${actionLogs.clientId} = ${clients.id})`,
    })
    .from(clients)
    .where(tenantId ? eq(clients.tenantId, tenantId) : undefined)
    .orderBy(clients.name);

  res.json(rows.map((row) => toApi({ ...row, actionCount: Number(row.actionCount) })));
});

/** Lists are stored as JSON text; the API speaks arrays. */
function toApi<T extends Pick<Client, 'emailDomains' | 'vipEmails' | 'authorisedContacts'>>(row: T) {
  return {
    ...row,
    emailDomains: parseDomainList(row.emailDomains),
    vipEmails: parseEmailList(row.vipEmails),
    authorisedContacts: parseEmailList(row.authorisedContacts),
  };
}

const domainList = z
  .array(z.string().max(253))
  .max(50)
  .transform((list, ctx) => {
    const out: string[] = [];
    for (const raw of list) {
      if (!raw.trim()) continue;
      const domain = normaliseDomain(raw);
      if (!domain) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `"${raw}" is not a domain` });
        return z.NEVER;
      }
      if (isFreeMailDomain(domain)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${domain} is a public email provider — anyone can register an address there, so it cannot identify a client`,
        });
        return z.NEVER;
      }
      if (!out.includes(domain)) out.push(domain);
    }
    return out;
  });

const emailList = z
  .array(z.string().max(254))
  .max(200)
  .transform((list) => [...new Set(list.map((e) => e.trim().toLowerCase()).filter(Boolean))])
  .refine((list) => list.every((e) => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(e)), 'Every VIP entry must be an email address');

const tenancyFields = {
  emailDomains: domainList.optional(),
  m365TenantId: z
    .string()
    .trim()
    .regex(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/i, 'The Microsoft 365 tenant ID is a GUID')
    .nullable()
    .optional(),
  m365DefaultDomain: z.string().trim().max(253).nullable().optional(),
  vipEmails: emailList.optional(),
  authorisedContacts: emailList.optional(),
};

/**
 * A domain owned by two clients makes tenant recognition ambiguous, and
 * ambiguity is exactly what a cross-client request exploits. Refuse it.
 */
async function findDomainClash(tenantId: string, clientId: string | null, domains: string[]): Promise<string | null> {
  if (domains.length === 0) return null;
  const siblings = await db.select().from(clients).where(eq(clients.tenantId, tenantId));
  for (const sibling of siblings) {
    if (sibling.id === clientId) continue;
    const owned = clientDomains(sibling);
    const clash = domains.find((d) => owned.includes(d));
    if (clash) return `${clash} already belongs to ${sibling.name}.`;
  }
  return null;
}

/**
 * Domains seen on this client's past tickets that are not configured yet —
 * the quickest way to fill in the list without asking the client.
 */
router.get('/:id/suggested-domains', async (req, res) => {
  const [client] = await db.select().from(clients).where(eq(clients.id, req.params.id)).limit(1);
  if (!client) {
    res.status(404).json({ error: 'Client not found' });
    return;
  }
  const rows = await db
    .select({ email: actionLogs.requesterEmail, n: sql<number>`count(*)` })
    .from(actionLogs)
    .where(eq(actionLogs.clientId, client.id))
    .groupBy(actionLogs.requesterEmail);

  const owned = clientDomains(client);
  const counts = new Map<string, number>();
  for (const row of rows) {
    const domain = domainOf(row.email);
    if (!domain || isFreeMailDomain(domain) || owned.includes(domain)) continue;
    counts.set(domain, (counts.get(domain) ?? 0) + Number(row.n));
  }
  res.json({
    suggestions: [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([domain, tickets]) => ({ domain, tickets })),
  });
});

router.get('/:id', async (req, res) => {
  const [client] = await db.select().from(clients).where(eq(clients.id, req.params.id)).limit(1);
  if (!client) {
    res.status(404).json({ error: 'Client not found' });
    return;
  }
  res.json(toApi(client));
});

const createSchema = z.object({
  tenantId: z.string().uuid(),
  name: z.string().min(1).max(200),
  superopsCompanyId: z.string().max(200).optional(),
  automationEnabled: z.boolean().optional(),
  contextNotes: z.string().max(5000).optional(),
  systemPromptOverride: z.string().max(20_000).optional(),
  ...tenancyFields,
});

router.post('/', async (req: AuthRequest, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
    return;
  }

  const {
    tenantId,
    name,
    superopsCompanyId,
    automationEnabled,
    contextNotes,
    systemPromptOverride,
    emailDomains,
    m365TenantId,
    m365DefaultDomain,
    vipEmails,
    authorisedContacts,
  } = parsed.data;

  const [tenant] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!tenant) {
    res.status(400).json({ error: 'Tenant not found' });
    return;
  }

  // Two rows for the same company would both match and race for the same
  // tickets, so reject the duplicate with a message that says which field clashed.
  const trimmedName = name.trim();
  const trimmedCompanyId = superopsCompanyId?.trim() || null;
  const siblings = await db.select().from(clients).where(eq(clients.tenantId, tenantId));

  if (siblings.some((c) => c.name.toLowerCase() === trimmedName.toLowerCase())) {
    res.status(409).json({ error: `A client named "${trimmedName}" already exists.` });
    return;
  }
  if (trimmedCompanyId && siblings.some((c) => c.superopsCompanyId === trimmedCompanyId)) {
    res.status(409).json({ error: `Another client already uses SuperOps company ID "${trimmedCompanyId}".` });
    return;
  }

  const clash = await findDomainClash(tenantId, null, emailDomains ?? []);
  if (clash) {
    res.status(409).json({ error: clash });
    return;
  }

  const id = uuidv4();
  await db.insert(clients).values({
    id,
    tenantId,
    name: trimmedName,
    superopsCompanyId: trimmedCompanyId,
    automationEnabled: automationEnabled ?? false,
    contextNotes: contextNotes?.trim() || null,
    systemPromptOverride: systemPromptOverride?.trim() || null,
    emailDomains: emailDomains?.length ? JSON.stringify(emailDomains) : null,
    m365TenantId: m365TenantId?.trim() || null,
    m365DefaultDomain: m365DefaultDomain ? normaliseDomain(m365DefaultDomain) : null,
    vipEmails: vipEmails?.length ? JSON.stringify(vipEmails) : null,
    authorisedContacts: authorisedContacts?.length ? JSON.stringify(authorisedContacts) : null,
  });

  await recordAudit({ user: req.user, action: 'client.create', targetType: 'client', targetId: id, tenantId, detail: { name: trimmedName }, req });
  const [created] = await db.select().from(clients).where(eq(clients.id, id)).limit(1);
  res.status(201).json(toApi(created!));
});

const updateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  superopsCompanyId: z.string().max(200).nullable().optional(),
  automationEnabled: z.boolean().optional(),
  contextNotes: z.string().max(5000).nullable().optional(),
  systemPromptOverride: z.string().max(20_000).nullable().optional(),
  ...tenancyFields,
});

router.patch('/:id', async (req: AuthRequest, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
    return;
  }

  const [existing] = await db.select().from(clients).where(eq(clients.id, req.params.id)).limit(1);
  if (!existing) {
    res.status(404).json({ error: 'Client not found' });
    return;
  }

  const { emailDomains, vipEmails, authorisedContacts, m365DefaultDomain, m365TenantId, ...fields } = parsed.data;
  const updates: Partial<Client> = { ...fields };
  if (emailDomains !== undefined) {
    const clash = existing.tenantId ? await findDomainClash(existing.tenantId, existing.id, emailDomains) : null;
    if (clash) {
      res.status(409).json({ error: clash });
      return;
    }
    updates.emailDomains = emailDomains.length ? JSON.stringify(emailDomains) : null;
  }
  if (vipEmails !== undefined) updates.vipEmails = vipEmails.length ? JSON.stringify(vipEmails) : null;
  if (authorisedContacts !== undefined) {
    updates.authorisedContacts = authorisedContacts.length ? JSON.stringify(authorisedContacts) : null;
  }
  if (m365TenantId !== undefined) updates.m365TenantId = m365TenantId?.trim() || null;
  if (m365DefaultDomain !== undefined) {
    const domain = m365DefaultDomain?.trim() ? normaliseDomain(m365DefaultDomain) : null;
    if (m365DefaultDomain?.trim() && !domain) {
      res.status(400).json({ error: `"${m365DefaultDomain}" is not a domain` });
      return;
    }
    updates.m365DefaultDomain = domain;
  }
  if (updates.name !== undefined) updates.name = updates.name.trim();
  if (updates.superopsCompanyId !== undefined) {
    updates.superopsCompanyId = updates.superopsCompanyId?.trim() || null;
  }
  if (updates.contextNotes !== undefined) {
    updates.contextNotes = updates.contextNotes?.trim() || null;
  }
  if (updates.systemPromptOverride !== undefined) {
    updates.systemPromptOverride = updates.systemPromptOverride?.trim() || null;
  }

  if (updates.name && existing.tenantId) {
    const [clash] = await db
      .select({ id: clients.id })
      .from(clients)
      .where(and(eq(clients.tenantId, existing.tenantId), eq(clients.name, updates.name)))
      .limit(1);
    if (clash && clash.id !== existing.id) {
      res.status(409).json({ error: `A client named "${updates.name}" already exists.` });
      return;
    }
  }

  await db.update(clients).set(updates).where(eq(clients.id, req.params.id));
  const [updated] = await db.select().from(clients).where(eq(clients.id, req.params.id)).limit(1);
  await recordAudit({
    user: req.user,
    action: 'client.update',
    targetType: 'client',
    targetId: existing.id,
    tenantId: existing.tenantId,
    detail: { fields: Object.keys(parsed.data) },
    req,
  });
  res.json(toApi(updated!));
});

router.delete('/:id', async (req: AuthRequest, res) => {
  const [existing] = await db.select({ id: clients.id }).from(clients).where(eq(clients.id, req.params.id)).limit(1);
  if (!existing) {
    res.status(404).json({ error: 'Client not found' });
    return;
  }

  // action_logs.client_id references clients(id) and foreign keys are enforced,
  // so detach the history rather than deleting an audit trail.
  await db.update(actionLogs).set({ clientId: null }).where(eq(actionLogs.clientId, req.params.id));
  await db.delete(clients).where(eq(clients.id, req.params.id));
  await recordAudit({ user: req.user, action: 'client.delete', targetType: 'client', targetId: req.params.id, req });
  res.json({ ok: true });
});

export default router;
