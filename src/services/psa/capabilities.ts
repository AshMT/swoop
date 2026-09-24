import type { GraphQLClient } from 'graphql-request';
import {
  TYPE_REF_FRAGMENT,
  namedType,
  isLeafType,
  isListType,
  pickField,
  pickFields,
  type FieldInfo,
} from './introspection';
import { createLogger, describeError } from '../../lib/logger';

const log = createLogger('SuperOps:probe');

/** Version stamp — bump to force a re-probe after changing the probe logic. */
export const CAPABILITIES_VERSION = 8;

export interface ObjectFieldShape {
  /** 'leaf' needs no sub-selection; 'object' does; 'missing' means absent. */
  shape: 'leaf' | 'object' | 'missing';
  /** Sub-fields to select when shape is 'object'. */
  subFields: string[];
  /** Sub-field holding the identifier, when discoverable. */
  idField: string | null;
  /** Sub-field holding the display name / email, when discoverable. */
  labelField: string | null;
  /** The field name as this schema spells it, e.g. 'client' or 'company'. */
  fieldName: string | null;
}

export interface PsaCapabilities {
  version: number;
  probedAt: number;
  endpoint: string;

  /** Root query used to list tickets, e.g. 'getTicketList'. */
  listQuery: string | null;
  /** Argument name carrying the list input, e.g. 'input'. */
  listArgName: string | null;
  /** Field on the list payload holding the ticket array, e.g. 'tickets'. */
  listResultField: string | null;
  /** Input type name for the list argument, e.g. 'ListInfoInput'. */
  listInputType: string | null;
  /** Input fields available on the list input type (page/pageSize/sort/...). */
  listInputFields: string[];
  /** Built sort clause, or null when the schema gives us nothing to sort on. */
  sortClause: { attribute: string; order: string } | null;
  /** Field names on the sort input, so the clause can be shaped correctly. */
  sortFieldNames: { attribute: string; order: string } | null;

  /** Ticket object type name, e.g. 'Ticket'. */
  ticketType: string | null;
  ticketFields: string[];
  idField: string;
  displayIdField: string | null;
  subjectField: string | null;
  /** Long-form ticket text — the thing the classifier actually needs. */
  bodyField: string | null;
  /** When the body field is an object, the scalar inside it holding the text. */
  bodySubField: string | null;
  statusField: string | null;
  priorityField: string | null;
  createdField: string | null;
  client: ObjectFieldShape;
  requester: ObjectFieldShape;

  /** Root query for a single ticket, used to fetch the body when the list omits it. */
  detailQuery: string | null;
  detailArgName: string | null;
  /** When the detail arg is an input object, the field inside it holding the id. */
  detailArgIdField: string | null;
  /** Ticket fields only available on the detail query. */
  detailOnlyFields: string[];

  /**
   * Where the ticket text lives when the ticket itself has no body field.
   * SuperOps keeps the requester's original message as the first entry of the
   * ticket's conversation thread rather than on the ticket.
   */
  conversationQuery: string | null;
  conversationArgName: string | null;
  /** When the argument is an input object, the field inside it holding the ticket id. */
  conversationArgIdField: string | null;
  /** When the ticket id sits one level down, e.g. input { ticket { ticketId } }, that field. */
  conversationArgTicketField: string | null;
  /** A paging input the query requires, e.g. listInfo { page pageSize }, and the fields it takes. */
  conversationArgListField: string | null;
  conversationArgListFields: string[];
  /** Field on the payload holding the array; null when the query returns the array itself. */
  conversationResultField: string | null;
  conversationContentField: string | null;
  conversationTimeField: string | null;
  /** Why no conversation query could be used, for the operator. Null when one was, or none exists. */
  conversationNote: string | null;

  /** Root query listing the MSP's clients, so the UI can offer a picker. */
  clientListQuery: string | null;
  clientListArgName: string | null;
  clientListResultField: string | null;
  clientListIdField: string | null;
  clientListNameField: string | null;

  /** Mutation that posts a note, e.g. 'createNote' or 'createTicketNote'. */
  noteMutation: string | null;
  noteArgName: string | null;
  noteInputType: string | null;
  noteInputFields: string[];
  noteContentField: string | null;
  noteVisibilityField: string | null;
  /** Newer schemas address the note's target as workItem { workId, module }. */
  noteWorkItemField: string | null;
  noteWorkItemFields: string[];
  /** Older schemas use ticket { ticketId } or a flat ticketId. */
  noteTicketField: string | null;
  noteTicketIdField: string | null;

  /** Knowledge base article list, when the schema exposes one. */
  kbListQuery: string | null;
  kbListArgName: string | null;
  kbResultField: string | null;
  kbIdField: string | null;
  kbTitleField: string | null;
  kbBodyField: string | null;

