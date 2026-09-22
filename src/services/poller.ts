import { and, eq, lte, or, isNull } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db';
import { tenants, clients, actionLogs, processedTickets } from '../db/schema';
import { config } from '../config';
import { createPsaClient } from './psa/factory';
import type { SuperOpsClient } from './psa/superops';
import { PsaError } from './psa/superops';
import type { PsaTicket } from './psa/interface';
import { classifyTicket, applyPolicy, AiError } from './ai';
import { formatProposalNote, isNoteFormat } from './note-format';
import { matchTicketToClient, emptySummary, type PollSummary } from './matching';
import { pruneAllTenants } from './retention';
import { createLogger, describeError } from '../lib/logger';
import { runPool } from '../lib/pool';
import type { Client, Tenant } from '../types';

const log = createLogger('Poller');

/** A ticket is given up on after this many failed classification attempts. */
const MAX_ATTEMPTS = 4;
/** Backoff before a failed ticket is retried, by attempt number. */
const RETRY_BACKOFF_SECONDS = [60, 300, 900];
/** How many times to retry posting a note whose classification succeeded. */
const MAX_NOTE_ATTEMPTS = 5;

type TenantId = string;

interface TenantSchedule {
  timer: ReturnType<typeof setTimeout>;
  intervalSeconds: number;
}

const schedules = new Map<TenantId, TenantSchedule>();
const inFlight = new Set<TenantId>();
let running = false;
let supervisorTimer: ReturnType<typeof setInterval> | null = null;

/** How often the supervisor reconciles schedules against the tenant table. */
const SUPERVISOR_INTERVAL_MS = 30_000;
/** Log pruning is housekeeping, so it runs on a much slower timer. */
const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;

let retentionTimer: ReturnType<typeof setInterval> | null = null;

export function startPoller(): void {
  if (running) return;
  running = true;
  log.info('Starting');
  void reconcile();
  supervisorTimer = setInterval(() => void reconcile(), SUPERVISOR_INTERVAL_MS);

  // Prune once shortly after start so a long-running install does not have to
  // wait six hours after an operator first sets a retention window.
  const firstPrune = setTimeout(() => void pruneAllTenants(), 60_000);
  firstPrune.unref?.();
  retentionTimer = setInterval(() => void pruneAllTenants(), RETENTION_INTERVAL_MS);
  retentionTimer.unref?.();
}

/**
 * Stops scheduling and waits for any in-flight cycle to finish.
 *
 * Called from the SIGTERM handler: abandoning a cycle mid-classification would
 * leave tickets marked in-progress with no note posted, so a bounded wait is
 * worth the couple of seconds it costs on shutdown.
 */
