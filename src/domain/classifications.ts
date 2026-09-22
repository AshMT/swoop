/**
 * The single source of truth for the classifier's label set.
 *
 * The prompt, the response validator, the dashboard filters and the review
 * dropdown all derive from this list, so adding an action type is a one-line
 * change instead of four places that can drift apart.
 */

export interface ActionType {
  id: string;
  label: string;
  description: string;
  /** Actions that cannot be undone, or that grant access, always need a human. */
  inherentlySensitive: boolean;
  /** Phase 2 execution target, recorded now so the mapping is reviewable. */
  plannedBackend: 'cipp' | 'psa' | 'none';
}

export const ACTION_TYPES: readonly ActionType[] = [
  {
    id: 'password_reset',
    label: 'Password reset',
    description: 'The requester or a named user needs their password reset.',
    inherentlySensitive: false,
    plannedBackend: 'cipp',
  },
  {
    id: 'mfa_reset',
    label: 'MFA reset',
    description: "Reset or re-register a user's multi-factor authentication.",
    inherentlySensitive: true,
    plannedBackend: 'cipp',
  },
  {
    id: 'group_add',
    label: 'Add to group',
    description: 'Add a user to a security group, distribution list or team.',
    inherentlySensitive: false,
    plannedBackend: 'cipp',
  },
  {
    id: 'group_remove',
    label: 'Remove from group',
    description: 'Remove a user from a security group, distribution list or team.',
    inherentlySensitive: false,
    plannedBackend: 'cipp',
  },
  {
    id: 'license_assign',
    label: 'Assign licence',
    description: 'Assign a Microsoft 365 or third-party licence to a user.',
    inherentlySensitive: false,
    plannedBackend: 'cipp',
  },
  {
    id: 'license_remove',
    label: 'Remove licence',
    description: 'Remove a licence from a user.',
    inherentlySensitive: false,
    plannedBackend: 'cipp',
  },
  {
    id: 'account_disable',
    label: 'Disable account',
    description: 'Disable or block sign-in for a user account, e.g. an offboarding.',
    inherentlySensitive: true,
    plannedBackend: 'cipp',
  },
  {
    id: 'account_enable',
    label: 'Enable account',
    description: 'Re-enable a previously disabled account.',
    inherentlySensitive: true,
    plannedBackend: 'cipp',
  },
  {
    id: 'mailbox_permission',
    label: 'Mailbox permission',
    description: 'Grant or revoke shared-mailbox access or send-as/delegate rights.',
    inherentlySensitive: true,
    plannedBackend: 'cipp',
  },
  {
    id: 'FOLLOW_UP',
    label: 'Needs follow-up',
    description: 'The intent is clear enough to ask one specific clarifying question.',
    inherentlySensitive: false,
    plannedBackend: 'psa',
  },
  {
    id: 'ESCALATE',
    label: 'Escalate',
    description: 'Out of scope, too vague, or needs human judgement.',
    inherentlySensitive: false,
    plannedBackend: 'none',
  },
];

export const ACTION_IDS: readonly string[] = ACTION_TYPES.map((a) => a.id);

/** Labels that mean "no automated action", i.e. not a real proposed action. */
export const TERMINAL_IDS = ['ESCALATE', 'FOLLOW_UP'] as const;

const BY_ID = new Map(ACTION_TYPES.map((a) => [a.id.toLowerCase(), a]));

export function findActionType(id: string | null | undefined): ActionType | null {
  if (!id) return null;
  return BY_ID.get(id.trim().toLowerCase()) ?? null;
}

export function isKnownAction(id: string | null | undefined): boolean {
  return findActionType(id) !== null;
}

/**
 * Normalises a model's label to a canonical id. Models reliably drift on case,
 * separators and pluralisation ("Password Reset", "password-resets"), and
 * treating those as unknown would escalate perfectly good classifications.
 */
export function canonicaliseAction(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const direct = findActionType(raw);
  if (direct) return direct.id;

  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z_]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');

  const bySlug = findActionType(slug);
  if (bySlug) return bySlug.id;

  const depluralised = slug.replace(/s$/, '');
  return findActionType(depluralised)?.id ?? null;
}
