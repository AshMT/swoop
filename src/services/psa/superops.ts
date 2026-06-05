import { GraphQLClient } from 'graphql-request';
import type { PSAClient } from './interface';
import type { SuperOpsTicket } from '../../types';

// Documented SuperOps GraphQL API (api.superops.ai/msp or euapi.superops.ai/msp)
// Subdomain passed as CustomerSubDomain header, not in URL.
// Fields verified against developer.superops.com/msp

const GET_TICKETS_QUERY = `
  query GetTicketList($input: ListInfoInput!) {
    getTicketList(input: $input) {
      tickets {
        ticketId
        subject
        status
        priority
        createdTime
        client
        requester
      }
      listInfo {
        totalCount
      }
    }
  }
`;

const ADD_NOTE_MUTATION = `
  mutation CreateTicketNote($input: CreateTicketNoteInput!) {
    createTicketNote(input: $input) {
      noteId
      content
      privacyType
    }
  }
`;

// Introspect CreateTicketNoteInput to discover real field names (logged once at startup)
const INTROSPECT_NOTE_INPUT = `
  query IntrospectNoteInput {
    __type(name: "CreateTicketNoteInput") {
      inputFields { name }
    }
  }
`;

// Introspection-safe test — asks for schema metadata, never fails on missing fields
const TEST_QUERY = `
  query TestConnection {
    __schema {
      queryType { name }
    }
  }
`;

export class SuperOpsClient implements PSAClient {
  private client: GraphQLClient;
  readonly endpoint: string;

  constructor(subdomain: string, apiKey: string, region: string = 'us') {
    const baseUrl = region === 'eu'
      ? 'https://euapi.superops.ai/msp'
      : 'https://api.superops.ai/msp';
    this.endpoint = baseUrl;
    this.client = new GraphQLClient(this.endpoint, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        CustomerSubDomain: subdomain.trim(),
        'Content-Type': 'application/json',
      },
    });
  }

  async pollNewTickets(since: number): Promise<SuperOpsTicket[]> {
    // The SuperOps API has no working sort or date filter, and the default sort order
    // does not correlate with createdTime (tickets may be imported with historical dates,
    // putting them on any page). We must scan all pages to find recently-created tickets.
    type ListResult = {
      getTicketList: { tickets: SuperOpsTicket[]; listInfo: { totalCount: number } };
    };
    const PAGE_SIZE = 100;
    const MAX_PAGES = 20; // safety cap — handles accounts up to 2000 tickets
    const OVERLAP_MS = 10 * 60 * 1000;
    const cutoff = since > 0
      ? since - OVERLAP_MS
      : Date.now() - 24 * 60 * 60 * 1000;

    const allTickets: SuperOpsTicket[] = [];
    let totalCount = 0;

    for (let page = 1; page <= MAX_PAGES; page++) {
      const data = await this.client.request<ListResult>(GET_TICKETS_QUERY, {
        input: { page, pageSize: PAGE_SIZE },
      });
      const pageTickets = data.getTicketList?.tickets || [];
      totalCount = data.getTicketList?.listInfo?.totalCount ?? 0;
      allTickets.push(...pageTickets);

      if (allTickets.length >= totalCount || pageTickets.length < PAGE_SIZE) break;
    }

    if (allTickets.length >= MAX_PAGES * PAGE_SIZE && allTickets.length < totalCount) {
      console.warn(`[SuperOps] Hit ${MAX_PAGES}-page cap — ${totalCount - allTickets.length} tickets not scanned`);
    }

    console.log(
      `[SuperOps] Scanned ${allTickets.length}/${totalCount} tickets | cutoff: ${new Date(cutoff).toISOString()} | since: ${since > 0 ? new Date(since).toISOString() : 'first poll (24h)'}`,
    );

    if (allTickets.length > 0) {
      console.log(
        `[SuperOps] Sample createdTime values: ${allTickets.slice(0, 3).map((t) => t.createdTime).join(', ')}`,
      );
    }

    const filtered = allTickets.filter((t) => {
      const ts = t.createdTime ? new Date(t.createdTime).getTime() : 0;
      return ts > cutoff;
    });
    console.log(`[SuperOps] After cutoff filter: ${filtered.length} new ticket(s)`);
    return filtered;
  }

  async logNoteInputFields(): Promise<void> {
    try {
      const data = await this.client.request<{ __type: { inputFields: { name: string }[] } }>(INTROSPECT_NOTE_INPUT);
      const fields = data.__type?.inputFields?.map((f) => f.name) || [];
      console.log('[SuperOps] CreateTicketNoteInput fields:', fields.join(', '));
    } catch {
      // non-critical
    }
  }

  async addTicketNote(ticketId: string, note: string, isPrivate: boolean): Promise<void> {
    await this.client.request(ADD_NOTE_MUTATION, {
      input: {
        // SuperOps uses ticketIdentifier (TicketIdentifierInput) not a flat ticketId field
        ticketIdentifier: { ticketId },
        content: note,
        privacyType: isPrivate ? 'PRIVATE' : 'PUBLIC',
      },
    });
  }

  async testConnection(): Promise<{ ok: boolean; error?: string; endpoint?: string }> {
    try {
      await this.client.request(TEST_QUERY);
      return { ok: true, endpoint: this.endpoint };
    } catch (err: unknown) {
      let message = 'Connection failed';
      if (err && typeof err === 'object') {
        const e = err as Record<string, unknown>;
        if (e.response && typeof e.response === 'object') {
          const r = e.response as Record<string, unknown>;
          if (r.status === 401 || r.status === 403) {
            message = `Authentication failed (HTTP ${r.status}) — check your API token`;
          } else if (r.status === 404) {
            message = `Endpoint not found (HTTP 404) — check your subdomain`;
          } else if (typeof r.status === 'number') {
            message = `HTTP ${r.status} from SuperOps`;
          }
          if (r.errors && Array.isArray(r.errors) && r.errors.length > 0) {
            const gqlErr = r.errors[0] as Record<string, unknown>;
            message += ` — ${gqlErr.message || JSON.stringify(gqlErr)}`;
          }
        } else if (e.code === 'ENOTFOUND' || e.code === 'ECONNREFUSED') {
          message = `Cannot reach ${this.endpoint} — check your subdomain`;
        } else if (typeof e.message === 'string') {
          message = e.message;
        }
      }
      return { ok: false, error: message, endpoint: this.endpoint };
    }
  }
}
