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

// Introspect ListInfoInput to discover sort/filter field names
const INTROSPECT_LIST_INPUT = `
  query IntrospectListInput {
    __type(name: "ListInfoInput") {
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
    // Fetch newest 100 tickets, sorted descending so page 1 is always the most recent.
    // Try sortBy/sortOrder first (most common GraphQL convention). If those field names are
    // invalid the API will throw a validation error — we catch it and fall back to no sort
    // (which returns oldest-first, only useful when the account has <100 tickets total).
    type ListResult = { getTicketList: { tickets: SuperOpsTicket[]; listInfo: { totalCount: number } } };
    let data: ListResult;
    try {
      data = await this.client.request<ListResult>(GET_TICKETS_QUERY, {
        input: { page: 1, pageSize: 100, sortColumn: 'createdTime', sortOrder: 'DESC' },
      });
      console.log('[SuperOps] Sort DESC applied (sortColumn/sortOrder)');
    } catch (sortErr) {
      console.warn('[SuperOps] sortColumn/sortOrder rejected, falling back to default sort:', (sortErr as Error).message?.slice(0, 120));
      data = await this.client.request<ListResult>(GET_TICKETS_QUERY, {
        input: { page: 1, pageSize: 100 },
      });
    }

    const tickets = data.getTicketList?.tickets || [];

    const OVERLAP_MS = 10 * 60 * 1000;
    const cutoff = since > 0
      ? since - OVERLAP_MS
      : Date.now() - 24 * 60 * 60 * 1000;

    console.log(
      `[SuperOps] Raw tickets from API: ${tickets.length} | cutoff: ${new Date(cutoff).toISOString()} | since: ${since > 0 ? new Date(since).toISOString() : 'first poll (24h)'}`,
    );
    if (tickets.length > 0) {
      console.log(
        `[SuperOps] Sample createdTime values: ${tickets.slice(0, 3).map((t) => t.createdTime).join(', ')}`,
      );
    }

    return tickets.filter((t) => {
      const ts = t.createdTime ? new Date(t.createdTime).getTime() : 0;
      return ts > cutoff;
    });
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

  async logListInputFields(): Promise<void> {
    try {
      const data = await this.client.request<{ __type: { inputFields: { name: string }[] } }>(INTROSPECT_LIST_INPUT);
      const fields = data.__type?.inputFields?.map((f) => f.name) || [];
      console.log('[SuperOps] ListInfoInput fields:', fields.join(', '));
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
