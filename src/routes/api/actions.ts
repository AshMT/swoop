import { Router } from 'express';
import { db } from '../../db';
import { actionLogs, executionLogs, tenants, clients } from '../../db/schema';
import { eq, desc, and } from 'drizzle-orm';
import { requireAuth, type AuthRequest } from '../../middleware/auth';
import { executeAction } from '../../services/executor';
import { getPolicy } from '../../services/policies';
import { getActivePipeline, getExecFeed } from '../../services/pipeline';
import { classifyTicket } from '../../services/ai';
import { formatProposalNote } from '../../services/poller';

const router = Router();

router.use(requireAuth);

router.get('/pending-count', async (req, res) => {
  const tenantId = req.query.tenantId as string | undefined;
  const rows = tenantId
    ? await db.select({ id: actionLogs.id }).from(actionLogs)
        .where(and(eq(actionLogs.tenantId, tenantId), eq(actionLogs.status, 'awaiting_approval')))
    : await db.select({ id: actionLogs.id }).from(actionLogs)
        .where(eq(actionLogs.status, 'awaiting_approval'));
  res.json({ pending: rows.length });
});

router.get('/', async (req, res) => {
  const { clientId, tenantId, classification, status, limit: limitStr } = req.query as Record<string, string>;
  const limit = Math.min(parseInt(limitStr || '50', 10) || 50, 200);

  const conditions = [];
  if (clientId) conditions.push(eq(actionLogs.clientId, clientId));
  if (tenantId) conditions.push(eq(actionLogs.tenantId, tenantId));
  if (classification) conditions.push(eq(actionLogs.classification, classification));
  if (status) conditions.push(eq(actionLogs.status, status));

  const rows = await db
    .select({
      id: actionLogs.id,
      tenantId: actionLogs.tenantId,
      clientId: actionLogs.clientId,
      ticketId: actionLogs.ticketId,
      ticketSubject: actionLogs.ticketSubject,
      ticketBody: actionLogs.ticketBody,
      requesterEmail: actionLogs.requesterEmail,
      classification: actionLogs.classification,
      confidence: actionLogs.confidence,
      sensitivity: actionLogs.sensitivity,
      entities: actionLogs.entities,
      reasoning: actionLogs.reasoning,
      followUpQuestion: actionLogs.followUpQuestion,
      proposedPsaNote: actionLogs.proposedPsaNote,
      status: actionLogs.status,
      approvedBy: actionLogs.approvedBy,
      approvedAt: actionLogs.approvedAt,
      rejectionReason: actionLogs.rejectionReason,
      verificationMethod: actionLogs.verificationMethod,
      verifiedBy: actionLogs.verifiedBy,
      verifiedAt: actionLogs.verifiedAt,
      createdAt: actionLogs.createdAt,
    })
    .from(actionLogs)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(actionLogs.createdAt))
    .limit(limit);

  res.json(rows);
});

router.get('/stats', async (req, res) => {
  const tenantId = req.query.tenantId as string | undefined;

  const allLogs = tenantId
    ? await db.select({ classification: actionLogs.classification, sensitivity: actionLogs.sensitivity, status: actionLogs.status })
        .from(actionLogs)
        .where(eq(actionLogs.tenantId, tenantId))
    : await db.select({ classification: actionLogs.classification, sensitivity: actionLogs.sensitivity, status: actionLogs.status })
        .from(actionLogs);

  const total = allLogs.length;
  const byClassification: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  let highSensitivity = 0;

  for (const log of allLogs) {
    const cls = log.classification || 'unknown';
    byClassification[cls] = (byClassification[cls] || 0) + 1;
    const s = log.status || 'unknown';
    byStatus[s] = (byStatus[s] || 0) + 1;
    if (log.sensitivity === 'high') highSensitivity++;
  }

  res.json({ total, byClassification, byStatus, highSensitivity });
});

// Live view of tickets currently moving through the pipeline (in-memory, near-real-time).
// Defined before '/:id' so it isn't captured by the param route.
router.get('/processing', (req, res) => {
  const tenantId = req.query.tenantId as string | undefined;
  res.json(getActivePipeline(tenantId));
});

router.get('/:id', async (req, res) => {
  const [log] = await db
    .select()
    .from(actionLogs)
    .where(eq(actionLogs.id, req.params.id))
    .limit(1);

  if (!log) {
    res.status(404).json({ error: 'Action log not found' });
    return;
  }
  res.json(log);
});

