import { Router } from 'express';
import { db } from '../../db';
import { clients, tenants } from '../../db/schema';
import { eq, and } from 'drizzle-orm';
import { requireAuth } from '../../middleware/auth';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

router.use(requireAuth);

router.get('/', async (req, res) => {
  const tenantId = req.query.tenantId as string | undefined;
  const rows = tenantId
    ? await db.select().from(clients).where(eq(clients.tenantId, tenantId))
    : await db.select().from(clients);
  res.json(rows);
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
  name: z.string().min(1),
  superopsCompanyId: z.string().optional(),
  cippTenantId: z.string().optional(),
  automationEnabled: z.boolean().optional(),
});

router.post('/', async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.errors[0]?.message || 'Invalid request' });
    return;
  }

  const { tenantId, name, superopsCompanyId, cippTenantId, automationEnabled } = parsed.data;

  // Verify tenant exists
  const [tenant] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!tenant) {
    res.status(400).json({ error: 'Tenant not found' });
    return;
  }

  const id = uuidv4();
  await db.insert(clients).values({
    id,
    tenantId,
    name,
    superopsCompanyId: superopsCompanyId || null,
    cippTenantId: cippTenantId || null,
    automationEnabled: automationEnabled ?? false,
  });

  const [created] = await db.select().from(clients).where(eq(clients.id, id)).limit(1);
  res.status(201).json(created);
});

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  superopsCompanyId: z.string().optional().nullable(),
  cippTenantId: z.string().optional().nullable(),
  automationEnabled: z.boolean().optional(),
});

router.patch('/:id', async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request' });
    return;
  }

  await db.update(clients).set(parsed.data).where(eq(clients.id, req.params.id));
  const [updated] = await db.select().from(clients).where(eq(clients.id, req.params.id)).limit(1);
  res.json(updated);
});

router.delete('/:id', async (req, res) => {
  await db.delete(clients).where(eq(clients.id, req.params.id));
  res.json({ ok: true });
});

export default router;
