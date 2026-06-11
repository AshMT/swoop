import type { AiClassification } from '../types';

export interface CippActionResult {
  ok: boolean;
  response?: unknown;
  error?: string;
}

/**
 * Normalize a user-entered CIPP API scope into a valid `.../.default` scope.
 * Accepts any of:
 *   - `api://<guid>/.default`  (verbatim — used as-is)
 *   - `api://<guid>`           (appends `/.default`)
 *   - `<guid>`                 (wraps as `api://<guid>/.default`)
 * Returns null for blank/whitespace input so the caller can fall back.
 */
export function normalizeScope(raw?: string | null): string | null {
  const v = (raw || '').trim();
  if (!v) return null;
  if (v.endsWith('/.default')) return v;
  if (v.startsWith('api://')) return `${v.replace(/\/$/, '')}/.default`;
  return `api://${v}/.default`;
}

/** Decode a JWT's payload WITHOUT verifying the signature — diagnostics only. */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export class CippClient {
  private baseUrl: string;
  private clientId: string;
  private clientSecret: string;
  private tenantId: string;
  private scope: string;

  private cachedToken: string | null = null;
  private tokenExpiry = 0;

  /**
   * @param apiScope The CIPP-API resource scope to request a token for, e.g.
   *   `api://<cipp-api-app-id>/.default` (the value from CIPP's "Copy API Scope").
   *   This is the AUDIENCE the CIPP Function App validates — it is usually a
   *   DIFFERENT app than the client you authenticate as. If omitted, falls back
   *   to `api://<clientId>/.default` for backward compatibility.
   */
  constructor(baseUrl: string, clientId: string, clientSecret: string, tenantId: string, apiScope?: string | null) {
    this.baseUrl = baseUrl.trim().replace(/\/$/, '');
    this.clientId = clientId.trim();
    this.clientSecret = clientSecret.trim();
    this.tenantId = tenantId.trim();
    this.scope = normalizeScope(apiScope) || `api://${this.clientId}/.default`;
  }

  private async getToken(): Promise<string> {
    if (this.cachedToken && Date.now() < this.tokenExpiry) {
      return this.cachedToken;
    }

    const tokenUrl = `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/token`;
    const scope = this.scope;

    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.clientId,
        client_secret: this.clientSecret,
        scope,
      }).toString(),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`CIPP token request failed: HTTP ${res.status} — ${text}`);
    }

    const data = await res.json() as { access_token: string; expires_in: number };
    this.cachedToken = data.access_token;
    // Expire 60s early to avoid using a token right as it expires
    this.tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
    return this.cachedToken;
  }

  private async request(path: string, params: Record<string, string> = {}, body?: unknown): Promise<unknown> {
    const token = await this.getToken();
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
    const res = await fetch(url.toString(), {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      let detail = res.statusText;
      try { detail = (await res.text()).slice(0, 500); } catch { /* ignore */ }

      // EasyAuth rejection: Azure AD issued the token, but the Function App's auth
      // layer refused it before it ever reached CIPP code. Decode the token so the
      // error shows exactly what was presented, plus how to fix the Function App.
      if (res.status === 401 || res.status === 403) {
        const claims = decodeJwtPayload(token) || {};
        const aud = String(claims.aud ?? 'unknown');
        const appid = String(claims.appid ?? claims.azp ?? 'unknown');
        const roles = Array.isArray(claims.roles) ? claims.roles.join(',') : 'none';
        throw new Error(
          `CIPP's Function App rejected the token (HTTP ${res.status}) before it reached CIPP. ` +
          `Token presented — audience: ${aud}, client app: ${appid}, roles: [${roles}]. ` +
          `This means the Function App's Authentication is not configured to accept this API client. ` +
          `Fix: the Function App needs a Microsoft identity provider with allowed token audience "${aud}" ` +
          `(CIPP normally adds this when the API client is created — re-save/recreate the client in CIPP, ` +
          `or add the provider manually in Azure Portal → Function App → Authentication, then restart it). ` +
          `Raw response: ${detail}`,
        );
      }

      throw new Error(`CIPP API error: HTTP ${res.status} — ${detail}`);
    }
    return res.json();
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.request('/api/ListTenants');
      return { ok: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  }

  async execute(
    classification: AiClassification,
    cippTenantId: string,
    onStep?: (message: string) => void,
  ): Promise<CippActionResult> {
    const { classification: action, entities } = classification;
    const tenantFilter = cippTenantId;

    try {
      onStep?.('Requesting OAuth token from Microsoft...');
      await this.getToken();
      onStep?.('Token acquired');

      let response: unknown;

      switch (action) {
        case 'password_reset': {
          if (!entities.target_user_email) throw new Error('target_user_email required for password_reset');
          onStep?.(`Calling CIPP ExecResetPass for ${entities.target_user_email}...`);
          response = await this.request('/api/ExecResetPass', {
            TenantFilter: tenantFilter,
            Id: entities.target_user_email,
            sendResults: 'true',
          });
          onStep?.(`Password reset triggered for ${entities.target_user_email}`);
          break;
        }

        case 'account_disable': {
          if (!entities.target_user_email) throw new Error('target_user_email required for account_disable');
          onStep?.(`Calling CIPP ExecDisableUser for ${entities.target_user_email}...`);
          response = await this.request('/api/ExecDisableUser', {
            TenantFilter: tenantFilter,
            Id: entities.target_user_email,
          });
          onStep?.(`Account disabled: ${entities.target_user_email}`);
          break;
        }

        case 'account_enable': {
          if (!entities.target_user_email) throw new Error('target_user_email required for account_enable');
          onStep?.(`Calling CIPP ExecEnableUser for ${entities.target_user_email}...`);
          response = await this.request('/api/ExecEnableUser', {
            TenantFilter: tenantFilter,
            Id: entities.target_user_email,
          });
          onStep?.(`Account enabled: ${entities.target_user_email}`);
          break;
        }

        case 'mfa_reset': {
          if (!entities.target_user_email) throw new Error('target_user_email required for mfa_reset');
          onStep?.(`Calling CIPP ExecResetMFA for ${entities.target_user_email}...`);
          response = await this.request('/api/ExecResetMFA', {
            TenantFilter: tenantFilter,
            Id: entities.target_user_email,
          });
          onStep?.(`MFA reset for ${entities.target_user_email}`);
          break;
        }

        case 'group_add': {
          if (!entities.target_user_email) throw new Error('target_user_email required for group_add');
          if (!entities.group_name) throw new Error('group_name required for group_add');
          onStep?.(`Calling CIPP EditGroup — adding ${entities.target_user_email} to "${entities.group_name}"...`);
          response = await this.request(
            '/api/EditGroup',
            { TenantFilter: tenantFilter },
            { action: 'Add', groupName: entities.group_name, userIds: [entities.target_user_email] },
          );
          onStep?.(`Added ${entities.target_user_email} to group "${entities.group_name}"`);
          break;
        }

        case 'group_remove': {
          if (!entities.target_user_email) throw new Error('target_user_email required for group_remove');
          if (!entities.group_name) throw new Error('group_name required for group_remove');
          onStep?.(`Calling CIPP EditGroup — removing ${entities.target_user_email} from "${entities.group_name}"...`);
          response = await this.request(
            '/api/EditGroup',
            { TenantFilter: tenantFilter },
            { action: 'Remove', groupName: entities.group_name, userIds: [entities.target_user_email] },
          );
          onStep?.(`Removed ${entities.target_user_email} from group "${entities.group_name}"`);
          break;
        }

        case 'license_assign': {
          if (!entities.target_user_email) throw new Error('target_user_email required for license_assign');
          if (!entities.license_sku) throw new Error('license_sku required for license_assign');
          onStep?.(`Calling CIPP EditUser — assigning license ${entities.license_sku} to ${entities.target_user_email}...`);
          response = await this.request(
            '/api/EditUser',
            { TenantFilter: tenantFilter },
            { id: entities.target_user_email, licenses: [{ skuId: entities.license_sku }], licenseAction: 'Add' },
          );
          onStep?.(`License ${entities.license_sku} assigned to ${entities.target_user_email}`);
          break;
        }

        case 'license_remove': {
          if (!entities.target_user_email) throw new Error('target_user_email required for license_remove');
          if (!entities.license_sku) throw new Error('license_sku required for license_remove');

          const removeAll = /^(all|current|any)$/i.test(entities.license_sku.trim());

          if (removeAll) {
            onStep?.(`Fetching assigned licenses for ${entities.target_user_email}...`);
            let skus: string[] = [];
            try {
              const usersRes = await this.request('/api/ListUsers', {
                TenantFilter: tenantFilter,
                UserId: entities.target_user_email,
              });
              const users = Array.isArray(usersRes) ? usersRes : (usersRes ? [usersRes] : []);
              const user = (users as Array<Record<string, unknown>>).find(u =>
                String(u.userPrincipalName ?? '').toLowerCase() === entities.target_user_email!.toLowerCase() ||
                String(u.mail ?? '').toLowerCase() === entities.target_user_email!.toLowerCase(),
              );
              const assigned = user?.assignedLicenses as Array<{ skuId?: string; SkuId?: string }> | undefined;
              if (Array.isArray(assigned)) {
                skus = assigned.map(l => (l.skuId || l.SkuId || '')).filter(Boolean);
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              onStep?.(`Could not enumerate licenses automatically: ${msg.slice(0, 200)}`);
            }

            if (skus.length === 0) {
              onStep?.(`No licenses found for ${entities.target_user_email} — nothing to remove`);
              response = { message: 'No licenses found to remove' };
              break;
            }

            onStep?.(`Found ${skus.length} license(s) — removing all from ${entities.target_user_email}...`);
            response = await this.request(
              '/api/EditUser',
              { TenantFilter: tenantFilter },
              { id: entities.target_user_email, licenses: skus.map(s => ({ skuId: s })), licenseAction: 'Remove' },
            );
            onStep?.(`All ${skus.length} license(s) removed from ${entities.target_user_email}`);
          } else {
            onStep?.(`Calling CIPP EditUser — removing license ${entities.license_sku} from ${entities.target_user_email}...`);
            response = await this.request(
              '/api/EditUser',
              { TenantFilter: tenantFilter },
              { id: entities.target_user_email, licenses: [{ skuId: entities.license_sku }], licenseAction: 'Remove' },
            );
            onStep?.(`License ${entities.license_sku} removed from ${entities.target_user_email}`);
          }
          break;
        }

        case 'mailbox_permission': {
          if (!entities.target_user_email) throw new Error('target_user_email required for mailbox_permission');
          onStep?.(`Calling CIPP ExecEditMailboxPermissions for ${entities.target_user_email}...`);
          response = await this.request(
            '/api/ExecEditMailboxPermissions',
            { TenantFilter: tenantFilter },
            { userId: entities.target_user_email },
          );
          onStep?.(`Mailbox permissions updated for ${entities.target_user_email}`);
          break;
        }

        default:
          throw new Error(`No CIPP handler for classification: ${action}`);
      }

      onStep?.('Done — CIPP action completed successfully');
      return { ok: true, response };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      onStep?.(`Failed: ${message.slice(0, 200)}`);
      return { ok: false, error: message };
    }
  }
}
