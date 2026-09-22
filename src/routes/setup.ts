import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { users, tenants, clients } from '../db/schema';
import { config } from '../config';
import { signToken, requireAuth } from '../middleware/auth';
import { rateLimit } from '../middleware/security';
import { encrypt } from '../services/crypto';
import { SuperOpsClient } from '../services/psa/superops';
import { testAiConnection } from '../services/ai';
import { createLogger } from '../lib/logger';

const router = Router();
const log = createLogger('Setup');

const BCRYPT_ROUNDS = 12;

/**
 * Only `/status` and `/admin` are reachable unauthenticated, and `/admin` works
 * exactly once — the very first request, when no user exists yet.
 *
 * Everything else requires the token that `/admin` issues. Previously the whole
 * of `/api/setup` was open, which let anyone who could reach the port create a
 * tenant, overwrite the AI configuration, or use the connection tests to probe
 * the host's internal network.
 */

// ─── Public: has this install been set up? ─────────────────────────────────────
router.get('/status', async (_req, res) => {
  const [user] = await db.select({ id: users.id }).from(users).limit(1);
  const [tenant] = await db.select({ id: tenants.id, name: tenants.name }).from(tenants).limit(1);
  const [client] = await db.select({ id: clients.id }).from(clients).limit(1);

  res.json({
    // "Set up" means an admin exists — without one, nothing else is reachable.
    setupComplete: Boolean(user),
    hasAdmin: Boolean(user),
    hasTenant: Boolean(tenant),
    hasClient: Boolean(client),
    // Surfaced so the wizard can resume at the right step after a reload.
    tenantId: tenant?.id ?? null,
    tenantName: tenant?.name ?? null,
  });
});

// ─── Step 1: create the one admin account (first-run only) ────────────────────
const adminSchema = z.object({
  email: z.string().email().max(254),
  password: z
    .string()
    .min(12, 'Password must be at least 12 characters')
    .max(200, 'Password must be at most 200 characters'),
});

router.post(
  '/admin',
  rateLimit({ windowMs: 60_000, max: 5, keyPrefix: 'setup-admin' }),
  async (req, res) => {
    const [existing] = await db.select({ id: users.id }).from(users).limit(1);
    if (existing) {
      res.status(409).json({ error: 'An admin account already exists. Sign in instead.' });
      return;
    }

    const parsed = adminSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
      return;
    }

    const email = parsed.data.email.toLowerCase().trim();
    const passwordHash = await bcrypt.hash(parsed.data.password, BCRYPT_ROUNDS);
    const id = uuidv4();

    try {
      await db.insert(users).values({ id, email, passwordHash, role: 'admin' });
    } catch {
      // Two concurrent first-run requests: the unique index decides the winner.
      res.status(409).json({ error: 'An admin account already exists. Sign in instead.' });
      return;
    }

    log.info(`Created the admin account for ${email}`);
    res.json({ token: signToken({ userId: id, email }), email });
  },
);

// ─── Everything below requires the token from step 1 ─────────────────────────
router.use(requireAuth);

/**
 * Connection tests take an operator-supplied URL, so they are an outbound
 * request Swoop makes on request. Auth plus a rate limit keeps them from being
 * a convenient internal-network scanner.
 */
const connectionTestLimit = rateLimit({
  windowMs: 60_000,
  max: 20,
  keyPrefix: 'connection-test',
  message: 'Too many connection tests. Wait a minute and try again.',
});

const superopsTestSchema = z.object({
  subdomain: z.string().min(1).max(253),
  apiKey: z.string().min(1).max(4096),
  region: z.enum(['us', 'eu']).default('us'),
});

router.post('/test-superops', connectionTestLimit, async (req, res) => {
  const parsed = superopsTestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'subdomain and apiKey are required' });
    return;
  }
  const { subdomain, apiKey, region } = parsed.data;
  const client = new SuperOpsClient({ subdomain, apiKey, region });
  res.json(await client.testConnection());
});

const tenantSchema = z.object({
  name: z.string().min(1).max(120),
  subdomain: z.string().min(1).max(253),
  apiKey: z.string().min(1).max(4096),
  region: z.enum(['us', 'eu']).default('us'),
});

