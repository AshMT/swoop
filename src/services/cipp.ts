import type { AiClassification } from '../types';

export interface CippActionResult {
  ok: boolean;
  response?: unknown;
  error?: string;
}

export class CippClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
  }

  private async request(path: string, params: Record<string, string> = {}, body?: unknown): Promise<unknown> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
    const res = await fetch(url.toString(), {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      throw new Error(`CIPP API error: HTTP ${res.status} ${res.statusText}`);
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

  async execute(classification: AiClassification, cippTenantId: string): Promise<CippActionResult> {
    const { classification: action, entities } = classification;
    const tenantFilter = cippTenantId;

    try {
      let response: unknown;

      switch (action) {
        case 'password_reset': {
          if (!entities.target_user_email) throw new Error('target_user_email required for password_reset');
          response = await this.request('/api/ExecResetPass', {
            TenantFilter: tenantFilter,
            Id: entities.target_user_email,
            sendResults: 'true',
          });
          break;
        }

        case 'account_disable': {
          if (!entities.target_user_email) throw new Error('target_user_email required for account_disable');
          response = await this.request('/api/ExecDisableUser', {
            TenantFilter: tenantFilter,
            Id: entities.target_user_email,
          });
          break;
        }

        case 'account_enable': {
          if (!entities.target_user_email) throw new Error('target_user_email required for account_enable');
          response = await this.request('/api/ExecEnableUser', {
            TenantFilter: tenantFilter,
            Id: entities.target_user_email,
          });
          break;
        }

        case 'mfa_reset': {
          if (!entities.target_user_email) throw new Error('target_user_email required for mfa_reset');
          response = await this.request('/api/ExecResetMFA', {
            TenantFilter: tenantFilter,
            Id: entities.target_user_email,
          });
          break;
        }

        case 'group_add': {
          if (!entities.target_user_email) throw new Error('target_user_email required for group_add');
          if (!entities.group_name) throw new Error('group_name required for group_add');
          response = await this.request(
            '/api/EditGroup',
            { TenantFilter: tenantFilter },
            {
              action: 'Add',
              groupName: entities.group_name,
              userIds: [entities.target_user_email],
            },
          );
          break;
        }

        case 'group_remove': {
          if (!entities.target_user_email) throw new Error('target_user_email required for group_remove');
          if (!entities.group_name) throw new Error('group_name required for group_remove');
          response = await this.request(
            '/api/EditGroup',
            { TenantFilter: tenantFilter },
            {
              action: 'Remove',
              groupName: entities.group_name,
              userIds: [entities.target_user_email],
            },
          );
          break;
        }

        case 'license_assign': {
          if (!entities.target_user_email) throw new Error('target_user_email required for license_assign');
          if (!entities.license_sku) throw new Error('license_sku required for license_assign');
          response = await this.request(
            '/api/EditUser',
            { TenantFilter: tenantFilter },
            {
              id: entities.target_user_email,
              licenses: [{ skuId: entities.license_sku }],
              licenseAction: 'Add',
            },
          );
          break;
        }

        case 'license_remove': {
          if (!entities.target_user_email) throw new Error('target_user_email required for license_remove');
          if (!entities.license_sku) throw new Error('license_sku required for license_remove');
          response = await this.request(
            '/api/EditUser',
            { TenantFilter: tenantFilter },
            {
              id: entities.target_user_email,
              licenses: [{ skuId: entities.license_sku }],
              licenseAction: 'Remove',
            },
          );
          break;
        }

        case 'mailbox_permission': {
          if (!entities.target_user_email) throw new Error('target_user_email required for mailbox_permission');
          response = await this.request(
            '/api/ExecEditMailboxPermissions',
            { TenantFilter: tenantFilter },
            {
              userId: entities.target_user_email,
            },
          );
          break;
        }

        default:
          throw new Error(`No CIPP handler for classification: ${action}`);
      }

      return { ok: true, response };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  }
}
