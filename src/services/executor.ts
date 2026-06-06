import { db } from '../db';
import { actionLogs, executionLogs, tenants, clients } from '../db/schema';
import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { CippClient } from './cipp';
import { decrypt } from './crypto';
import type { AiClassification } from '../types';

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '';

const NON_ACTIONABLE = new Set(['ESCALATE', 'FOLLOW_UP']);

export async function executeAction(actionLogId: string, approvedBy: string): Promise<void> {
  const [actionLog] = await db.select().from(actionLogs).where(eq(actionLogs.id, actionLogId)).limit(1);
  if (!actionLog) throw new Error(`Action log ${actionLogId} not found`);
  if (actionLog.status !== 'awaiting_approval') {
    throw new Error(`Action ${actionLogId} is not awaiting approval (status: ${actionLog.status})`);
  }
  if (!actionLog.classification || NON_ACTIONABLE.has(actionLog.classification)) {
    throw new Error(`Classification "${actionLog.classification}" is not executable`);
  }

  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, actionLog.tenantId!)).limit(1);
  if (!tenant) throw new Error('Tenant not found');
  if (!tenant.cippBaseUrl || !tenant.cippApiKey) throw new Error('CIPP not configured for this tenant');

  const [client] = await db.select().from(clients).where(eq(clients.id, actionLog.clientId!)).limit(1);
  if (!client) throw new Error('Client not found');
  if (!client.cippTenantId) throw new Error('Client has no CIPP tenant ID configured');

  // Mark approved before executing
  const now = Math.floor(Date.now() / 1000);
  await db.update(actionLogs).set({ status: 'executing', approvedBy, approvedAt: now }).where(eq(actionLogs.id, actionLogId));

  const cippApiKey = ENCRYPTION_KEY ? decrypt(tenant.cippApiKey, ENCRYPTION_KEY) : tenant.cippApiKey;
  const cipp = new CippClient(tenant.cippBaseUrl, cippApiKey);

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

  const result = await cipp.execute(classification, client.cippTenantId);

  await db.insert(executionLogs).values({
    id: uuidv4(),
    actionLogId,
    result: result.ok ? 'success' : 'failure',
    response: result.response ? JSON.stringify(result.response) : null,
    error: result.error ?? null,
  });

  await db
    .update(actionLogs)
    .set({ status: result.ok ? 'executed' : 'failed' })
    .where(eq(actionLogs.id, actionLogId));
}
