import { db } from '../db';
import { tenants, clients, actionLogs, processedTickets } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { SuperOpsClient } from './psa/superops';
import { classifyTicket } from './ai';
import { decrypt } from './crypto';
import { getPolicy } from './policies';
import { executeAction } from './executor';
import { trackStart, trackStage, trackDone } from './pipeline';
import { warmupAi } from './ai';
import type { Tenant, Client, SuperOpsTicket, AiClassification } from '../types';

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '';
const POLL_INTERVAL_MS = 60_000;

let pollerTimer: ReturnType<typeof setInterval> | null = null;
let pollerRunning = false;
let noteFieldsLogged = false;

export function startPoller(): void {
  if (pollerTimer) return;
  console.log('[Poller] Starting — interval: 60s');
  // Warm up the AI model immediately so it's loaded before the first real ticket arrives.
  // This runs in the background — polling starts regardless.
  void db.select().from(tenants).limit(1).then(([t]) => { if (t) void warmupAi(t); });
  void runAllTenants();
  pollerTimer = setInterval(() => void runAllTenants(), POLL_INTERVAL_MS);
}

export function stopPoller(): void {
  if (pollerTimer) {
    clearInterval(pollerTimer);
    pollerTimer = null;
    console.log('[Poller] Stopped');
  }
}

// Extract client identifier from the flexible client field (string name or object)
function extractClientName(client: SuperOpsTicket['client']): string {
  if (!client) return '';
  if (typeof client === 'string') return client;
  return client.name || client.clientName || '';
}

// Extract requester email from the flexible requester field
function extractRequesterEmail(requester: SuperOpsTicket['requester']): string {
  if (!requester) return '';
  if (typeof requester === 'string') return requester;
  return requester.email || requester.emailId || '';
}

// Whether the ticket has a requester we can reply to. A SuperOps requester is a
// JSON object that may carry name/userId without an email — and sendMail routes
// to them regardless — so presence (not just email) is what we check.
function ticketHasRequester(requester: SuperOpsTicket['requester']): boolean {
  if (!requester) return false;
  if (typeof requester === 'string') return requester.trim().length > 0;
  return !!(requester.email || requester.emailId || requester.name);
}

async function runAllTenants(): Promise<void> {
  if (pollerRunning) {
    console.log('[Poller] Previous cycle still running — skipping this tick');
    return;
  }
  pollerRunning = true;
  try {
    let allTenants: Tenant[];
    try {
      allTenants = await db.select().from(tenants);
    } catch (err) {
      console.error('[Poller] Failed to load tenants:', err);
      return;
    }

    for (const tenant of allTenants) {
      await pollTenant(tenant).catch((err) => {
        console.error(`[Poller] Tenant "${tenant.name}" poll failed:`, err);
      });
    }
  } finally {
    pollerRunning = false;
  }
}

async function pollTenant(tenant: Tenant): Promise<void> {
  const pollStartedAt = Date.now(); // capture before any async work

  const enabledClients = await db
    .select()
    .from(clients)
    .where(and(eq(clients.tenantId, tenant.id), eq(clients.automationEnabled, true)));

  if (enabledClients.length === 0) return;

  const apiKey = ENCRYPTION_KEY
    ? decrypt(tenant.superopsApiKey, ENCRYPTION_KEY)
    : tenant.superopsApiKey;

  const superops = new SuperOpsClient(tenant.superopsSubdomain, apiKey, tenant.superopsRegion || 'us');

  if (!noteFieldsLogged) {
    noteFieldsLogged = true;
    void superops.logNoteInputFields();
    void superops.logConversationInputFields();
  }

  let tickets: SuperOpsTicket[];
  try {
    // since param kept for interface compatibility but is no longer used for filtering;
    // dedup via processedTickets table is the sole gate against reprocessing
    tickets = await superops.pollNewTickets(tenant.lastPolledAt || 0);
  } catch (err) {
    console.error(`[Poller] SuperOps poll failed for tenant "${tenant.name}":`, err);
    return;
  }

  console.log(`[Poller] Tenant "${tenant.name}": ${tickets.length} total ticket(s) to check`);

  for (const ticket of tickets) {
    await processTicket(ticket, tenant, enabledClients, superops);
  }

  // Information-gathering loop: check tickets where we asked the customer a
  // question — if they've replied, re-classify with the new context.
  await checkWaitingReplies(tenant, superops).catch((err) => {
    console.error(`[Poller] Reply check failed for tenant "${tenant.name}":`, err);
  });

  // Use poll start time so tickets created DURING a slow AI call are still in the next window
  await db
    .update(tenants)
    .set({ lastPolledAt: pollStartedAt })
    .where(eq(tenants.id, tenant.id));
}

