import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { tenants } from '../../db/schema';
import { config } from '../../config';
import { requireAuth, requireRole, type AuthRequest } from '../../middleware/auth';
import { rateLimit } from '../../middleware/security';
import { encrypt } from '../../services/crypto';
import { createPsaClient } from '../../services/psa/factory';
import { runTenantCycle } from '../../services/poller';
import { describeLogStorage, pruneTenantLogs } from '../../services/retention';
import { defaultSystemPromptTemplate } from '../../prompts/system';
import { formatProposalNote, NOTE_FORMATS, isNoteFormat } from '../../services/note-format';
import { describeError } from '../../lib/logger';
import type { PublicTenant, Tenant } from '../../types';
import { isValidTimezone, readTriageSettings, triageSettingsSchema } from '../../services/triage/settings';
import { approvalPolicySchema, readApprovalPolicy } from '../../services/approvals/policy';
import { createCippClient } from '../../services/cipp/client';
import { recordAudit } from '../../services/audit';
import { CATEGORIES } from '../../domain/triage';
import { agentSettingsSchema, readAgentSettings } from '../../services/agent/settings';
import { executionPolicySchema, readExecutionPolicy } from '../../services/execution/policy';
import { EXECUTABLE_ACTIONS } from '../../services/execution/actions';
import { syncSuperOpsKb } from '../../services/knowledge/runbooks';

const router = Router();

router.use(requireAuth);

/**
 * Strips secrets while still telling the UI whether each one is set. The
 * discovered-schema blob is dropped too — it is several kilobytes and has its
 * own endpoint, so shipping it with every tenant poll is pure waste.
 */
function toPublic(tenant: Tenant): PublicTenant {
  const { superopsApiKey, aiApiKey, cippClientSecret, psaCapabilities: _caps, ...rest } = tenant;
  return {
    ...rest,
    hasSuperopsApiKey: Boolean(superopsApiKey),
    hasAiApiKey: Boolean(aiApiKey),
    hasCippClientSecret: Boolean(cippClientSecret),
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
  classifyConcurrency: z.number().int().min(1).max(8).optional(),
  confidenceThreshold: z.number().min(0).max(1).optional(),
  automationPaused: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  noteFormat: z.enum(['plain', 'markdown', 'html']).optional(),
  systemPromptOverride: z.string().max(20_000).nullable().optional(),
  // 0 keeps everything; the cap is ten years.
  logRetentionDays: z.number().int().min(0).max(3650).optional(),
  triageSettings: triageSettingsSchema.optional(),
  approvalPolicy: approvalPolicySchema.optional(),
  agentSettings: agentSettingsSchema.optional(),
  executionPolicy: executionPolicySchema.optional(),
  cippEnabled: z.boolean().optional(),
  cippApiUrl: z.string().url().max(2048).nullable().optional(),
  cippTenantId: z.string().max(200).nullable().optional(),
  cippClientId: z.string().max(200).nullable().optional(),
  cippClientSecret: z.string().max(4096).nullable().optional(),
});

router.patch('/:id', requireRole('admin'), async (req: AuthRequest, res) => {
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
  const {
    superopsApiKey,
    aiApiKey,
    systemPromptOverride,
    triageSettings,
    approvalPolicy,
    agentSettings,
    executionPolicy,
    cippClientSecret,
    ...rest
  } = parsed.data;
  const updates: Partial<Tenant> = { ...rest };

  if (triageSettings) {
    if (!isValidTimezone(triageSettings.businessHours.timezone)) {
      res.status(400).json({ error: `Unknown timezone "${triageSettings.businessHours.timezone}"` });
      return;
    }
    updates.triageSettings = JSON.stringify(triageSettings);
  }
  if (approvalPolicy) updates.approvalPolicy = JSON.stringify(approvalPolicy);
  if (agentSettings) updates.agentSettings = JSON.stringify(agentSettings);
  if (executionPolicy) {
    const unknown = executionPolicy.actions.filter((a) => !EXECUTABLE_ACTIONS.includes(a));
    if (unknown.length) {
      res.status(400).json({ error: `These actions cannot be executed: ${unknown.join(', ')}` });
      return;
    }
    // Going live is the one setting that changes what Swoop can do to a
    // client's tenant, so it is recorded on its own line in the audit log.
    const before = readExecutionPolicy(existing.executionPolicy);
    if (before.mode !== executionPolicy.mode) {
      await recordAudit({
        user: req.user,
        action: 'execution.mode_change',
        targetType: 'tenant',
        targetId: existing.id,
        tenantId: existing.id,
        detail: { from: before.mode, to: executionPolicy.mode },
        req,
      });
    }
    updates.executionPolicy = JSON.stringify(executionPolicy);
  }

  if (cippClientSecret !== undefined) {
    const trimmed = cippClientSecret?.trim();
    updates.cippClientSecret = trimmed
      ? cfg.encryptionEnabled
        ? encrypt(trimmed, cfg.encryptionKey)
        : trimmed
      : null;
  }

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

  // Field names only — never the values, some of which are credentials.
  await recordAudit({
    user: req.user,
    action: 'tenant.update',
    targetType: 'tenant',
    targetId: existing.id,
    tenantId: existing.id,
    detail: { fields: Object.keys(parsed.data) },
    req,
  });
  res.json(toPublic(updated!));
});

