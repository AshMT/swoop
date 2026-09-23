import './setup-env';
import { describe, expect, it } from 'vitest';
import { probeCapabilities } from '../src/services/psa/capabilities';
import { buildListQuery, extractTickets, literal, parseTimestamp, EnumLiteral } from '../src/services/psa/superops';
import { buildFakeSchema, fakeGraphQLClient } from './fixtures/superops-schema';

const ENDPOINT = 'https://api.superops.ai/msp';

async function probe(options = {}) {
  const schema = buildFakeSchema(options);
  return probeCapabilities(fakeGraphQLClient(schema), ENDPOINT);
}

describe('probeCapabilities', () => {
  it('discovers the list query, ticket fields and note mutation', async () => {
    const caps = await probe();

    expect(caps.listQuery).toBe('getTicketList');
    expect(caps.listArgName).toBe('input');
    expect(caps.listResultField).toBe('tickets');
    expect(caps.listInputType).toBe('ListInfoInput');
    expect(caps.ticketType).toBe('Ticket');
    expect(caps.idField).toBe('ticketId');
    expect(caps.displayIdField).toBe('displayId');
    expect(caps.subjectField).toBe('subject');
    expect(caps.createdField).toBe('createdTime');
    expect(caps.noteMutation).toBe('createNote');
    expect(caps.warnings).toEqual([]);
  });

  // The whole point of the probe: the ticket body is what the classifier needs,
  // and previous versions shipped with it hardcoded to an empty string.
  it('finds the ticket body field', async () => {
    expect((await probe()).bodyField).toBe('description');
  });

  it('finds the body under an alternative name', async () => {
    for (const name of ['ticketBody', 'details', 'content']) {
      const caps = await probe({ bodyField: name });
      expect(caps.bodyField, name).toBe(name);
    }
  });

  it('warns loudly when no body field exists at all, listing the fields it saw', async () => {
    const caps = await probe({ bodyField: null });
    expect(caps.bodyField).toBeNull();
    expect(caps.warnings.join(' ')).toMatch(/subject line only/i);
    expect(caps.warnings.join(' ')).toMatch(/Ticket fields: ticketId, displayId, subject/);
  });

  it('finds a body field by meaning when its name is not on the list', async () => {
    const caps = await probe({ bodyField: 'problemDescription' });
    expect(caps.bodyField).toBe('problemDescription');
  });

  it('reads a body held inside an object', async () => {
    const caps = await probe({ bodyField: 'description', bodyObject: true });
    expect(caps).toMatchObject({ bodyField: 'description', bodySubField: 'content' });
  });

  // SuperOps keeps the requester's message in the ticket's conversations, not
  // on the ticket, so a schema with no body field must not mean no body.
  it('falls back to the ticket conversation thread when the ticket has no body', async () => {
    for (const shape of ['list', 'wrapped'] as const) {
      const caps = await probe({ bodyField: null, conversations: shape });
      expect(caps.bodyField, shape).toBeNull();
      expect(caps, shape).toMatchObject({
        conversationQuery: 'getTicketConversationList',
        conversationArgName: 'input',
        conversationArgIdField: 'ticketId',
        conversationResultField: shape === 'wrapped' ? 'conversations' : null,
        conversationContentField: 'content',
        conversationTimeField: 'time',
      });
      expect(caps.warnings.join(' '), shape).not.toMatch(/subject line only/i);
    }
  });

  it('reads a fully wrapped list return type', async () => {
    const caps = await probe({ bodyField: null, conversations: 'deep' });
    expect(caps).toMatchObject({ conversationQuery: 'getTicketConversationList', conversationContentField: 'content' });
  });

  it('uses the documented shape when the entry type cannot be introspected', async () => {
    const caps = await probe({ bodyField: null, conversations: 'opaque' });
    expect(caps).toMatchObject({
      conversationQuery: 'getTicketConversationList',
      conversationArgIdField: 'ticketId',
      conversationContentField: 'content',
      conversationTimeField: 'time',
    });
    expect(caps.warnings.join(' ')).not.toMatch(/subject line only/i);
  });

  it('says why a conversation query it found could not be used', async () => {
    const caps = await probe({ bodyField: null, conversations: 'textless' });
    expect(caps.conversationQuery).toBeNull();
    expect(caps.warnings.join(' ')).toMatch(/passed over getTicketConversationList \(its entries have no text field \(has: conversationId\)\)/);
  });

  it('lists the schema’s ticket queries when it finds no conversation query', async () => {
    const caps = await probe({ bodyField: null });
    expect(caps.warnings.join(' ')).toMatch(/Ticket queries on this schema: getTicketList, getTicket\./);
  });

  // A real EU schema: getTicketConversation fetches one message by its own id.
  it('passes over a single-message lookup and says why', async () => {
    const caps = await probe({ bodyField: null, singleConversation: true });
    expect(caps.conversationQuery).toBeNull();
    const warning = caps.warnings.join(' ');
    expect(warning).toMatch(/passed over getTicketConversation \(needs conversationId, not a ticket id\)/);
    expect(warning).toMatch(/Ticket queries on this schema: getTicketList, getTicket, getTicketConversation\./);
  });

  it('uses the ticket thread when a single-message lookup sits beside it', async () => {
    const caps = await probe({ bodyField: null, singleConversation: true, conversations: 'list' });
    expect(caps).toMatchObject({ conversationQuery: 'getTicketConversationList', conversationArgIdField: 'ticketId' });
  });

  it('prefers a body on the ticket over the conversation thread', async () => {
    const caps = await probe({ conversations: 'list' });
    expect(caps.bodyField).toBe('description');
    expect(caps.conversationQuery).toBeNull();
  });

  it('resolves an object-shaped client into id and label sub-fields', async () => {
    const caps = await probe({ clientShape: 'object' });
    expect(caps.client.shape).toBe('object');
    expect(caps.client.fieldName).toBe('client');
    expect(caps.client.idField).toBe('accountId');
    expect(caps.client.labelField).toBe('name');
    // Nested objects cannot be selected without a sub-selection we cannot guess.
    expect(caps.client.subFields).not.toContain('primaryContact');
  });

  it('handles a client returned as a bare string', async () => {
    const caps = await probe({ clientShape: 'leaf' });
    expect(caps.client.shape).toBe('leaf');
    expect(caps.client.subFields).toEqual([]);
  });

  it('warns when the ticket has no client field to match on', async () => {
    const caps = await probe({ clientShape: 'missing' });
    expect(caps.client.shape).toBe('missing');
    expect(caps.warnings.join(' ')).toMatch(/cannot be matched/i);
  });

  it('discovers the newer createNote workItem addressing', async () => {
    const caps = await probe({ noteStyle: 'createNote' });
    expect(caps.noteMutation).toBe('createNote');
    expect(caps.noteWorkItemField).toBe('workItem');
    expect(caps.noteWorkItemFields).toEqual(['workId', 'module']);
    expect(caps.noteContentField).toBe('content');
    expect(caps.noteVisibilityField).toBe('privacyType');
  });

  it('falls back to the older createTicketNote shape', async () => {
    const caps = await probe({ noteStyle: 'createTicketNote' });
    expect(caps.noteMutation).toBe('createTicketNote');
    expect(caps.noteWorkItemField).toBeNull();
    expect(caps.noteTicketField).toBe('ticketIdentifier');
    expect(caps.noteTicketIdField).toBe('ticketId');
  });

  it('warns rather than throwing when no note mutation exists', async () => {
    const caps = await probe({ noteStyle: 'none' });
    expect(caps.noteMutation).toBeNull();
    expect(caps.warnings.join(' ')).toMatch(/cannot write proposals back/i);
    // Reading still works, which is the important part.
    expect(caps.listQuery).toBe('getTicketList');
  });

  it('builds a sort clause when the sort input has a recognisable shape', async () => {
    const caps = await probe({ sort: 'supported' });
    expect(caps.sortFieldNames).toEqual({ attribute: 'attribute', order: 'order' });
    expect(caps.sortClause).toEqual({ attribute: 'createdTime', order: 'DESC' });
  });

  it('skips sorting, with a warning, when the sort input is unrecognisable', async () => {
    const caps = await probe({ sort: 'unrecognised' });
    expect(caps.sortClause).toBeNull();
    expect(caps.warnings.join(' ')).toMatch(/unrecognised shape/i);
  });

  it('skips sorting when the schema has no sort field', async () => {
    expect((await probe({ sort: 'absent' })).sortClause).toBeNull();
  });

  it('discovers the detail query and its identifier field', async () => {
    const caps = await probe();
    expect(caps.detailQuery).toBe('getTicket');
    expect(caps.detailArgName).toBe('input');
    expect(caps.detailArgIdField).toBe('ticketId');
  });

  it('copes with no detail query at all', async () => {
    const caps = await probe({ detailQuery: false });
    expect(caps.detailQuery).toBeNull();
    expect(caps.listQuery).toBe('getTicketList');
  });

  // Without this, an operator has to find each company ID in SuperOps by hand.
  it('discovers the client list query so the UI can offer a picker', async () => {
    const caps = await probe({ clientList: 'wrapped' });
    expect(caps.clientListQuery).toBe('getClientList');
    expect(caps.clientListResultField).toBe('clients');
    expect(caps.clientListIdField).toBe('accountId');
    expect(caps.clientListNameField).toBe('name');
  });

  it('disables the picker, with a warning, when the client fields are unresolvable', async () => {
    const caps = await probe({ clientList: 'unusable' });
    expect(caps.clientListQuery).toBeNull();
    expect(caps.warnings.join(' ')).toMatch(/client picker is unavailable/i);
    // The allowlist still works with a typed ID, so this is not fatal.
    expect(caps.listQuery).toBe('getTicketList');
  });

  it('copes with no client list query at all', async () => {
    const caps = await probe({ clientList: 'absent' });
    expect(caps.clientListQuery).toBeNull();
    expect(caps.listQuery).toBe('getTicketList');
  });
});

