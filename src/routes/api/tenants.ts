import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { tenants } from '../../db/schema';
import { config } from '../../config';
import { requireAuth } from '../../middleware/auth';
import { rateLimit } from '../../middleware/security';
import { encrypt } from '../../services/crypto';
import { createPsaClient } from '../../services/psa/factory';
import { runTenantCycle } from '../../services/poller';
import { defaultSystemPromptTemplate } from '../../prompts/system';
import { describeError } from '../../lib/logger';
import type { PublicTenant, Tenant } from '../../types';

const router = Router();

router.use(requireAuth);

/**
 * Strips secrets while still telling the UI whether each one is set. The
 * discovered-schema blob is dropped too — it is several kilobytes and has its
 * own endpoint, so shipping it with every tenant poll is pure waste.
 */
function toPublic(tenant: Tenant): PublicTenant {
  const { superopsApiKey, aiApiKey, psaCapabilities: _caps, ...rest } = tenant;
  return {
    ...rest,
    hasSuperopsApiKey: Boolean(superopsApiKey),
    hasAiApiKey: Boolean(aiApiKey),
  };
}

router.get('/', async (_req, res) => {
  const rows = await db.select().from(tenants);
  res.json(rows.map(toPublic));
});

router.get('/:id', async (req, res) => {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, req.params.id)).limit(1);
  if (!tenant) {
    res.status(404).json({ error: 'Tenant not found' });
    return;
  }
  res.json(toPublic(tenant));
});

const updateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  superopsSubdomain: z.string().min(1).max(253).optional(),
  superopsApiKey: z.string().min(1).max(4096).optional(),
  superopsRegion: z.enum(['us', 'eu']).optional(),
  aiBaseUrl: z.string().min(1).max(2048).nullable().optional(),
  aiApiKey: z.string().max(4096).nullable().optional(),
  aiModel: z.string().max(200).nullable().optional(),
  pollIntervalSeconds: z.number().int().min(15).max(3600).optional(),
  confidenceThreshold: z.number().min(0).max(1).optional(),
  automationPaused: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  systemPromptOverride: z.string().max(20_000).nullable().optional(),
});

router.patch('/:id', async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    res.status(400).json({ error: `${issue?.path.join('.') || 'body'}: ${issue?.message ?? 'invalid'}` });
    return;
  }

  const [existing] = await db.select().from(tenants).where(eq(tenants.id, req.params.id)).limit(1);
  if (!existing) {
    res.status(404).json({ error: 'Tenant not found' });
    return;
  }

  const cfg = config();
  const { superopsApiKey, aiApiKey, systemPromptOverride, ...rest } = parsed.data;
  const updates: Partial<Tenant> = { ...rest };

  if (superopsApiKey) {
    updates.superopsApiKey = cfg.encryptionEnabled
      ? encrypt(superopsApiKey, cfg.encryptionKey)
      : superopsApiKey;
    // New credentials may point at a different instance, so discard the probe.
    updates.psaCapabilities = null;
    updates.psaCapabilitiesProbedAt = null;
  }

  // A changed subdomain or region is also a different endpoint.
  if (
    (rest.superopsSubdomain && rest.superopsSubdomain !== existing.superopsSubdomain) ||
    (rest.superopsRegion && rest.superopsRegion !== existing.superopsRegion)
  ) {
    updates.psaCapabilities = null;
    updates.psaCapabilitiesProbedAt = null;
  }

  if (aiApiKey !== undefined) {
    const trimmed = aiApiKey?.trim();
    updates.aiApiKey = trimmed
      ? cfg.encryptionEnabled
        ? encrypt(trimmed, cfg.encryptionKey)
        : trimmed
      : null;
  }

  if (systemPromptOverride !== undefined) {
    updates.systemPromptOverride = systemPromptOverride?.trim() ? systemPromptOverride : null;
  }

  await db.update(tenants).set(updates).where(eq(tenants.id, req.params.id));
  const [updated] = await db.select().from(tenants).where(eq(tenants.id, req.params.id)).limit(1);
  res.json(toPublic(updated!));
});

/** Re-runs the schema probe and reports what it found. */
router.post(
  '/:id/test-connection',
  rateLimit({ windowMs: 60_000, max: 20, keyPrefix: 'tenant-test' }),
  async (req, res) => {
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, req.params.id)).limit(1);
    if (!tenant) {
      res.status(404).json({ error: 'Tenant not found' });
      return;
    }
    try {
      const psa = createPsaClient(tenant);
      res.json(await psa.testConnection());
    } catch (err) {
      // A DecryptionError lands here when ENCRYPTION_KEY has changed.
      res.status(400).json({ ok: false, error: describeError(err) });
    }
  },
);

/** The discovered SuperOps schema, for the diagnostics panel. */
router.get('/:id/capabilities', async (req, res) => {
  const [tenant] = await db
    .select({
      psaCapabilities: tenants.psaCapabilities,
      psaCapabilitiesProbedAt: tenants.psaCapabilitiesProbedAt,
    })
    .from(tenants)
    .where(eq(tenants.id, req.params.id))
    .limit(1);

  if (!tenant) {
    res.status(404).json({ error: 'Tenant not found' });
    return;
  }
  if (!tenant.psaCapabilities) {
    res.json({ probed: false, capabilities: null });
    return;
  }
  res.json({
    probed: true,
    probedAt: tenant.psaCapabilitiesProbedAt,
    capabilities: JSON.parse(tenant.psaCapabilities),
  });
});

/** Runs a poll cycle immediately instead of waiting out the interval. */
router.post(
  '/:id/poll-now',
  rateLimit({ windowMs: 60_000, max: 10, keyPrefix: 'poll-now' }),
  async (req, res) => {
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, req.params.id)).limit(1);
    if (!tenant) {
      res.status(404).json({ error: 'Tenant not found' });
      return;
    }
    try {
      const summary = await runTenantCycle(tenant);
      // A cycle that could not reach SuperOps is not a successful poll, even
      // though the request itself succeeded — say so rather than reporting ok.
      res.json({ ok: summary.outcome !== 'error', summary, error: summary.error });
    } catch (err) {
      res.status(500).json({ ok: false, error: describeError(err) });
    }
  },
);

/** The built-in prompt, so the editor can show it and offer a reset. */
router.get('/:id/default-prompt', (_req, res) => {
  res.json({ prompt: defaultSystemPromptTemplate() });
});

export default router;
