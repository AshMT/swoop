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

  constructor(subdomain: string, apiKey: string) {
    const endpoint = `https://${subdomain}.superops.ai/graphql`;
    this.client = new GraphQLClient(endpoint, {
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

  async testConnection(): Promise<boolean> {
    try {
      await this.client.request(TEST_QUERY);
      return true;
    } catch {
      return false;
    }
  }
}
