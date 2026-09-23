import { describeError } from '../../lib/logger';
import type { CippClient } from './client';

/**
 * Typed, read-only views of a client's Microsoft 365 directory, via CIPP.
 *
 * Shared by the investigation agent and the executor, so both read the same
 * facts the same way. Field names follow what CIPP's list endpoints return,
 * checked against CIPP-API's source; everything is parsed defensively,
 * because one unexpected shape must degrade to "unknown", never throw a
 * half-read value into a decision.
 */

export interface M365User {
  id: string;
  upn: string;
  displayName: string | null;
  accountEnabled: boolean | null;
  userType: string | null;
  jobTitle: string | null;
  department: string | null;
  onPremisesSync: boolean;
  assignedSkuIds: string[];
  licences: string[];
  lastPasswordChange: string | null;
}

export interface M365Group {
  id: string;
  displayName: string;
  mail: string | null;
  mailEnabled: boolean;
  securityEnabled: boolean;
  /** 'Microsoft 365' | 'Security' | 'Mail-Enabled Security' | 'Distribution List' */
  kind: string;
  dynamic: boolean;
  onPremisesSync: boolean;
  roleAssignable: boolean;
}

export interface M365Licence {
  skuId: string;
  name: string;
  total: number;
  used: number;
  available: number;
}

export interface SignIn {
  at: string | null;
  app: string | null;
  ip: string | null;
  location: string | null;
  ok: boolean;
  failure: string | null;
  interactive: boolean | null;
}

const NOT_FOUND = /404|does not exist|not found|Request_ResourceNotFound|ResourceNotFound/i;

