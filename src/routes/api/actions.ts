import { Router } from 'express';
import { db } from '../../db';
import { actionLogs, executionLogs } from '../../db/schema';
import { eq, desc, and } from 'drizzle-orm';
import { requireAuth, type AuthRequest } from '../../middleware/auth';
import { executeAction } from '../../services/executor';

const router = Router();

router.use(requireAuth);

router.get('/', async (req, res) => {
  const { clientId, tenantId, classification, limit: limitStr } = req.query as Record<string, string>;
  const limit = Math.min(parseInt(limitStr || '50', 10) || 50, 200);

  const conditions = [];
  if (clientId) conditions.push(eq(actionLogs.clientId, clientId));
  if (tenantId) conditions.push(eq(actionLogs.tenantId, tenantId));
  if (classification) conditions.push(eq(actionLogs.classification, classification));

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
    ? await db.select({ classification: actionLogs.classification, sensitivity: actionLogs.sensitivity })
        .from(actionLogs)
        .where(eq(actionLogs.tenantId, tenantId))
    : await db.select({ classification: actionLogs.classification, sensitivity: actionLogs.sensitivity })
        .from(actionLogs);

  const total = allLogs.length;
  const byClassification: Record<string, number> = {};
  let highSensitivity = 0;

  for (const log of allLogs) {
    const cls = log.classification || 'unknown';
    byClassification[cls] = (byClassification[cls] || 0) + 1;
    if (log.sensitivity === 'high') highSensitivity++;
  }

  res.json({ total, byClassification, highSensitivity });
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

  try {
    await executeAction(id, approvedBy);
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
