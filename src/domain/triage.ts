/**
 * The triage vocabulary: categories, impact, urgency and the priority matrix.
 *
 * Swoop's action list covers the handful of identity changes it could one day
 * automate. Most tickets an MSP sees are not those — printers, Wi-Fi, a laptop
 * that won't boot — and a tool that answers "escalate" for all of them is not
 * triaging. Categories cover the whole desk; the action says what, if
 * anything, could be automated.
 *
 * Deterministic where it can be. The model judges impact and urgency, which
 * need reading comprehension; the priority is then computed from the matrix
 * rather than chosen by the model, so two tickets with the same impact and
 * urgency always land on the same priority.
 */

export interface TriageCategory {
  id: string;
  label: string;
  description: string;
  /** Default queue when no routing rule overrides it. */
  defaultQueue: string;
}

export const CATEGORIES: readonly TriageCategory[] = [
  {
    id: 'identity_access',
    label: 'Identity & access',
    description: 'Passwords, MFA, lockouts, permissions, group membership, licences.',
    defaultQueue: 'Service desk',
  },
  {
    id: 'email_collab',
    label: 'Email & collaboration',
    description: 'Outlook, mailboxes, shared mailboxes, Teams, SharePoint, OneDrive, calendars.',
    defaultQueue: 'Service desk',
  },
  {
    id: 'security',
    label: 'Security',
    description: 'Phishing, malware, suspicious sign-ins, compromised accounts, fraud attempts.',
    defaultQueue: 'Security',
  },
  {
    id: 'endpoint',
    label: 'Devices & hardware',
    description: 'Laptops, desktops, monitors, docks, peripherals, mobile devices, performance.',
    defaultQueue: 'Service desk',
  },
  {
    id: 'printing',
    label: 'Printing & scanning',
    description: 'Printers, print queues, scanners, scan-to-email.',
    defaultQueue: 'Service desk',
  },
  {
    id: 'network',
    label: 'Network & connectivity',
    description: 'Internet, Wi-Fi, VPN, firewall, DNS, site connectivity.',
    defaultQueue: 'Service desk',
  },
  {
    id: 'software',
    label: 'Software & applications',
    description: 'Installs, updates, line-of-business apps, application errors.',
    defaultQueue: 'Service desk',
  },
  {
    id: 'lifecycle',
    label: 'Onboarding & offboarding',
    description: 'New starters, leavers, role changes, moves.',
    defaultQueue: 'Service desk',
  },
  {
    id: 'infrastructure',
    label: 'Servers & infrastructure',
    description: 'Servers, backups, storage, cloud resources, domain services.',
    defaultQueue: 'Infrastructure',
  },
  {
    id: 'telephony',
    label: 'Phones & telephony',
    description: 'VoIP, softphones, call routing, mobile service.',
    defaultQueue: 'Service desk',
  },
  {
    id: 'admin_billing',
    label: 'Admin & billing',
    description: 'Quotes, invoices, procurement, contracts, account questions.',
    defaultQueue: 'Account management',
  },
  {
    id: 'other',
    label: 'Other',
    description: 'Anything that fits none of the above.',
    defaultQueue: 'Service desk',
  },
];

export const CATEGORY_IDS = CATEGORIES.map((c) => c.id);

const CATEGORY_BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]));

export function findCategory(id: string | null | undefined): TriageCategory | null {
  if (!id) return null;
  return CATEGORY_BY_ID.get(id.trim().toLowerCase()) ?? null;
}

/** Accepts label-ish drift from the model: "Email & Collaboration" → email_collab. */
export function canonicaliseCategory(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const direct = findCategory(raw);
  if (direct) return direct.id;

  const needle = raw.trim().toLowerCase();
  const byLabel = CATEGORIES.find((c) => c.label.toLowerCase() === needle);
  if (byLabel) return byLabel.id;

  const slug = needle.replace(/&/g, ' ').replace(/[^a-z]+/g, '_').replace(/^_|_$/g, '');
  if (CATEGORY_BY_ID.has(slug)) return slug;

  // First-word match catches "email", "network issue", "printer problem".
  const aliases: Record<string, string> = {
    identity: 'identity_access',
    access: 'identity_access',
    account: 'identity_access',
    password: 'identity_access',
    email: 'email_collab',
    outlook: 'email_collab',
    teams: 'email_collab',
    sharepoint: 'email_collab',
    security: 'security',
    phishing: 'security',
    device: 'endpoint',
    devices: 'endpoint',
    hardware: 'endpoint',
    laptop: 'endpoint',
    printer: 'printing',
    printing: 'printing',
    network: 'network',
    internet: 'network',
    wifi: 'network',
    vpn: 'network',
    software: 'software',
    application: 'software',
    app: 'software',
    onboarding: 'lifecycle',
    offboarding: 'lifecycle',
    server: 'infrastructure',
    infrastructure: 'infrastructure',
    backup: 'infrastructure',
    phone: 'telephony',
    telephony: 'telephony',
    billing: 'admin_billing',
    invoice: 'admin_billing',
  };
  const firstWord = slug.split('_')[0];
  return aliases[firstWord] ?? null;
}

