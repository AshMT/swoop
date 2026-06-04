import { db } from '../db';
import { tenants, clients, actionLogs, processedTickets } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { SuperOpsClient } from './psa/superops';
import { classifyTicket } from './ai';
import { decrypt } from './crypto';
import type { Tenant, Client, SuperOpsTicket } from '../types';

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '';
const POLL_INTERVAL_MS = 60_000;

let pollerTimer: ReturnType<typeof setInterval> | null = null;

export function startPoller(): void {
  if (pollerTimer) return;
  console.log('[Poller] Starting — interval: 60s');
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

async function runAllTenants(): Promise<void> {
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
}

async function pollTenant(tenant: Tenant): Promise<void> {
  // Only poll tenants that have at least one enabled client
  const enabledClients = await db
    .select()
    .from(clients)
    .where(and(eq(clients.tenantId, tenant.id), eq(clients.automationEnabled, true)));

  if (enabledClients.length === 0) return;

  const apiKey = ENCRYPTION_KEY
    ? decrypt(tenant.superopsApiKey, ENCRYPTION_KEY)
    : tenant.superopsApiKey;

  const superops = new SuperOpsClient(tenant.superopsSubdomain, apiKey, tenant.superopsRegion || 'us');

  let tickets: SuperOpsTicket[];
  try {
    tickets = await superops.pollNewTickets(tenant.lastPolledAt || 0);
  } catch (err) {
    console.error(`[Poller] SuperOps poll failed for tenant "${tenant.name}":`, err);
    return;
  }

  console.log(`[Poller] Tenant "${tenant.name}": ${tickets.length} ticket(s) fetched`);

  for (const ticket of tickets) {
    await processTicket(ticket, tenant, enabledClients, superops);
  }

  // Update last_polled_at
  await db
    .update(tenants)
    .set({ lastPolledAt: Date.now() })
    .where(eq(tenants.id, tenant.id));
}

async function processTicket(
  ticket: SuperOpsTicket,
  tenant: Tenant,
  enabledClients: Client[],
  superops: SuperOpsClient,
): Promise<void> {
  // Check dedup ledger
  const existing = await db
    .select()
    .from(processedTickets)
    .where(eq(processedTickets.ticketId, ticket.id))
    .limit(1);

  if (existing.length > 0) return;

  // Match ticket to an enabled client via company ID
  const matchedClient = enabledClients.find(
    (c) => c.superopsCompanyId === ticket.companyId,
  );

  if (!matchedClient) {
    // No matching enabled client — skip silently
    return;
  }

  console.log(`[Poller] Processing ticket ${ticket.id}: "${ticket.subject}"`);

  let rawAiResponse = '';
  let classification;

  try {
    const result = await classifyTicket(
      {
        subject: ticket.subject,
        description: ticket.description,
        requesterEmail: ticket.requesterEmail,
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
    console.error(`[Poller] AI classification failed for ticket ${ticket.id}:`, err);
    // Mark as processed to avoid retry loop
    await markProcessed(ticket.id, tenant.id);
    return;
  }

  // Post internal note to SuperOps (always private in Phase 1)
  const noteText = formatProposalNote(classification, tenant.name);
  try {
    await superops.addTicketNote(ticket.id, noteText, true);
  } catch (err) {
    console.error(`[Poller] Failed to post note to ticket ${ticket.id}:`, err);
    // Continue — still log to DB even if note fails
  }

  // Log to DB
  await db.insert(actionLogs).values({
    id: uuidv4(),
    tenantId: tenant.id,
    clientId: matchedClient.id,
    ticketId: ticket.id,
    ticketSubject: ticket.subject,
    ticketBody: ticket.description,
    requesterEmail: ticket.requesterEmail,
    classification: classification.classification,
    confidence: classification.confidence,
    sensitivity: classification.sensitivity,
    entities: JSON.stringify(classification.entities),
    reasoning: classification.reasoning,
    followUpQuestion: classification.follow_up_question,
    proposedPsaNote: noteText,
    rawAiResponse,
    status: 'pending',
  });

  // Mark as processed
  await markProcessed(ticket.id, tenant.id);

  console.log(
    `[Poller] Ticket ${ticket.id} → ${classification.classification} (confidence: ${classification.confidence.toFixed(2)})`,
  );
}

async function markProcessed(ticketId: string, tenantId: string): Promise<void> {
  await db
    .insert(processedTickets)
    .values({ ticketId, tenantId })
    .onConflictDoNothing();
}

function formatProposalNote(classification: import('../types').AiClassification, mspName: string): string {
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
