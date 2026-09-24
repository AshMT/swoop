import { GraphQLClient } from 'graphql-request';
import type { ConnectionTestResult, PSAClient, PsaCompany, PsaTicket } from './interface';
import { probeCapabilities, CAPABILITIES_VERSION, type PsaCapabilities } from './capabilities';
import { htmlToText } from '../../lib/html';
import { createLogger, describeError } from '../../lib/logger';
import { config } from '../../config';

const log = createLogger('SuperOps');

/** SuperOps caps a list request at 100 records. */
const MAX_PAGE_SIZE = 100;
/** Ceiling on pages walked in one poll, so a misconfigured filter cannot spin. */
const MAX_PAGES = 10;
const REQUEST_TIMEOUT_MS = 30_000;

export interface SuperOpsClientOptions {
  subdomain: string;
  apiKey: string;
  region?: string;
  /** Capabilities from a previous probe. Omit to probe on first use. */
  capabilities?: PsaCapabilities | null;
  /** Called whenever a fresh probe runs, so the caller can persist the result. */
  onCapabilities?: (capabilities: PsaCapabilities) => void | Promise<void>;
}

export class PsaError extends Error {
  readonly status?: number;
  readonly retryable: boolean;
  constructor(message: string, options: { status?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = 'PsaError';
    this.status = options.status;
    // Auth and validation failures will fail identically on a retry; transport
    // and 5xx failures are worth another attempt.
    this.retryable = options.retryable ?? true;
  }
}

export class SuperOpsClient implements PSAClient {
  readonly endpoint: string;
  private readonly client: GraphQLClient;
  private readonly subdomain: string;
  private readonly region: string;
  private capabilities: PsaCapabilities | null;
  private readonly onCapabilities?: SuperOpsClientOptions['onCapabilities'];
  private probeInFlight: Promise<PsaCapabilities> | null = null;
  /** Set when a sorted request was rejected, so we stop sending the clause. */
  private sortRejected = false;

  constructor(options: SuperOpsClientOptions) {
    this.subdomain = options.subdomain.trim();
    this.region = (options.region || 'us').toLowerCase();
    this.endpoint =
      config().superopsApiUrl ??
      (this.region === 'eu' ? 'https://euapi.superops.ai/msp' : 'https://api.superops.ai/msp');
    this.capabilities =
      options.capabilities && options.capabilities.version === CAPABILITIES_VERSION
        ? options.capabilities
        : null;
    this.onCapabilities = options.onCapabilities;

    this.client = new GraphQLClient(this.endpoint, {
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        // SuperOps routes on a header rather than the hostname, which is why a
        // custom vanity domain still works against the shared endpoint.
        CustomerSubDomain: this.subdomain,
        'Content-Type': 'application/json',
      },
    });
  }

  /** The web console URL, distinct from the API endpoint. */
  get consoleBaseUrl(): string {
    // A subdomain containing a dot is a full custom domain (e.g. mighty.it).
    return this.subdomain.includes('.') ? `https://${this.subdomain}` : `https://${this.subdomain}.superops.ai`;
  }

  ticketUrl(ticket: Pick<PsaTicket, 'ticketId' | 'displayId'>): string {
    return `${this.consoleBaseUrl}/ticket/${encodeURIComponent(ticket.displayId || ticket.ticketId)}`;
  }

  // ─── Capabilities ───────────────────────────────────────────────────────────

  /** Probes once and memoises; concurrent callers share the same in-flight probe. */
  async ensureCapabilities(force = false): Promise<PsaCapabilities> {
    if (this.capabilities && !force) return this.capabilities;
    if (this.probeInFlight && !force) return this.probeInFlight;

    this.probeInFlight = (async () => {
      const caps = await this.withErrorMapping(() => probeCapabilities(this.client, this.endpoint));
      this.capabilities = caps;
      this.sortRejected = false;
      if (this.onCapabilities) {
        try {
          await this.onCapabilities(caps);
        } catch (err) {
          log.warn('Could not persist discovered capabilities', err);
        }
      }
      return caps;
    })();

    try {
      return await this.probeInFlight;
    } finally {
      this.probeInFlight = null;
    }
  }

