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
import type { Tenant, Client, SuperOpsTicket } from '../types';

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

  try {
    trackStage(ticketId, 'classifying');
    const result = await classifyTicket(
      {
        subject: ticket.subject,
        description: '',
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

  let status: string;
  let reasoning = classification.reasoning;
  if (cls === 'ESCALATE') {
    status = 'escalated';
  } else if (cls === 'FOLLOW_UP') {
    status = 'follow_up';
  } else if (policy?.permission === 'disabled') {
    status = 'escalated';
    reasoning = `${reasoning} [Action type "${cls}" is disabled by policy — escalated to a human]`;
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
    ticketBody: null,
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
        const outcome = after?.status === 'executed' ? '✅ executed successfully' : '❌ execution failed — see Swoop dashboard';
        try {
          await superops.addTicketNote(ticketId, `🤖 **Swoop AI Agent** — pre-approved action auto-executed per policy: ${outcome}`, true);
        } catch { /* note is best-effort */ }
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
