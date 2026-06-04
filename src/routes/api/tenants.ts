import { Router } from 'express';
import { db } from '../../db';
import { tenants } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { requireAuth } from '../../middleware/auth';
import { encrypt, decrypt } from '../../services/crypto';
import { SuperOpsClient } from '../../services/psa/superops';
import { z } from 'zod';

const router = Router();
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '';

router.use(requireAuth);

router.get('/', async (_req, res) => {
  const rows = await db.select({
    id: tenants.id,
    name: tenants.name,
    slug: tenants.slug,
    superopsSubdomain: tenants.superopsSubdomain,
    superopsRegion: tenants.superopsRegion,
    aiBaseUrl: tenants.aiBaseUrl,
    aiModel: tenants.aiModel,
    lastPolledAt: tenants.lastPolledAt,
    createdAt: tenants.createdAt,
  }).from(tenants);
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const [tenant] = await db.select({
    id: tenants.id,
    name: tenants.name,
    slug: tenants.slug,
    superopsSubdomain: tenants.superopsSubdomain,
    superopsRegion: tenants.superopsRegion,
    aiBaseUrl: tenants.aiBaseUrl,
    aiModel: tenants.aiModel,
    lastPolledAt: tenants.lastPolledAt,
    createdAt: tenants.createdAt,
  }).from(tenants).where(eq(tenants.id, req.params.id)).limit(1);

  if (!tenant) {
    res.status(404).json({ error: 'Tenant not found' });
    return;
  }
  res.json(tenant);
});

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  superopsSubdomain: z.string().min(1).optional(),
  superopsApiKey: z.string().min(1).optional(),
  superopsRegion: z.enum(['us', 'eu']).optional(),
  aiBaseUrl: z.string().url().optional().nullable(),
  aiApiKey: z.string().optional().nullable(),
  aiModel: z.string().optional().nullable(),
});

router.patch('/:id', async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request' });
    return;
  }

  const updates: Record<string, unknown> = {};
  const { superopsApiKey, aiApiKey, ...rest } = parsed.data;

  Object.assign(updates, rest);

  if (superopsApiKey) {
    updates.superopsApiKey = ENCRYPTION_KEY ? encrypt(superopsApiKey, ENCRYPTION_KEY) : superopsApiKey;
  }
  if (aiApiKey !== undefined) {
    updates.aiApiKey = aiApiKey && ENCRYPTION_KEY ? encrypt(aiApiKey, ENCRYPTION_KEY) : aiApiKey;
  }

  await db.update(tenants).set(updates).where(eq(tenants.id, req.params.id));
  res.json({ ok: true });
});

router.post('/:id/test-connection', async (req, res) => {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, req.params.id)).limit(1);
  if (!tenant) {
    res.status(404).json({ error: 'Tenant not found' });
    return;
  }

  const apiKey = ENCRYPTION_KEY ? decrypt(tenant.superopsApiKey, ENCRYPTION_KEY) : tenant.superopsApiKey;
  const client = new SuperOpsClient(tenant.superopsSubdomain, apiKey, tenant.superopsRegion || 'us');
  const result = await client.testConnection();
  res.json(result);
});

export default router;
