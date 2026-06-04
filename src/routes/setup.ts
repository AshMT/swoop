import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db';
import { users, tenants, clients } from '../db/schema';
import { eq } from 'drizzle-orm';
import { signToken } from '../middleware/auth';
import { encrypt } from '../services/crypto';
import { SuperOpsClient } from '../services/psa/superops';
import { testAiConnection } from '../services/ai';
import { z } from 'zod';

const router = Router();
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '';

// Check if setup has been completed
router.get('/status', async (_req, res) => {
  const [user] = await db.select({ id: users.id }).from(users).limit(1);
  const [tenant] = await db.select({ id: tenants.id }).from(tenants).limit(1);
  res.json({
    setupComplete: !!user,
    hasAdmin: !!user,
    hasTenant: !!tenant,
  });
});

// Step 1: Create admin account
const adminSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

router.post('/admin', async (req, res) => {
  const [existing] = await db.select({ id: users.id }).from(users).limit(1);
  if (existing) {
    res.status(409).json({ error: 'Admin account already exists' });
    return;
  }

  const parsed = adminSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.errors[0]?.message || 'Invalid request' });
    return;
  }

  const { email, password } = parsed.data;
  const passwordHash = await bcrypt.hash(password, 12);
  const id = uuidv4();

  await db.insert(users).values({ id, email: email.toLowerCase(), passwordHash });

  const token = signToken({ userId: id, email: email.toLowerCase() });
  res.json({ token, email: email.toLowerCase() });
});

// Step 2: Test SuperOps connection
router.post('/test-superops', async (req, res) => {
  const { subdomain, apiKey } = req.body as { subdomain: string; apiKey: string };
  if (!subdomain || !apiKey) {
    res.status(400).json({ error: 'subdomain and apiKey required' });
    return;
  }

  const client = new SuperOpsClient(subdomain.trim(), apiKey.trim());
  const result = await client.testConnection();
  res.json(result);
});

// Step 2: Save tenant (SuperOps connection)
const tenantSchema = z.object({
  name: z.string().min(1),
  subdomain: z.string().min(1),
  apiKey: z.string().min(1),
});

router.post('/tenant', async (req, res) => {
  const parsed = tenantSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.errors[0]?.message || 'Invalid request' });
    return;
  }

  const { name, subdomain, apiKey } = parsed.data;

  const encryptedKey = ENCRYPTION_KEY ? encrypt(apiKey, ENCRYPTION_KEY) : apiKey;
  const slug = name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
  const id = uuidv4();

  await db.insert(tenants).values({
    id,
    name,
    slug,
    superopsSubdomain: subdomain.trim(),
    superopsApiKey: encryptedKey,
  });

  res.json({ id, name, slug });
});

// Step 3: Test AI connection
router.post('/test-ai', async (req, res) => {
  const { baseUrl, apiKey, model } = req.body as { baseUrl: string; apiKey: string; model: string };
  if (!baseUrl || !model) {
    res.status(400).json({ error: 'baseUrl and model required' });
    return;
  }

  const ok = await testAiConnection(baseUrl.trim(), (apiKey || '').trim(), model.trim());
  res.json({ ok });
});

// Step 3: Save AI configuration to tenant
const aiConfigSchema = z.object({
  tenantId: z.string().uuid(),
  baseUrl: z.string().url(),
  apiKey: z.string().optional(),
  model: z.string().min(1),
});

router.post('/ai-config', async (req, res) => {
  const parsed = aiConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.errors[0]?.message || 'Invalid request' });
    return;
  }

  const { tenantId, baseUrl, apiKey, model } = parsed.data;
  const encryptedAiKey = apiKey && ENCRYPTION_KEY ? encrypt(apiKey, ENCRYPTION_KEY) : (apiKey || null);

  await db
    .update(tenants)
    .set({ aiBaseUrl: baseUrl.trim(), aiApiKey: encryptedAiKey, aiModel: model.trim() })
    .where(eq(tenants.id, tenantId));

  res.json({ ok: true });
});

// Step 4: Add first client
const clientSchema = z.object({
  tenantId: z.string().uuid(),
  name: z.string().min(1),
  superopsCompanyId: z.string().optional(),
  automationEnabled: z.boolean().optional(),
});

router.post('/client', async (req, res) => {
  const parsed = clientSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.errors[0]?.message || 'Invalid request' });
    return;
  }

  const { tenantId, name, superopsCompanyId, automationEnabled } = parsed.data;
  const id = uuidv4();

  await db.insert(clients).values({
    id,
    tenantId,
    name,
    superopsCompanyId: superopsCompanyId || null,
    automationEnabled: automationEnabled ?? false,
  });

  res.json({ id, name });
});

export default router;