/** Triage settings and approval policy with defaults filled in, for the editor. */
router.get('/:id/policies', async (req, res) => {
  const [tenant] = await db
    .select({
      triageSettings: tenants.triageSettings,
      approvalPolicy: tenants.approvalPolicy,
      agentSettings: tenants.agentSettings,
      executionPolicy: tenants.executionPolicy,
    })
    .from(tenants)
    .where(eq(tenants.id, req.params.id))
    .limit(1);
  if (!tenant) {
    res.status(404).json({ error: 'Tenant not found' });
    return;
  }
  res.json({
    triageSettings: readTriageSettings(tenant.triageSettings),
    approvalPolicy: readApprovalPolicy(tenant.approvalPolicy),
    agentSettings: readAgentSettings(tenant.agentSettings),
    executionPolicy: readExecutionPolicy(tenant.executionPolicy),
    executionDisabledByInstall: config().executionDisabled,
    executableActions: EXECUTABLE_ACTIONS,
    categories: CATEGORIES,
  });
});

/** Pulls the SuperOps knowledge base into the runbook store. */
router.post(
  '/:id/kb-sync',
  requireRole('reviewer'),
  rateLimit({ windowMs: 60_000, max: 5, keyPrefix: 'kb-sync' }),
  async (req, res) => {
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, req.params.id)).limit(1);
    if (!tenant) {
      res.status(404).json({ error: 'Tenant not found' });
      return;
    }
    const result = await syncSuperOpsKb(tenant);
    res.status(result.error && result.imported === 0 ? 400 : 200).json({ ok: !result.error, ...result });
  },
);

/** Checks the CIPP credentials by listing the tenants the client can see. */
router.post(
  '/:id/test-cipp',
  requireRole('admin'),
  rateLimit({ windowMs: 60_000, max: 10, keyPrefix: 'cipp-test' }),
  async (req, res) => {
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, req.params.id)).limit(1);
    if (!tenant) {
      res.status(404).json({ error: 'Tenant not found' });
      return;
    }
    // Test even when the switch is off, so it can be checked before enabling.
    const client = createCippClient({ ...tenant, cippEnabled: true });
    if (!client) {
      res.status(400).json({ ok: false, error: 'Fill in the CIPP URL, tenant ID, client ID and secret first.' });
      return;
    }
    try {
      const visible = await client.listTenants();
      res.json({
        ok: true,
        tenantCount: visible.length,
        tenants: visible.slice(0, 200).map((t) => ({ domain: t.defaultDomainName ?? null, name: t.displayName ?? null })),
      });
    } catch (err) {
      res.status(400).json({ ok: false, error: describeError(err) });
    }
  },
);

