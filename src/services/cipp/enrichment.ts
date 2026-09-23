import { describeError, createLogger } from '../../lib/logger';
import type { CippClient } from './client';

const log = createLogger('CIPP');

/**
 * What CIPP says about the user a ticket is about. Read-only, and advisory:
 * a failed lookup is recorded and triage carries on without it.
 */
export interface UserEnrichment {
  tenant: string;
  upn: string;
  found: boolean;
  displayName: string | null;
  accountEnabled: boolean | null;
  userType: string | null;
  jobTitle: string | null;
  department: string | null;
  /** Synced from on-premises AD: most changes must be made there. */
  onPremisesSync: boolean;
  licences: string[];
  lastPasswordChange: string | null;
  createdAt: string | null;
  groups: string[] | null;
  mfa: { registered: boolean | null; methods: string[]; perUser: string | null; coveredByCA: string | null } | null;
  fetchedAt: number;
  /** Set when one or more lookups failed. */
  error: string | null;
}

interface CippUser {
  displayName?: string;
  userPrincipalName?: string;
  accountEnabled?: boolean;
  userType?: string;
  jobTitle?: string;
  department?: string;
  onPremisesSyncEnabled?: boolean;
  LicJoined?: string;
  lastPasswordChangeDateTime?: string;
  createdDateTime?: string;
}

interface CippMfaRow {
  UPN?: string;
  userPrincipalName?: string;
  MFARegistration?: boolean;
  MFAMethods?: string[] | string;
  PerUser?: string;
  CoveredByCA?: string;
}

export async function enrichUser(client: CippClient, tenant: string, upn: string): Promise<UserEnrichment> {
  const result: UserEnrichment = {
    tenant,
    upn,
    found: false,
    displayName: null,
    accountEnabled: null,
    userType: null,
    jobTitle: null,
    department: null,
    onPremisesSync: false,
    licences: [],
    lastPasswordChange: null,
    createdAt: null,
    groups: null,
    mfa: null,
    fetchedAt: Math.floor(Date.now() / 1000),
    error: null,
  };
  const errors: string[] = [];

  try {
    const users = await client.get<CippUser[] | CippUser>('ListUsers', { tenantFilter: tenant, UserID: upn });
    const user = (Array.isArray(users) ? users : [users]).find(
      (u) => u?.userPrincipalName?.toLowerCase() === upn.toLowerCase(),
    ) ?? (Array.isArray(users) && users.length === 1 ? users[0] : null);
    if (user?.userPrincipalName) {
      result.found = true;
      result.displayName = user.displayName ?? null;
      result.accountEnabled = typeof user.accountEnabled === 'boolean' ? user.accountEnabled : null;
      result.userType = user.userType ?? null;
      result.jobTitle = user.jobTitle ?? null;
      result.department = user.department ?? null;
      result.onPremisesSync = Boolean(user.onPremisesSyncEnabled);
      result.licences = (user.LicJoined ?? '').split(',').map((l) => l.trim()).filter(Boolean);
      result.lastPasswordChange = user.lastPasswordChangeDateTime ?? null;
      result.createdAt = user.createdDateTime ?? null;
    }
  } catch (err) {
    // Graph answers 404 for an unknown user; CIPP surfaces that as an error.
    const message = describeError(err);
    if (/404|does not exist|not found|Request_ResourceNotFound/i.test(message)) {
      result.error = 'No user with that address in this tenant';
      return result;
    }
    errors.push(`user lookup: ${message}`);
  }

  if (result.found) {
    const [groups, mfa] = await Promise.allSettled([
      client.get<Array<{ DisplayName?: string }>>('ListUserGroups', { tenantFilter: tenant, userId: upn }),
      client.get<CippMfaRow[]>('ListMFAUsers', { tenantFilter: tenant, UseReportDB: 'true' }),
    ]);
    if (groups.status === 'fulfilled' && Array.isArray(groups.value)) {
      result.groups = groups.value.map((g) => g.DisplayName).filter((g): g is string => Boolean(g));
    } else if (groups.status === 'rejected') {
      errors.push(`groups: ${describeError(groups.reason)}`);
    }
    if (mfa.status === 'fulfilled' && Array.isArray(mfa.value)) {
      const row = mfa.value.find((r) => (r.UPN ?? r.userPrincipalName)?.toLowerCase() === upn.toLowerCase());
      if (row) {
        const methods = Array.isArray(row.MFAMethods)
          ? row.MFAMethods
          : (row.MFAMethods ?? '').split(',').map((m) => m.trim()).filter(Boolean);
        result.mfa = {
          registered: typeof row.MFARegistration === 'boolean' ? row.MFARegistration : null,
          methods,
          perUser: row.PerUser ?? null,
          coveredByCA: row.CoveredByCA ?? null,
        };
      }
    } else if (mfa.status === 'rejected') {
      errors.push(`MFA: ${describeError(mfa.reason)}`);
    }
  }

  if (errors.length > 0) {
    result.error = errors.join('; ');
    log.warn(`Enrichment of ${upn} in ${tenant} was partial — ${result.error}`);
  }
  return result;
}