async function processTicket(
  ticket: SuperOpsTicket,
  tenant: Tenant,
  enabledClients: Client[],
  superops: SuperOpsClient,
): Promise<void> {
  const ticketId = ticket.ticketId;

  // Dedup check
  const existing = await db
    .select()
    .from(processedTickets)
    .where(eq(processedTickets.ticketId, ticketId))
    .limit(1);

  if (existing.length > 0) return;

  // Match to an enabled client by superopsCompanyId (ID match) or client name (fallback)
  const clientName = extractClientName(ticket.client);
  const matchedClient = enabledClients.find((c) =>
    (c.superopsCompanyId && c.superopsCompanyId === clientName) ||
    (clientName && c.name.toLowerCase() === clientName.toLowerCase()),
  );

  if (!matchedClient) return;

  // Claim the ticket immediately so concurrent/overlapping poll cycles can't pick it up
  await markProcessed(ticketId, tenant.id);

  const requesterEmail = extractRequesterEmail(ticket.requester);
  console.log(`[Poller] Processing ticket ${ticketId}: "${ticket.subject}"`);

  // Live pipeline view — surfaces the ticket on the Dashboard the moment it's picked up
  trackStart({ ticketId, tenantId: tenant.id, subject: ticket.subject, clientName: matchedClient.name });

  let rawAiResponse = '';
  let classification;

  const ticketBody = ticket.description || '';

  try {
    trackStage(ticketId, 'classifying');
    const result = await classifyTicket(
      {
        subject: ticket.subject,
        description: ticketBody,
        requesterEmail,
      },
      {
        mspName: tenant.name,
        clientName: matchedClient.name,
      },
      tenant,
    );
    classification = result.classification;
    rawAiResponse = result.rawResponse;
  } catch (err) {
    console.error(`[Poller] AI classification failed for ticket ${ticketId}:`, err);
    trackDone(ticketId, 'failed');
    return; // already marked processed above
  }

  const cls = classification.classification;
  trackStage(ticketId, 'posting_note', { classification: cls, confidence: classification.confidence });

  // Always record the AI's analysis as an internal (private) note — audit trail
  const noteText = formatProposalNote(classification, tenant.name);
  try {
    await superops.addTicketNote(ticketId, noteText, true);
  } catch (err) {
    console.error(`[Poller] Failed to post note to ticket ${ticketId}:`, err);
  }

  const isActionable = cls !== 'ESCALATE' && cls !== 'FOLLOW_UP';

  // Consult the action policy (Rallied-style permission catalog)
  trackStage(ticketId, 'deciding');
  const policy = isActionable ? await getPolicy(tenant.id, cls) : null;

  const hasRequester = ticketHasRequester(ticket.requester);

  let status: string;
  let reasoning = classification.reasoning;
  let customerQuestion: string | null = null;
  let questionPostedAt: number | null = null;
  let askAttempts = 0;

  if (cls === 'FOLLOW_UP' && classification.follow_up_question) {
    // Information gathering: ask the customer via a real reply (emails the
    // requester) so their answer comes back as a REQ_REPLY. Falls back to a
    // public note only when there's no requester to email.
    customerQuestion = classification.follow_up_question;
    const ask = formatCustomerQuestion(customerQuestion, tenant.name);
    const channel = await superops.sendCustomerMessage(ticketId, ask, hasRequester);
    if (channel !== 'failed') {
      questionPostedAt = Math.floor(Date.now() / 1000);
      askAttempts = 1;
      status = 'waiting_on_customer';
      console.log(`[Poller] Ticket ${ticketId}: asked customer via ${channel} — "${customerQuestion}"`);
    } else {
      status = 'follow_up'; // couldn't reach the customer — leave for a human
    }
  } else if (cls === 'ESCALATE' || cls === 'FOLLOW_UP') {
    status = 'escalated';
    // Escalation: post an internal note formatted FOR THE TECH, tagging the
    // escalation contact if one is configured.
    const escNote = formatEscalationNote(classification, tenant, ticket.subject, requesterEmail);
    try {
      await superops.addTicketNote(ticketId, escNote, true);
    } catch (err) {
      console.error(`[Poller] Failed to post escalation note to ticket ${ticketId}:`, err);
    }
  } else if (policy?.permission === 'disabled') {
    status = 'escalated';
    reasoning = `${reasoning} [Action type "${cls}" is disabled by policy — escalated to a human]`;
    const escNote = formatEscalationNote(
      { ...classification, escalation_reason: `Action type "${cls}" is disabled by policy` },
      tenant, ticket.subject, requesterEmail,
    );
    try {
      await superops.addTicketNote(ticketId, escNote, true);
    } catch { /* best-effort */ }
  } else {
    status = 'awaiting_approval';
  }

  const actionLogId = uuidv4();
  await db.insert(actionLogs).values({
    id: actionLogId,
    tenantId: tenant.id,
    clientId: matchedClient.id,
    ticketId,
    ticketSubject: ticket.subject,
    ticketBody: ticketBody || null,
    requesterEmail: requesterEmail || null,
    classification: cls,
    confidence: classification.confidence,
    sensitivity: classification.sensitivity,
    entities: JSON.stringify(classification.entities),
    reasoning,
    followUpQuestion: classification.follow_up_question,
    proposedPsaNote: noteText,
    rawAiResponse,
    status,
    customerQuestion,
    questionPostedAt,
    askAttempts,
  });

  console.log(
    `[Poller] Ticket ${ticketId} → ${cls} (confidence: ${classification.confidence.toFixed(2)}, policy: ${policy?.permission ?? 'n/a'})`,
  );

  // Pre-approved (auto) execution — guarded by confidence threshold and sensitivity.
  // High-sensitivity tickets ALWAYS require a human regardless of policy.
  let finalOutcome = status;
  if (status === 'awaiting_approval' && policy?.permission === 'auto') {
    const minConfidence = tenant.autoConfidenceMin ?? 0.9;
    if (classification.sensitivity === 'high') {
      console.log(`[Poller] Ticket ${ticketId}: auto policy skipped — high sensitivity requires human approval`);
    } else if (classification.confidence < minConfidence) {
      console.log(
        `[Poller] Ticket ${ticketId}: auto policy skipped — confidence ${classification.confidence.toFixed(2)} below threshold ${minConfidence}`,
      );
    } else {
      console.log(`[Poller] Ticket ${ticketId}: auto-executing per policy`);
      trackStage(ticketId, 'executing');
      try {
        await executeAction(actionLogId, 'swoop:auto-policy');
        const [after] = await db.select().from(actionLogs).where(eq(actionLogs.id, actionLogId)).limit(1);
        finalOutcome = after?.status ?? status;
        if (after?.status === 'executed') {
          // Tell the customer it's done (reply, emails the requester), keep the
          // technical record as an internal note.
          await superops.sendCustomerMessage(ticketId, formatCompletionNote(classification, tenant.name), hasRequester);
          try {
            await superops.addTicketNote(ticketId, `🤖 **Swoop AI Agent** — pre-approved action auto-executed per policy: ✅ executed successfully`, true);
          } catch { /* note is best-effort */ }
        } else {
          try {
            await superops.addTicketNote(ticketId, `🤖 **Swoop AI Agent** — pre-approved action auto-executed per policy: ❌ execution failed — see Swoop dashboard`, true);
          } catch { /* note is best-effort */ }
        }
      } catch (err) {
        // Pre-execution failure (e.g. CIPP not configured) — action stays awaiting_approval for a human
        console.error(`[Poller] Auto-execution failed for ticket ${ticketId}, left in approval queue:`, err);
      }
    }
  }

  trackDone(ticketId, finalOutcome);
}

