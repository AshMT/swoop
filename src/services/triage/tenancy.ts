import type { Client } from '../../types';
import type { PsaTicket } from '../psa/interface';

/**
 * Tenant recognition: working out which client a ticket really belongs to,
 * and noticing when a request reaches across clients.
 *
 * An MSP holds admin rights in dozens of Microsoft 365 tenants. The cheapest
 * social-engineering attack on it is a plausible ticket from one client asking
 * for a change to a user at another — or from a personal address claiming to
 * be staff. A human reading one ticket at a time rarely notices; comparing the
 * domains involved against what each client owns catches it every time.
 */

/** Consumer mailbox providers — an address here proves nothing about employment. */
const FREE_MAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'hotmail.co.uk',
  'live.com',
  'live.com.au',
  'msn.com',
  'yahoo.com',
  'yahoo.co.uk',
  'yahoo.com.au',
  'ymail.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'gmx.com',
  'gmx.net',
  'zoho.com',
  'mail.com',
  'bigpond.com',
  'bigpond.net.au',
  'optusnet.com.au',
  'btinternet.com',
  'sky.com',
  'virginmedia.com',
  'comcast.net',
  'verizon.net',
  'att.net',
  'hey.com',
  'fastmail.com',
]);

export function isFreeMailDomain(domain: string | null | undefined): boolean {
  return Boolean(domain && FREE_MAIL_DOMAINS.has(domain.toLowerCase()));
}

export function domainOf(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf('@');
  if (at < 1) return null;
  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase()
    .replace(/[>\s].*$/, '');
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) ? domain : null;
}

/** Normalises what an operator typed: strips @, protocols, paths and case. */
export function normaliseDomain(raw: string): string | null {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^.*@/, '')
    .replace(/\/.*$/, '')
    .replace(/\.$/, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(cleaned) ? cleaned : null;
}

export function parseDomainList(raw: string | null | undefined): string[] {
  return parseStringList(raw)
    .map(normaliseDomain)
    .filter((d): d is string => Boolean(d));
}

export function parseEmailList(raw: string | null | undefined): string[] {
  return parseStringList(raw)
    .map((e) => e.trim().toLowerCase())
    .filter((e) => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(e));
}

function parseStringList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    // Tolerate a comma or newline separated string saved by hand.
  }
  return raw.split(/[\s,;]+/).filter(Boolean);
}

/** The domains a client owns: its configured list plus its M365 default domain. */
export function clientDomains(client: Pick<Client, 'emailDomains' | 'm365DefaultDomain'>): string[] {
  const domains = new Set(parseDomainList(client.emailDomains));
  const m365 = client.m365DefaultDomain ? normaliseDomain(client.m365DefaultDomain) : null;
  if (m365) domains.add(m365);
  return [...domains];
}

