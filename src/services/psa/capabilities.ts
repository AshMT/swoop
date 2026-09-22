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
export const CAPABILITIES_VERSION = 3;

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
    statusField: null,
    priorityField: null,
    createdField: null,
    client: { shape: 'missing', subFields: [], idField: null, labelField: null, fieldName: null },
    requester: { shape: 'missing', subFields: [], idField: null, labelField: null, fieldName: null },
    detailQuery: null,
    detailArgName: null,
    detailArgIdField: null,
    detailOnlyFields: [],
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
        caps.bodyField = pickField(detailFields, BODY_CANDIDATES);
      }
    }
  }

  if (!caps.bodyField) {
    warnings.push(
      `No ticket body field found (looked for: ${BODY_CANDIDATES.slice(0, 5).join(', ')}). Classification will use the subject line only, which measurably reduces accuracy.`,
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

  // Only accept a body field whose type is a leaf — a nested object here would
  // need a sub-selection we cannot guess, and the AI wants plain text anyway.
  const bodyName = pickField(names, BODY_CANDIDATES);
  if (bodyName) {
    const field = fields.find((f) => f.name === bodyName);
    if (field && isLeafType(field.type)) {
      caps.bodyField = bodyName;
    } else {
      warnings.push(`Ticket.${bodyName} is not a scalar, so it cannot be read as the ticket body.`);
    }
  }

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