/** Re-runs the schema probe and reports what it found. */
router.post(
  '/:id/test-connection',
  requireRole('admin'),
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
  requireRole('reviewer'),
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

/**
 * The MSP's clients as the PSA knows them, so the Clients page can offer a
 * picker rather than asking an operator to find a company ID by hand.
 *
 * `available: false` means this schema exposes no client list — not an error,
 * since the allowlist works fine with a typed ID.
 */
router.get(
  '/:id/psa-clients',
  rateLimit({ windowMs: 60_000, max: 30, keyPrefix: 'psa-clients' }),
  async (req, res) => {
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, req.params.id)).limit(1);
    if (!tenant) {
      res.status(404).json({ error: 'Tenant not found' });
      return;
    }
    try {
      const companies = await createPsaClient(tenant).listCompanies();
      if (companies === null) {
        res.json({
          available: false,
          companies: [],
          reason: 'This SuperOps schema exposes no client list query, so company IDs must be entered by hand.',
        });
        return;
      }
      res.json({ available: true, companies });
    } catch (err) {
      res.status(502).json({ available: false, companies: [], error: describeError(err) });
    }
  },
);

/** Action log size, so an operator can see what retention would reclaim. */
router.get('/:id/log-storage', async (req, res) => {
  const [tenant] = await db
    .select({ id: tenants.id, logRetentionDays: tenants.logRetentionDays })
    .from(tenants)
    .where(eq(tenants.id, req.params.id))
    .limit(1);
  if (!tenant) {
    res.status(404).json({ error: 'Tenant not found' });
    return;
  }
  const storage = await describeLogStorage(tenant.id);
  res.json({ ...storage, logRetentionDays: tenant.logRetentionDays ?? 0 });
});

/** Runs retention now rather than waiting for the six-hourly timer. */
router.post(
  '/:id/prune-logs',
  requireRole('admin'),
  rateLimit({ windowMs: 60_000, max: 5, keyPrefix: 'prune-logs' }),
  async (req, res) => {
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, req.params.id)).limit(1);
    if (!tenant) {
      res.status(404).json({ error: 'Tenant not found' });
      return;
    }
    if (!tenant.logRetentionDays || tenant.logRetentionDays <= 0) {
      res.status(400).json({ error: 'Set a retention window before pruning.' });
      return;
    }
    res.json({ ok: true, ...(await pruneTenantLogs(tenant)) });
  },
);

/**
 * Renders a worked example of the internal note in each format.
 *
 * Whether a PSA renders Markdown or HTML in a note cannot be settled from
 * outside a real instance, so rather than guess, show the operator exactly
 * what each option produces and let them paste one into a test ticket.
 */
router.get('/:id/note-preview', async (req, res) => {
  const [tenant] = await db
    .select({ name: tenants.name, noteFormat: tenants.noteFormat, dryRun: tenants.dryRun })
    .from(tenants)
    .where(eq(tenants.id, req.params.id))
    .limit(1);
  if (!tenant) {
    res.status(404).json({ error: 'Tenant not found' });
    return;
  }

  const sample = {
    classification: 'password_reset',
    confidence: 0.94,
    sensitivity: 'normal' as const,
    entities: {
      target_user_email: 'sarah.jones@acme.com',
      target_user_display_name: 'Sarah Jones',
      group_name: null,
      license_sku: null,
    },
    reasoning: 'Explicit password reset request naming the user by email address.',
    follow_up_question: null,
    escalation_reason: null,
    proposed_psa_note: 'Reset the password for sarah.jones@acme.com and send the temporary credential via the agreed channel.',
    triage: {
      category: 'identity_access',
      subcategory: 'Account lockout',
      impact: 'individual' as const,
      urgency: 'blocking' as const,
      summary: 'Sarah Jones is locked out and cannot start work.',
      sentiment: 'neutral' as const,
      first_response: "We're resetting Sarah's password now and will send you the temporary one shortly.",
      next_steps: ['Confirm the requester is authorised', 'Reset the password', 'Check sign-in logs for the lockout cause'],
    },
  };

  res.json({
    current: isNoteFormat(tenant.noteFormat) ? tenant.noteFormat : 'plain',
    formats: NOTE_FORMATS.map((format) => ({
      ...format,
      preview: formatProposalNote(sample, {
        mspName: tenant.name,
        dryRun: Boolean(tenant.dryRun),
        format: format.id,
        triage: {
          priority: 'P3',
          queue: 'Service desk',
          signals: [],
          related: [],
          duplicateOf: null,
          approval: { state: 'pending', required: 1 },
          planBlockers: [],
        },
      }),
    })),
  });
});

/** The built-in prompt, so the editor can show it and offer a reset. */
router.get('/:id/default-prompt', (_req, res) => {
  res.json({ prompt: defaultSystemPromptTemplate() });
});

export default router;
