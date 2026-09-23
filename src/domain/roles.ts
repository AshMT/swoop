/**
 * Roles, from least to most privileged. Each includes everything below it.
 *
 * - viewer    — reads the queue, the log and the reports
 * - reviewer  — also marks triage right or wrong, and re-runs tickets
 * - approver  — also approves or rejects proposed actions
 * - admin     — also changes settings, clients, tenants and people
 */
export const ROLES = ['viewer', 'reviewer', 'approver', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  viewer: 'Viewer',
  reviewer: 'Reviewer',
  approver: 'Approver',
  admin: 'Admin',
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  viewer: 'Sees the triage queue, the log and reports.',
  reviewer: 'Also marks triage right or wrong and re-runs tickets.',
  approver: 'Also approves or rejects proposed actions.',
  admin: 'Full access, including settings and people.',
};

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/** Unknown roles rank lowest, so a corrupted value fails closed. */
export function roleAtLeast(role: string | null | undefined, minimum: Role): boolean {
  if (!isRole(role)) return false;
  return ROLES.indexOf(role) >= ROLES.indexOf(minimum);
}