  /** Anything the probe could not resolve, surfaced in the UI. */
  warnings: string[];
}

// ─── Candidate names, most-likely first ────────────────────────────────────────
const LIST_QUERY_CANDIDATES = ['getTicketList', 'getTickets', 'ticketList', 'tickets'];
const DETAIL_QUERY_CANDIDATES = ['getTicket', 'ticket'];
const CLIENT_LIST_CANDIDATES = [
  'getClientList',
  'getClients',
  'getAccountList',
  'clientList',
  'clients',
  'accounts',
];
const CLIENT_LIST_RESULT_CANDIDATES = ['clients', 'accounts', 'items', 'data', 'results', 'records'];
const NOTE_MUTATION_CANDIDATES = [
  'createNote',
  'createTicketNote',
  'addTicketNote',
  'addNote',
  'createWorklog',
];
const KB_LIST_CANDIDATES = [
  'getKbArticleList',
  'getKBArticleList',
  'getKnowledgeBaseArticleList',
  'getArticleList',
  'getKbArticles',
  'getSolutionList',
  'getKbItemList',
];
const KB_RESULT_CANDIDATES = ['articles', 'kbArticles', 'solutions', 'items', 'data', 'results', 'records'];
const KB_ID_CANDIDATES = ['articleId', 'kbArticleId', 'itemId', 'solutionId', 'id'];
const KB_TITLE_CANDIDATES = ['title', 'name', 'subject', 'articleTitle'];
const KB_BODY_CANDIDATES = ['content', 'body', 'articleContent', 'description', 'text', 'details'];
const LIST_RESULT_CANDIDATES = ['tickets', 'items', 'data', 'results', 'records', 'edges', 'nodes'];
const ID_CANDIDATES = ['ticketId', 'ticketID', 'id', 'workId'];
const DISPLAY_ID_CANDIDATES = ['displayId', 'ticketNumber', 'number', 'displayID'];
const SUBJECT_CANDIDATES = ['subject', 'title', 'summary', 'name'];
const BODY_CANDIDATES = [
  'description',
  'ticketBody',
  'body',
  'details',
  'content',
  'ticketDescription',
  'requestBody',
  'message',
  'note',
];
const CONVERSATION_QUERY_CANDIDATES = [
  'getTicketConversationList',
  'getTicketConversations',
  'getConversationList',
  'getTicketThreadList',
  'getTicketThreads',
  'ticketConversations',
];
const CONVERSATION_RESULT_CANDIDATES = ['conversations', 'conversationList', 'threads', 'items', 'data', 'results'];
const CONVERSATION_CONTENT_CANDIDATES = ['content', 'body', 'message', 'text', 'description', 'html', 'htmlContent'];
const CONVERSATION_TIME_CANDIDATES = ['time', 'createdTime', 'createdAt', 'sentTime', 'date', 'timestamp'];
const STATUS_CANDIDATES = ['status', 'ticketStatus', 'state'];
const PRIORITY_CANDIDATES = ['priority', 'ticketPriority', 'urgency'];
const CREATED_CANDIDATES = ['createdTime', 'createdAt', 'createdDate', 'creationTime'];
const CLIENT_CANDIDATES = ['client', 'company', 'account', 'customer', 'organisation', 'organization'];
const REQUESTER_CANDIDATES = ['requester', 'contact', 'reporter', 'requestedBy', 'user'];
const SORT_ATTR_CANDIDATES = ['attribute', 'field', 'name', 'sortBy', 'key'];
const SORT_ORDER_CANDIDATES = ['order', 'direction', 'sortOrder', 'dir'];
const NOTE_CONTENT_CANDIDATES = ['content', 'note', 'body', 'description', 'text', 'message'];
const NOTE_VISIBILITY_CANDIDATES = ['privacyType', 'visibility', 'noteType', 'isPrivate', 'privacy'];
const NOTE_WORKITEM_CANDIDATES = ['workItem', 'workitem', 'target'];
const NOTE_TICKET_CANDIDATES = ['ticket', 'ticketIdentifier', 'ticketId'];

interface RootFieldsResponse {
  __schema: {
    queryType: { fields: FieldInfo[] } | null;
    mutationType: { fields: FieldInfo[] } | null;
  };
}

interface TypeResponse {
  __type: {
    name: string | null;
    kind: string;
    fields: FieldInfo[] | null;
    inputFields: FieldInfo[] | null;
  } | null;
}

