import { GraphQLClient } from 'graphql-request';
import type { PSAClient } from './interface';
import type { SuperOpsTicket, TicketConversation } from '../../types';

// Documented SuperOps GraphQL API (api.superops.ai/msp or euapi.superops.ai/msp)
// Subdomain passed as CustomerSubDomain header, not in URL.
// Fields verified against developer.superops.com/msp

// Preferred query includes the ticket description (body) so the AI can classify
// on full context. If the schema rejects `description`, we permanently fall back
// to the subject-only query for this process lifetime.
const GET_TICKETS_QUERY_WITH_DESC = `
  query GetTicketList($input: ListInfoInput!) {
    getTicketList(input: $input) {
      tickets {
        ticketId
        subject
        description
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

// Conversation thread for a single ticket — used to detect customer replies
// when an action is waiting on more information.
const GET_CONVERSATIONS_QUERY = `
  query GetTicketConversationList($input: ListInfoInput!, $ticketId: ID!) {
    getTicketConversationList(input: $input, ticketId: $ticketId) {
      conversations {
        conversationId
        content
        type
        createdTime
        user
      }
      listInfo {
        totalCount
      }
    }
  }
`;

// Introspect conversation-related queries so logs reveal the real field names
// if our best-guess query shape is rejected.
const INTROSPECT_QUERIES = `
  query IntrospectQueries {
    __schema {
      queryType {
        fields {
          name
          args { name type { name kind ofType { name kind } } }
        }
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

// Process-wide: once the description field is rejected, stop asking for it.
let descriptionSupported: boolean | null = null;
// Process-wide: once the conversation query is rejected, stop using it (log once).
let conversationsSupported: boolean | null = null;

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
      const data = await this.requestTicketPage<ListResult>(page, PAGE_SIZE);
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

  // Fetch one page of tickets, preferring the description-inclusive query.
  // Falls back (permanently for this process) if the schema rejects `description`.
  private async requestTicketPage<T>(page: number, pageSize: number): Promise<T> {
    const input = { page, pageSize };
    if (descriptionSupported !== false) {
      try {
        const data = await this.client.request<T>(GET_TICKETS_QUERY_WITH_DESC, { input });
        if (descriptionSupported === null) {
          descriptionSupported = true;
          console.log('[SuperOps] Ticket description field supported — classifying on full ticket body');
        }
        return data;
      } catch (err) {
        if (descriptionSupported === null) {
          descriptionSupported = false;
          console.warn('[SuperOps] Ticket description not available in getTicketList — falling back to subject-only:',
            err instanceof Error ? err.message.slice(0, 200) : err);
        } else {
          throw err; // description was supported before — this is a real error
        }
      }
    }
    return this.client.request<T>(GET_TICKETS_QUERY, { input });
  }

  /**
   * Fetch the conversation thread for a ticket (replies + notes), oldest first.
   * Returns [] if the API doesn't support the query shape — logged once with
   * schema introspection output so the real field names can be identified.
   */
  async getTicketConversations(ticketId: string): Promise<TicketConversation[]> {
    if (conversationsSupported === false) return [];
    type ConvResult = {
      getTicketConversationList: {
        conversations: TicketConversation[];
        listInfo: { totalCount: number };
      };
    };
    try {
      const data = await this.client.request<ConvResult>(GET_CONVERSATIONS_QUERY, {
        input: { page: 1, pageSize: 100 },
        ticketId,
      });
      conversationsSupported = true;
      return data.getTicketConversationList?.conversations || [];
    } catch (err) {
      if (conversationsSupported === null) {
        conversationsSupported = false;
        console.warn('[SuperOps] Conversation query rejected — reply monitoring disabled:',
          err instanceof Error ? err.message.slice(0, 300) : err);
        void this.logConversationQueryShapes();
      }
      return [];
    }
  }

  // Log every query whose name mentions conversation/note/reply, with its args,
  // so a rejected conversation query can be corrected from the logs.
  private async logConversationQueryShapes(): Promise<void> {
    try {
      type ArgInfo = { name: string; type: { name: string | null; kind: string; ofType: { name: string | null; kind: string } | null } };
      type FieldInfo = { name: string; args: ArgInfo[] };
      const data = await this.client.request<{ __schema: { queryType: { fields: FieldInfo[] } } }>(INTROSPECT_QUERIES);
      const relevant = (data.__schema?.queryType?.fields || [])
        .filter((f) => /conversation|note|reply|comment/i.test(f.name));
      for (const f of relevant) {
        const args = f.args.map((a) => {
          const t = a.type.ofType ?? a.type;
          return `${a.name}: ${t.name ?? a.type.kind}`;
        }).join(', ');
        console.log(`[SuperOps] Available query: ${f.name}(${args})`);
      }
    } catch {
      // non-critical
    }
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
