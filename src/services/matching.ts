import type { Client } from '../types';
import type { PsaTicket } from './psa/interface';

/**
 * Resolves a ticket to an allowlisted client.
 *
 * The previous implementation compared `client.superopsCompanyId` against the
 * ticket's client *name*, so an ID-configured client could never match and the
 * allowlist silently dropped every ticket. Match on the id and the name
 * independently, preferring the id because names get renamed.
 */
export function matchTicketToClient(ticket: PsaTicket, candidates: readonly Client[]): Client | null {
  const ticketClientId = normalise(ticket.clientId);
  const ticketClientName = normalise(ticket.clientName);

  if (ticketClientId) {
    const byId = candidates.find((c) => normalise(c.superopsCompanyId) === ticketClientId);
    if (byId) return byId;
  }

  // A SuperOps schema that returns `client` as a bare string gives us a name in
  // clientName, but operators sometimes paste that same string into the company
  // ID field, so check both configured fields against it.
  if (ticketClientName) {
    const byName = candidates.find(
      (c) => normalise(c.name) === ticketClientName || normalise(c.superopsCompanyId) === ticketClientName,
    );
    if (byName) return byName;
  }

  return null;
}

function normalise(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

/** Why a ticket was skipped, for the poll summary. */
export type SkipReason =
  | 'already-processed'
  | 'awaiting-retry'
  /** Retried to the attempt limit and given up on — not the same as done. */
  | 'gave-up'
  | 'client-not-enabled'
  | 'no-ticket-id';

export type PollOutcome = 'ok' | 'degraded' | 'error' | 'paused' | 'idle';

export interface PollSummary {
  /** What happened overall, so a caller need not infer it from the counts. */
  outcome: PollOutcome;
  /** Populated for 'error', 'degraded' and 'idle'. */
  error: string | null;
  fetched: number;
  classified: number;
  failed: number;
  skipped: Record<SkipReason, number>;
}

export function emptySummary(): PollSummary {
  return {
    outcome: 'ok',
    error: null,
    fetched: 0,
    classified: 0,
    failed: 0,
    skipped: {
      'already-processed': 0,
      'awaiting-retry': 0,
      'gave-up': 0,
      'client-not-enabled': 0,
      'no-ticket-id': 0,
    },
  };
}
