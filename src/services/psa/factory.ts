import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { tenants } from '../../db/schema';
import { config } from '../../config';
import { decrypt } from '../crypto';
import { SuperOpsClient } from './superops';
import { CAPABILITIES_VERSION, type PsaCapabilities } from './capabilities';
import { createLogger } from '../../lib/logger';
import type { Tenant } from '../../types';

const log = createLogger('PSA');

/** Re-probe the schema if the cached result is older than this. */
const CAPABILITIES_TTL_SECONDS = 7 * 24 * 60 * 60;

export function readStoredCapabilities(tenant: Pick<Tenant, 'psaCapabilities'>): PsaCapabilities | null {
  if (!tenant.psaCapabilities) return null;
  try {
    const parsed = JSON.parse(tenant.psaCapabilities) as PsaCapabilities;
    if (parsed.version !== CAPABILITIES_VERSION) return null;
    const age = Math.floor(Date.now() / 1000) - (parsed.probedAt ?? 0);
    if (age > CAPABILITIES_TTL_SECONDS) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function decryptSuperOpsKey(tenant: Pick<Tenant, 'superopsApiKey'>): string {
  const cfg = config();
  return cfg.encryptionEnabled ? decrypt(tenant.superopsApiKey, cfg.encryptionKey) : tenant.superopsApiKey;
}

/**
 * Builds a PSA client for a tenant, reusing the cached schema probe and writing
 * a fresh one back when it runs. Persisting the probe means a restart does not
 * cost half a dozen introspection round-trips before the first poll.
 */
export function createPsaClient(
  tenant: Pick<Tenant, 'id' | 'superopsSubdomain' | 'superopsApiKey' | 'superopsRegion' | 'psaCapabilities'>,
): SuperOpsClient {
  return new SuperOpsClient({
    subdomain: tenant.superopsSubdomain,
    apiKey: decryptSuperOpsKey(tenant),
    region: tenant.superopsRegion || 'us',
    capabilities: readStoredCapabilities(tenant),
    onCapabilities: async (capabilities) => {
      await db
        .update(tenants)
        .set({
          psaCapabilities: JSON.stringify(capabilities),
          psaCapabilitiesProbedAt: capabilities.probedAt,
        })
        .where(eq(tenants.id, tenant.id));
      log.debug(`Stored schema capabilities for tenant ${tenant.id}`);
    },
  });
}