async function markProcessed(ticketId: string, tenantId: string): Promise<void> {
  await db
    .insert(processedTickets)
    .values({ ticketId, tenantId })
    .onConflictDoNothing();
}

// ─── Information-gathering loop ──────────────────────────────────────────────
// For every action waiting on the customer, check the ticket conversation for a
// new reply. When one arrives, re-classify with the full Q&A context and move
// the action forward (approval queue, another question, or tech escalation).

const MAX_ASK_ATTEMPTS = 2;

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

// Conversation `time` is an ISO string; parse defensively (fall back to epoch).
function parseConvTime(t: string | null | undefined): number {
  if (!t) return 0;
  const ms = new Date(t).getTime();
  if (!Number.isNaN(ms)) return ms;
  const n = Number(t);
  return Number.isNaN(n) ? 0 : n;
}

async function checkWaitingReplies(tenant: Tenant, superops: SuperOpsClient): Promise<void> {
  const waiting = await db
    .select()
    .from(actionLogs)
    .where(and(eq(actionLogs.tenantId, tenant.id), eq(actionLogs.status, 'waiting_on_customer')));

  if (waiting.length === 0) return;
  console.log(`[Poller] ${waiting.length} ticket(s) waiting on customer — checking for replies`);

  for (const log of waiting) {
    const conversations = await superops.getTicketConversations(log.ticketId);
    if (conversations.length === 0) continue; // none yet, or query unsupported

    // Only genuine requester replies posted AFTER we asked. The `type` enum is
    // the canonical author signal — REQ_REPLY is the customer; our own replies
    // are TECH_REPLY, so we can never mistake them for the customer's.
    const askedAt = (log.questionPostedAt ?? 0) * 1000;
    const newReplies = conversations
      .filter((c) => c.type === 'REQ_REPLY' && parseConvTime(c.time) > askedAt)
      .map((c) => stripHtml(c.content || ''))
      .filter(Boolean);

    if (newReplies.length === 0) continue;

    const replyText = newReplies.join('\n');
    console.log(`[Poller] Ticket ${log.ticketId}: customer replied — re-classifying`);

    await processCustomerReply(log.id, replyText, tenant, superops);
  }
}

