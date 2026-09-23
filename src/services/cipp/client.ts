import { config } from '../../config';
import { decrypt } from '../crypto';
import { describeError } from '../../lib/logger';
import type { Tenant } from '../../types';

/**
 * A read-only CIPP API client.
 *
 * Only GET is exposed. Swoop reads a user's state from CIPP to check a
 * proposal before anyone approves it; it has no code path that writes to a
 * client tenant, and keeping POST out of this class keeps it that way until
 * execution is designed on purpose.
 *
 * Auth is the CIPP-API client-credentials flow: a token from the MSP's own
 * Entra tenant, scoped to api://<client id>/.default, sent as a bearer token.
 */

export class CippError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'CippError';
    this.status = status;
  }
}

export interface CippCredentials {
  apiUrl: string;
  /** The MSP's own Entra tenant id, where the CIPP-API app registration lives. */
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();
const REQUEST_TIMEOUT_MS = 15_000;

export class CippClient {
  private readonly creds: CippCredentials;

  constructor(creds: CippCredentials) {
    this.creds = { ...creds, apiUrl: creds.apiUrl.trim().replace(/\/+$/, '') };
  }

  private cacheKey(): string {
    return `${this.creds.tenantId}|${this.creds.clientId}|${this.creds.apiUrl}`;
  }

  private async token(forceRefresh = false): Promise<string> {
    const key = this.cacheKey();
    const cached = tokenCache.get(key);
    if (!forceRefresh && cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

    const authority = config().cippAuthorityUrl;
    const url = `${authority}/${encodeURIComponent(this.creds.tenantId)}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      client_id: this.creds.clientId,
      client_secret: this.creds.clientSecret,
      scope: `api://${this.creds.clientId}/.default`,
      grant_type: 'client_credentials',
    });

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new CippError(`Could not reach Entra ID to get a CIPP token: ${describeError(err)}`);
    }

    const data = (await response.json().catch(() => null)) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    } | null;

    if (!response.ok || !data?.access_token) {
      const description = data?.error_description?.split('\n')[0] ?? `HTTP ${response.status}`;
      if (/AADSTS7000215/.test(description)) {
        throw new CippError('The CIPP client secret is wrong or expired. Copy the secret Value (not its ID) into Settings.', response.status);
      }
      throw new CippError(`Entra ID refused the CIPP token request: ${description}`, response.status);
    }

    tokenCache.set(key, {
      token: data.access_token,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    });
    return data.access_token;
  }

  /** GET /api/<endpoint>. Retries once with a fresh token on a 401. */
  async get<T = unknown>(endpoint: string, params: Record<string, string> = {}): Promise<T> {
    const path = endpoint.replace(/^\/?(api\/)?/, '');
    const url = new URL(`${this.creds.apiUrl}/api/${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    for (let attempt = 1; attempt <= 2; attempt++) {
      const token = await this.token(attempt === 2);
      let response: Response;
      try {
        response = await fetch(url, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        throw new CippError(`Could not reach CIPP at ${this.creds.apiUrl}: ${describeError(err)}`);
      }

      if (response.status === 401 && attempt === 1) continue;
      if (response.status === 401 || response.status === 403) {
        throw new CippError(
          'CIPP rejected the token. Check the client is added and enabled under CIPP → Integrations → CIPP-API, and that it is allowed this tenant.',
          response.status,
        );
      }
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 200);
        throw new CippError(`CIPP ${path} returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`, response.status);
      }
      return (await response.json()) as T;
    }
    throw new CippError('CIPP request failed');
  }

  /** Lists the tenants this CIPP client can see — the connection test. */
  async listTenants(): Promise<Array<{ defaultDomainName?: string; displayName?: string; customerId?: string }>> {
    const result = await this.get<unknown>('ListTenants');
    return Array.isArray(result) ? (result as Array<Record<string, string>>) : [];
  }
}

export function cippConfigured(
  tenant: Pick<Tenant, 'cippEnabled' | 'cippApiUrl' | 'cippTenantId' | 'cippClientId' | 'cippClientSecret'>,
): boolean {
  return Boolean(
    tenant.cippEnabled && tenant.cippApiUrl && tenant.cippTenantId && tenant.cippClientId && tenant.cippClientSecret,
  );
}

export function createCippClient(
  tenant: Pick<Tenant, 'cippEnabled' | 'cippApiUrl' | 'cippTenantId' | 'cippClientId' | 'cippClientSecret'>,
): CippClient | null {
  if (!cippConfigured(tenant)) return null;
  const cfg = config();
  const secret = cfg.encryptionEnabled ? decrypt(tenant.cippClientSecret!, cfg.encryptionKey) : tenant.cippClientSecret!;
  return new CippClient({
    apiUrl: tenant.cippApiUrl!,
    tenantId: tenant.cippTenantId!,
    clientId: tenant.cippClientId!,
    clientSecret: secret,
  });
}

/** For tests: forget cached tokens. */
export function clearCippTokenCache(): void {
  tokenCache.clear();
}