export async function stopPoller(timeoutMs = 20_000): Promise<void> {
  running = false;
  if (supervisorTimer) {
    clearInterval(supervisorTimer);
    supervisorTimer = null;
  }
  if (retentionTimer) {
    clearInterval(retentionTimer);
    retentionTimer = null;
  }
  for (const schedule of schedules.values()) clearTimeout(schedule.timer);
  schedules.clear();

  const deadline = Date.now() + timeoutMs;
  while (inFlight.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (inFlight.size > 0) {
    log.warn(`Shutting down with ${inFlight.size} poll cycle(s) still running`);
  } else {
    log.info('Stopped');
  }
}

export function pollerStatus(): { running: boolean; tenants: number; inFlight: string[] } {
  return { running, tenants: schedules.size, inFlight: [...inFlight] };
}

/**
 * Brings the schedule map in line with the tenant table: adds new tenants,
 * drops deleted ones, and reschedules any whose interval changed in Settings.
 */
async function reconcile(): Promise<void> {
  if (!running) return;
  let rows: Tenant[];
  try {
    rows = await db.select().from(tenants);
  } catch (err) {
    log.error('Could not load tenants', err);
    return;
  }

  const seen = new Set<TenantId>();
  for (const tenant of rows) {
    seen.add(tenant.id);
    const desired = clampInterval(tenant.pollIntervalSeconds);
    const existing = schedules.get(tenant.id);
    if (!existing) {
      scheduleTenant(tenant.id, desired, 0);
    } else if (existing.intervalSeconds !== desired) {
      log.info(`Tenant ${tenant.name}: poll interval changed to ${desired}s`);
      clearTimeout(existing.timer);
      scheduleTenant(tenant.id, desired, desired * 1000);
    }
  }

  for (const [tenantId, schedule] of schedules) {
    if (seen.has(tenantId)) continue;
    clearTimeout(schedule.timer);
    schedules.delete(tenantId);
  }
}

/**
 * Concurrency is capped at 8: past that the bottleneck is the provider, and a
 * wide pool against a local model just queues requests inside Ollama while
 * holding more tickets in an unfinished state if the process dies.
 */
function clampConcurrency(value: number | null): number {
  if (!value || value < 1) return 1;
  return Math.min(Math.floor(value), 8);
}

function clampInterval(seconds: number | null): number {
  const fallback = config().defaultPollIntervalSeconds;
  const value = seconds && seconds > 0 ? seconds : fallback;
  return Math.min(Math.max(value, 15), 3600);
}

function scheduleTenant(tenantId: TenantId, intervalSeconds: number, delayMs: number): void {
  const timer = setTimeout(() => void tick(tenantId), delayMs);
  // A long poll interval should not hold the process open on shutdown.
  timer.unref?.();
  schedules.set(tenantId, { timer, intervalSeconds });
}

async function tick(tenantId: TenantId): Promise<void> {
  if (!running) return;

  let intervalSeconds = config().defaultPollIntervalSeconds;
  try {
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    if (!tenant) {
      schedules.delete(tenantId);
      return;
    }
    intervalSeconds = clampInterval(tenant.pollIntervalSeconds);
    await runTenantCycle(tenant);
  } catch (err) {
    log.error(`Unhandled error in the poll cycle for tenant ${tenantId}`, err);
  } finally {
    if (running) scheduleTenant(tenantId, intervalSeconds, intervalSeconds * 1000);
  }
}

/**
 * One poll cycle for one tenant. Safe to call directly — the API exposes it as
 * a "poll now" button so an operator does not have to wait out the interval.
 */
export async function runTenantCycle(tenant: Tenant): Promise<PollSummary> {
  const summary = emptySummary();

  if (inFlight.has(tenant.id)) {
    log.debug(`Tenant ${tenant.name}: previous cycle still running, skipping`);
    return summary;
  }
  inFlight.add(tenant.id);

  const startedAt = Date.now();
  // Captured before any await: a ticket created during a slow classification
  // must still fall inside the next window.
  const windowStart = Math.floor(startedAt / 1000);

  try {
    if (tenant.automationPaused) {
      log.debug(`Tenant ${tenant.name}: automation paused`);
      summary.outcome = 'paused';
      summary.error = 'Automation is paused in Settings.';
      await recordPollResult(tenant.id, { status: 'paused', durationMs: Date.now() - startedAt, ticketCount: 0 });
      return summary;
    }

    const enabledClients = await db
      .select()
      .from(clients)
      .where(and(eq(clients.tenantId, tenant.id), eq(clients.automationEnabled, true)));

    if (enabledClients.length === 0) {
      summary.outcome = 'idle';
      summary.error = 'No clients have automation enabled.';
      await recordPollResult(tenant.id, {
        status: 'idle',
        error: summary.error,
        durationMs: Date.now() - startedAt,
        ticketCount: 0,
      });
      return summary;
    }

    const psa = createPsaClient(tenant);

    let tickets: PsaTicket[];
    try {
      tickets = await psa.pollNewTickets(tenant.lastPolledAt ?? 0);
    } catch (err) {
      const message = describeError(err);
      log.error(`Tenant ${tenant.name}: could not fetch tickets — ${message}`);
      summary.outcome = 'error';
      summary.error = message;
      await recordPollResult(tenant.id, {
        status: 'error',
        error: message,
        durationMs: Date.now() - startedAt,
        ticketCount: 0,
      });
      return summary;
    }

    summary.fetched = tickets.length;

    // A classification whose note failed to post has already cost an AI call,
    // so retry just the note rather than re-running the whole thing.
    if (!tenant.dryRun) {
      await retryUndeliveredNotes(tenant, psa);
    }

    // Retry any ticket that previously failed and is now past its backoff.
    const retryable = await loadRetryableTickets(tenant.id);
    const retrySet = new Set(retryable);

    // Tickets are independent of each other: each claims its own ledger row
    // before any slow work, so running several at once cannot double-process.
    await runPool(
      tickets,
      (ticket) => processTicket(ticket, tenant, enabledClients, psa, summary, retrySet),
      {
        concurrency: clampConcurrency(tenant.classifyConcurrency),
        shouldContinue: () => running,
      },
    );

    // Only advance the watermark once the fetch succeeded, so a failed poll
    // does not skip the window it never actually read.
    await db
      .update(tenants)
      .set({ lastPolledAt: windowStart })
      .where(eq(tenants.id, tenant.id));

    summary.outcome = summary.failed > 0 ? 'degraded' : 'ok';
    summary.error =
      summary.failed > 0
        ? `${summary.failed} ticket(s) failed classification and will be retried.`
        : null;

    await recordPollResult(tenant.id, {
      status: summary.outcome,
      error: summary.error,
      durationMs: Date.now() - startedAt,
      ticketCount: summary.fetched,
    });

    if (summary.fetched > 0 || summary.classified > 0) {
      log.info(
        `Tenant ${tenant.name}: ${summary.fetched} fetched, ${summary.classified} classified, ${summary.failed} failed, ` +
          `${summary.skipped['already-processed']} already seen, ${summary.skipped['client-not-enabled']} not allowlisted`,
      );
    }
    return summary;
  } finally {
    inFlight.delete(tenant.id);
  }
}

/**
 * Re-posts notes for classifications that succeeded but whose write-back
 * failed, most often a transient PSA error or a rate limit. The classification
 * is already stored, so this costs nothing but the PSA call.
 */
async function retryUndeliveredNotes(tenant: Tenant, psa: SuperOpsClient): Promise<void> {
  const pending = await db
    .select({
      id: actionLogs.id,
      ticketId: actionLogs.ticketId,
      note: actionLogs.proposedPsaNote,
      attempts: actionLogs.noteAttempts,
    })
    .from(actionLogs)
    .where(
      and(
        eq(actionLogs.tenantId, tenant.id),
        eq(actionLogs.status, 'note_failed'),
        lte(actionLogs.noteAttempts, MAX_NOTE_ATTEMPTS - 1),
      ),
    )
    .limit(25);

  for (const row of pending) {
    if (!running || !row.note) continue;
    const attempt = (row.attempts ?? 1) + 1;
    try {
      await psa.addTicketNote(row.ticketId, row.note, true);
      await db
        .update(actionLogs)
        .set({ status: 'classified', notePosted: true, noteError: null, noteAttempts: attempt })
        .where(eq(actionLogs.id, row.id));
      log.info(`Ticket ${row.ticketId}: note delivered on retry ${attempt}`);
    } catch (err) {
      const message = describeError(err);
      const exhausted = attempt >= MAX_NOTE_ATTEMPTS;
      await db
        .update(actionLogs)
        .set({
          noteAttempts: attempt,
          noteError: exhausted ? `Gave up after ${attempt} attempts: ${message}` : message,
        })
        .where(eq(actionLogs.id, row.id));
      log.warn(
        `Ticket ${row.ticketId}: note retry ${attempt}/${MAX_NOTE_ATTEMPTS} failed${exhausted ? ' — giving up' : ''} — ${message}`,
      );
    }
  }
}

/** Ticket ids previously marked failed whose backoff has elapsed. */
async function loadRetryableTickets(tenantId: string): Promise<string[]> {
  const now = Math.floor(Date.now() / 1000);
  const rows = await db
    .select({ ticketId: processedTickets.ticketId })
    .from(processedTickets)
    .where(
      and(
        eq(processedTickets.tenantId, tenantId),
        eq(processedTickets.status, 'failed'),
        or(isNull(processedTickets.nextAttemptAt), lte(processedTickets.nextAttemptAt, now)),
      ),
    );
  return rows.map((r) => r.ticketId);
}

async function processTicket(
  ticket: PsaTicket,
  tenant: Tenant,
  enabledClients: Client[],
  psa: SuperOpsClient,
  summary: PollSummary,
  retrySet: Set<string>,
): Promise<void> {
  if (!ticket.ticketId) {
    summary.skipped['no-ticket-id']++;
    return;
  }

  const ledger = await readLedger(tenant.id, ticket.ticketId);
  if (ledger) {
    if (ledger.status === 'done') {
      summary.skipped['already-processed']++;
      return;
    }
    if ((ledger.attempts ?? 0) >= MAX_ATTEMPTS) {
      // Already retried to the limit and logged as a failure. Counting this as
      // "already processed" would hide it from the poll summary.
      summary.skipped['gave-up']++;
      return;
    }
    if (!retrySet.has(ticket.ticketId)) {
      summary.skipped['awaiting-retry']++;
      return;
    }
  }

  const matchedClient = matchTicketToClient(ticket, enabledClients);
  if (!matchedClient) {
    summary.skipped['client-not-enabled']++;
    return;
  }

  const attempt = (ledger?.attempts ?? 0) + 1;

  // Claim the ticket before the slow work so an overlapping cycle cannot pick
  // it up, but claim it as 'failed' with a retry time rather than 'done' — the
  // old code claimed it as complete, so any AI error lost the ticket silently.
  await claimTicket(tenant.id, ticket.ticketId, attempt);

  let enriched = ticket;
  try {
    enriched = await psa.enrichTicket(ticket);
  } catch (err) {
    log.warn(`Ticket ${ticket.ticketId}: could not enrich — ${describeError(err)}`);
  }

  log.debug(`Ticket ${ticket.ticketId} (attempt ${attempt}): "${enriched.subject}"`);

  const threshold = tenant.confidenceThreshold ?? 0.75;

  let result;
  try {
    result = await classifyTicket(
      {
        subject: enriched.subject,
        body: enriched.body,
        requesterEmail: enriched.requesterEmail,
        requesterName: enriched.requesterName,
        priority: enriched.priority,
        status: enriched.status,
      },
      {
        mspName: tenant.name,
        clientName: matchedClient.name,
        clientContext: matchedClient.contextNotes,
        confidenceThreshold: threshold,
      },
      tenant,
      matchedClient.systemPromptOverride,
    );
  } catch (err) {
    const message = describeError(err);
    const retryable = err instanceof AiError ? err.retryable : true;
    const willRetry = retryable && attempt < MAX_ATTEMPTS;

    log.error(
      `Ticket ${ticket.ticketId}: classification failed (attempt ${attempt}/${MAX_ATTEMPTS})${willRetry ? ', will retry' : ', giving up'} — ${message}`,
    );

    await markFailed(tenant.id, ticket.ticketId, attempt, message, willRetry);
    summary.failed++;

    // Record the failure as an action log so it is visible in the dashboard
    // instead of only in the container logs.
    if (!willRetry) {
      await writeFailureLog(tenant, matchedClient, enriched, message, attempt, err);
    }
    return;
  }

  const { classification, adjustments: policyAdjustments } = applyPolicy(result.classification, {
    confidenceThreshold: threshold,
    sourceText: `${enriched.subject}\n${enriched.body}\n${enriched.requesterEmail ?? ''}`,
  });
  const adjustments = [...result.adjustments, ...policyAdjustments];

  const note = formatProposalNote(classification, {
    mspName: tenant.name,
    dryRun: Boolean(tenant.dryRun),
    adjustments,
    format: isNoteFormat(tenant.noteFormat) ? tenant.noteFormat : 'plain',
  });

  let notePosted = false;
  let noteError: string | null = null;
  if (tenant.dryRun) {
    noteError = null;
  } else {
    try {
      await psa.addTicketNote(ticket.ticketId, note, true);
      notePosted = true;
    } catch (err) {
      noteError = describeError(err);
      log.error(`Ticket ${ticket.ticketId}: could not post the note — ${noteError}`);
    }
  }

  await db.insert(actionLogs).values({
    id: uuidv4(),
    tenantId: tenant.id,
    clientId: matchedClient.id,
    ticketId: ticket.ticketId,
    ticketDisplayId: enriched.displayId,
    ticketSubject: enriched.subject,
    ticketBody: enriched.body || null,
    requesterEmail: enriched.requesterEmail,
    classification: classification.classification,
    confidence: classification.confidence,
    sensitivity: classification.sensitivity,
    entities: JSON.stringify(classification.entities),
    reasoning: classification.reasoning,
    followUpQuestion: classification.follow_up_question,
    escalationReason: classification.escalation_reason,
    proposedPsaNote: note,
    rawAiResponse: result.rawResponse,
    status: noteError ? 'note_failed' : 'classified',
    errorMessage: noteError,
    aiModel: result.model,
    promptFingerprint: result.promptFingerprint,
    aiLatencyMs: result.latencyMs,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    notePosted,
    noteError,
    noteAttempts: tenant.dryRun ? 0 : 1,
  });

  await markDone(tenant.id, ticket.ticketId, attempt);
  summary.classified++;

  log.info(
    `Ticket ${enriched.displayId || ticket.ticketId} → ${classification.classification} ` +
      `(${Math.round(classification.confidence * 100)}%, ${result.latencyMs}ms${tenant.dryRun ? ', dry run' : ''})`,
  );
}

async function writeFailureLog(
  tenant: Tenant,
  client: Client,
  ticket: PsaTicket,
  message: string,
  attempt: number,
  err: unknown,
): Promise<void> {
  await db.insert(actionLogs).values({
    id: uuidv4(),
    tenantId: tenant.id,
    clientId: client.id,
    ticketId: ticket.ticketId,
    ticketDisplayId: ticket.displayId,
    ticketSubject: ticket.subject,
    ticketBody: ticket.body || null,
    requesterEmail: ticket.requesterEmail,
    // Deliberately not 'ESCALATE': a model outage is not the model declining a
    // ticket, and mixing the two corrupts the accuracy figures.
    classification: null,
    confidence: null,
    sensitivity: null,
    entities: null,
    reasoning: null,
    status: 'ai_failed',
    errorMessage: `Gave up after ${attempt} attempt(s): ${message}`,
    rawAiResponse: err instanceof AiError ? err.rawResponse || null : null,
    notePosted: false,
  });
}

// ─── Deduplication ledger ──────────────────────────────────────────────────────

async function readLedger(tenantId: string, ticketId: string) {
  const [row] = await db
    .select()
    .from(processedTickets)
    .where(and(eq(processedTickets.tenantId, tenantId), eq(processedTickets.ticketId, ticketId)))
    .limit(1);
  return row ?? null;
}

/** Claims a ticket as in-flight, reserving a retry slot if the work dies. */
async function claimTicket(tenantId: string, ticketId: string, attempt: number): Promise<void> {
  const nextAttemptAt = Math.floor(Date.now() / 1000) + backoffFor(attempt);
  await db
    .insert(processedTickets)
    .values({
      tenantId,
      ticketId,
      status: 'failed',
      attempts: attempt,
      lastError: 'Classification in progress',
      nextAttemptAt,
    })
    .onConflictDoUpdate({
      target: [processedTickets.tenantId, processedTickets.ticketId],
      set: { attempts: attempt, status: 'failed', lastError: 'Classification in progress', nextAttemptAt },
    });
}

async function markDone(tenantId: string, ticketId: string, attempt: number): Promise<void> {
  await db
    .update(processedTickets)
    .set({
      status: 'done',
      attempts: attempt,
      lastError: null,
      nextAttemptAt: null,
      processedAt: Math.floor(Date.now() / 1000),
    })
    .where(and(eq(processedTickets.tenantId, tenantId), eq(processedTickets.ticketId, ticketId)));
}

async function markFailed(
  tenantId: string,
  ticketId: string,
  attempt: number,
  error: string,
  willRetry: boolean,
): Promise<void> {
  await db
    .update(processedTickets)
    .set({
      status: 'failed',
      attempts: willRetry ? attempt : MAX_ATTEMPTS,
      lastError: error.slice(0, 1000),
      nextAttemptAt: willRetry ? Math.floor(Date.now() / 1000) + backoffFor(attempt) : null,
    })
    .where(and(eq(processedTickets.tenantId, tenantId), eq(processedTickets.ticketId, ticketId)));
}

function backoffFor(attempt: number): number {
  return RETRY_BACKOFF_SECONDS[Math.min(attempt - 1, RETRY_BACKOFF_SECONDS.length - 1)];
}

async function recordPollResult(
  tenantId: string,
  result: { status: string; error?: string | null; durationMs: number; ticketCount: number },
): Promise<void> {
  await db
    .update(tenants)
    .set({
      lastPollStatus: result.status,
      lastPollError: result.error ?? null,
      lastPollFinishedAt: Math.floor(Date.now() / 1000),
      lastPollDurationMs: result.durationMs,
      lastPollTicketCount: result.ticketCount,
    })
    .where(eq(tenants.id, tenantId));
}

/**
 * Re-runs classification for a single already-logged ticket.
 *
 * This is the prompt-tuning workflow: change the prompt, re-run a ticket you
 * know the right answer to, and see whether the verdict improves — without
 * waiting for a new ticket to arrive.
 */
export async function reclassifyTicket(
  tenantId: string,
  ticketId: string,
  options: { postNote?: boolean } = {},
): Promise<{ ok: boolean; error?: string; actionLogId?: string }> {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!tenant) return { ok: false, error: 'Tenant not found' };

  const [previous] = await db
    .select()
    .from(actionLogs)
    .where(and(eq(actionLogs.tenantId, tenantId), eq(actionLogs.ticketId, ticketId)))
    .limit(1);
  if (!previous) return { ok: false, error: 'No previous classification found for that ticket' };

  const [client] = previous.clientId
    ? await db.select().from(clients).where(eq(clients.id, previous.clientId)).limit(1)
    : [];

  const psa = createPsaClient(tenant);
  let ticket: PsaTicket = {
    ticketId,
    displayId: previous.ticketDisplayId,
    subject: previous.ticketSubject ?? '',
    body: previous.ticketBody ?? '',
    status: null,
    priority: null,
    createdAt: null,
    clientId: client?.superopsCompanyId ?? null,
    clientName: client?.name ?? null,
    requesterEmail: previous.requesterEmail,
    requesterName: null,
  };

  if (!ticket.body) {
    try {
      ticket = await psa.enrichTicket(ticket);
    } catch (err) {
      log.warn(`Reclassify ${ticketId}: could not re-fetch the body — ${describeError(err)}`);
    }
  }

  const threshold = tenant.confidenceThreshold ?? 0.75;

  let result;
  try {
    result = await classifyTicket(
      {
        subject: ticket.subject,
        body: ticket.body,
        requesterEmail: ticket.requesterEmail,
        requesterName: ticket.requesterName,
      },
      {
        mspName: tenant.name,
        clientName: client?.name ?? 'unknown client',
        clientContext: client?.contextNotes,
        confidenceThreshold: threshold,
      },
      tenant,
      client?.systemPromptOverride,
    );
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }

  const { classification, adjustments: policyAdjustments } = applyPolicy(result.classification, {
    confidenceThreshold: threshold,
    sourceText: `${ticket.subject}\n${ticket.body}\n${ticket.requesterEmail ?? ''}`,
  });
  const adjustments = [...result.adjustments, ...policyAdjustments];
  const note = formatProposalNote(classification, {
    mspName: tenant.name,
    dryRun: !options.postNote || Boolean(tenant.dryRun),
    adjustments,
    format: isNoteFormat(tenant.noteFormat) ? tenant.noteFormat : 'plain',
  });

  let notePosted = false;
  let noteError: string | null = null;
  if (options.postNote && !tenant.dryRun) {
    try {
      await psa.addTicketNote(ticketId, note, true);
      notePosted = true;
    } catch (err) {
      noteError = describeError(err);
    }
  }

  const id = uuidv4();
  await db.insert(actionLogs).values({
    id,
    tenantId,
    clientId: previous.clientId,
    ticketId,
    ticketDisplayId: ticket.displayId,
    ticketSubject: ticket.subject,
    ticketBody: ticket.body || null,
    requesterEmail: ticket.requesterEmail,
    classification: classification.classification,
    confidence: classification.confidence,
    sensitivity: classification.sensitivity,
    entities: JSON.stringify(classification.entities),
    reasoning: classification.reasoning,
    followUpQuestion: classification.follow_up_question,
    escalationReason: classification.escalation_reason,
    proposedPsaNote: note,
    rawAiResponse: result.rawResponse,
    status: noteError ? 'note_failed' : 'classified',
    errorMessage: noteError,
    aiModel: result.model,
    promptFingerprint: result.promptFingerprint,
    aiLatencyMs: result.latencyMs,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    notePosted,
    noteError,
  });

  return { ok: true, actionLogId: id };
}

export { PsaError };