/**
 * Re-run classification with the customer's answer folded into the context,
 * then route the action: approval queue, ask again (max 2), or escalate.
 * Exported so the API retry endpoint can feed in a manually-entered answer.
 */
export async function processCustomerReply(
  actionLogId: string,
  replyText: string,
  tenant: Tenant,
  superops: SuperOpsClient | null,
): Promise<void> {
  const [log] = await db.select().from(actionLogs).where(eq(actionLogs.id, actionLogId)).limit(1);
  if (!log) return;

  const [client] = log.clientId
    ? await db.select().from(clients).where(eq(clients.id, log.clientId)).limit(1)
    : [undefined];

  // Surface the re-classification in the live pipeline view
  trackStart({
    ticketId: log.ticketId,
    tenantId: tenant.id,
    subject: log.ticketSubject || '(no subject)',
    clientName: client?.name || '',
  });
  trackStage(log.ticketId, 'classifying');

  const contextBody = [
    log.ticketBody || '',
    '',
    `--- ADDITIONAL INFORMATION GATHERED ---`,
    log.customerQuestion ? `WE ASKED THE CUSTOMER: ${log.customerQuestion}` : '',
    `CUSTOMER REPLIED: ${replyText}`,
  ].filter(Boolean).join('\n');

  const { classification, rawResponse } = await classifyTicket(
    {
      subject: log.ticketSubject || '',
      description: contextBody,
      requesterEmail: log.requesterEmail || '',
    },
    { mspName: tenant.name, clientName: client?.name || '' },
    tenant,
  );

  const cls = classification.classification;
  const isActionable = cls !== 'ESCALATE' && cls !== 'FOLLOW_UP';
  const policy = isActionable ? await getPolicy(tenant.id, cls) : null;
  const attempts = log.askAttempts ?? 0;

  let status: string;
  let reasoning = classification.reasoning;
  let customerQuestion = log.customerQuestion;
  let questionPostedAt = log.questionPostedAt;
  let askAttempts = attempts;

  trackStage(log.ticketId, 'deciding', { classification: cls, confidence: classification.confidence });

  if (isActionable && policy?.permission !== 'disabled') {
    status = 'awaiting_approval';
  } else if (cls === 'FOLLOW_UP' && classification.follow_up_question && attempts < MAX_ASK_ATTEMPTS && superops) {
    // Still missing something — ask once more (via reply), then stop bothering the customer
    customerQuestion = classification.follow_up_question;
    const channel = await superops.sendCustomerMessage(
      log.ticketId,
      formatCustomerQuestion(customerQuestion, tenant.name),
      !!log.requesterEmail,
    );
    if (channel !== 'failed') {
      questionPostedAt = Math.floor(Date.now() / 1000);
      askAttempts = attempts + 1;
      status = 'waiting_on_customer';
      console.log(`[Poller] Ticket ${log.ticketId}: asked customer again via ${channel} (attempt ${askAttempts})`);
    } else {
      status = 'escalated';
    }
  } else {
    status = 'escalated';
    reasoning = isActionable
      ? `${reasoning} [Action type "${cls}" is disabled by policy — escalated to a human]`
      : `${reasoning} [Could not resolve after ${attempts} customer question(s) — escalated to a human]`;
    if (superops) {
      try {
        await superops.addTicketNote(
          log.ticketId,
          formatEscalationNote(classification, tenant, log.ticketSubject || '', log.requesterEmail || ''),
          true,
        );
      } catch { /* best-effort */ }
    }
  }

  // Post the updated analysis as an internal note
  if (superops) {
    try {
      await superops.addTicketNote(log.ticketId, formatProposalNote(classification, tenant.name), true);
    } catch { /* best-effort */ }
  }

  await db.update(actionLogs).set({
    classification: cls,
    confidence: classification.confidence,
    sensitivity: classification.sensitivity,
    entities: JSON.stringify(classification.entities),
    reasoning,
    followUpQuestion: classification.follow_up_question,
    proposedPsaNote: formatProposalNote(classification, tenant.name),
    rawAiResponse: rawResponse,
    status,
    customerReply: replyText,
    customerQuestion,
    questionPostedAt,
    askAttempts,
    approvedBy: null,
    approvedAt: null,
    rejectionReason: null,
  }).where(eq(actionLogs.id, actionLogId));

  trackDone(log.ticketId, status);
  console.log(`[Poller] Ticket ${log.ticketId} re-classified → ${cls} (status: ${status})`);
}