const ROOT_FIELDS_QUERY = `
  ${TYPE_REF_FRAGMENT}
  query SwoopProbeRoots {
    __schema {
      queryType { fields { name args { name type { ...TypeRef } } type { ...TypeRef } } }
      mutationType { fields { name args { name type { ...TypeRef } } type { ...TypeRef } } }
    }
  }
`;

const TYPE_QUERY = `
  ${TYPE_REF_FRAGMENT}
  query SwoopProbeType($name: String!) {
    __type(name: $name) {
      name
      kind
      fields { name type { ...TypeRef } }
      inputFields { name type { ...TypeRef } }
    }
  }
`;

/**
 * Introspects the endpoint and works out how to read tickets and post notes.
 *
 * Every step degrades rather than throws: a capability set with warnings and a
 * usable list query is far more valuable than an exception, because the UI can
 * show the operator exactly what was and was not found.
 */
export async function probeCapabilities(
  client: Pick<GraphQLClient, 'request'>,
  endpoint: string,
): Promise<PsaCapabilities> {
  const warnings: string[] = [];
  const caps: PsaCapabilities = {
    version: CAPABILITIES_VERSION,
    probedAt: Math.floor(Date.now() / 1000),
    endpoint,
    listQuery: null,
    listArgName: null,
    listResultField: null,
    listInputType: null,
    listInputFields: [],
    sortClause: null,
    sortFieldNames: null,
    ticketType: null,
    ticketFields: [],
    idField: 'ticketId',
    displayIdField: null,
    subjectField: null,
    bodyField: null,
    bodySubField: null,
    statusField: null,
    priorityField: null,
    createdField: null,
    client: { shape: 'missing', subFields: [], idField: null, labelField: null, fieldName: null },
    requester: { shape: 'missing', subFields: [], idField: null, labelField: null, fieldName: null },
    detailQuery: null,
    detailArgName: null,
    detailArgIdField: null,
    detailOnlyFields: [],
    conversationQuery: null,
    conversationArgName: null,
    conversationArgIdField: null,
    conversationArgTicketField: null,
    conversationArgListField: null,
    conversationArgListFields: [],
    conversationResultField: null,
    conversationContentField: null,
    conversationTimeField: null,
    conversationNote: null,
    clientListQuery: null,
    clientListArgName: null,
    clientListResultField: null,
    clientListIdField: null,
    clientListNameField: null,
    noteMutation: null,
    noteArgName: null,
    noteInputType: null,
    noteInputFields: [],
    noteContentField: null,
    noteVisibilityField: null,
    noteWorkItemField: null,
    noteWorkItemFields: [],
    noteTicketField: null,
    noteTicketIdField: null,
    kbListQuery: null,
    kbListArgName: null,
    kbResultField: null,
    kbIdField: null,
    kbTitleField: null,
    kbBodyField: null,
    warnings,
  };

  let listInputFieldInfos: FieldInfo[] = [];

  const roots = await client.request<RootFieldsResponse>(ROOT_FIELDS_QUERY);
  const queryFields = roots.__schema?.queryType?.fields ?? [];
  const mutationFields = roots.__schema?.mutationType?.fields ?? [];

  const describeType = async (name: string): Promise<TypeResponse['__type']> => {
    try {
      const res = await client.request<TypeResponse>(TYPE_QUERY, { name });
      return res.__type;
    } catch (err) {
      log.debug(`Could not introspect type ${name}: ${describeError(err)}`);
      return null;
    }
  };

  // ─── Ticket list query ──────────────────────────────────────────────────────
  const listField = findRootField(queryFields, LIST_QUERY_CANDIDATES);
  if (!listField) {
    warnings.push(
      `No ticket list query found. Looked for: ${LIST_QUERY_CANDIDATES.join(', ')}. Swoop cannot poll this endpoint.`,
    );
  } else {
    caps.listQuery = listField.name;
    const listArg = listField.args?.[0];
    caps.listArgName = listArg?.name ?? null;

    const payloadTypeName = namedType(listField.type).name;
    if (payloadTypeName) {
      const payload = await describeType(payloadTypeName);
      const payloadFields = payload?.fields ?? [];
      const ticketArrayField =
        payloadFields.find((f) => LIST_RESULT_CANDIDATES.includes(f.name)) ??
        payloadFields.find((f) => !isLeafType(f.type));
      if (ticketArrayField) {
        caps.listResultField = ticketArrayField.name;
        caps.ticketType = namedType(ticketArrayField.type).name;
      } else {
        warnings.push(`Could not find the ticket array on ${payloadTypeName}.`);
      }
    }

    if (listArg) {
      const listInputName = namedType(listArg.type).name;
      caps.listInputType = listInputName;
      if (listInputName) {
        const listInput = await describeType(listInputName);
        caps.listInputFields = (listInput?.inputFields ?? []).map((f) => f.name);
        // The sort clause names a ticket field, so it can only be resolved once
        // the ticket type has been introspected below.
        listInputFieldInfos = listInput?.inputFields ?? [];
      }
    }
  }

  // ─── Ticket object fields ───────────────────────────────────────────────────
  if (caps.ticketType) {
    const ticketType = await describeType(caps.ticketType);
    const fields = ticketType?.fields ?? [];
    caps.ticketFields = fields.map((f) => f.name);
    await assignTicketFields(caps, fields, describeType, warnings);
  } else if (caps.listQuery) {
    warnings.push('Ticket type could not be resolved; falling back to a minimal field selection.');
  }

  // Now that createdField is known, work out whether we can sort by it.
  if (listInputFieldInfos.length > 0) {
    await resolveSort(caps, listInputFieldInfos, describeType, warnings);
  }

  // ─── Single-ticket detail query (the ticket body usually lives here) ────────
  const detailField = findRootField(queryFields, DETAIL_QUERY_CANDIDATES);
  if (detailField) {
    caps.detailQuery = detailField.name;
    const detailArg = detailField.args?.[0];
    caps.detailArgName = detailArg?.name ?? null;
    if (detailArg) {
      const argTypeName = namedType(detailArg.type).name;
      const argKind = namedType(detailArg.type).kind;
      if (argKind === 'INPUT_OBJECT' && argTypeName) {
        const argType = await describeType(argTypeName);
        const argFields = (argType?.inputFields ?? []).map((f) => f.name);
        caps.detailArgIdField = pickField(argFields, ID_CANDIDATES) ?? argFields[0] ?? null;
      }
    }
    // The detail query may expose the same Ticket type but the list query is
    // often projected narrower, so record which fields are detail-only.
    const detailTypeName = namedType(detailField.type).name;
    if (detailTypeName && detailTypeName !== caps.ticketType) {
      const detailType = await describeType(detailTypeName);
      const detailFields = (detailType?.fields ?? []).map((f) => f.name);
      caps.detailOnlyFields = detailFields.filter((f) => !caps.ticketFields.includes(f));
      if (!caps.bodyField) {
        await assignBodyField(caps, detailType?.fields ?? [], describeType);
      }
    }
  }

  // ─── Conversation thread, where SuperOps keeps the original message ─────────
  if (!caps.bodyField) {
    await resolveConversation(caps, queryFields, describeType);
  }

  if (!caps.bodyField && !caps.conversationQuery) {
    const seen = caps.ticketFields.length ? ` Ticket fields: ${caps.ticketFields.join(', ')}.` : '';
    const ticketQueries = queryFields.map((f) => f.name).filter((n) => /ticket|conversation|thread/i.test(n));
    const conversation =
      caps.conversationNote ?? `no conversation query (looked for: ${CONVERSATION_QUERY_CANDIDATES.slice(0, 2).join(', ')})`;
    warnings.push(
      `No ticket body found — no body field on the ticket (looked for: ${BODY_CANDIDATES.slice(0, 5).join(', ')}) and ${conversation}. Classification will use the subject line only, which measurably reduces accuracy. Ticket queries on this schema: ${ticketQueries.join(', ') || 'none'}.${seen}`,
    );
  }

  // ─── Client list, used to offer a picker instead of hand-typed IDs ──────────
  const clientListField = findRootField(queryFields, CLIENT_LIST_CANDIDATES);
  if (clientListField) {
    caps.clientListQuery = clientListField.name;
    caps.clientListArgName = clientListField.args?.[0]?.name ?? null;

    const payloadTypeName = namedType(clientListField.type).name;
    if (payloadTypeName) {
      const payload = await describeType(payloadTypeName);
      const payloadFields = payload?.fields ?? [];
      // The payload may be the list wrapper, or the client array directly.
      const arrayField =
        payloadFields.find((f) => CLIENT_LIST_RESULT_CANDIDATES.includes(f.name)) ??
        payloadFields.find((f) => !isLeafType(f.type) && isListType(f.type));

      if (arrayField) {
        caps.clientListResultField = arrayField.name;
        const clientTypeName = namedType(arrayField.type).name;
        if (clientTypeName) {
          const clientType = await describeType(clientTypeName);
          const scalarNames = (clientType?.fields ?? [])
            .filter((f) => isLeafType(f.type))
            .map((f) => f.name);
          caps.clientListIdField = pickField(scalarNames, ['accountId', 'clientId', 'companyId', 'id']);
          caps.clientListNameField = pickField(scalarNames, [
            'name',
            'accountName',
            'clientName',
            'companyName',
            'displayName',
          ]);
        }
      }
    }

    if (!caps.clientListIdField || !caps.clientListNameField) {
      warnings.push(
        'A client list query exists but its id or name field could not be resolved, so the client picker is unavailable. Company IDs can still be entered by hand.',
      );
      caps.clientListQuery = null;
    }
  }

  // ─── Knowledge base, used as context for investigations ─────────────────────
  const kbField =
    findRootField(queryFields, KB_LIST_CANDIDATES) ??
    queryFields.find((f) => /^get(kb|knowledge)\w*list$/i.test(f.name)) ??
    null;
  if (kbField) {
    const payloadTypeName = namedType(kbField.type).name;
    const payload = payloadTypeName ? await describeType(payloadTypeName) : null;
    const payloadFields = payload?.fields ?? [];
    const arrayField =
      payloadFields.find((f) => KB_RESULT_CANDIDATES.includes(f.name)) ??
      payloadFields.find((f) => !isLeafType(f.type) && isListType(f.type));
    const articleTypeName = arrayField ? namedType(arrayField.type).name : null;
    const articleType = articleTypeName ? await describeType(articleTypeName) : null;
    const scalars = (articleType?.fields ?? []).filter((f) => isLeafType(f.type)).map((f) => f.name);
    const id = pickField(scalars, KB_ID_CANDIDATES);
    const title = pickField(scalars, KB_TITLE_CANDIDATES);
    const body = pickField(scalars, KB_BODY_CANDIDATES);
    if (arrayField && id && title) {
      caps.kbListQuery = kbField.name;
      caps.kbListArgName = kbField.args?.[0]?.name ?? null;
      caps.kbResultField = arrayField.name;
      caps.kbIdField = id;
      caps.kbTitleField = title;
      caps.kbBodyField = body;
    }
  }

  // ─── Note mutation ──────────────────────────────────────────────────────────
  const noteField = findRootField(mutationFields, NOTE_MUTATION_CANDIDATES);
  if (!noteField) {
    warnings.push(
      `No note mutation found. Looked for: ${NOTE_MUTATION_CANDIDATES.join(', ')}. Swoop will classify tickets but cannot write proposals back.`,
    );
  } else {
    caps.noteMutation = noteField.name;
    const noteArg = noteField.args?.[0];
    caps.noteArgName = noteArg?.name ?? null;
    const noteInputName = noteArg ? namedType(noteArg.type).name : null;
    caps.noteInputType = noteInputName;
    if (noteInputName) {
      const noteInput = await describeType(noteInputName);
      const inputFields = noteInput?.inputFields ?? [];
      caps.noteInputFields = inputFields.map((f) => f.name);
      await resolveNoteTarget(caps, inputFields, describeType, warnings);
    }
  }

  log.info(
    `Probe complete — list: ${caps.listQuery ?? 'none'}, body field: ${caps.bodyField ?? 'none'}, note mutation: ${caps.noteMutation ?? 'none'}, warnings: ${warnings.length}`,
  );
  return caps;
}

