/**
 * A stand-in SuperOps GraphQL endpoint for the capability probe.
 *
 * Built as a mutable schema description so tests can present the probe with the
 * shapes this integration has actually hit in the wild: a `client` that is
 * sometimes a string and sometimes an object, a ticket body under one of
 * several names or missing entirely, and either the newer `createNote` or the
 * older `createTicketNote` mutation.
 */

export interface FakeField {
  name: string;
  type: FakeTypeRef;
  args?: Array<{ name: string; type: FakeTypeRef }>;
}

export interface FakeTypeRef {
  kind: string;
  name: string | null;
  ofType?: FakeTypeRef | null;
}

export const scalar = (name = 'String'): FakeTypeRef => ({ kind: 'SCALAR', name });
export const object = (name: string): FakeTypeRef => ({ kind: 'OBJECT', name });
export const input = (name: string): FakeTypeRef => ({ kind: 'INPUT_OBJECT', name });
export const list = (of: FakeTypeRef): FakeTypeRef => ({ kind: 'LIST', name: null, ofType: of });
export const nonNull = (of: FakeTypeRef): FakeTypeRef => ({ kind: 'NON_NULL', name: null, ofType: of });

export interface FakeType {
  name: string;
  kind: string;
  fields?: FakeField[];
  inputFields?: FakeField[];
}

export interface FakeSchema {
  queryFields: FakeField[];
  mutationFields: FakeField[];
  types: Record<string, FakeType>;
}

export interface SchemaOptions {
  /** Field name for the ticket body, or null to omit it entirely. */
  bodyField?: string | null;
  /** Whether `client` and `requester` are nested objects or bare strings. */
  clientShape?: 'object' | 'leaf' | 'missing';
  /** Which note mutation the schema exposes. */
  noteStyle?: 'createNote' | 'createTicketNote' | 'none';
  /** Whether ListInfoInput advertises a usable sort. */
  sort?: 'supported' | 'unrecognised' | 'absent';
  /** Whether a single-ticket detail query exists. */
  detailQuery?: boolean;
  /**
   * Shape of the client list query: 'wrapped' returns { clients { ... } },
   * 'unusable' returns a payload whose id field cannot be resolved, and
   * 'absent' omits the query entirely.
   */
  clientList?: 'wrapped' | 'unusable' | 'absent';
  /**
   * A per-ticket conversation query, where SuperOps keeps the original message:
   * 'list' returns [TicketConversation] directly, 'wrapped' returns
   * { conversations { ... } }, 'none' omits it.
   */
  conversations?: 'list' | 'wrapped' | 'none';
  /** Put the body inside an object, as description { content }. */
  bodyObject?: boolean;
}