describe('buildListQuery', () => {
  it('selects only fields the schema actually has', async () => {
    const query = buildListQuery(await probe());
    expect(query).toContain('getTicketList(input: $input)');
    expect(query).toContain('query SwoopTicketList($input: ListInfoInput!)');
    expect(query).toContain('ticketId');
    expect(query).toContain('client { accountId name }');
    // Notably absent: the guessed `description` field on the list query that
    // previously broke every poll.
    expect(query).not.toContain('technician');
  });

  it('selects a scalar client without a sub-selection', async () => {
    const query = buildListQuery(await probe({ clientShape: 'leaf' }));
    expect(query).toMatch(/^\s*client$/m);
    expect(query).not.toContain('client {');
  });

  it('omits the client entirely when the schema has none', async () => {
    expect(buildListQuery(await probe({ clientShape: 'missing' }))).not.toContain('client');
  });
});

describe('extractTickets', () => {
  it('normalises an object-shaped payload', async () => {
    const caps = await probe();
    const tickets = extractTickets(
      {
        getTicketList: {
          tickets: [
            {
              ticketId: 'T-1',
              displayId: '1042',
              subject: 'Password reset',
              status: 'Open',
              priority: 'High',
              createdTime: '2026-09-01T10:00:00Z',
              description: '<p>Please reset <b>my</b> password.</p>',
              client: { accountId: 'acct-9', name: 'Acme Corp' },
              requester: { userId: 'u-1', email: 'Sarah@Acme.com', name: 'Sarah Jones' },
            },
          ],
        },
      },
      caps,
    );

    expect(tickets).toHaveLength(1);
    const [ticket] = tickets;
    expect(ticket.ticketId).toBe('T-1');
    expect(ticket.displayId).toBe('1042');
    expect(ticket.clientId).toBe('acct-9');
    expect(ticket.clientName).toBe('Acme Corp');
    expect(ticket.requesterEmail).toBe('Sarah@Acme.com');
    // HTML is converted before it reaches the model.
    expect(ticket.body).toBe('Please reset my password.');
    expect(ticket.createdAt).toBe(Math.floor(Date.parse('2026-09-01T10:00:00Z') / 1000));
  });

  it('normalises a scalar-shaped client', async () => {
    const caps = await probe({ clientShape: 'leaf' });
    const [ticket] = extractTickets(
      { getTicketList: { tickets: [{ ticketId: 'T-2', subject: 's', client: 'Acme Corp', requester: 'a@b.com' }] } },
      caps,
    );
    expect(ticket.clientId).toBeNull();
    expect(ticket.clientName).toBe('Acme Corp');
    expect(ticket.requesterEmail).toBe('a@b.com');
  });

  it('returns an empty array for a malformed payload rather than throwing', async () => {
    const caps = await probe();
    expect(extractTickets({}, caps)).toEqual([]);
    expect(extractTickets({ getTicketList: { tickets: null } }, caps)).toEqual([]);
    expect(extractTickets({ getTicketList: { tickets: [null, undefined] } }, caps)).toEqual([]);
  });
});

