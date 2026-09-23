import { z } from 'zod';
import { CATEGORY_IDS } from '../../domain/triage';
import { createLogger } from '../../lib/logger';

const log = createLogger('Triage');

/**
 * Per-tenant triage settings, stored as one JSON document on the tenant.
 *
 * Every field has a default, so an install that never opens the settings page
 * still gets sensible business hours, routing and thresholds, and a document
 * saved by an older build parses cleanly after an upgrade.
 */
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour HH:MM');

export const triageSettingsSchema = z.object({
  businessHours: z
    .object({
      /** IANA zone, e.g. Australia/Sydney. */
      timezone: z.string().min(1).max(64).default('UTC'),
      /** ISO weekdays, 1 = Monday … 7 = Sunday. */
      days: z.array(z.number().int().min(1).max(7)).max(7).default([1, 2, 3, 4, 5]),
      start: hhmm.default('08:00'),
      end: hhmm.default('18:00'),
    })
    .default({}),
  /** Category id → queue name. Unset categories use their built-in default. */
  queueRouting: z.record(z.string(), z.string().max(80)).default({}),
  /** Where a P1/P2 ticket goes outside business hours. Empty disables it. */
  afterHoursQueue: z.string().max(80).default('On-call'),
  /** Tickets from one requester within 7 days before it is called out. */
  repeatRequesterThreshold: z.number().int().min(2).max(50).default(3),
  /** Hours within which a near-identical ticket from the same requester is a duplicate. */
  duplicateWindowHours: z.number().int().min(1).max(24 * 14).default(72),
  /** Minutes over which similar tickets are grouped into a possible incident. */
  clusterWindowMinutes: z.number().int().min(5).max(24 * 60).default(60),
  /** Similar tickets needed inside the window to call it an incident. */
  clusterThreshold: z.number().int().min(2).max(50).default(3),
  /** Use technician-reviewed past tickets as examples for the model. */
  useReviewedExamples: z.boolean().default(true),
});

export type TriageSettings = z.infer<typeof triageSettingsSchema>;

export const DEFAULT_TRIAGE_SETTINGS: TriageSettings = triageSettingsSchema.parse({});

/** Parses the stored document, falling back to defaults on anything unreadable. */
export function readTriageSettings(raw: string | null | undefined): TriageSettings {
  if (!raw) return DEFAULT_TRIAGE_SETTINGS;
  try {
    const parsed = triageSettingsSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return sanitiseRouting(parsed.data);
    log.warn(`Stored triage settings are invalid, using defaults: ${parsed.error.issues[0]?.message}`);
  } catch {
    log.warn('Stored triage settings are not valid JSON, using defaults');
  }
  return DEFAULT_TRIAGE_SETTINGS;
}

/** Drops routing entries for categories that no longer exist. */
function sanitiseRouting(settings: TriageSettings): TriageSettings {
  const queueRouting: Record<string, string> = {};
  for (const [category, queue] of Object.entries(settings.queueRouting)) {
    if (CATEGORY_IDS.includes(category) && queue.trim()) queueRouting[category] = queue.trim();
  }
  return { ...settings, queueRouting };
}

/** True when an IANA zone name is one this runtime can format. */
export function isValidTimezone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a moment falls inside business hours in the tenant's timezone.
 * Returns true for an unknown zone, so a typo never floods the on-call queue.
 */
export function isWithinBusinessHours(at: Date, hours: TriageSettings['businessHours']): boolean {
  if (!isValidTimezone(hours.timezone)) return true;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: hours.timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(get('weekday')) + 1;
  const minutes = Number(get('hour')) * 60 + Number(get('minute'));
  const [startH, startM] = hours.start.split(':').map(Number);
  const [endH, endM] = hours.end.split(':').map(Number);
  const start = startH * 60 + startM;
  const end = endH * 60 + endM;

  if (!hours.days.includes(weekday)) return false;
  // An overnight window (22:00–06:00) wraps past midnight.
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}
