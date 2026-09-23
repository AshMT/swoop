import type { PsaCapabilities } from './capabilities';

/** A ticket normalised away from whatever shape the PSA happened to return. */
export interface PsaTicket {
  /** The identifier used for API calls and deduplication. */
  ticketId: string;
  /** The number a human sees, used for deep links. Falls back to ticketId. */
  displayId: string | null;
  subject: string;
  /** Plain text. HTML from the PSA is converted before it reaches here. */
  body: string;
  status: string | null;
  priority: string | null;
  /** Unix seconds, or null when the PSA exposes no creation timestamp. */
  createdAt: number | null;
  clientId: string | null;
  clientName: string | null;
  requesterEmail: string | null;
  requesterName: string | null;
}

export interface ConnectionTestResult {
  ok: boolean;
  endpoint: string;
  error?: string;
  /** Present when the probe ran, so the UI can show what was discovered. */
  capabilities?: PsaCapabilities;
  /** The body read from the newest ticket, proving the body source works on real data. */
  bodyCheck?: { ticket: string; characters: number; preview: string } | { ticket: string | null; error: string };
}

/** A client (company) as the PSA knows it, for the allowlist picker. */
export interface PsaCompany {
  id: string;
  name: string;
}

export interface PSAClient {
  readonly endpoint: string;
  /** Tickets created after `sinceUnixSeconds`, newest first where supported. */
  pollNewTickets(sinceUnixSeconds: number): Promise<PsaTicket[]>;
  /** Fills in fields the list query does not project, notably the body. */
  enrichTicket(ticket: PsaTicket): Promise<PsaTicket>;
  addTicketNote(ticketId: string, note: string, isPrivate: boolean): Promise<void>;
  /** The MSP's clients, or null when this schema exposes no way to list them. */
  listCompanies(): Promise<PsaCompany[] | null>;
  testConnection(): Promise<ConnectionTestResult>;
  /** Browser URL for a ticket, for dashboard deep links. */
  ticketUrl(ticket: Pick<PsaTicket, 'ticketId' | 'displayId'>): string;
}