  getCapabilities(): PsaCapabilities | null {
    return this.capabilities;
  }

  // ─── Reads ──────────────────────────────────────────────────────────────────

  async pollNewTickets(sinceUnixSeconds: number): Promise<PsaTicket[]> {
    const caps = await this.ensureCapabilities();
    if (!caps.listQuery || !caps.listResultField || !caps.listArgName) {
      throw new PsaError(
        'This SuperOps schema exposes no usable ticket list query. Re-run the connection test in Settings for details.',
        { retryable: false },
      );
    }

    // The dedup ledger is the real guard against reprocessing, so the window
    // only needs to be wide enough not to miss anything: a generous overlap is
    // cheap, a missed ticket is not.
    const cutoff = sinceUnixSeconds > 0
      ? sinceUnixSeconds - 15 * 60
      : Math.floor(Date.now() / 1000) - 24 * 60 * 60;

    const collected: PsaTicket[] = [];
    const sortedNewestFirst = Boolean(caps.sortClause && !this.sortRejected);

    for (let page = 1; page <= MAX_PAGES; page++) {
      const batch = await this.fetchTicketPage(caps, page);
      if (batch.length === 0) break;

      const fresh = batch.filter((t) => t.createdAt === null || t.createdAt > cutoff);
      collected.push(...fresh);

      // With a newest-first sort, the first page that runs off the end of the
      // window means every later page is older still.
      if (sortedNewestFirst && fresh.length < batch.length) break;
      if (batch.length < MAX_PAGE_SIZE) break;
      if (!sortedNewestFirst && collected.length >= MAX_PAGE_SIZE * 3) {
        // Unsorted: stop after a few pages rather than walking the whole history.
        log.warn('Ticket list is unsorted; stopping after 3 pages. Older tickets may be missed.');
        break;
      }
    }

    log.info(
      `Fetched ${collected.length} ticket(s) created after ${new Date(cutoff * 1000).toISOString()}` +
        (sortedNewestFirst ? '' : ' (unsorted list)'),
    );
    return collected;
  }

  private async fetchTicketPage(caps: PsaCapabilities, page: number): Promise<PsaTicket[]> {
    const query = buildListQuery(caps);
    const input: Record<string, unknown> = { page, pageSize: MAX_PAGE_SIZE };
    if (caps.sortClause && caps.sortFieldNames && !this.sortRejected) {
      input.sort = [
        {
          [caps.sortFieldNames.attribute]: caps.sortClause.attribute,
          [caps.sortFieldNames.order]: caps.sortClause.order,
        },
      ];
    }

    try {
      const data = await this.request<Record<string, unknown>>(query, { [caps.listArgName!]: input });
      return extractTickets(data, caps);
    } catch (err) {
      // A schema that advertises `sort` but rejects our clause shape is exactly
      // the failure mode that broke this integration before. Drop the sort and
      // carry on unsorted rather than returning nothing.
      if (!this.sortRejected && caps.sortClause && isValidationError(err)) {
        log.warn(`Sorted ticket query rejected (${describeError(err)}); retrying unsorted.`);
        this.sortRejected = true;
        return this.fetchTicketPage(caps, page);
      }
      throw err;
    }
  }

  /**
   * Fetches the fields the list query cannot project — above all the ticket
   * body, without which the classifier only ever sees a subject line.
   */
  async enrichTicket(ticket: PsaTicket): Promise<PsaTicket> {
    const caps = await this.ensureCapabilities();
    if (ticket.body) return ticket;
    try {
      const body = await this.fetchBody(caps, ticket.ticketId);
      if (body) return { ...ticket, body };
    } catch (err) {
      log.warn(`Could not fetch the body for ticket ${ticket.ticketId}: ${describeError(err)}`);
    }
    return ticket;
  }

