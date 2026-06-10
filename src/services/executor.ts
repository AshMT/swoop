import { db } from '../db';
import { actionLogs, executionLogs, tenants, clients } from '../db/schema';
import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { CippClient } from './cipp';
import { SuperOpsClient } from './psa/superops';
import { decrypt } from './crypto';
import { addExecStep } from './pipeline';
import { formatCustomerQuestion } from './poller';
import type { AiClassification } from '../types';

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '';

const NON_ACTIONABLE = new Set(['ESCALATE', 'FOLLOW_UP']);

export interface VerificationInfo {
  method: string; // e.g. phone_callback, video_call, manager_confirmed
}

export async function executeAction(
  actionLogId: string,
  approvedBy: string,
  verification?: VerificationInfo,
): Promise<void> {
  const step = (message: string) => addExecStep(actionLogId, message);

  const [actionLog] = await db.select().from(actionLogs).where(eq(actionLogs.id, actionLogId)).limit(1);
  if (!actionLog) throw new Error(`Action log ${actionLogId} not found`);
  if (actionLog.status !== 'awaiting_approval') {
    throw new Error(`Action ${actionLogId} is not awaiting approval (status: ${actionLog.status})`);
  }
  if (!actionLog.classification || NON_ACTIONABLE.has(actionLog.classification)) {
    throw new Error(`Classification "${actionLog.classification}" is not executable`);
  }

  step(`Executing ${actionLog.classification} for ticket #${actionLog.ticketId}`);

  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, actionLog.tenantId!)).limit(1);
  if (!tenant) throw new Error('Tenant not found');
  if (!tenant.cippBaseUrl || !tenant.cippClientId || !tenant.cippClientSecret || !tenant.cippOauthTenantId) {
    throw new Error('CIPP not fully configured for this tenant — set Base URL, Client ID, Client Secret, and Tenant ID in Settings');
  }

  step(`Verified: CIPP configured at ${tenant.cippBaseUrl}`);

  const [client] = await db.select().from(clients).where(eq(clients.id, actionLog.clientId!)).limit(1);
  if (!client) throw new Error('Client not found');
  if (!client.cippTenantId) throw new Error(`Client "${client.name}" has no CIPP Tenant ID — edit the client in the Clients page and set its CIPP Tenant ID (e.g. contoso.onmicrosoft.com)`);

  step(`Target tenant: ${client.cippTenantId} (${client.name})`);

  // Mark approved before executing
  const now = Math.floor(Date.now() / 1000);
  await db.update(actionLogs).set({
    status: 'executing',
    approvedBy,
    approvedAt: now,
    ...(verification ? { verificationMethod: verification.method, verifiedBy: approvedBy, verifiedAt: now } : {}),
  }).where(eq(actionLogs.id, actionLogId));

  const clientSecret = ENCRYPTION_KEY ? decrypt(tenant.cippClientSecret, ENCRYPTION_KEY) : tenant.cippClientSecret;
  const cipp = new CippClient(tenant.cippBaseUrl, tenant.cippClientId, clientSecret, tenant.cippOauthTenantId, tenant.cippApiScope);

  // Reconstruct AiClassification from stored fields
  let entities: AiClassification['entities'] = {
    target_user_email: null,
    target_user_display_name: null,
    group_name: null,
    license_sku: null,
  };
  if (actionLog.entities) {
    try {
      entities = JSON.parse(actionLog.entities) as AiClassification['entities'];
    } catch { /* use defaults */ }
  }

  const classification: AiClassification = {
    classification: actionLog.classification,
    confidence: actionLog.confidence ?? 0,
    sensitivity: (actionLog.sensitivity as 'normal' | 'high') ?? 'normal',
    entities,
    reasoning: actionLog.reasoning ?? '',
    follow_up_question: actionLog.followUpQuestion ?? null,
    escalation_reason: null,
    proposed_psa_note: actionLog.proposedPsaNote ?? '',
  };

  const result = await cipp.execute(classification, client.cippTenantId, step);

  await db.insert(executionLogs).values({
    id: uuidv4(),
    actionLogId,
    result: result.ok ? 'success' : 'failure',
    response: result.response ? JSON.stringify(result.response) : null,
    error: result.error ?? null,
  });

  // Missing-entity failure (e.g. "license_sku required for license_remove"):
  // instead of dead-ending as 'failed', ask the customer for the missing detail
  // on the ticket and park the action as waiting_on_customer.
  if (!result.ok && result.error) {
    const missing = parseMissingEntity(result.error);
    if (missing) {
      const question = MISSING_ENTITY_QUESTIONS[missing] || `Could you provide the ${missing.replace(/_/g, ' ')}?`;
      step(`Missing information: ${missing} — asking the customer on the ticket`);
      const channel = await askCustomerOnTicket(tenant, actionLog.ticketId, question, !!actionLog.requesterEmail);
      if (channel !== 'failed') {
        step(`Question posted to ticket #${actionLog.ticketId} via ${channel} — waiting on customer reply`);
        await db.update(actionLogs).set({
          status: 'waiting_on_customer',
          customerQuestion: question,
          questionPostedAt: Math.floor(Date.now() / 1000),
          askAttempts: (actionLog.askAttempts ?? 0) + 1,
        }).where(eq(actionLogs.id, actionLogId));
        return;
      }
      step('Could not post the question to the ticket — marking failed for manual handling');
    }
  }

  step(result.ok ? 'Execution log saved — action complete' : 'Execution log saved — action failed');

  await db
    .update(actionLogs)
    .set({ status: result.ok ? 'executed' : 'failed' })
    .where(eq(actionLogs.id, actionLogId));
}

// CIPP execute() throws "X required for Y" when an entity wasn't extracted.
function parseMissingEntity(error: string): string | null {
  const m = error.match(/^(\w+) required for /);
  return m ? m[1] : null;
}

const MISSING_ENTITY_QUESTIONS: Record<string, string> = {
  target_user_email: 'What is the email address of the user this request is for?',
  group_name: 'What is the name of the group this request is for?',
  license_sku: 'Which license should this apply to? (e.g. Microsoft 365 Business Premium, Office 365 E3)',
};

async function askCustomerOnTicket(
  tenant: { superopsSubdomain: string; superopsApiKey: string; superopsRegion: string | null; name: string },
  ticketId: string,
  question: string,
  hasRequester: boolean,
): Promise<'reply' | 'public_note' | 'failed'> {
  try {
    const apiKey = ENCRYPTION_KEY ? decrypt(tenant.superopsApiKey, ENCRYPTION_KEY) : tenant.superopsApiKey;
    const superops = new SuperOpsClient(tenant.superopsSubdomain, apiKey, tenant.superopsRegion || 'us');
    return await superops.sendCustomerMessage(ticketId, formatCustomerQuestion(question, tenant.name), hasRequester);
  } catch (err) {
    console.error(`[Executor] Failed to ask customer on ticket ${ticketId}:`, err);
    return 'failed';
  }
}