/**
 * Picks the ticket body: a scalar by a known name, else any scalar whose name
 * says description or body, else an object by a known name with a text field
 * inside it (selected as `description { content }`).
 */
async function assignBodyField(
  caps: PsaCapabilities,
  fields: FieldInfo[],
  describeType: (name: string) => Promise<TypeResponse['__type']>,
): Promise<void> {
  const leaves = fields.filter((f) => isLeafType(f.type)).map((f) => f.name);
  const exact = pickField(leaves, BODY_CANDIDATES);
  const fuzzy = leaves.find((n) => /description|body/i.test(n) && !/(id|type|format|count)$/i.test(n));
  if (exact || fuzzy) {
    caps.bodyField = (exact ?? fuzzy)!;
    caps.bodySubField = null;
    return;
  }
  const objects = fields.filter((f) => !isLeafType(f.type));
  const objectName = pickField(objects.map((f) => f.name), BODY_CANDIDATES);
  if (!objectName) return;
  const typeName = namedType(objects.find((f) => f.name === objectName)!.type).name;
  const type = typeName ? await describeType(typeName) : null;
  const inner = pickField(
    (type?.fields ?? []).filter((f) => isLeafType(f.type)).map((f) => f.name),
    CONVERSATION_CONTENT_CANDIDATES,
  );
  if (inner) {
    caps.bodyField = objectName;
    caps.bodySubField = inner;
  }
}

