import { Router } from 'express';
import { db } from '../../db';
import { tenants } from '../../db/schema';
import { config } from '../../config';
import { requireAuth } from '../../middleware/auth';
import { pollerStatus } from '../../services/poller';
import { readStoredCapabilities } from '../../services/psa/factory';
import { APP_VERSION } from '../../version';

const router = Router();

router.use(requireAuth);

/**
 * One call that answers "is Swoop actually working right now?".
 *
 * Poll failures used to appear only in the container logs, so an operator whose
 * API token had expired saw an empty dashboard and no explanation.
 */
router.get('/status', async (_req, res) => {
  const cfg = config();
  const rows = await db.select().from(tenants);

  const warnings: string[] = [];
  if (!cfg.encryptionEnabled) {
    warnings.push(
      'ENCRYPTION_KEY is not set, so SuperOps and AI credentials are stored in plaintext. Set it and re-enter the credentials in Settings.',
    );
  }

  const tenantStatus = rows.map((tenant) => {
    const capabilities = readStoredCapabilities(tenant);
    const capabilityWarnings = capabilities?.warnings ?? [];

    if (tenant.lastPollStatus === 'error' && tenant.lastPollError) {
      warnings.push(`${tenant.name}: ${tenant.lastPollError}`);
    }
    if (tenant.automationPaused) {
      warnings.push(`${tenant.name}: automation is paused, so no tickets are being classified.`);
    }
    if (tenant.dryRun) {
      warnings.push(`${tenant.name}: preview mode is on, so notes are not written back to SuperOps.`);
    }
    if (!capabilities) {
      warnings.push(`${tenant.name}: the SuperOps schema has not been probed yet. Run the connection test in Settings.`);
    } else if (!capabilities.bodyField) {
      warnings.push(
        `${tenant.name}: no ticket body field was found on this SuperOps schema, so classification uses the subject line only.`,
      );
    } else if (!capabilities.noteMutation) {
      warnings.push(`${tenant.name}: no note mutation was found, so proposals cannot be written back to tickets.`);
    }

    return {
      id: tenant.id,
      name: tenant.name,
      automationPaused: Boolean(tenant.automationPaused),
      dryRun: Boolean(tenant.dryRun),
      pollIntervalSeconds: tenant.pollIntervalSeconds,
      confidenceThreshold: tenant.confidenceThreshold,
      lastPolledAt: tenant.lastPolledAt,
      lastPollStatus: tenant.lastPollStatus,
      lastPollError: tenant.lastPollError,
      lastPollFinishedAt: tenant.lastPollFinishedAt,
      lastPollDurationMs: tenant.lastPollDurationMs,
      lastPollTicketCount: tenant.lastPollTicketCount,
      aiModel: tenant.aiModel || cfg.ai.model,
      capabilitiesProbedAt: capabilities?.probedAt ?? null,
      capabilityWarnings,
    };
  });

  const poller = pollerStatus();

  res.json({
    version: APP_VERSION,
    nodeEnv: cfg.nodeEnv,
    encryptionEnabled: cfg.encryptionEnabled,
    poller,
    tenants: tenantStatus,
    // Deduplicated so a repeated condition is not listed once per tenant.
    warnings: [...new Set(warnings)],
    healthy: poller.running && tenantStatus.every((t) => t.lastPollStatus !== 'error'),
  });
});

export default router;