// ─── Note formatters ─────────────────────────────────────────────────────────

/** Friendly PUBLIC reply asking the customer for missing information. */
export function formatCustomerQuestion(question: string, mspName: string): string {
  return [
    `Hi, thanks for reaching out! 👋`,
    ``,
    `To get this sorted for you, we just need one more piece of information:`,
    ``,
    `**${question}**`,
    ``,
    `Reply to this ticket and we'll take care of the rest.`,
    ``,
    `— ${mspName} Support (Swoop AI assistant)`,
  ].join('\n');
}

/** PUBLIC confirmation posted after an action completes successfully. */
export function formatCompletionNote(classification: AiClassification, mspName: string): string {
  const e = classification.entities;
  const friendly: Record<string, string> = {
    password_reset: `The password for ${e.target_user_email || 'the requested account'} has been reset. A password reset notification is on its way.`,
    account_disable: `The account ${e.target_user_email || 'requested'} has been disabled.`,
    account_enable: `The account ${e.target_user_email || 'requested'} has been re-enabled.`,
    mfa_reset: `MFA has been reset for ${e.target_user_email || 'the requested account'} — they'll be prompted to set it up again at next sign-in.`,
    group_add: `${e.target_user_email || 'The user'} has been added to the "${e.group_name || 'requested'}" group.`,
    group_remove: `${e.target_user_email || 'The user'} has been removed from the "${e.group_name || 'requested'}" group.`,
    license_assign: `The ${e.license_sku || 'requested'} license has been assigned to ${e.target_user_email || 'the user'}.`,
    license_remove: `The ${e.license_sku || 'requested'} license has been removed from ${e.target_user_email || 'the user'}.`,
    mailbox_permission: `Mailbox permissions have been updated for ${e.target_user_email || 'the requested mailbox'}.`,
  };
  const detail = friendly[classification.classification] || 'The requested change has been completed.';
  return [
    `Hi, good news — this has been completed! ✅`,
    ``,
    detail,
    ``,
    `If anything doesn't look right, just reply to this ticket.`,
    ``,
    `— ${mspName} Support (Swoop AI assistant)`,
  ].join('\n');
}