  private async fetchBody(caps: PsaCapabilities, ticketId: string): Promise<string | null> {
    if (caps.bodyField && caps.detailQuery && caps.detailArgName) return this.fetchBodyField(caps, ticketId);
    if (caps.conversationQuery) return this.fetchFirstConversation(caps, ticketId);
    return null;
  }

  /** Reads the newest ticket's body, so the connection test proves it on real data. */
  private async checkBody(caps: PsaCapabilities): Promise<ConnectionTestResult['bodyCheck']> {
    if (!caps.listQuery || !caps.listResultField || !caps.listArgName) return undefined;
    if (!(caps.bodyField || caps.conversationQuery)) return undefined;
    let label: string | null = null;
    try {
      const [ticket] = await this.fetchTicketPage(caps, 1);
      if (!ticket) return undefined;
      label = ticket.displayId ? `#${ticket.displayId}` : ticket.ticketId;
      const body = await this.fetchBody(caps, ticket.ticketId);
      if (!body) return { ticket: label, error: 'The query ran but returned no text for this ticket.' };
      return { ticket: label, characters: body.length, preview: body.slice(0, 160) };
    } catch (err) {
      return { ticket: label, error: describeError(err) };
    }
  }

  private async fetchBodyField(caps: PsaCapabilities, ticketId: string): Promise<string | null> {
    const bodySelection = caps.bodySubField ? `${caps.bodyField} { ${caps.bodySubField} }` : caps.bodyField;
    const argValue = caps.detailArgIdField ? { [caps.detailArgIdField]: ticketId } : ticketId;
    // The argument is inlined as a literal rather than declared as a variable:
    // a `$var` declaration must name its type exactly, and that type is only
    // known from introspection. `literal()` JSON-escapes every string.
    const query = `
      query SwoopTicketDetail {
        ${caps.detailQuery}(${caps.detailArgName}: ${literal(argValue)}) {
          ${caps.idField}
          ${bodySelection}
        }
      }
    `;
    const data = await this.request<Record<string, unknown>>(query);
    const node = data[caps.detailQuery!] as Record<string, unknown> | null;
    let raw = node?.[caps.bodyField!];
    if (caps.bodySubField && raw && typeof raw === 'object') raw = (raw as Record<string, unknown>)[caps.bodySubField];
    return typeof raw === 'string' && raw.trim() ? htmlToText(raw) : null;
  }

