import type { Impact } from '../../domain/triage';

/**
 * Deterministic checks that run before and alongside the model.
 *
 * A model reads tone well and rules poorly: it will sometimes call a
 * "please update our bank details for the next invoice" email routine, and it
 * has no idea who the client's managing director is. These checks are cheap,
 * explainable, and never hallucinate — each one that fires is recorded with
 * the evidence that fired it, so a technician can see exactly why a ticket was
 * bumped.
 */

export type SignalSeverity = 'info' | 'warn' | 'critical';

export interface TriageSignal {
  id: string;
  label: string;
  /** The evidence, quoted or counted, so the flag is checkable. */
  detail: string;
  severity: SignalSeverity;
}

interface Pattern {
  id: string;
  label: string;
  regex: RegExp;
}

/**
 * Security patterns. Written to catch how people actually describe these —
 * "I clicked a link", not "I have been phished" — while staying specific
 * enough that "phishing training" alone does not fire the BEC check.
 */
const SECURITY_PATTERNS: Pattern[] = [
  {
    id: 'phishing',
    label: 'Possible phishing',
    regex:
      /\b(phish\w*|suspicious (e-?mail|link|attachment|message)|clicked (on )?(a|the|this) (link|attachment)|entered my (password|details|credentials)|fake (login|sign.?in) page)\b/i,
  },
  {
    id: 'account_compromise',
    label: 'Possible account compromise',
    regex:
      /\b(hack(ed|er)|compromis(ed|e)|someone (else )?(has )?(logged|signed) in|(unusual|unknown|strange|suspicious) (sign.?in|log.?in|activity)|sending (spam|emails?) (from|as) (me|my)|emails? (i|we) (didn'?t|did not) send|inbox rules?)\b/i,
  },
  {
    id: 'mfa_fatigue',
    label: 'Unexpected MFA prompts',
    regex:
      /\b((keep|keeps|constantly|repeatedly) (getting|receiving|being sent) .{0,30}(mfa|authenticator|approval|sign.?in) (prompts?|requests?|notifications?|codes?)|(didn'?t|did not|never) (request|ask for) (a|the|this) (code|prompt|approval))\b/i,
  },
  {
    id: 'malware',
    label: 'Possible malware or ransomware',
    regex:
      /\b(ransom\w*|files? (have been|are|were|got) encrypted|encrypted (all|my|our) files|malware|virus|trojan|keylogger|crypto.?locker|\.locked\b)/i,
  },
  {
    id: 'payment_fraud',
    label: 'Payment-detail change (possible invoice fraud)',
    regex:
      /\b((change|update|new|changed|updated) (of |to )?(our |their |the |my )?(bank|banking|payment|remittance|account) (details|information|info|account)|bsb (and|&) account|wire (transfer|the funds)|gift ?cards?|itunes cards?|google play cards?)\b/i,
  },
];

/**
 * Outage language. Only raises the impact floor — it never lowers what the
 * model decided — so a false positive costs a priority level, not a missed
 * outage.
 */
const ORG_WIDE =
  /\b(every(one|body)|no ?one|nobody|all (staff|users|of us|the (staff|users|office))|whole (office|company|business|site|building)|entire (office|company|business|site)|company.?wide|office.?wide|site.?wide)\b/i;
const OUTAGE_WORD =
  /\b(down|offline|outage|not working|isn'?t working|stopped working|can'?t|cannot|unable|no (internet|email|access|connection)|lost (internet|connection|access))\b/i;
/** "Nobody can get on the internet" is an outage with no outage word in it. */
const NOBODY_CAN = /\b(no ?one|nobody|none of us)\b.{0,40}?\b(can|could|is able|are able)\b/i;
/** "Everyone in accounts" is a team, however universal "everyone" sounds. */
const SCOPED_EVERYONE =
  /\b(every(one|body)|all (of )?(the )?(staff|users)|no ?one|nobody) (in|on|from|at) (the |our |my )?(\w+ ){0,2}(team|department|dept|floor|accounts|finance|sales|marketing|reception|warehouse|hr|payroll|ops|operations|design|support|branch|room)\b/i;
const TEAM_WIDE =
  /\b((the |our |whole )?(accounts|finance|sales|marketing|reception|warehouse|hr|payroll|ops|operations|design|support) (team|department|dept)|several (people|users|staff)|a few (people|users|of us)|multiple (people|users|staff))\b/i;

const URGENT_LANGUAGE = /\b(urgent(ly)?|asap|emergency|critical|immediately|right now|top priority)\b/i;

export interface SignalInput {
  subject: string;
  body: string;
  requesterEmail: string | null;
  /** Lower-cased VIP addresses for the ticket's client. */
  vipEmails: readonly string[];
  withinBusinessHours: boolean;
  /** Other tickets from this requester in the last seven days. */
  recentFromRequester: number;
  repeatThreshold: number;
}

export interface SignalAssessment {
  signals: TriageSignal[];
  /** A security pattern matched — route to Security, flag sensitive. */
  security: boolean;
  /** The lowest impact the ticket can have, from the words used. */
  impactFloor: Impact | null;
  vipRequester: boolean;
  afterHours: boolean;
}

export function detectSignals(input: SignalInput): SignalAssessment {
  const text = `${input.subject}\n${input.body}`;
  const signals: TriageSignal[] = [];

  let security = false;
  for (const pattern of SECURITY_PATTERNS) {
    const match = pattern.regex.exec(text);
    if (match) {
      security = true;
      signals.push({
        id: `security_${pattern.id}`,
        label: pattern.label,
        detail: `Matched "${quote(match[0])}"`,
        severity: 'critical',
      });
    }
  }

  let impactFloor: Impact | null = null;
  const scoped = SCOPED_EVERYONE.exec(text);
  const orgWide = scoped ? null : ORG_WIDE.exec(text);
  const outage = OUTAGE_WORD.exec(text) ?? NOBODY_CAN.exec(text);
  if (orgWide && outage) {
    impactFloor = 'organisation';
    signals.push({
      id: 'outage_wide',
      label: 'Sounds organisation-wide',
      detail: `"${quote(orgWide[0])}" with "${quote(outage[0])}"`,
      severity: 'warn',
    });
  } else {
    const team = scoped ?? TEAM_WIDE.exec(text);
    if (team && outage) {
      impactFloor = 'team';
      signals.push({
        id: 'outage_team',
        label: 'Affects a team',
        detail: `"${quote(team[0])}" with "${quote(outage[0])}"`,
        severity: 'info',
      });
    }
  }

  const requester = input.requesterEmail?.trim().toLowerCase() ?? null;
  const vipRequester = Boolean(requester && input.vipEmails.includes(requester));
  if (vipRequester) {
    signals.push({
      id: 'vip_requester',
      label: 'VIP requester',
      detail: `${requester} is on this client's VIP list`,
      severity: 'warn',
    });
  }

  const afterHours = !input.withinBusinessHours;
  if (afterHours) {
    signals.push({
      id: 'after_hours',
      label: 'Raised out of hours',
      detail: 'Outside the business hours set for this tenant',
      severity: 'info',
    });
  }

  if (input.recentFromRequester + 1 >= input.repeatThreshold) {
    signals.push({
      id: 'repeat_requester',
      label: 'Repeat requester',
      detail: `${ordinal(input.recentFromRequester + 1)} ticket from this requester in 7 days`,
      severity: 'info',
    });
  }

  const urgent = URGENT_LANGUAGE.exec(text);
  if (urgent) {
    // Recorded, not acted on: "urgent" is in half of all tickets. The model
    // judges urgency from what is actually broken.
    signals.push({
      id: 'urgent_language',
      label: 'Marked urgent by requester',
      detail: `Said "${quote(urgent[0])}"`,
      severity: 'info',
    });
  }

  return { signals, security, impactFloor, vipRequester, afterHours };
}

function quote(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 60 ? `${flat.slice(0, 57)}...` : flat;
}

function ordinal(n: number): string {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${suffix}`;
}