/** INTERNAL escalation note written for the tech who will pick the ticket up. */
export function formatEscalationNote(
  classification: AiClassification,
  tenant: Tenant,
  subject: string,
  requesterEmail: string,
): string {
  const lines: string[] = [
    `🔴 **SWOOP ESCALATION — needs tech review**`,
    ``,
  ];
  if (tenant.escalationContact) {
    lines.push(`@${tenant.escalationContact} — please pick this up.`, ``);
  }
  lines.push(
    `**Ticket:** ${subject || '(no subject)'}`,
    `**Requester:** ${requesterEmail || 'unknown'}`,
    `**Why escalated:** ${classification.escalation_reason || 'AI could not confidently action this request'}`,
    ``,
    `**AI analysis:** ${classification.reasoning}`,
  );
  const e = classification.entities;
  const known: string[] = [];
  if (e.target_user_email) known.push(`• User: ${e.target_user_email}`);
  if (e.group_name) known.push(`• Group: ${e.group_name}`);
  if (e.license_sku) known.push(`• License: ${e.license_sku}`);
  if (known.length > 0) {
    lines.push(``, `**What we know so far:**`, ...known);
  }
  lines.push(
    ``,
    `**Action required:** Human judgement needed — review and respond to the customer directly.`,
  );
  return lines.join('\n');
}

export function formatProposalNote(classification: import('../types').AiClassification, mspName: string): string {
  const lines: string[] = [
    `🤖 **Swoop AI Agent** — ${mspName}`,
    ``,
    `**Classification:** ${classification.classification}`,
    `**Confidence:** ${(classification.confidence * 100).toFixed(0)}%`,
    `**Sensitivity:** ${classification.sensitivity}`,
    ``,
    `**Reasoning:** ${classification.reasoning}`,
  ];

  if (classification.follow_up_question) {
    lines.push(``, `**Follow-up needed:** ${classification.follow_up_question}`);
  }

  if (classification.escalation_reason) {
    lines.push(``, `**Escalation reason:** ${classification.escalation_reason}`);
  }

  const entities = classification.entities;
  const entityLines: string[] = [];
  if (entities.target_user_email) entityLines.push(`• User: ${entities.target_user_email}`);
  if (entities.target_user_display_name) entityLines.push(`• Display name: ${entities.target_user_display_name}`);
  if (entities.group_name) entityLines.push(`• Group: ${entities.group_name}`);
  if (entities.license_sku) entityLines.push(`• License: ${entities.license_sku}`);

  if (entityLines.length > 0) {
    lines.push(``, `**Entities extracted:**`, ...entityLines);
  }

  lines.push(``, `---`, `*This is a read-only proposal. No action has been taken.*`);

  return lines.join('\n');
}