describe('parseTimestamp', () => {
  it('parses ISO strings', () => {
    expect(parseTimestamp('2026-09-01T10:00:00Z')).toBe(1788256800);
  });

  it('parses epoch seconds', () => {
    expect(parseTimestamp(1788256800)).toBe(1788256800);
  });

  // SuperOps has returned createdTime as epoch millis in some responses, which
  // would otherwise land the ticket 55,000 years in the future and never expire
  // out of the poll window.
  it('parses epoch milliseconds', () => {
    expect(parseTimestamp(1788256800000)).toBe(1788256800);
  });

  it('parses a numeric string', () => {
    expect(parseTimestamp('1788256800')).toBe(1788256800);
  });

  it('returns null for anything unparseable', () => {
    expect(parseTimestamp(null)).toBeNull();
    expect(parseTimestamp('')).toBeNull();
    expect(parseTimestamp('not a date')).toBeNull();
    expect(parseTimestamp({})).toBeNull();
  });
});

describe('literal', () => {
  it('escapes strings so ticket content cannot break out of the query', () => {
    expect(literal('a "quoted" value')).toBe('"a \\"quoted\\" value"');
    expect(literal('line\nbreak')).toBe('"line\\nbreak"');
    // The classic injection attempt against a naively interpolated query: the
    // payload survives as text, but every quote that would have closed the
    // literal is escaped, so it stays one string argument.
    const injection = literal('") { __typename } mutation evil { deleteEverything(x: "');
    expect(injection.startsWith('"')).toBe(true);
    expect(injection.endsWith('"')).toBe(true);
    expect(JSON.parse(injection)).toBe('") { __typename } mutation evil { deleteEverything(x: "');
  });

  it('emits enums unquoted and everything else as JSON', () => {
    expect(literal(new EnumLiteral('PRIVATE'))).toBe('PRIVATE');
    expect(literal(42)).toBe('42');
    expect(literal(true)).toBe('true');
    expect(literal(null)).toBe('null');
  });

  it('emits objects with unquoted keys, as GraphQL requires', () => {
    expect(literal({ workId: 'T-1', module: new EnumLiteral('TICKET') })).toBe(
      '{workId: "T-1", module: TICKET}',
    );
  });

  it('omits undefined members', () => {
    expect(literal({ a: 1, b: undefined })).toBe('{a: 1}');
  });
});

