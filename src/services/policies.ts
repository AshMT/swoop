import { db } from '../db';
import { actionPolicies } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';

export type PolicyPermission = 'approval' | 'auto' | 'disabled';

export interface ActionCatalogEntry {
  actionType: string;
  label: string;
  description: string;
  defaultPermission: PolicyPermission;
  defaultRequireVerification: boolean;
}

export interface EffectivePolicy {
  actionType: string;
  label: string;
  description: string;
  permission: PolicyPermission;
  requireVerification: boolean;
  isDefault: boolean; // true when no tenant override exists
}

/**
 * The catalog of every action Swoop can execute via CIPP. Mirrors the
 * Rallied-style permission model: each action has a permission level the MSP
 * can override per tenant. All Swoop actions are M365 writes, so everything
 * defaults to requiring human approval; identity verification defaults ON for
 * credential/access-sensitive actions.
 */
export const ACTION_CATALOG: ActionCatalogEntry[] = [
  {
    actionType: 'password_reset',
    label: 'Reset password',
    description: 'Force a password reset for a Microsoft 365 user. The user must change their password at next sign-in.',
    defaultPermission: 'approval',
    defaultRequireVerification: true,
  },
  {
    actionType: 'mfa_reset',
    label: 'Reset MFA',
    description: "Reset a user's registered MFA/authentication methods so they can re-enrol from scratch.",
    defaultPermission: 'approval',
    defaultRequireVerification: true,
  },
  {
    actionType: 'account_disable',
    label: 'Disable account',
    description: 'Disable a Microsoft 365 user account, blocking all sign-ins. Used for offboarding and compromise response.',
    defaultPermission: 'approval',
    defaultRequireVerification: true,
  },
  {
    actionType: 'account_enable',
    label: 'Enable account',
    description: 'Re-enable a previously disabled Microsoft 365 user account, restoring sign-in access.',
    defaultPermission: 'approval',
    defaultRequireVerification: true,
  },
  {
    actionType: 'group_add',
    label: 'Add to group',
    description: 'Add a Microsoft 365 user to a security or Microsoft 365 group.',
    defaultPermission: 'approval',
    defaultRequireVerification: false,
  },
  {
    actionType: 'group_remove',
    label: 'Remove from group',
    description: 'Remove a Microsoft 365 user from a security or Microsoft 365 group.',
    defaultPermission: 'approval',
    defaultRequireVerification: false,
  },
  {
    actionType: 'license_assign',
    label: 'Assign license',
    description: 'Assign a Microsoft 365 license SKU to a user. Consumes a seat.',
    defaultPermission: 'approval',
    defaultRequireVerification: false,
  },
  {
    actionType: 'license_remove',
    label: 'Remove license',
    description: 'Remove a Microsoft 365 license SKU from a user. Frees a seat; associated services stop working.',
    defaultPermission: 'approval',
    defaultRequireVerification: false,
  },
  {
    actionType: 'mailbox_permission',
    label: 'Mailbox permissions',
    description: 'Grant or modify access permissions on a user mailbox (e.g. delegate or shared access).',
    defaultPermission: 'approval',
    defaultRequireVerification: true,
  },
];

const CATALOG_BY_TYPE = new Map(ACTION_CATALOG.map((e) => [e.actionType, e]));

/** All policies for a tenant, merged over catalog defaults. */
export async function getEffectivePolicies(tenantId: string): Promise<EffectivePolicy[]> {
  const rows = await db.select().from(actionPolicies).where(eq(actionPolicies.tenantId, tenantId));
  const byType = new Map(rows.map((r) => [r.actionType, r]));

  return ACTION_CATALOG.map((entry) => {
    const row = byType.get(entry.actionType);
    return {
      actionType: entry.actionType,
      label: entry.label,
      description: entry.description,
      permission: (row?.permission as PolicyPermission) ?? entry.defaultPermission,
      requireVerification: row ? !!row.requireVerification : entry.defaultRequireVerification,
      isDefault: !row,
    };
  });
}

/** Effective policy for a single action type (catalog defaults if no override). */
export async function getPolicy(tenantId: string, actionType: string): Promise<EffectivePolicy | null> {
  const entry = CATALOG_BY_TYPE.get(actionType);
  if (!entry) return null;

  const [row] = await db
    .select()
    .from(actionPolicies)
    .where(and(eq(actionPolicies.tenantId, tenantId), eq(actionPolicies.actionType, actionType)))
    .limit(1);

  return {
    actionType: entry.actionType,
    label: entry.label,
    description: entry.description,
    permission: (row?.permission as PolicyPermission) ?? entry.defaultPermission,
    requireVerification: row ? !!row.requireVerification : entry.defaultRequireVerification,
    isDefault: !row,
  };
}

/** Upsert a tenant's policy override for one action type. */
export async function setPolicy(
  tenantId: string,
  actionType: string,
  updates: { permission?: PolicyPermission; requireVerification?: boolean },
): Promise<EffectivePolicy | null> {
  const entry = CATALOG_BY_TYPE.get(actionType);
  if (!entry) return null;

  const current = await getPolicy(tenantId, actionType);
  const permission = updates.permission ?? current!.permission;
  const requireVerification = updates.requireVerification ?? current!.requireVerification;
  const now = Math.floor(Date.now() / 1000);

  const [existing] = await db
    .select()
    .from(actionPolicies)
    .where(and(eq(actionPolicies.tenantId, tenantId), eq(actionPolicies.actionType, actionType)))
    .limit(1);

  if (existing) {
    await db
      .update(actionPolicies)
      .set({ permission, requireVerification, updatedAt: now })
      .where(eq(actionPolicies.id, existing.id));
  } else {
    await db.insert(actionPolicies).values({
      id: uuidv4(),
      tenantId,
      actionType,
      permission,
      requireVerification,
      updatedAt: now,
    });
  }

  return getPolicy(tenantId, actionType);
}