router.post('/tenant', async (req, res) => {
  const parsed = tenantSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
    return;
  }

  // Phase 1 is single-tenant. Rather than silently creating a second tenant the
  // UI would ignore, update the existing one — that is what the operator means
  // when they re-run the wizard.
  const [existing] = await db.select({ id: tenants.id }).from(tenants).limit(1);

  const { name, subdomain, apiKey, region } = parsed.data;
  const cfg = config();
  const storedKey = cfg.encryptionEnabled ? encrypt(apiKey, cfg.encryptionKey) : apiKey;

  if (existing) {
    await db
      .update(tenants)
      .set({
        name,
        superopsSubdomain: subdomain.trim(),
        superopsApiKey: storedKey,
        superopsRegion: region,
        // The credentials changed, so the cached schema probe may not apply.
        psaCapabilities: null,
        psaCapabilitiesProbedAt: null,
      })
      .where(eq(tenants.id, existing.id));
    res.json({ id: existing.id, name, slug: slugify(name), updated: true });
    return;
  }

  const id = uuidv4();
  await db.insert(tenants).values({
    id,
    name,
    slug: await uniqueSlug(name),
    superopsSubdomain: subdomain.trim(),
    superopsApiKey: storedKey,
    superopsRegion: region,
  });

  log.info(`Created tenant "${name}"`);
  res.json({ id, name, slug: slugify(name), updated: false });
});

const aiTestSchema = z.object({
  baseUrl: z.string().min(1).max(2048),
  apiKey: z.string().max(4096).optional(),
  model: z.string().min(1).max(200),
});

router.post('/test-ai', connectionTestLimit, async (req, res) => {
  const parsed = aiTestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'baseUrl and model are required' });
    return;
  }
  const { baseUrl, apiKey, model } = parsed.data;
  res.json(await testAiConnection(baseUrl.trim(), (apiKey ?? '').trim(), model.trim()));
});

const aiConfigSchema = z.object({
  tenantId: z.string().uuid(),
  baseUrl: z.string().min(1).max(2048),
  apiKey: z.string().max(4096).optional(),
  model: z.string().min(1).max(200),
});

router.post('/ai-config', async (req, res) => {
  const parsed = aiConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
    return;
  }

  const { tenantId, baseUrl, apiKey, model } = parsed.data;
  const cfg = config();
  const trimmedKey = apiKey?.trim();

  const result = await db
    .update(tenants)
    .set({
      aiBaseUrl: baseUrl.trim(),
      aiApiKey: trimmedKey
        ? cfg.encryptionEnabled
          ? encrypt(trimmedKey, cfg.encryptionKey)
          : trimmedKey
        : null,
      aiModel: model.trim(),
    })
    .where(eq(tenants.id, tenantId))
    .returning({ id: tenants.id });

  if (result.length === 0) {
    res.status(404).json({ error: 'Tenant not found' });
    return;
  }
  res.json({ ok: true });
});

const clientSchema = z.object({
  tenantId: z.string().uuid(),
  name: z.string().min(1).max(200),
  superopsCompanyId: z.string().max(200).optional(),
  automationEnabled: z.boolean().optional(),
});

router.post('/client', async (req, res) => {
  const parsed = clientSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
    return;
  }

  const { tenantId, name, superopsCompanyId, automationEnabled } = parsed.data;
  const [tenant] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!tenant) {
    res.status(404).json({ error: 'Tenant not found' });
    return;
  }

  const id = uuidv4();
  await db.insert(clients).values({
    id,
    tenantId,
    name: name.trim(),
    superopsCompanyId: superopsCompanyId?.trim() || null,
    automationEnabled: automationEnabled ?? false,
  });

  res.json({ id, name: name.trim() });
});

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'tenant'
  );
}

/** The slug column is unique, so a second "Acme IT" must not collide. */
async function uniqueSlug(name: string): Promise<string> {
  const base = slugify(name);
  const existing = await db.select({ slug: tenants.slug }).from(tenants);
  const taken = new Set(existing.map((r) => r.slug));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

export default router;
