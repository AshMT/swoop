import { Router } from 'express';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { actionLogs, incidentClusters } from '../../db/schema';
import { requireAuth, requireRole, type AuthRequest } from '../../middleware/auth';
import { recordAudit } from '../../services/audit';

/**
 * Incidents: bursts of similar tickets Swoop grouped together.
 */
const router = Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const parsed = z
    .object({
      tenantId: z.string().optional(),
      status: z.enum(['open', 'acknowledged', 'resolved', 'active']).optional(),
      days: z.coerce.number().int().min(1).max(365).optional(),
    })
    .safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid query parameters' });
    return;
  }
  const { tenantId, status, days } = parsed.data;
  const since = Math.floor(Date.now() / 1000) - (days ?? 14) * 86400;

  const rows = await db
    .select()
    .from(incidentClusters)
    .where(
      and(
        tenantId ? eq(incidentClusters.tenantId, tenantId) : undefined,
        status === 'active'
          ? inArray(incidentClusters.status, ['open', 'acknowledged'])
          : status
            ? eq(incidentClusters.status, status)
            : undefined,
        gte(incidentClusters.lastSeenAt, since),
      ),
    )
    .orderBy(desc(incidentClusters.lastSeenAt))
    .limit(100);

  const ids = rows.map((r) => r.id);
  const tickets = ids.length
    ? await db
        .select({
          id: actionLogs.id,
          clusterId: actionLogs.clusterId,
          ticketId: actionLogs.ticketId,
          ticketDisplayId: actionLogs.ticketDisplayId,
          ticketSubject: actionLogs.ticketSubject,
          clientId: actionLogs.clientId,
          requesterEmail: actionLogs.requesterEmail,
          priority: actionLogs.priority,
          createdAt: actionLogs.createdAt,
        })
        .from(actionLogs)
        .where(inArray(actionLogs.clusterId, ids))
        .orderBy(desc(actionLogs.createdAt), sql`rowid DESC`)
    : [];

  res.json(
    rows.map((row) => {
      const seen = new Set<string>();
      return {
        ...row,
        terms: parseTerms(row.terms),
        tickets: tickets.filter((t) => {
          if (t.clusterId !== row.id || seen.has(t.ticketId)) return false;
          seen.add(t.ticketId);
          return true;
        }),
      };
    }),
  );
});

const statusSchema = z.object({ status: z.enum(['open', 'acknowledged', 'resolved']) });

router.post('/:id/status', requireRole('reviewer'), async (req: AuthRequest, res) => {
  const parsed = statusSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'status must be open, acknowledged or resolved' });
    return;
  }
  const [cluster] = await db.select().from(incidentClusters).where(eq(incidentClusters.id, req.params.id)).limit(1);
  if (!cluster) {
    res.status(404).json({ error: 'Incident not found' });
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  await db
    .update(incidentClusters)
    .set({
      status: parsed.data.status,
      acknowledgedBy: parsed.data.status === 'open' ? null : (req.user?.email ?? null),
      acknowledgedAt: parsed.data.status === 'open' ? null : now,
    })
    .where(eq(incidentClusters.id, cluster.id));
  await recordAudit({
    user: req.user,
    action: `incident.${parsed.data.status}`,
    targetType: 'incident',
    targetId: cluster.id,
    tenantId: cluster.tenantId,
    detail: { label: cluster.label },
    req,
  });
  res.json({ ok: true });
});

function parseTerms(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

export default router;