  /**
   * The requester's original message, from the ticket's conversation thread —
   * where SuperOps keeps it. The earliest entry is the one that opened the
   * ticket; later replies are left out so a long thread cannot drown it.
   */
  private async fetchFirstConversation(caps: PsaCapabilities, ticketId: string): Promise<string | null> {
    let argValue: unknown = ticketId;
    if (caps.conversationArgIdField) {
      const id = { [caps.conversationArgIdField]: ticketId };
      const input: Record<string, unknown> = caps.conversationArgTicketField ? { [caps.conversationArgTicketField]: id } : id;
      if (caps.conversationArgListField) {
        // One generous page: the message that opened the ticket is picked by time below.
        const paging: Record<string, number> = {};
        if (caps.conversationArgListFields.includes('page')) paging.page = 1;
        if (caps.conversationArgListFields.includes('pageSize')) paging.pageSize = MAX_PAGE_SIZE;
        input[caps.conversationArgListField] = paging;
      }
      argValue = input;
    }
    const entry = [caps.conversationContentField, caps.conversationTimeField].filter(Boolean).join(' ');
    const selection = caps.conversationResultField ? `${caps.conversationResultField} { ${entry} }` : entry;
    const query = `
      query SwoopTicketConversations {
        ${caps.conversationQuery}(${caps.conversationArgName}: ${literal(argValue)}) {
          ${selection}
        }
      }
    `;
    const data = await this.request<Record<string, unknown>>(query);
    const root = data[caps.conversationQuery!];
    const rows = caps.conversationResultField
      ? (root as Record<string, unknown> | null)?.[caps.conversationResultField]
      : root;
    if (!Array.isArray(rows)) return null;
    const entries = rows
      .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === 'object')
      .map((r, index) => ({
        text: typeof r[caps.conversationContentField!] === 'string' ? htmlToText(r[caps.conversationContentField!] as string) : '',
        at: caps.conversationTimeField ? parseTimestamp(r[caps.conversationTimeField]) : null,
        index,
      }))
      .filter((e) => e.text.trim());
    if (entries.length === 0) return null;
    // Order by time when every entry has one; otherwise trust the API's order.
    if (entries.every((e) => e.at !== null)) entries.sort((a, b) => a.at! - b.at! || a.index - b.index);
    return entries[0].text;
  }

  /**
   * Lists the MSP's clients so the UI can offer a picker.
   *
   * Returns null rather than throwing when the schema exposes no client list —
   * the allowlist still works with a hand-typed company ID, so this is a
   * convenience, not a dependency.
   */
  async listCompanies(): Promise<PsaCompany[] | null> {
    const caps = await this.ensureCapabilities();
    if (!caps.clientListQuery || !caps.clientListResultField || !caps.clientListIdField) {
      return null;
    }

    const selection = [caps.clientListIdField, caps.clientListNameField].filter(Boolean).join(' ');
    const arg = caps.clientListArgName
      ? `(${caps.clientListArgName}: ${literal({ page: 1, pageSize: MAX_PAGE_SIZE })})`
      : '';

    const query = `
      query SwoopClientList {
        ${caps.clientListQuery}${arg} {
          ${caps.clientListResultField} { ${selection} }
        }
      }
    `;

    const data = await this.request<Record<string, unknown>>(query);
    const root = data[caps.clientListQuery] as Record<string, unknown> | undefined;
    const rows = root?.[caps.clientListResultField];
    if (!Array.isArray(rows)) return [];

    return rows
      .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object')
      .map((row) => ({
        id: String(row[caps.clientListIdField!] ?? ''),
        name: String((caps.clientListNameField && row[caps.clientListNameField]) || ''),
      }))
      .filter((company) => company.id && company.name)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Knowledge base articles, a page at a time. Null when the schema exposes
   * no knowledge base the probe could recognise.
   */
  async listKbArticles(page: number): Promise<Array<{ id: string; title: string; body: string }> | null> {
    const caps = await this.ensureCapabilities();
    if (!caps.kbListQuery || !caps.kbResultField || !caps.kbIdField || !caps.kbTitleField) return null;
    const selection = [caps.kbIdField, caps.kbTitleField, caps.kbBodyField].filter(Boolean).join(' ');
    const arg = caps.kbListArgName ? `(${caps.kbListArgName}: ${literal({ page, pageSize: MAX_PAGE_SIZE })})` : '';
    const query = `
      query SwoopKbList {
        ${caps.kbListQuery}${arg} {
          ${caps.kbResultField} { ${selection} }
        }
      }
    `;
    const data = await this.request<Record<string, unknown>>(query);
    const root = data[caps.kbListQuery] as Record<string, unknown> | undefined;
    const rows = root?.[caps.kbResultField];
    if (!Array.isArray(rows)) return [];
    return rows
      .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object')
      .map((row) => ({
        id: String(row[caps.kbIdField!] ?? ''),
        title: String(row[caps.kbTitleField!] ?? '').trim(),
        body: caps.kbBodyField ? htmlToText(String(row[caps.kbBodyField] ?? '')) : '',
      }))
      .filter((a) => a.id && a.title);
  }

  // ─── Writes ─────────────────────────────────────────────────────────────────

  async addTicketNote(ticketId: string, note: string, isPrivate: boolean): Promise<void> {
    const caps = await this.ensureCapabilities();
    if (!caps.noteMutation || !caps.noteArgName || !caps.noteContentField) {
      throw new PsaError(
        'This SuperOps schema exposes no usable note mutation, so proposals cannot be written back. Swoop will keep classifying and logging.',
        { retryable: false },
      );
    }

    const input: Record<string, unknown> = { [caps.noteContentField]: note };

    if (caps.noteVisibilityField) {
      input[caps.noteVisibilityField] = visibilityValue(caps.noteVisibilityField, isPrivate);
    }

    if (caps.noteWorkItemField) {
      const workItem: Record<string, unknown> = {};
      const idKey = caps.noteWorkItemFields.find((f) => /^(workid|id|ticketid)$/i.test(f)) ?? 'workId';
      workItem[idKey] = ticketId;
      const moduleKey = caps.noteWorkItemFields.find((f) => /^module$/i.test(f));
      if (moduleKey) workItem[moduleKey] = 'TICKET';
      input[caps.noteWorkItemField] = workItem;
    } else if (caps.noteTicketField) {
      input[caps.noteTicketField] = caps.noteTicketIdField
        ? { [caps.noteTicketIdField]: ticketId }
        : ticketId;
    }

    const mutation = `
      mutation SwoopCreateNote {
        ${caps.noteMutation}(${caps.noteArgName}: ${literal(input)}) {
          __typename
        }
      }
    `;

    await this.request(mutation);
  }

  // ─── Diagnostics ────────────────────────────────────────────────────────────

  async testConnection(): Promise<ConnectionTestResult> {
    try {
      const capabilities = await this.ensureCapabilities(true);
      const bodyCheck = await this.checkBody(capabilities);
      return { ok: true, endpoint: this.endpoint, capabilities, ...(bodyCheck ? { bodyCheck } : {}) };
    } catch (err) {
      return { ok: false, endpoint: this.endpoint, error: describeError(err) };
    }
  }

  // ─── Transport ──────────────────────────────────────────────────────────────

  private async request<T>(document: string, variables?: Record<string, unknown>): Promise<T> {
    return this.withErrorMapping(() =>
      this.client.request<T>({
        document,
        variables,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }),
    );
  }

  /** Turns graphql-request's nested error shapes into actionable messages. */
  private async withErrorMapping<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw mapPsaError(err, this.endpoint, this.subdomain);
    }
  }
}

