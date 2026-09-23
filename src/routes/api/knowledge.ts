import { Router } from 'express';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { db } from '../../db';
import { clients, runbooks } from '../../db/schema';
import { requireAuth, requireRole, type AuthRequest } from '../../middleware/auth';
import { recordAudit } from '../../services/audit';
import { searchKnowledge } from '../../services/knowledge/runbooks';

/**
 * Runbooks: how this MSP handles things, per client or for everyone. Written
 * here, or synced read-only from the SuperOps knowledge base.
 */
const router = Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const parsed = z
    .object({ tenantId: z.string(), clientId: z.string().optional(), scope: z.enum(['all', 'general', 'client']).optional() })
    .safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'tenantId is required' });
    return;
  }
  const { tenantId, clientId, scope } = parsed.data;
  const rows = await db
    .select()
    .from(runbooks)
    .where(
      and(
        eq(runbooks.tenantId, tenantId),
        scope === 'general' ? isNull(runbooks.clientId) : clientId ? eq(runbooks.clientId, clientId) : undefined,
      ),
    )
    .orderBy(desc(runbooks.updatedAt));
  res.json(rows.map((r) => ({ ...r, tags: parseTags(r.tags) })));
});

router.get('/search', async (req, res) => {
  const parsed = z
    .object({ tenantId: z.string(), clientId: z.string().optional(), q: z.string().min(1).max(500), scope: z.enum(['all', 'general', 'client']).optional() })
    .safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'tenantId and q are required' });
    return;
  }
  const { tenantId, clientId, q, scope } = parsed.data;
  res.json(
    await searchKnowledge({
      tenantId,
      clientId: scope === 'general' ? null : clientId ?? null,
      allClients: scope === 'all' && !clientId,
      query: q,
      limit: 20,
      minScore: 0.05,
    }),
  );
});

const bodySchema = z.object({
  tenantId: z.string(),
  clientId: z.string().nullable().optional(),
  title: z.string().trim().min(3).max(300),
  body: z.string().trim().min(10).max(50_000),
  tags: z.array(z.string().max(40)).max(20).optional(),
});

async function clientBelongs(tenantId: string, clientId: string | null | undefined): Promise<boolean> {
  if (!clientId) return true;
  const [client] = await db.select({ tenantId: clients.tenantId }).from(clients).where(eq(clients.id, clientId)).limit(1);
  return client?.tenantId === tenantId;
}

router.post('/', requireRole('reviewer'), async (req: AuthRequest, res) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
    return;
  }
  if (!(await clientBelongs(parsed.data.tenantId, parsed.data.clientId))) {
    res.status(400).json({ error: 'That client is not in this tenant' });
    return;
  }
  const id = uuidv4();
  await db.insert(runbooks).values({
    id,
    tenantId: parsed.data.tenantId,
    clientId: parsed.data.clientId ?? null,
    title: parsed.data.title,
    body: parsed.data.body,
    tags: parsed.data.tags?.length ? JSON.stringify(parsed.data.tags) : null,
    source: 'swoop',
    updatedBy: req.user!.email,
  });
  await recordAudit({ user: req.user, action: 'runbook.create', targetType: 'runbook', targetId: id, tenantId: parsed.data.tenantId, detail: { title: parsed.data.title }, req });
  res.status(201).json({ id });
});

router.patch('/:id', requireRole('reviewer'), async (req: AuthRequest, res) => {
  const parsed = bodySchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
    return;
  }
  const [row] = await db.select().from(runbooks).where(eq(runbooks.id, req.params.id)).limit(1);
  if (!row) {
    res.status(404).json({ error: 'Runbook not found' });
    return;
  }
  if (row.source !== 'swoop') {
    res.status(400).json({ error: 'This article is synced from SuperOps. Edit it there.' });
    return;
  }
  if (parsed.data.clientId !== undefined && !(await clientBelongs(row.tenantId!, parsed.data.clientId))) {
    res.status(400).json({ error: 'That client is not in this tenant' });
    return;
  }
  await db
    .update(runbooks)
    .set({
      ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
      ...(parsed.data.body !== undefined ? { body: parsed.data.body } : {}),
      ...(parsed.data.clientId !== undefined ? { clientId: parsed.data.clientId } : {}),
      ...(parsed.data.tags !== undefined ? { tags: parsed.data.tags.length ? JSON.stringify(parsed.data.tags) : null } : {}),
      updatedBy: req.user!.email,
      updatedAt: Math.floor(Date.now() / 1000),
    })
    .where(eq(runbooks.id, row.id));
  await recordAudit({ user: req.user, action: 'runbook.update', targetType: 'runbook', targetId: row.id, tenantId: row.tenantId, detail: { title: parsed.data.title ?? row.title }, req });
  res.json({ ok: true });
});

router.delete('/:id', requireRole('reviewer'), async (req: AuthRequest, res) => {
  const [row] = await db.select().from(runbooks).where(eq(runbooks.id, req.params.id)).limit(1);
  if (!row) {
    res.status(404).json({ error: 'Runbook not found' });
    return;
  }
  if (row.source !== 'swoop') {
    res.status(400).json({ error: 'This article is synced from SuperOps. Delete it there.' });
    return;
  }
  await db.delete(runbooks).where(eq(runbooks.id, row.id));
  await recordAudit({ user: req.user, action: 'runbook.delete', targetType: 'runbook', targetId: row.id, tenantId: row.tenantId, detail: { title: row.title }, req });
  res.json({ ok: true });
});

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

export default router;