// Retry an action that got stuck.
//   failed      → reset to awaiting_approval so the user can re-approve and re-execute
//   escalated / follow_up → re-run AI classification against stored ticket data;
//                           if successful, moves to awaiting_approval
router.post('/:id/retry', async (req: AuthRequest, res) => {
  const { id } = req.params;

  const [log] = await db.select().from(actionLogs).where(eq(actionLogs.id, id)).limit(1);
  if (!log) {
    res.status(404).json({ error: 'Action log not found' });
    return;
  }

  if (!['failed', 'escalated', 'follow_up'].includes(log.status ?? '')) {
    res.status(400).json({ error: `Retry is only available for failed, escalated, or follow_up actions (current: ${log.status})` });
    return;
  }

  // Failed execution: reset to awaiting_approval so the user re-approves.
  // Optional `entities` body patch lets the caller fill in missing fields before re-queuing.
  if (log.status === 'failed') {
    const { entities: entityPatch } = req.body as { entities?: Record<string, string> };
    let entities = log.entities;
    if (entityPatch && Object.keys(entityPatch).length > 0) {
      const existing = log.entities ? (() => { try { return JSON.parse(log.entities); } catch { return {}; } })() : {};
      entities = JSON.stringify({ ...existing, ...entityPatch });
    }
    await db.update(actionLogs)
      .set({ status: 'awaiting_approval', approvedBy: null, approvedAt: null, entities })
      .where(eq(actionLogs.id, id));
    const [updated] = await db.select().from(actionLogs).where(eq(actionLogs.id, id)).limit(1);
    res.json(updated);
    return;
  }

  // Escalated / follow-up: re-run AI classification
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, log.tenantId!)).limit(1);
  if (!tenant) {
    res.status(400).json({ error: 'Tenant not found' });
    return;
  }
  const [client] = await db.select().from(clients).where(eq(clients.id, log.clientId!)).limit(1);

  const { classification, rawResponse } = await classifyTicket(
    {
      subject: log.ticketSubject || '',
      description: log.ticketBody || '',
      requesterEmail: log.requesterEmail || '',
    },
    { mspName: tenant.name, clientName: client?.name || '' },
    tenant,
  );

  const cls = classification.classification;
  const isActionable = cls !== 'ESCALATE' && cls !== 'FOLLOW_UP';
  const policy = isActionable ? await getPolicy(tenant.id, cls) : null;

  let newStatus: string;
  let reasoning = classification.reasoning;
  if (cls === 'ESCALATE') {
    newStatus = 'escalated';
  } else if (cls === 'FOLLOW_UP') {
    newStatus = 'follow_up';
  } else if (policy?.permission === 'disabled') {
    newStatus = 'escalated';
    reasoning = `${reasoning} [Action type "${cls}" is disabled by policy — escalated to a human]`;
  } else {
    newStatus = 'awaiting_approval';
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
    status: newStatus,
    approvedBy: null,
    approvedAt: null,
    rejectionReason: null,
  }).where(eq(actionLogs.id, id));

  const [updated] = await db.select().from(actionLogs).where(eq(actionLogs.id, id)).limit(1);
  res.json(updated);
});

router.post('/:id/approve', async (req: AuthRequest, res) => {
  const { id } = req.params;
  const approvedBy = req.user?.email ?? 'unknown';
  const { verificationMethod } = req.body as { verificationMethod?: string };

  try {
    // Enforce the action's policy: verification must be recorded when required
    const [log] = await db.select().from(actionLogs).where(eq(actionLogs.id, id)).limit(1);
    if (log?.tenantId && log.classification) {
      const policy = await getPolicy(log.tenantId, log.classification);
      if (policy?.permission === 'disabled') {
        res.status(403).json({ error: `Action type "${log.classification}" is disabled by policy` });
        return;
      }
      if (policy?.requireVerification && !verificationMethod) {
        res.status(400).json({
          error: 'Identity verification required: confirm how you verified the requester before approving',
          requiresVerification: true,
        });
        return;
      }
    }

    await executeAction(id, approvedBy, verificationMethod ? { method: verificationMethod } : undefined);
    const [updated] = await db.select().from(actionLogs).where(eq(actionLogs.id, id)).limit(1);
    res.json(updated);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes('not found') ? 404
      : message.includes('not awaiting approval') ? 409
      : 400;
    res.status(status).json({ error: message });
  }
});

router.post('/:id/reject', async (req: AuthRequest, res) => {
  const { id } = req.params;
  const { reason } = req.body as { reason?: string };

  const [existing] = await db.select().from(actionLogs).where(eq(actionLogs.id, id)).limit(1);
  if (!existing) {
    res.status(404).json({ error: 'Action log not found' });
    return;
  }
  if (existing.status !== 'awaiting_approval') {
    res.status(409).json({ error: `Action is not awaiting approval (status: ${existing.status})` });
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  await db
    .update(actionLogs)
    .set({
      status: 'rejected',
      approvedBy: req.user?.email ?? 'unknown',
      approvedAt: now,
      rejectionReason: reason ?? null,
    })
    .where(eq(actionLogs.id, id));

  const [updated] = await db.select().from(actionLogs).where(eq(actionLogs.id, id)).limit(1);
  res.json(updated);
});

// Live execution step feed for a single action (in-memory, ephemeral).
router.get('/:id/feed', (req, res) => {
  res.json(getExecFeed(req.params.id));
});

router.get('/:id/execution', async (req, res) => {
  const [log] = await db
    .select()
    .from(executionLogs)
    .where(eq(executionLogs.actionLogId, req.params.id))
    .limit(1);

  if (!log) {
    res.status(404).json({ error: 'Execution log not found' });
    return;
  }
  res.json(log);
});

export default router;
