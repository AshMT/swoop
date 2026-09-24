import type { Client } from '../types';
import type { PsaTicket } from './psa/interface';

/**
 * Tickets the poller saw but did not triage because no enabled client matched
 * them — kept so the operator can see what was passed over and fix it, rather
 * than a new ticket simply never appearing.
 *
 * In memory: it is a convenience list, not a record, and the poll window is
 * short, so a restart losing it costs nothing a fresh poll would not show.
 */

export interface SkippedTicket {
  ticket: PsaTicket;
  /** 'no_client': nothing in Swoop matches it. 'client_disabled': it matched a client that is switched off. */
  reason: 'no_client' | 'client_disabled';
  clientId: string | null;
  clientName: string | null;
  firstSeenAt: number;
  lastSeenAt: number;
}

const MAX_PER_TENANT = 50;
const store = new Map<string, Map<string, SkippedTicket>>();

export function recordSkipped(tenantId: string, ticket: PsaTicket, matched: Client | null): void {
  let tenantStore = store.get(tenantId);
  if (!tenantStore) {
    tenantStore = new Map();
    store.set(tenantId, tenantStore);
  }
  const now = Math.floor(Date.now() / 1000);
  const previous = tenantStore.get(ticket.ticketId);
  tenantStore.delete(ticket.ticketId);
  tenantStore.set(ticket.ticketId, {
    ticket,
    reason: matched ? 'client_disabled' : 'no_client',
    clientId: matched?.id ?? null,
    clientName: matched?.name ?? null,
    firstSeenAt: previous?.firstSeenAt ?? now,
    lastSeenAt: now,
  });
  // Maps iterate in insertion order, so the first key is the stalest.
  while (tenantStore.size > MAX_PER_TENANT) {
    const oldest = tenantStore.keys().next().value as string;
    tenantStore.delete(oldest);
  }
}

export function listSkipped(tenantId: string): SkippedTicket[] {
  return [...(store.get(tenantId)?.values() ?? [])].reverse();
}

export function getSkipped(tenantId: string, ticketId: string): SkippedTicket | null {
  return store.get(tenantId)?.get(ticketId) ?? null;
}

export function forgetSkipped(tenantId: string, ticketId: string): void {
  store.get(tenantId)?.delete(ticketId);
}

/** For tests. */
export function clearSkipped(): void {
  store.clear();
}