export function buildFakeSchema(options: SchemaOptions = {}): FakeSchema {
  const {
    bodyField = 'description',
    clientShape = 'object',
    noteStyle = 'createNote',
    sort = 'supported',
    detailQuery = true,
    clientList = 'wrapped',
    conversations = 'none',
    bodyObject = false,
  } = options;

  const ticketFields: FakeField[] = [
    { name: 'ticketId', type: nonNull(scalar('ID')) },
    { name: 'displayId', type: scalar() },
    { name: 'subject', type: scalar() },
    { name: 'status', type: scalar() },
    { name: 'priority', type: scalar() },
    { name: 'createdTime', type: scalar() },
    { name: 'updatedTime', type: scalar() },
    { name: 'technician', type: object('User') },
  ];

  if (bodyField) ticketFields.push({ name: bodyField, type: bodyObject ? object('RichText') : scalar() });

  if (clientShape === 'object') {
    ticketFields.push({ name: 'client', type: object('Client') });
    ticketFields.push({ name: 'requester', type: object('Requester') });
  } else if (clientShape === 'leaf') {
    ticketFields.push({ name: 'client', type: scalar() });
    ticketFields.push({ name: 'requester', type: scalar() });
  }

  const types: Record<string, FakeType> = {
    TicketList: {
      name: 'TicketList',
      kind: 'OBJECT',
      fields: [
        { name: 'tickets', type: list(object('Ticket')) },
        { name: 'listInfo', type: object('ListInfo') },
      ],
    },
    Ticket: { name: 'Ticket', kind: 'OBJECT', fields: ticketFields },
    ListInfo: {
      name: 'ListInfo',
      kind: 'OBJECT',
      fields: [
        { name: 'page', type: scalar('Int') },
        { name: 'pageSize', type: scalar('Int') },
        { name: 'totalCount', type: scalar('Int') },
        { name: 'hasMore', type: scalar('Boolean') },
      ],
    },
    Client: {
      name: 'Client',
      kind: 'OBJECT',
      fields: [
        { name: 'accountId', type: scalar('ID') },
        { name: 'name', type: scalar() },
        { name: 'stage', type: scalar() },
        { name: 'primaryContact', type: object('Requester') },
      ],
    },
    Requester: {
      name: 'Requester',
      kind: 'OBJECT',
      fields: [
        { name: 'userId', type: scalar('ID') },
        { name: 'email', type: scalar() },
        { name: 'name', type: scalar() },
        { name: 'firstName', type: scalar() },
      ],
    },
    User: { name: 'User', kind: 'OBJECT', fields: [{ name: 'userId', type: scalar('ID') }] },
    TicketIdentifierInput: {
      name: 'TicketIdentifierInput',
      kind: 'INPUT_OBJECT',
      inputFields: [{ name: 'ticketId', type: nonNull(scalar('ID')) }],
    },
  };

  types.RichText = {
    name: 'RichText',
    kind: 'OBJECT',
    fields: [
      { name: 'content', type: scalar() },
      { name: 'format', type: scalar() },
    ],
  };
  types.TicketConversation = {
    name: 'TicketConversation',
    kind: 'OBJECT',
    fields: [
      { name: 'conversationId', type: scalar('ID') },
      { name: 'content', type: scalar() },
      { name: 'time', type: scalar() },
      { name: 'user', type: scalar('JSON') },
    ],
  };
  types.TicketConversationList = {
    name: 'TicketConversationList',
    kind: 'OBJECT',
    fields: [{ name: 'conversations', type: list(object('TicketConversation')) }],
  };

  const listInputFields: FakeField[] = [
    { name: 'page', type: scalar('Int') },
    { name: 'pageSize', type: scalar('Int') },
    { name: 'condition', type: input('RuleConditionInput') },
  ];
  if (sort === 'supported') {
    listInputFields.push({ name: 'sort', type: list(input('SortInput')) });
    types.SortInput = {
      name: 'SortInput',
      kind: 'INPUT_OBJECT',
      inputFields: [
        { name: 'attribute', type: scalar() },
        { name: 'order', type: scalar() },
      ],
    };
  } else if (sort === 'unrecognised') {
    listInputFields.push({ name: 'sort', type: list(input('SortInput')) });
    types.SortInput = {
      name: 'SortInput',
      kind: 'INPUT_OBJECT',
      inputFields: [{ name: 'expression', type: scalar() }],
    };
  }

  types.ListInfoInput = { name: 'ListInfoInput', kind: 'INPUT_OBJECT', inputFields: listInputFields };

  const queryFields: FakeField[] = [
    {
      name: 'getTicketList',
      type: object('TicketList'),
      args: [{ name: 'input', type: nonNull(input('ListInfoInput')) }],
    },
  ];

  if (clientList !== 'absent') {
    queryFields.push({
      name: 'getClientList',
      type: object('ClientList'),
      args: [{ name: 'input', type: nonNull(input('ListInfoInput')) }],
    });
    types.ClientList = {
      name: 'ClientList',
      kind: 'OBJECT',
      fields: [{ name: 'clients', type: list(object(clientList === 'wrapped' ? 'Client' : 'OpaqueClient')) }],
    };
    if (clientList === 'unusable') {
      types.OpaqueClient = {
        name: 'OpaqueClient',
        kind: 'OBJECT',
        fields: [{ name: 'opaqueRef', type: scalar() }],
      };
    }
  }

  if (detailQuery) {
    queryFields.push({
      name: 'getTicket',
      type: object('Ticket'),
      args: [{ name: 'input', type: nonNull(input('TicketIdentifierInput')) }],
    });
  }

  if (conversations !== 'none') {
    queryFields.push({
      name: 'getTicketConversationList',
      type: conversations === 'list' ? list(object('TicketConversation')) : object('TicketConversationList'),
      args: [{ name: 'input', type: nonNull(input('TicketIdentifierInput')) }],
    });
  }

  const mutationFields: FakeField[] = [];
  if (noteStyle === 'createNote') {
    mutationFields.push({
      name: 'createNote',
      type: object('Note'),
      args: [{ name: 'input', type: nonNull(input('CreateNoteInput')) }],
    });
    types.CreateNoteInput = {
      name: 'CreateNoteInput',
      kind: 'INPUT_OBJECT',
      inputFields: [
        { name: 'workItem', type: nonNull(input('WorkItemInput')) },
        { name: 'content', type: nonNull(scalar()) },
        { name: 'privacyType', type: scalar('PrivacyType') },
      ],
    };
    types.WorkItemInput = {
      name: 'WorkItemInput',
      kind: 'INPUT_OBJECT',
      inputFields: [
        { name: 'workId', type: nonNull(scalar('ID')) },
        { name: 'module', type: nonNull(scalar('ModuleType')) },
      ],
    };
  } else if (noteStyle === 'createTicketNote') {
    mutationFields.push({
      name: 'createTicketNote',
      type: object('Note'),
      args: [{ name: 'input', type: nonNull(input('CreateTicketNoteInput')) }],
    });
    types.CreateTicketNoteInput = {
      name: 'CreateTicketNoteInput',
      kind: 'INPUT_OBJECT',
      inputFields: [
        { name: 'ticketIdentifier', type: nonNull(input('TicketIdentifierInput')) },
        { name: 'content', type: nonNull(scalar()) },
        { name: 'privacyType', type: scalar('PrivacyType') },
      ],
    };
  }

  return { queryFields, mutationFields, types };
}

/**
 * A minimal GraphQL client that answers only the introspection queries the
 * probe sends, by reading the fake schema.
 */
export function fakeGraphQLClient(schema: FakeSchema, log: string[] = []) {
  return {
    request: async <T>(
      document: string | { document: string },
      variables?: Record<string, unknown>,
    ): Promise<T> => {
      const text = typeof document === 'string' ? document : document.document;
      log.push(text);

      if (text.includes('SwoopProbeRoots')) {
        return {
          __schema: {
            queryType: { fields: schema.queryFields },
            mutationType: schema.mutationFields.length > 0 ? { fields: schema.mutationFields } : null,
          },
        } as T;
      }

      if (text.includes('SwoopProbeType')) {
        const name = variables?.name as string;
        const type = schema.types[name];
        if (!type) return { __type: null } as T;
        return {
          __type: {
            name: type.name,
            kind: type.kind,
            fields: type.fields ?? null,
            inputFields: type.inputFields ?? null,
          },
        } as T;
      }

      throw new Error(`Unexpected query in the fake client: ${text.slice(0, 80)}`);
    },
  };
}