/**
 * Finds a per-ticket conversation query and the text and time fields on its
 * entries. SuperOps documents it as
 * `getTicketConversationList(input: TicketIdentifierInput!): [TicketConversation]`
 * with `content` and `time` strings, but schemas also carry look-alikes such as
 * `getTicketConversation(input: TicketConversationIdentifierInput!)`, which
 * fetches one message by its own id and is no use here. Every candidate is
 * tried, lists first; the first that can be addressed by ticket id and has a
 * text field wins, and the reason each other one was passed over is recorded.
 */
async function resolveConversation(
  caps: PsaCapabilities,
  queryFields: FieldInfo[],
  describeType: (name: string) => Promise<TypeResponse['__type']>,
): Promise<void> {
  const candidates: FieldInfo[] = [];
  const add = (field: FieldInfo | null | undefined) => {
    if (field && !candidates.includes(field)) candidates.push(field);
  };
  for (const name of CONVERSATION_QUERY_CANDIDATES) add(findRootField(queryFields, [name]));
  for (const field of queryFields) {
    if (/ticket\w*(conversation|thread|repl)|(conversation|thread)\w*ticket/i.test(field.name)) add(field);
  }
  // A query returning a list, or named like one, is far likelier to be the thread.
  const listish = (f: FieldInfo) => isListType(f.type) || /(list|s)$/i.test(f.name);
  candidates.sort((a, b) => Number(listish(b)) - Number(listish(a)));

  const passedOver: string[] = [];
  for (const field of candidates) {
    const outcome = await tryConversationQuery(field, describeType);
    if ('reason' in outcome) {
      passedOver.push(`${field.name} (${outcome.reason})`);
      continue;
    }
    Object.assign(caps, outcome, { conversationNote: null });
    return;
  }
  if (passedOver.length > 0) caps.conversationNote = `no usable conversation query — passed over ${passedOver.join('; ')}`;
}

