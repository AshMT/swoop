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

  it('warns loudly when no body field exists at all', async () => {
    const caps = await probe({ bodyField: null });
    expect(caps.bodyField).toBeNull();
    expect(caps.warnings.join(' ')).toMatch(/subject line only/i);
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
