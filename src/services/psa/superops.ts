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
      inputFields {
        name
        type { name kind ofType { name kind } }
      }
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

  async pollNewTickets(_since: number): Promise<SuperOpsTicket[]> {
    // SuperOps has no reliable sort or date filter, and sort order is inconsistent —
    // new tickets can appear on any page. We scan all pages and return every ticket.
    // The processedTickets dedup table in poller.ts is the sole gate against
    // reprocessing: a ticket is "new" if its ID has never been seen before.
    type ListResult = {
      getTicketList: { tickets: SuperOpsTicket[]; listInfo: { totalCount: number } };
    };
    const PAGE_SIZE = 100;
    const MAX_PAGES = 20; // safety cap — handles accounts up to 2000 tickets

    const allTickets: SuperOpsTicket[] = [];
    let totalCount = 0;

    for (let page = 1; page <= MAX_PAGES; page++) {
      const data = await this.client.request<ListResult>(GET_TICKETS_QUERY, {
        input: { page, pageSize: PAGE_SIZE },
      });
      const pageTickets = data.getTicketList?.tickets || [];
      totalCount = data.getTicketList?.listInfo?.totalCount ?? 0;
      allTickets.push(...pageTickets);

      const lastPage = Math.ceil(totalCount / PAGE_SIZE);
      console.log(`[SuperOps] Fetched page ${page}/${lastPage} — ${pageTickets.length} tickets`);

      if (allTickets.length >= totalCount || pageTickets.length < PAGE_SIZE) break;
    }

    if (allTickets.length < totalCount) {
      console.warn(`[SuperOps] Hit ${MAX_PAGES}-page cap — ${totalCount - allTickets.length} tickets not scanned`);
    }

    console.log(`[SuperOps] Scanned ${allTickets.length}/${totalCount} total — dedup table determines what is new`);
    return allTickets;
  }

  async logNoteInputFields(): Promise<void> {
    try {
      type FieldInfo = { name: string; type: { name: string | null; kind: string; ofType: { name: string | null; kind: string } | null } };
      const data = await this.client.request<{ __type: { inputFields: FieldInfo[] } }>(INTROSPECT_NOTE_INPUT);
      const fields = (data.__type?.inputFields || []).map((f) => {
        const t = f.type.ofType ?? f.type;
        return `${f.name}: ${t.name ?? f.type.kind}`;
      });
      console.log('[SuperOps] CreateTicketNoteInput fields:', fields.join(', '));
    } catch {
      // non-critical
    }
  }

  async addTicketNote(ticketId: string, note: string, isPrivate: boolean): Promise<void> {
    await this.client.request(ADD_NOTE_MUTATION, {
      input: {
        // Field is "ticket" per CreateTicketNoteInput introspection (not "ticketIdentifier")
        ticket: { ticketId },
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