// ─── Impact and urgency ────────────────────────────────────────────────────────

export const IMPACTS = ['organisation', 'team', 'individual'] as const;
export type Impact = (typeof IMPACTS)[number];

export const URGENCIES = ['blocking', 'degraded', 'routine'] as const;
export type Urgency = (typeof URGENCIES)[number];

export const PRIORITIES = ['P1', 'P2', 'P3', 'P4'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const PRIORITY_LABELS: Record<Priority, string> = {
  P1: 'Critical',
  P2: 'High',
  P3: 'Medium',
  P4: 'Low',
};

/**
 * ITIL-style impact × urgency matrix, tuned for an MSP desk: a whole client
 * down is P1, one person unable to work is P3, a routine request is P4.
 */
const MATRIX: Record<Impact, Record<Urgency, Priority>> = {
  organisation: { blocking: 'P1', degraded: 'P2', routine: 'P3' },
  team: { blocking: 'P2', degraded: 'P3', routine: 'P4' },
  individual: { blocking: 'P3', degraded: 'P4', routine: 'P4' },
};

export function priorityFor(impact: Impact, urgency: Urgency): Priority {
  return MATRIX[impact][urgency];
}

export function normaliseImpact(raw: string | null | undefined): Impact {
  const value = (raw ?? '').trim().toLowerCase();
  if (/^(org|organisation|organization|company|business|site|all|everyone|high)/.test(value)) return 'organisation';
  if (/^(team|department|group|multiple|several|medium)/.test(value)) return 'team';
  return 'individual';
}

export function normaliseUrgency(raw: string | null | undefined): Urgency {
  const value = (raw ?? '').trim().toLowerCase();
  if (/^(block|critical|urgent|high|down|stopped|cannot)/.test(value)) return 'blocking';
  if (/^(degrad|impair|slow|partial|medium|intermittent)/.test(value)) return 'degraded';
  return 'routine';
}

export function priorityRank(priority: Priority): number {
  return PRIORITIES.indexOf(priority);
}

/** Raises a priority by `steps` levels, never past P1. */
export function raisePriority(priority: Priority, steps = 1): Priority {
  return PRIORITIES[Math.max(0, priorityRank(priority) - steps)];
}

/** Returns whichever of the two is more urgent. */
export function atLeast(priority: Priority, floor: Priority): Priority {
  return priorityRank(priority) <= priorityRank(floor) ? priority : floor;
}

export function isPriority(value: string | null | undefined): value is Priority {
  return value === 'P1' || value === 'P2' || value === 'P3' || value === 'P4';
}

// ─── Sentiment ─────────────────────────────────────────────────────────────────

export const SENTIMENTS = ['positive', 'neutral', 'frustrated', 'angry'] as const;
export type Sentiment = (typeof SENTIMENTS)[number];

export function normaliseSentiment(raw: string | null | undefined): Sentiment {
  const value = (raw ?? '').trim().toLowerCase();
  if (/^(angry|furious|hostile|irate)/.test(value)) return 'angry';
  if (/^(frustrat|annoy|upset|impatient|stress)/.test(value)) return 'frustrated';
  if (/^(positive|happy|polite|grateful|thank)/.test(value)) return 'positive';
  return 'neutral';
}

/**
 * The category an action implies, for when a custom prompt predates the
 * triage fields and the model returns only a classification.
 */
export function categoryForAction(action: string | null | undefined): string {
  switch (action) {
    case 'password_reset':
    case 'mfa_reset':
    case 'group_add':
    case 'group_remove':
    case 'license_assign':
    case 'license_remove':
    case 'account_enable':
      return 'identity_access';
    case 'account_disable':
      return 'lifecycle';
    case 'mailbox_permission':
      return 'email_collab';
    default:
      return 'other';
  }
}

/** Bumped when the shape or meaning of the stored triage changes. */
export const TRIAGE_VERSION = 1;