async function tryConversationQuery(
  field: FieldInfo,
  describeType: (name: string) => Promise<TypeResponse['__type']>,
): Promise<
  | { reason: string }
  | Pick<
      PsaCapabilities,
      | 'conversationQuery'
      | 'conversationArgName'
      | 'conversationArgIdField'
      | 'conversationArgTicketField'
      | 'conversationArgListField'
      | 'conversationArgListFields'
      | 'conversationResultField'
      | 'conversationContentField'
      | 'conversationTimeField'
    >
> {
  const documented = field.name === 'getTicketConversationList';
  const arg = field.args?.[0];
  if (!arg) return { reason: 'takes no argument' };

  // It must be addressed by the ticket's id, not by a message's own id — either
  // directly, input { ticketId }, or one level down, input { ticket { ticketId } },
  // optionally alongside a paging input such as listInfo { page pageSize }.
  let argIdField: string | null = null;
  let ticketField: string | null = null;
  let listField: string | null = null;
  let listFields: string[] = [];
  if (namedType(arg.type).kind === 'INPUT_OBJECT') {
    const argTypeName = namedType(arg.type).name;
    const argType = argTypeName ? await describeType(argTypeName) : null;
    const inputs = argType?.inputFields ?? [];
    const argFields = inputs.map((f) => f.name);
    argIdField =
      pickField(argFields, ['ticketId', 'ticketID', 'workId']) ??
      (argTypeName && /ticket/i.test(argTypeName) && !/conversation|thread/i.test(argTypeName) ? pickField(argFields, ['id']) : null) ??
      (documented && argFields.length === 0 ? 'ticketId' : null);

    if (!argIdField) {
      const nested = inputs.find((f) => /^ticket(identifier|input)?$/i.test(f.name) && namedType(f.type).kind === 'INPUT_OBJECT');
      const nestedTypeName = nested ? namedType(nested.type).name : null;
      const nestedType = nestedTypeName ? await describeType(nestedTypeName) : null;
      const nestedId = pickField((nestedType?.inputFields ?? []).map((f) => f.name), ['ticketId', 'ticketID', 'id']);
      if (nested && nestedId) {
        ticketField = nested.name;
        argIdField = nestedId;
      }
    }
    if (!argIdField) return { reason: `needs ${argFields.join(', ') || 'an input it could not read'}, not a ticket id` };

    const paging = inputs.find((f) => /^(listinfo|pagination|paging|page(info|input)?)$/i.test(f.name) && namedType(f.type).kind === 'INPUT_OBJECT');
    if (paging) {
      const pagingTypeName = namedType(paging.type).name;
      const pagingType = pagingTypeName ? await describeType(pagingTypeName) : null;
      listField = paging.name;
      listFields = pickFields((pagingType?.inputFields ?? []).map((f) => f.name), ['page', 'pageSize']);
    }
    // Anything else the input insists on is something Swoop cannot supply.
    const unmet = inputs.filter(
      (f) => f.type.kind === 'NON_NULL' && ![argIdField, ticketField, listField].includes(f.name),
    );
    if (unmet.length > 0) return { reason: `also requires ${unmet.map((f) => f.name).join(', ')}` };
  } else if (!/ticket|workid/i.test(arg.name)) {
    return { reason: `needs ${arg.name}, not a ticket id` };
  }

  // Either the query returns the entries directly, or a wrapper holding them.
  let resultField: string | null = null;
  let entryTypeName = namedType(field.type).name;
  if (!isListType(field.type) && entryTypeName) {
    const wrapper = await describeType(entryTypeName);
    const wrapperFields = wrapper?.fields ?? [];
    const arrayField =
      wrapperFields.find((f) => CONVERSATION_RESULT_CANDIDATES.includes(f.name)) ??
      wrapperFields.find((f) => !isLeafType(f.type) && isListType(f.type));
    if (!arrayField) return { reason: `returns a single ${entryTypeName}, not a list` };
    resultField = arrayField.name;
    entryTypeName = namedType(arrayField.type).name;
  }
  const entryType = entryTypeName ? await describeType(entryTypeName) : null;
  const scalars = (entryType?.fields ?? []).filter((f) => isLeafType(f.type)).map((f) => f.name);
  let content = pickField(scalars, CONVERSATION_CONTENT_CANDIDATES);
  let time = pickField(scalars, CONVERSATION_TIME_CANDIDATES);
  if (!content && documented && scalars.length === 0) {
    // The entry type could not be read at all; trust the documented shape.
    content = 'content';
    time = 'time';
  }
  if (!content) return { reason: `its entries have no text field (has: ${scalars.join(', ') || 'nothing readable'})` };

  return {
    conversationQuery: field.name,
    conversationArgName: arg.name,
    conversationArgIdField: argIdField,
    conversationArgTicketField: ticketField,
    conversationArgListField: listField,
    conversationArgListFields: listFields,
    conversationResultField: resultField,
    conversationContentField: content,
    conversationTimeField: time,
  };
}