export class DirectoryError extends Error {
  readonly notFound: boolean;
  constructor(message: string, notFound = false) {
    super(message);
    this.name = 'DirectoryError';
    this.notFound = notFound;
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function bool(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 'True') return true;
  if (v === 'false' || v === 'False') return false;
  return null;
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function groupKind(g: Record<string, unknown>): string {
  const types = Array.isArray(g.groupTypes) ? (g.groupTypes as string[]) : String(g.groupTypes ?? '').split(',');
  if (types.includes('Unified')) return 'Microsoft 365';
  const mail = bool(g.mailEnabled) ?? bool(g.MailEnabled);
  const sec = bool(g.securityEnabled) ?? bool(g.SecurityGroup);
  if (mail && sec) return 'Mail-Enabled Security';
  if (mail) return 'Distribution List';
  return 'Security';
}

function toGroup(g: Record<string, unknown>): M365Group | null {
  const id = str(g.id);
  const displayName = str(g.displayName) ?? str(g.DisplayName);
  if (!id || !displayName) return null;
  const types = Array.isArray(g.groupTypes) ? (g.groupTypes as string[]) : String(g.groupTypes ?? '').split(',');
  return {
    id,
    displayName,
    mail: str(g.mail) ?? str(g.Mail),
    mailEnabled: Boolean(bool(g.mailEnabled) ?? bool(g.MailEnabled)),
    securityEnabled: Boolean(bool(g.securityEnabled) ?? bool(g.SecurityGroup)),
    kind: groupKind(g),
    dynamic: types.includes('DynamicMembership') || Boolean(str(g.membershipRule)),
    onPremisesSync: Boolean(bool(g.onPremisesSyncEnabled) ?? bool(g.OnPremisesSync)),
    roleAssignable: Boolean(bool(g.isAssignableToRole) ?? bool(g.IsAssignableToRole)),
  };
}

/** One user by UPN. Throws DirectoryError(notFound) when the user does not exist. */
export async function getUser(cipp: CippClient, tenant: string, upn: string): Promise<M365User> {
  let raw: unknown;
  try {
    raw = await cipp.get('ListUsers', { tenantFilter: tenant, UserID: upn });
  } catch (err) {
    const message = describeError(err);
    throw new DirectoryError(NOT_FOUND.test(message) ? `No user ${upn} in ${tenant}` : message, NOT_FOUND.test(message));
  }
  const rows = (Array.isArray(raw) ? raw : [raw]) as Array<Record<string, unknown>>;
  const row =
    rows.find((r) => str(r?.userPrincipalName)?.toLowerCase() === upn.toLowerCase()) ??
    (rows.length === 1 ? rows[0] : undefined);
  const id = str(row?.id);
  if (!row || !id) throw new DirectoryError(`No user ${upn} in ${tenant}`, true);
  const assigned = Array.isArray(row.assignedLicenses) ? (row.assignedLicenses as Array<{ skuId?: string }>) : [];
  return {
    id,
    upn: str(row.userPrincipalName) ?? upn,
    displayName: str(row.displayName),
    accountEnabled: bool(row.accountEnabled),
    userType: str(row.userType),
    jobTitle: str(row.jobTitle),
    department: str(row.department),
    onPremisesSync: Boolean(bool(row.onPremisesSyncEnabled)),
    assignedSkuIds: assigned.map((l) => str(l.skuId)?.toLowerCase()).filter((v): v is string => Boolean(v)),
    licences: String(row.LicJoined ?? '')
      .split(',')
      .map((l) => l.trim())
      .filter(Boolean),
    lastPasswordChange: str(row.lastPasswordChangeDateTime),
  };
}

/** Groups the user is a direct member of. Accepts a UPN or object id. */
export async function getUserGroups(cipp: CippClient, tenant: string, user: string): Promise<M365Group[]> {
  const raw = await cipp.get<unknown>('ListUserGroups', { tenantFilter: tenant, userId: user });
  return (Array.isArray(raw) ? raw : [])
    .map((g) => toGroup(g as Record<string, unknown>))
    .filter((g): g is M365Group => Boolean(g));
}

/**
 * Groups whose name or address matches. Exact matches first; the caller
 * decides what to do with more than one.
 */
export async function findGroups(cipp: CippClient, tenant: string, query: string): Promise<M365Group[]> {
  const raw = await cipp.get<unknown>('ListGroups', { tenantFilter: tenant });
  const needle = query.trim().toLowerCase();
  const groups = (Array.isArray(raw) ? raw : [])
    .map((g) => toGroup(g as Record<string, unknown>))
    .filter((g): g is M365Group => Boolean(g));
  const exact = groups.filter((g) => g.displayName.toLowerCase() === needle || g.mail?.toLowerCase() === needle);
  const partial = groups.filter(
    (g) => !exact.includes(g) && (g.displayName.toLowerCase().includes(needle) || g.mail?.toLowerCase().includes(needle)),
  );
  return [...exact, ...partial];
}

export async function listLicences(cipp: CippClient, tenant: string): Promise<M365Licence[]> {
  const raw = await cipp.get<unknown>('ListLicenses', { tenantFilter: tenant });
  return (Array.isArray(raw) ? raw : [])
    .map((r) => {
      const row = r as Record<string, unknown>;
      const skuId = str(row.skuId)?.toLowerCase();
      if (!skuId) return null;
      const total = num(row.TotalLicenses);
      const used = num(row.CountUsed);
      return {
        skuId,
        name: str(row.License) ?? str(row.skuPartNumber) ?? skuId,
        total,
        used,
        available: Math.max(0, total - used),
      };
    })
    .filter((l): l is M365Licence => Boolean(l));
}

/** The most recent sign-ins. CIPP filters on the object id, not the UPN. */
export async function recentSignIns(cipp: CippClient, tenant: string, userId: string, top = 10): Promise<SignIn[]> {
  const raw = await cipp.get<unknown>('ListUserSigninLogs', { tenantFilter: tenant, UserID: userId, top: String(top) });
  return (Array.isArray(raw) ? raw : [])
    .map((r) => {
      const row = r as Record<string, unknown>;
      const status = (row.status ?? {}) as Record<string, unknown>;
      const location = (row.location ?? {}) as Record<string, unknown>;
      const code = num(status.errorCode);
      return {
        at: str(row.createdDateTime),
        app: str(row.appDisplayName),
        ip: str(row.ipAddress),
        location: [str(location.city), str(location.countryOrRegion)].filter(Boolean).join(', ') || null,
        ok: code === 0,
        failure: code === 0 ? null : (str(status.failureReason) ?? `error ${code}`),
        interactive: bool(row.isInteractive),
      };
    })
    .filter((s) => s.at);
}

export interface MfaState {
  registered: boolean | null;
  methods: string[];
  perUser: string | null;
  coveredByCA: string | null;
}

/** MFA registration from CIPP's report database — fast, but can lag by hours. */
export async function getMfaState(cipp: CippClient, tenant: string, upn: string): Promise<MfaState | null> {
  const raw = await cipp.get<unknown>('ListMFAUsers', { tenantFilter: tenant, UseReportDB: 'true' });
  const row = (Array.isArray(raw) ? raw : []).find((r) => {
    const x = r as Record<string, unknown>;
    return (str(x.UPN) ?? str(x.userPrincipalName))?.toLowerCase() === upn.toLowerCase();
  }) as Record<string, unknown> | undefined;
  if (!row) return null;
  const methods = Array.isArray(row.MFAMethods)
    ? (row.MFAMethods as string[])
    : String(row.MFAMethods ?? '')
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean);
  return {
    registered: bool(row.MFARegistration),
    methods,
    perUser: str(row.PerUser),
    coveredByCA: str(row.CoveredByCA),
  };
}
