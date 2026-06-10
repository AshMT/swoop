import { Router } from 'express';
import { db } from '../../db';
import { actionLogs, executionLogs } from '../../db/schema';
import { eq, desc, and } from 'drizzle-orm';
import { requireAuth, type AuthRequest } from '../../middleware/auth';
import { executeAction } from '../../services/executor';
import { getPolicy } from '../../services/policies';
import { getActivePipeline } from '../../services/pipeline';

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
