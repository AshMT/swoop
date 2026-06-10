import { Router } from 'express';
import { db } from '../../db';
import { tenants } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { requireAuth } from '../../middleware/auth';
import { encrypt, decrypt } from '../../services/crypto';
import { SuperOpsClient } from '../../services/psa/superops';
import { CippClient } from '../../services/cipp';
import { z } from 'zod';

const router = Router();
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '';

router.use(requireAuth);

const SAFE_FIELDS = {
  id: tenants.id,
  name: tenants.name,
  slug: tenants.slug,
  superopsSubdomain: tenants.superopsSubdomain,
  superopsRegion: tenants.superopsRegion,
  aiBaseUrl: tenants.aiBaseUrl,
  aiModel: tenants.aiModel,
  cippBaseUrl: tenants.cippBaseUrl,
  cippClientId: tenants.cippClientId,
  cippOauthTenantId: tenants.cippOauthTenantId,
  cippApiScope: tenants.cippApiScope,
  lastPolledAt: tenants.lastPolledAt,
  createdAt: tenants.createdAt,
} as const;

router.get('/', async (_req, res) => {
  const rows = await db.select(SAFE_FIELDS).from(tenants);
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const [tenant] = await db.select(SAFE_FIELDS).from(tenants).where(eq(tenants.id, req.params.id)).limit(1);
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
  cippBaseUrl: z.string().url().optional().nullable(),
  cippClientId: z.string().optional().nullable(),
  cippClientSecret: z.string().optional().nullable(),
  cippOauthTenantId: z.string().optional().nullable(),
  cippApiScope: z.string().optional().nullable(),
});

router.patch('/:id', async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request' });
    return;
  }

  const updates: Record<string, unknown> = {};
  const { superopsApiKey, aiApiKey, cippClientSecret, ...rest } = parsed.data;

  Object.assign(updates, rest);

  if (superopsApiKey) {
    updates.superopsApiKey = ENCRYPTION_KEY ? encrypt(superopsApiKey, ENCRYPTION_KEY) : superopsApiKey;
  }
  if (aiApiKey !== undefined) {
    updates.aiApiKey = aiApiKey && ENCRYPTION_KEY ? encrypt(aiApiKey, ENCRYPTION_KEY) : aiApiKey;
  }
  if (cippClientSecret !== undefined) {
    updates.cippClientSecret = cippClientSecret && ENCRYPTION_KEY
      ? encrypt(cippClientSecret, ENCRYPTION_KEY)
      : cippClientSecret;
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

router.post('/:id/test-cipp', async (req, res) => {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, req.params.id)).limit(1);
  if (!tenant) {
    res.status(404).json({ error: 'Tenant not found' });
    return;
  }
  if (!tenant.cippBaseUrl || !tenant.cippClientId || !tenant.cippClientSecret || !tenant.cippOauthTenantId) {
    res.status(400).json({ ok: false, error: 'CIPP not fully configured — set Base URL, Client ID, Client Secret, and Tenant ID' });
    return;
  }

  const clientSecret = ENCRYPTION_KEY ? decrypt(tenant.cippClientSecret, ENCRYPTION_KEY) : tenant.cippClientSecret;
  const cipp = new CippClient(tenant.cippBaseUrl, tenant.cippClientId, clientSecret, tenant.cippOauthTenantId, tenant.cippApiScope);
  const result = await cipp.testConnection();
  res.json(result);
});

export default router;