/**
 * graphql-request stringifies the entire request — query text included — into
 * `error.message`. Surfacing that raw was the previous behaviour and it made
 * every failure unreadable, so pull out the parts that identify the problem and
 * drop the rest.
 */
function summariseGraphQLMessage(message: string): { status?: number; detail: string } {
  const codeMatch = /GraphQL Error \(Code: (\d+)\)/.exec(message);
  const status = codeMatch ? Number.parseInt(codeMatch[1], 10) : undefined;

  const jsonStart = message.indexOf('{');
  if (jsonStart === -1) return { status, detail: message.slice(0, 300) };

  try {
    const payload = JSON.parse(message.slice(jsonStart)) as {
      response?: { errors?: Array<{ message?: string }>; error?: string; message?: string };
    };
    const response = payload.response ?? {};
    const detail =
      response.errors?.map((e) => e.message).filter(Boolean).join('; ') ||
      (typeof response.error === 'string' ? response.error : '') ||
      response.message ||
      '';
    return { status, detail: detail.slice(0, 300) };
  } catch {
    return { status, detail: '' };
  }
}

export function mapPsaError(err: unknown, endpoint: string, subdomain: string): PsaError {
  if (err instanceof PsaError) return err;

  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;

    const response = e.response as Record<string, unknown> | undefined;
    let status = typeof response?.status === 'number' ? response.status : undefined;

    const gqlErrors = Array.isArray(response?.errors) ? (response!.errors as Record<string, unknown>[]) : [];
    let gqlMessage = gqlErrors.length > 0 ? String(gqlErrors[0].message ?? '') : '';

    // Fall back to parsing the stringified form when the structured fields are
    // absent, which is how graphql-request reports a non-GraphQL HTTP error.
    if (typeof e.message === 'string' && e.message.startsWith('GraphQL Error')) {
      const parsed = summariseGraphQLMessage(e.message);
      status = status ?? parsed.status;
      gqlMessage = gqlMessage || parsed.detail;
    }

    if (status === 401 || status === 403) {
      return new PsaError(
        `SuperOps rejected the API token (HTTP ${status}). Check the token in Settings, and that the subdomain "${subdomain}" matches the account that issued it.`,
        { status, retryable: false },
      );
    }
    if (status === 404) {
      return new PsaError(
        `SuperOps returned HTTP 404 for ${endpoint}. Check the data centre setting — a US token will not work against the EU endpoint.`,
        { status, retryable: false },
      );
    }
    if (status === 429) {
      return new PsaError('SuperOps rate limit reached (HTTP 429). Swoop will retry on the next poll.', {
        status,
        retryable: true,
      });
    }
    if (status === 400) {
      // SuperOps answers an unusable token or a rejected query with a bare 400.
      return new PsaError(
        `SuperOps rejected the request (HTTP 400)${gqlMessage ? ` — ${gqlMessage}` : ''}. ` +
          'This is usually an invalid or revoked API token, or a subdomain that does not match the token. ' +
          `Check the credentials for "${subdomain}" in Settings.`,
        { status, retryable: false },
      );
    }
    if (status && status >= 500) {
      return new PsaError(`SuperOps returned HTTP ${status}${gqlMessage ? ` — ${gqlMessage}` : ''}.`, {
        status,
        retryable: true,
      });
    }
    if (gqlMessage) {
      return new PsaError(`SuperOps GraphQL error: ${gqlMessage}`, {
        status,
        retryable: !isValidationMessage(gqlMessage),
      });
    }

    const code = typeof e.code === 'string' ? e.code : '';
    if (code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'EAI_AGAIN') {
      return new PsaError(`Cannot reach ${endpoint} (${code}). Check outbound network access and DNS.`, {
        retryable: true,
      });
    }
    if (e.name === 'TimeoutError' || code === 'ETIMEDOUT' || code === 'ABORT_ERR') {
      return new PsaError(`SuperOps did not respond within ${REQUEST_TIMEOUT_MS / 1000}s.`, { retryable: true });
    }
  }

  const message = describeError(err);
  return new PsaError(
    message.startsWith('GraphQL Error')
      ? `SuperOps returned an error Swoop could not interpret. ${summariseGraphQLMessage(message).detail || 'No detail was included in the response.'}`
      : message.slice(0, 500),
  );
}