/** Where the ticket text comes from, for the UI. Null when nowhere. */
export function describeBodySource(caps: Pick<PsaCapabilities, 'bodyField' | 'bodySubField' | 'conversationQuery'>): string | null {
  if (caps.bodyField) return caps.bodySubField ? `${caps.bodyField}.${caps.bodySubField}` : caps.bodyField;
  if (caps.conversationQuery) return `${caps.conversationQuery} (first message)`;
  return null;
}

function findRootField(fields: FieldInfo[], candidates: readonly string[]): FieldInfo | null {
  const byLower = new Map(fields.map((f) => [f.name.toLowerCase(), f]));
  for (const candidate of candidates) {
    const hit = byLower.get(candidate.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

async function assignTicketFields(
  caps: PsaCapabilities,
  fields: FieldInfo[],
  describeType: (name: string) => Promise<TypeResponse['__type']>,
  warnings: string[],
): Promise<void> {
  const names = fields.map((f) => f.name);
  caps.idField = pickField(names, ID_CANDIDATES) ?? 'ticketId';
  caps.displayIdField = pickField(names, DISPLAY_ID_CANDIDATES);
  caps.subjectField = pickField(names, SUBJECT_CANDIDATES);
  caps.statusField = pickField(names, STATUS_CANDIDATES);
  caps.priorityField = pickField(names, PRIORITY_CANDIDATES);
  caps.createdField = pickField(names, CREATED_CANDIDATES);

  await assignBodyField(caps, fields, describeType);

  if (!caps.createdField) {
    warnings.push('No ticket creation timestamp field found; the poll window cannot be narrowed by age.');
  }

  caps.client = await describeObjectField(fields, CLIENT_CANDIDATES, 'client', describeType);
  caps.requester = await describeObjectField(fields, REQUESTER_CANDIDATES, 'requester', describeType);

  if (caps.client.shape === 'missing') {
    warnings.push('No client/company field on the ticket — tickets cannot be matched to an enabled client.');
  }
  if (caps.client.shape === 'object' && caps.client.subFields.length === 0) {
    warnings.push('The ticket client field is an object whose sub-fields could not be introspected.');
  }
}

/**
 * SuperOps has returned `client` as both a bare string and a nested object
 * across versions, so record which one this schema uses — and, when it is an
 * object, which of its scalar sub-fields carry the id and the label.
 */
async function describeObjectField(
  fields: FieldInfo[],
  candidates: readonly string[],
  kind: 'client' | 'requester',
  describeType: (name: string) => Promise<TypeResponse['__type']>,
): Promise<ObjectFieldShape> {
  const byLower = new Map(fields.map((f) => [f.name.toLowerCase(), f]));
  for (const candidate of candidates) {
    const field = byLower.get(candidate.toLowerCase());
    if (!field) continue;

    if (isLeafType(field.type)) {
      return { shape: 'leaf', subFields: [], idField: null, labelField: null, fieldName: field.name };
    }

    const typeName = namedType(field.type).name;
    const type = typeName ? await describeType(typeName) : null;
    const subFieldInfos = type?.fields ?? [];
    // Select only scalars: a deeper object would need another sub-selection.
    const scalarNames = subFieldInfos.filter((f) => isLeafType(f.type)).map((f) => f.name);

    const idCandidates =
      kind === 'client'
        ? ['accountId', 'clientId', 'companyId', 'id']
        : ['userId', 'contactId', 'requesterId', 'id'];
    const labelCandidates =
      kind === 'client'
        ? ['name', 'accountName', 'clientName', 'companyName', 'displayName']
        : ['email', 'emailId', 'emailAddress', 'name', 'displayName'];

    const idField = pickField(scalarNames, idCandidates);
    const labelField = pickField(scalarNames, labelCandidates);
    // Keep the selection tight: the id, the label, plus a couple of useful extras.
    const subFields = pickFields(scalarNames, [
      ...idCandidates,
      ...labelCandidates,
      'firstName',
      'lastName',
    ]);

    return {
      shape: 'object',
      subFields: subFields.length > 0 ? subFields : scalarNames.slice(0, 4),
      idField,
      labelField,
      fieldName: field.name,
    };
  }
  return { shape: 'missing', subFields: [], idField: null, labelField: null, fieldName: null };
}


async function resolveSort(
  caps: PsaCapabilities,
  listInputFields: FieldInfo[],
  describeType: (name: string) => Promise<TypeResponse['__type']>,
  warnings: string[],
): Promise<void> {
  const sortField = listInputFields.find((f) => f.name.toLowerCase() === 'sort');
  if (!sortField || !caps.createdField) return;

  const sortTypeName = namedType(sortField.type).name;
  if (!sortTypeName) return;

  const sortType = await describeType(sortTypeName);
  const sortFieldNames = (sortType?.inputFields ?? []).map((f) => f.name);
  const attribute = pickField(sortFieldNames, SORT_ATTR_CANDIDATES);
  const order = pickField(sortFieldNames, SORT_ORDER_CANDIDATES);

  if (!attribute || !order) {
    warnings.push(
      `Sort input ${sortTypeName} has an unrecognised shape (${sortFieldNames.join(', ') || 'no fields'}); tickets will be fetched unsorted.`,
    );
    return;
  }

  caps.sortFieldNames = { attribute, order };
  caps.sortClause = { attribute: caps.createdField, order: 'DESC' };
}

async function resolveNoteTarget(
  caps: PsaCapabilities,
  inputFields: FieldInfo[],
  describeType: (name: string) => Promise<TypeResponse['__type']>,
  warnings: string[],
): Promise<void> {
  const names = inputFields.map((f) => f.name);
  caps.noteContentField = pickField(names, NOTE_CONTENT_CANDIDATES);
  caps.noteVisibilityField = pickField(names, NOTE_VISIBILITY_CANDIDATES);

  if (!caps.noteContentField) {
    warnings.push(
      `Note input ${caps.noteInputType} has no recognisable content field (has: ${names.join(', ')}).`,
    );
  }

  // Newer schema: workItem { workId, module }
  const workItemName = pickField(names, NOTE_WORKITEM_CANDIDATES);
  if (workItemName) {
    const field = inputFields.find((f) => f.name === workItemName)!;
    caps.noteWorkItemField = workItemName;
    const typeName = namedType(field.type).name;
    if (typeName) {
      const type = await describeType(typeName);
      caps.noteWorkItemFields = (type?.inputFields ?? []).map((f) => f.name);
    }
    return;
  }

  // Older schema: ticket { ticketId } or a flat ticketId scalar.
  const ticketFieldName = pickField(names, NOTE_TICKET_CANDIDATES);
  if (!ticketFieldName) {
    warnings.push(
      `Note input ${caps.noteInputType} has no recognisable ticket reference (has: ${names.join(', ')}).`,
    );
    return;
  }

  caps.noteTicketField = ticketFieldName;
  const field = inputFields.find((f) => f.name === ticketFieldName)!;
  if (isLeafType(field.type)) {
    caps.noteTicketIdField = null; // flat scalar
    return;
  }
  const typeName = namedType(field.type).name;
  if (typeName) {
    const type = await describeType(typeName);
    const subFields = (type?.inputFields ?? []).map((f) => f.name);
    caps.noteTicketIdField = pickField(subFields, ID_CANDIDATES) ?? subFields[0] ?? null;
  }
}

export { BODY_CANDIDATES };