describe('reading the ticket body', () => {
  // graphql-request brings its own fetch, so the transport is replaced on the
  // client itself rather than stubbed globally.
  async function clientFor(options: Parameters<typeof buildFakeSchema>[0], respond: (query: string) => unknown) {
    const { SuperOpsClient } = await import('../src/services/psa/superops');
    const capabilities = await probe(options);
    const sent: string[] = [];
    const client = new SuperOpsClient({ subdomain: 'msp', apiKey: 'k', capabilities });
    (client as unknown as { client: { request: (req: { document: string }) => Promise<unknown> } }).client = {
      request: async ({ document }) => {
        sent.push(document);
        return respond(document);
      },
    };
    return { client, sent };
  }

  const bare = { ticketId: 'T-1', displayId: '1', subject: 'Locked out', body: '', status: null, priority: null, createdAt: null, clientId: null, clientName: null, requesterEmail: null, requesterName: null };

  it('takes the earliest conversation entry, as text', async () => {
    const { client, sent } = await clientFor({ bodyField: null, conversations: 'wrapped' }, () => ({
      getTicketConversationList: {
        conversations: [
          { content: '<p>Thanks, trying now</p>', time: '2026-09-23T10:05:00Z' },
          { content: '<p>I am <b>locked out</b> of Outlook</p>', time: '2026-09-23T09:00:00Z' },
        ],
      },
    }));
    const enriched = await client.enrichTicket({ ...bare });
    expect(enriched.body).toBe('I am locked out of Outlook');
    expect(sent[0]).toContain('getTicketConversationList(input: {ticketId: "T-1"})');
    expect(sent[0]).toContain('conversations { content time }');
  });

  it('reads a body nested in an object', async () => {
    const { client, sent } = await clientFor({ bodyObject: true }, () => ({
      getTicket: { ticketId: 'T-1', description: { content: '<div>Printer offline</div>' } },
    }));
    expect((await client.enrichTicket({ ...bare })).body).toBe('Printer offline');
    expect(sent[0]).toContain('description { content }');
  });

  it('leaves the ticket alone when the conversation query fails', async () => {
    const { client } = await clientFor({ bodyField: null, conversations: 'list' }, () => {
      throw new Error('Field required: listInfo');
    });
    expect((await client.enrichTicket({ ...bare })).body).toBe('');
  });

  it('proves the body source on the newest ticket during the connection test', async () => {
    const { SuperOpsClient } = await import('../src/services/psa/superops');
    const introspection = fakeGraphQLClient(buildFakeSchema({ bodyField: null, conversations: 'list' }));
    const client = new SuperOpsClient({ subdomain: 'msp', apiKey: 'k' });
    (client as unknown as { client: { request: (req: unknown, vars?: Record<string, unknown>) => Promise<unknown> } }).client = {
      // The probe calls request(document, variables); reads call request({ document, variables }).
      request: async (req, vars) => {
        const { document, variables } = typeof req === 'string' ? { document: req, variables: vars } : (req as { document: string; variables?: Record<string, unknown> });
        if (document.includes('SwoopTicketList')) return { getTicketList: { tickets: [{ ticketId: 'T-9', displayId: '1009', subject: 'VPN down' }] } };
        if (document.includes('SwoopTicketConversations')) {
          expect(document).toContain('ticketId: "T-9"');
          return { getTicketConversationList: [{ content: '<p>The VPN will not connect since this morning.</p>', time: '2026-09-23T08:00:00Z' }] };
        }
        return introspection.request(document, variables);
      },
    };
    const result = await client.testConnection();
    expect(result.bodyCheck).toEqual({ ticket: '#1009', characters: 44, preview: 'The VPN will not connect since this morning.' });
  });

  it('reports a body source that fails on real data', async () => {
    const { SuperOpsClient } = await import('../src/services/psa/superops');
    const introspection = fakeGraphQLClient(buildFakeSchema({ bodyField: null, conversations: 'list' }));
    const client = new SuperOpsClient({ subdomain: 'msp', apiKey: 'k' });
    (client as unknown as { client: { request: (req: unknown, vars?: Record<string, unknown>) => Promise<unknown> } }).client = {
      // The probe calls request(document, variables); reads call request({ document, variables }).
      request: async (req, vars) => {
        const { document, variables } = typeof req === 'string' ? { document: req, variables: vars } : (req as { document: string; variables?: Record<string, unknown> });
        if (document.includes('SwoopTicketList')) return { getTicketList: { tickets: [{ ticketId: 'T-9', displayId: '1009' }] } };
        if (document.includes('SwoopTicketConversations')) throw new Error('Not authorised to read conversations');
        return introspection.request(document, variables);
      },
    };
    const result = await client.testConnection();
    expect(result.bodyCheck).toMatchObject({ ticket: '#1009', error: expect.stringMatching(/Not authorised/) });
  });
});