function isValidationMessage(message: string): boolean {
  return /validation|cannot query|unknown (field|argument|type)|is not defined|expected type/i.test(message);
}

function isValidationError(err: unknown): boolean {
  return err instanceof PsaError ? !err.retryable && !err.status : isValidationMessage(describeError(err));
}

/** SuperOps has used both an enum and a boolean for note visibility. */
function visibilityValue(fieldName: string, isPrivate: boolean): unknown {
  if (/^is/i.test(fieldName)) return isPrivate;
  // Enum values are emitted unquoted by `literal()` via the EnumLiteral marker.
  return new EnumLiteral(isPrivate ? 'PRIVATE' : 'PUBLIC');
}

/** Marks a string that must be emitted as a GraphQL enum, not a quoted string. */
export class EnumLiteral {
  constructor(readonly value: string) {}
}

/**
 * Serialises a value as a GraphQL literal.
 *
 * Inlining rather than using variables is deliberate: the input type names are
 * discovered at runtime, and a `$var` declaration has to name its type exactly.
 * Every string is JSON-escaped, so ticket content cannot break out of the
 * literal.
 */
export function literal(value: unknown): string {
  if (value instanceof EnumLiteral) return value.value;
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(literal).join(', ')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}: ${literal(v)}`);
    return `{${entries.join(', ')}}`;
  }
  return JSON.stringify(String(value));
}

/** Builds the ticket list query from whatever the schema actually exposes. */
export function buildListQuery(caps: PsaCapabilities): string {
  const selection: string[] = [caps.idField];
  for (const field of [caps.displayIdField, caps.subjectField, caps.statusField, caps.priorityField, caps.createdField]) {
    if (field && !selection.includes(field)) selection.push(field);
  }

  for (const shape of [caps.client, caps.requester]) {
    if (!shape.fieldName) continue;
    if (shape.shape === 'leaf') {
      selection.push(shape.fieldName);
    } else if (shape.shape === 'object' && shape.subFields.length > 0) {
      selection.push(`${shape.fieldName} { ${shape.subFields.join(' ')} }`);
    }
  }

  // The input type name came from introspection, so it can be declared as a
  // proper variable — unlike the detail query, whose arg type varies more.
  const inputVar = `$${caps.listArgName}`;
  const inputType = caps.listInputType ?? 'ListInfoInput';
  return `
    query SwoopTicketList(${inputVar}: ${inputType}!) {
      ${caps.listQuery}(${caps.listArgName}: ${inputVar}) {
        ${caps.listResultField} {
          ${selection.join('\n          ')}
        }
      }
    }
  `;
}

/** Normalises whatever the list query returned into PsaTicket records. */
export function extractTickets(data: unknown, caps: PsaCapabilities): PsaTicket[] {
  const root = (data as Record<string, unknown>)?.[caps.listQuery!] as Record<string, unknown> | undefined;
  const raw = root?.[caps.listResultField!];
  if (!Array.isArray(raw)) return [];

  return raw
    .filter((node): node is Record<string, unknown> => Boolean(node) && typeof node === 'object')
    .map((node) => normaliseTicket(node, caps));
}

export function normaliseTicket(node: Record<string, unknown>, caps: PsaCapabilities): PsaTicket {
  const clientValue = caps.client.fieldName ? node[caps.client.fieldName] : undefined;
  const requesterValue = caps.requester.fieldName ? node[caps.requester.fieldName] : undefined;

  const bodyRaw = caps.bodyField ? node[caps.bodyField] : undefined;

  return {
    ticketId: String(node[caps.idField] ?? ''),
    displayId: caps.displayIdField ? stringOrNull(node[caps.displayIdField]) : null,
    subject: caps.subjectField ? String(node[caps.subjectField] ?? '') : '',
    body: typeof bodyRaw === 'string' ? htmlToText(bodyRaw) : '',
    status: caps.statusField ? stringOrNull(node[caps.statusField]) : null,
    priority: caps.priorityField ? stringOrNull(node[caps.priorityField]) : null,
    createdAt: caps.createdField ? parseTimestamp(node[caps.createdField]) : null,
    clientId: readSubField(clientValue, caps.client.idField),
    clientName: readSubField(clientValue, caps.client.labelField) ?? stringOrNull(clientValue),
    requesterEmail: readEmail(requesterValue, caps.requester.labelField),
    requesterName: readSubField(requesterValue, 'name') ?? stringOrNull(requesterValue),
  };
}

function stringOrNull(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number') return String(value);
  return null;
}

function readSubField(container: unknown, field: string | null): string | null {
  if (!field || !container || typeof container !== 'object') return null;
  return stringOrNull((container as Record<string, unknown>)[field]);
}

function readEmail(container: unknown, labelField: string | null): string | null {
  const direct = readSubField(container, labelField);
  if (direct && direct.includes('@')) return direct;
  if (container && typeof container === 'object') {
    for (const key of ['email', 'emailId', 'emailAddress']) {
      const value = readSubField(container, key);
      if (value?.includes('@')) return value;
    }
    return null;
  }
  const scalar = stringOrNull(container);
  return scalar?.includes('@') ? scalar : null;
}

/** SuperOps has returned ISO strings, epoch seconds and epoch millis. */
export function parseTimestamp(value: unknown): number | null {
  if (value === null || value === undefined) return null;

  if (typeof value === 'number' && Number.isFinite(value)) {
    // Anything past year 2600 in seconds is really milliseconds.
    return value > 20_000_000_000 ? Math.floor(value / 1000) : Math.floor(value);
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d+$/.test(trimmed)) return parseTimestamp(Number.parseInt(trimmed, 10));
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }

  return null;
}
