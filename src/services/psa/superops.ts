import { GraphQLClient } from 'graphql-request';
import type { PSAClient } from './interface';
import type { SuperOpsTicket } from '../../types';

// NOTE: SuperOps GraphQL field names are approximations based on their API conventions.
// If queries fail, verify field names against: https://{subdomain}.superops.ai/graphql (introspection)
// or the SuperOps API documentation. Common adjustments needed:
//   - 'description' may be 'ticketBody' or 'body'
//   - 'requesterEmail' may be nested as 'requester { email }'
//   - 'companyId' may be 'clientId' or nested as 'company { id }'

const GET_TICKETS_QUERY = `
  query GetNewTickets($createdAfter: String, $limit: Int) {
    tickets(
      filter: { createdAfter: $createdAfter }
      limit: $limit
      sort: { field: "createdAt", order: "asc" }
    ) {
      id
      subject
      description
      requesterEmail
      companyId
      companyName
      status
      createdAt
    }
  }
`;

const ADD_NOTE_MUTATION = `
  mutation AddTicketNote($ticketId: String!, $note: String!, $isPrivate: Boolean!) {
    addTicketNote(ticketId: $ticketId, note: $note, isPrivate: $isPrivate) {
      id
    }
  }
`;

const TEST_QUERY = `
  query TestConnection {
    tickets(limit: 1) {
      id
    }
  }
`;

export class SuperOpsClient implements PSAClient {
  private client: GraphQLClient;
  readonly endpoint: string;

  constructor(subdomain: string, apiKey: string) {
    // Strip protocol and any path, keeping only the hostname
    const host = subdomain
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '')
      .trim();
    // If it already contains a dot it's a custom domain (e.g. mighty.it),
    // otherwise treat it as a superops.ai subdomain (e.g. mightyit → mightyit.superops.ai)
    this.endpoint = host.includes('.')
      ? `https://${host}/graphql`
      : `https://${host}.superops.ai/graphql`;
    this.client = new GraphQLClient(this.endpoint, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });
  }

  async pollNewTickets(since: number): Promise<SuperOpsTicket[]> {
    // Convert Unix timestamp (ms) to ISO string for the API
    const createdAfter = since > 0
      ? new Date(since).toISOString()
      : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); // default: last 24h on first poll

    const data = await this.client.request<{ tickets: SuperOpsTicket[] }>(GET_TICKETS_QUERY, {
      createdAfter,
      limit: 100,
    });

    return data.tickets || [];
  }

  async addTicketNote(ticketId: string, note: string, isPrivate: boolean): Promise<void> {
    await this.client.request(ADD_NOTE_MUTATION, {
      ticketId,
      note,
      isPrivate,
    });
  }

  async testConnection(): Promise<{ ok: boolean; error?: string; endpoint?: string }> {
    try {
      await this.client.request(TEST_QUERY);
      return { ok: true, endpoint: this.endpoint };
    } catch (err: unknown) {
      let message = 'Connection failed';
      if (err && typeof err === 'object') {
        // graphql-request wraps HTTP errors
        const e = err as Record<string, unknown>;
        if (e.response && typeof e.response === 'object') {
          const r = e.response as Record<string, unknown>;
          if (r.status === 401 || r.status === 403) {
            message = `Authentication failed (HTTP ${r.status}) — check your API token`;
          } else if (r.status === 404) {
            message = `Endpoint not found (HTTP 404) — check your subdomain: ${this.endpoint}`;
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