/** A domain matches when it is the owned domain or a subdomain of it. */
export function domainBelongsTo(domain: string, owned: readonly string[]): boolean {
  return owned.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/** Which client owns a domain, if any. The longest (most specific) match wins. */
export function clientForDomain<T extends Pick<Client, 'emailDomains' | 'm365DefaultDomain'>>(
  domain: string | null,
  candidates: readonly T[],
): T | null {
  if (!domain) return null;
  let best: { client: T; length: number } | null = null;
  for (const client of candidates) {
    for (const owned of clientDomains(client)) {
      if ((domain === owned || domain.endsWith(`.${owned}`)) && (!best || owned.length > best.length)) {
        best = { client, length: owned.length };
      }
    }
  }
  return best?.client ?? null;
}

export type MatchMethod = 'company_id' | 'company_name' | 'email_domain';

export interface ClientMatch {
  client: Client;
  method: MatchMethod;
}

/**
 * Resolves a ticket to a client: by SuperOps company id, then name, then by
 * the requester's email domain. The last catches tickets raised by email from
 * an address SuperOps has not linked to a company yet, which otherwise fall
 * through the allowlist.
 *
 * `candidates` should be every client of the tenant — the caller decides
 * whether the matched one is enabled, so a ticket from a disabled client is
 * not misattributed to an enabled one sharing a domain.
 */
export function resolveClient(ticket: PsaTicket, candidates: readonly Client[]): ClientMatch | null {
  const id = norm(ticket.clientId);
  const name = norm(ticket.clientName);

  if (id) {
    const byId = candidates.find((c) => norm(c.superopsCompanyId) === id);
    if (byId) return { client: byId, method: 'company_id' };
  }
  if (name) {
    const byName = candidates.find((c) => norm(c.name) === name || norm(c.superopsCompanyId) === name);
    if (byName) return { client: byName, method: 'company_name' };
  }
  const byDomain = clientForDomain(domainOf(ticket.requesterEmail), candidates);
  if (byDomain) return { client: byDomain, method: 'email_domain' };
  return null;
}

function norm(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

export type TenancyFlag =
  /** The requester's domain belongs to a different client. */
  | 'requester_other_client'
  /** The user the action targets belongs to a different client. */
  | 'target_other_client'
  /** Requester uses a consumer mailbox, so their identity is unverified. */
  | 'requester_free_mail'
  /** Requester's domain belongs to no client at all. */
  | 'requester_external'
  /** Target address is on a domain this client does not own. */
  | 'target_unrecognised_domain';

export interface TenancyAssessment {
  clientId: string;
  clientName: string;
  matchMethod: MatchMethod;
  /** Whether the client has any domains configured — without them most checks cannot run. */
  domainsConfigured: boolean;
  requesterDomain: string | null;
  requesterClient: { id: string; name: string } | null;
  targetEmail: string | null;
  targetDomain: string | null;
  targetClient: { id: string; name: string } | null;
  m365: { tenantId: string | null; defaultDomain: string | null } | null;
  flags: TenancyFlag[];
  /** Any flag that means the request reaches into another client's tenant. */
  crossTenant: boolean;
}

export function assessTenancy(input: {
  client: Client;
  matchMethod: MatchMethod;
  requesterEmail: string | null;
  targetEmail: string | null;
  allClients: readonly Client[];
}): TenancyAssessment {
  const { client, allClients } = input;
  const owned = clientDomains(client);
  const others = allClients.filter((c) => c.id !== client.id);

  const requesterDomain = domainOf(input.requesterEmail);
  const targetDomain = domainOf(input.targetEmail);
  const flags: TenancyFlag[] = [];

  let requesterClient: TenancyAssessment['requesterClient'] = null;
  if (requesterDomain) {
    if (domainBelongsTo(requesterDomain, owned)) {
      requesterClient = { id: client.id, name: client.name };
    } else {
      const other = clientForDomain(requesterDomain, others);
      if (other) {
        requesterClient = { id: other.id, name: other.name };
        flags.push('requester_other_client');
      } else if (isFreeMailDomain(requesterDomain)) {
        flags.push('requester_free_mail');
      } else if (owned.length > 0) {
        flags.push('requester_external');
      }
    }
  }

  let targetClient: TenancyAssessment['targetClient'] = null;
  if (targetDomain) {
    if (domainBelongsTo(targetDomain, owned)) {
      targetClient = { id: client.id, name: client.name };
    } else {
      const other = clientForDomain(targetDomain, others);
      if (other) {
        targetClient = { id: other.id, name: other.name };
        flags.push('target_other_client');
      } else if (owned.length > 0 || isFreeMailDomain(targetDomain)) {
        flags.push('target_unrecognised_domain');
      }
    }
  }

  const m365 =
    client.m365TenantId || client.m365DefaultDomain
      ? { tenantId: client.m365TenantId ?? null, defaultDomain: client.m365DefaultDomain ?? null }
      : null;

  return {
    clientId: client.id,
    clientName: client.name,
    matchMethod: input.matchMethod,
    domainsConfigured: owned.length > 0,
    requesterDomain,
    requesterClient,
    targetEmail: input.targetEmail,
    targetDomain,
    targetClient,
    m365,
    flags,
    crossTenant: flags.includes('requester_other_client') || flags.includes('target_other_client'),
  };
}
