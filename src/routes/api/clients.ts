import { Router } from 'express';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../../db';
import { clients, tenants, actionLogs } from '../../db/schema';
import { requireAuth } from '../../middleware/auth';

const router = Router();

router.use(requireAuth);

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
      createdAt: clients.createdAt,
      actionCount: sql<number>`(select count(*) from ${actionLogs} where ${actionLogs.clientId} = ${clients.id})`,
      lastActionAt: sql<number | null>`(select max(${actionLogs.createdAt}) from ${actionLogs} where ${actionLogs.clientId} = ${clients.id})`,
    })
    .from(clients)
    .where(tenantId ? eq(clients.tenantId, tenantId) : undefined)
    .orderBy(clients.name);

  res.json(rows.map((row) => ({ ...row, actionCount: Number(row.actionCount) })));
});

router.get('/:id', async (req, res) => {
  const [client] = await db.select().from(clients).where(eq(clients.id, req.params.id)).limit(1);
  if (!client) {
    res.status(404).json({ error: 'Client not found' });
    return;
  }
  res.json(client);
});

const createSchema = z.object({
  tenantId: z.string().uuid(),
  name: z.string().min(1).max(200),
  superopsCompanyId: z.string().max(200).optional(),
  automationEnabled: z.boolean().optional(),
  contextNotes: z.string().max(5000).optional(),
  systemPromptOverride: z.string().max(20_000).optional(),
});

router.post('/', async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
    return;
  }

  const { tenantId, name, superopsCompanyId, automationEnabled, contextNotes, systemPromptOverride } =
    parsed.data;

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

  const id = uuidv4();
  await db.insert(clients).values({
    id,
    tenantId,
    name: trimmedName,
    superopsCompanyId: trimmedCompanyId,
    automationEnabled: automationEnabled ?? false,
    contextNotes: contextNotes?.trim() || null,
    systemPromptOverride: systemPromptOverride?.trim() || null,
  });

  const [created] = await db.select().from(clients).where(eq(clients.id, id)).limit(1);
  res.status(201).json(created);
});

const updateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  superopsCompanyId: z.string().max(200).nullable().optional(),
  automationEnabled: z.boolean().optional(),
  contextNotes: z.string().max(5000).nullable().optional(),
  systemPromptOverride: z.string().max(20_000).nullable().optional(),
});

router.patch('/:id', async (req, res) => {
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

  const updates = { ...parsed.data };
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
  res.json(updated);
});

router.delete('/:id', async (req, res) => {
  const [existing] = await db.select({ id: clients.id }).from(clients).where(eq(clients.id, req.params.id)).limit(1);
  if (!existing) {
    res.status(404).json({ error: 'Client not found' });
    return;
  }

  // action_logs.client_id references clients(id) and foreign keys are enforced,
  // so detach the history rather than deleting an audit trail.
  await db.update(actionLogs).set({ clientId: null }).where(eq(actionLogs.clientId, req.params.id));
  await db.delete(clients).where(eq(clients.id, req.params.id));
  res.json({ ok: true });
});

export default router;
