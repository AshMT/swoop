/** Display helpers shared across pages. */

export function formatPercent(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatDateTime(unixSeconds: number | null | undefined): string {
  if (!unixSeconds) return '—';
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function formatDate(unixSeconds: number | null | undefined): string {
  if (!unixSeconds) return '—';
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

/** "4 minutes ago" — the form that actually answers "is polling working?". */
export function formatRelative(unixSeconds: number | null | undefined): string {
  if (!unixSeconds) return 'never';
  const seconds = Math.floor(Date.now() / 1000) - unixSeconds;
  if (seconds < 0) return 'just now';
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(unixSeconds);
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

/** Turns an action id into the label a technician would recognise. */
export function humanClassification(id: string | null | undefined): string {
  if (!id) return 'Unclassified';
  const labels: Record<string, string> = {
    password_reset: 'Password reset',
    mfa_reset: 'MFA reset',
    group_add: 'Add to group',
    group_remove: 'Remove from group',
    license_assign: 'Assign licence',
    license_remove: 'Remove licence',
    account_disable: 'Disable account',
    account_enable: 'Enable account',
    mailbox_permission: 'Mailbox permission',
    ESCALATE: 'Escalate',
    FOLLOW_UP: 'Needs follow-up',
  };
  return labels[id] ?? id.replace(/_/g, ' ');
}

export interface Entities {
  target_user_email?: string | null;
  target_user_display_name?: string | null;
  group_name?: string | null;
  license_sku?: string | null;
}

/** Entities are stored as a JSON string; never let a bad row break the table. */
export function parseEntities(raw: string | null | undefined): Entities {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Entities) : {};
  } catch {
    return {};
  }
}

export function hasEntities(entities: Entities): boolean {
  return Boolean(
    entities.target_user_email ||
      entities.target_user_display_name ||
      entities.group_name ||
      entities.license_sku,
  );
}

/** Human-readable byte size. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
