import { Router } from 'express';
import { and, desc, eq, gte, isNull, or, sql, inArray, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { actionLogs, clients, tenants } from '../../db/schema';
import { requireAuth, type AuthRequest } from '../../middleware/auth';
import { rateLimit } from '../../middleware/security';
import { buildCalibrationReport, buildQuickStats } from '../../services/metrics';
import { reclassifyTicket } from '../../services/poller';
import { createPsaClient } from '../../services/psa/factory';
import { ACTION_IDS, isKnownAction } from '../../domain/classifications';
import { describeError } from '../../lib/logger';

const router = Router();

router.use(requireAuth);

const MAX_PAGE_SIZE = 200;

const listQuerySchema = z.object({
  tenantId: z.string().optional(),
  clientId: z.string().optional(),
  classification: z.string().optional(),
  sensitivity: z.enum(['normal', 'high']).optional(),
  status: z.enum(['classified', 'ai_failed', 'note_failed']).optional(),
  review: z.enum(['correct', 'incorrect', 'unreviewed']).optional(),
  /** Free-text search across subject, ticket id and requester. */
  q: z.string().max(200).optional(),
  days: z.coerce.number().int().min(1).max(3650).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

type ListQuery = z.infer<typeof listQuerySchema>;

function buildFilters(query: ListQuery): SQL | undefined {
  const conditions: SQL[] = [];
  if (query.tenantId) conditions.push(eq(actionLogs.tenantId, query.tenantId));
  if (query.clientId) conditions.push(eq(actionLogs.clientId, query.clientId));
  if (query.classification) conditions.push(eq(actionLogs.classification, query.classification));
  if (query.sensitivity) conditions.push(eq(actionLogs.sensitivity, query.sensitivity));
  if (query.status) conditions.push(eq(actionLogs.status, query.status));

  if (query.review === 'unreviewed') conditions.push(isNull(actionLogs.reviewVerdict));
  else if (query.review) conditions.push(eq(actionLogs.reviewVerdict, query.review));

  if (query.days) {
    conditions.push(gte(actionLogs.createdAt, Math.floor(Date.now() / 1000) - query.days * 86400));
  }

  if (query.q?.trim()) {
    // LIKE wildcards in the search term are escaped, which only works if the
    // escape character is declared — `like()` alone emits no ESCAPE clause, so
    // a search for "%" would otherwise match every row.
    const term = `%${query.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const searchable = [
      actionLogs.ticketSubject,
      // The body is where the actual request lives, so it is the most useful
      // thing to search — a subject of "Help please" is no help at all.
      actionLogs.ticketBody,
      actionLogs.ticketId,
      actionLogs.ticketDisplayId,
      actionLogs.requesterEmail,
      actionLogs.reasoning,
      actionLogs.followUpQuestion,
    ];
    const textSearch = or(
      ...searchable.map((column) => sql`${column} LIKE ${term} ESCAPE '\\'`),
    );
    if (textSearch) conditions.push(textSearch);
  }

  if (conditions.length === 0) return undefined;
  return conditions.length === 1 ? conditions[0] : and(...conditions);
}

/** Columns for the list view — rawAiResponse and ticketBody are large, so omit them. */
const listColumns = {
  id: actionLogs.id,
  tenantId: actionLogs.tenantId,
  clientId: actionLogs.clientId,
  ticketId: actionLogs.ticketId,
  ticketDisplayId: actionLogs.ticketDisplayId,
  ticketSubject: actionLogs.ticketSubject,
  requesterEmail: actionLogs.requesterEmail,
  classification: actionLogs.classification,
  confidence: actionLogs.confidence,
  sensitivity: actionLogs.sensitivity,
  entities: actionLogs.entities,
  reasoning: actionLogs.reasoning,
  followUpQuestion: actionLogs.followUpQuestion,
  escalationReason: actionLogs.escalationReason,
  proposedPsaNote: actionLogs.proposedPsaNote,
  status: actionLogs.status,
  errorMessage: actionLogs.errorMessage,
  aiModel: actionLogs.aiModel,
  promptFingerprint: actionLogs.promptFingerprint,
  aiLatencyMs: actionLogs.aiLatencyMs,
  notePosted: actionLogs.notePosted,
  noteError: actionLogs.noteError,
  noteAttempts: actionLogs.noteAttempts,
  reviewVerdict: actionLogs.reviewVerdict,
  reviewCorrectClassification: actionLogs.reviewCorrectClassification,
  reviewNote: actionLogs.reviewNote,
  reviewedBy: actionLogs.reviewedBy,
  reviewedAt: actionLogs.reviewedAt,
  createdAt: actionLogs.createdAt,
};

router.get('/', async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid query parameters' });
    return;
  }

  const query = parsed.data;
  const limit = query.limit ?? 50;
  const offset = query.offset ?? 0;
  const where = buildFilters(query);

  const [rows, [countRow]] = await Promise.all([
    db
      .select(listColumns)
      .from(actionLogs)
      .where(where)
      .orderBy(desc(actionLogs.createdAt), desc(actionLogs.id))
      .limit(limit)
      .offset(offset),
    db.select({ total: sql<number>`count(*)` }).from(actionLogs).where(where),
  ]);

  const total = Number(countRow?.total ?? 0);
  res.json({ items: rows, total, limit, offset, hasMore: offset + rows.length < total });
});

router.get('/stats', async (req, res) => {
  const tenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined;
  const clientId = typeof req.query.clientId === 'string' ? req.query.clientId : undefined;
  const days = req.query.days ? Number(req.query.days) : undefined;
  res.json(await buildQuickStats({ tenantId, clientId, days: Number.isFinite(days) ? days : undefined }));
});

/** The calibration report — agreement rate, confusion matrix, latency. */
router.get('/metrics', async (req, res) => {
  const parsed = z
    .object({
      tenantId: z.string().optional(),
      clientId: z.string().optional(),
      days: z.coerce.number().int().min(1).max(3650).optional(),
      promptFingerprint: z.string().max(64).optional(),
    })
    .safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid query parameters' });
    return;
  }
  res.json(await buildCalibrationReport(parsed.data));
});

/** The label set, so the UI never hardcodes its own copy. */
router.get('/classifications', (_req, res) => {
  res.json({ classifications: ACTION_IDS });
});

/**
 * CSV export.
 *
 * Exporting the log is how a team reviews classifications away from the
 * dashboard, and it is the input to any offline accuracy analysis.
 */
router.get('/export.csv', async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid query parameters' });
    return;
  }

  const where = buildFilters(parsed.data);
  const rows = await db
    .select({
      createdAt: actionLogs.createdAt,
      ticketId: actionLogs.ticketId,
      ticketDisplayId: actionLogs.ticketDisplayId,
      clientId: actionLogs.clientId,
      ticketSubject: actionLogs.ticketSubject,
      requesterEmail: actionLogs.requesterEmail,
      classification: actionLogs.classification,
      confidence: actionLogs.confidence,
      sensitivity: actionLogs.sensitivity,
      status: actionLogs.status,
      reasoning: actionLogs.reasoning,
      followUpQuestion: actionLogs.followUpQuestion,
      entities: actionLogs.entities,
      aiModel: actionLogs.aiModel,
      promptFingerprint: actionLogs.promptFingerprint,
      aiLatencyMs: actionLogs.aiLatencyMs,
      notePosted: actionLogs.notePosted,
      errorMessage: actionLogs.errorMessage,
      reviewVerdict: actionLogs.reviewVerdict,
      reviewCorrectClassification: actionLogs.reviewCorrectClassification,
      reviewNote: actionLogs.reviewNote,
      reviewedBy: actionLogs.reviewedBy,
    })
    .from(actionLogs)
    .where(where)
    .orderBy(desc(actionLogs.createdAt))
    .limit(10_000);

  const clientRows = await db.select({ id: clients.id, name: clients.name }).from(clients);
  const clientNames = new Map(clientRows.map((c) => [c.id, c.name]));

  const headers = [
    'created_at',
    'ticket_id',
    'ticket_number',
    'client',
    'subject',
    'requester_email',
    'classification',
    'confidence',
    'sensitivity',
    'status',
    'reasoning',
    'follow_up_question',
    'target_user_email',
    'group_name',
    'license_sku',
    'ai_model',
    'prompt_version',
    'ai_latency_ms',
    'note_posted',
    'error',
    'review_verdict',
    'review_correct_classification',
    'review_note',
    'reviewed_by',
  ];

  const lines = [headers.join(',')];
  for (const row of rows) {
    const entities = safeParseEntities(row.entities);
    lines.push(
      [
        row.createdAt ? new Date(row.createdAt * 1000).toISOString() : '',
        row.ticketId,
        row.ticketDisplayId ?? '',
        (row.clientId && clientNames.get(row.clientId)) || '',
        row.ticketSubject ?? '',
        row.requesterEmail ?? '',
        row.classification ?? '',
        row.confidence === null ? '' : row.confidence.toFixed(3),
        row.sensitivity ?? '',
        row.status ?? '',
        row.reasoning ?? '',
        row.followUpQuestion ?? '',
        entities.target_user_email ?? '',
        entities.group_name ?? '',
        entities.license_sku ?? '',
        row.aiModel ?? '',
        row.promptFingerprint ?? '',
        row.aiLatencyMs ?? '',
        row.notePosted ? 'yes' : 'no',
        row.errorMessage ?? '',
        row.reviewVerdict ?? '',
        row.reviewCorrectClassification ?? '',
        row.reviewNote ?? '',
        row.reviewedBy ?? '',
      ]
        .map(csvCell)
        .join(','),
    );
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="swoop-actions-${new Date().toISOString().slice(0, 10)}.csv"`,
  );
  // Excel needs a BOM to read UTF-8 correctly.
  res.send(`\uFEFF${lines.join('\r\n')}\r\n`);
});

router.get('/:id', async (req, res) => {
  const [log] = await db.select().from(actionLogs).where(eq(actionLogs.id, req.params.id)).limit(1);
  if (!log) {
    res.status(404).json({ error: 'Action log not found' });
    return;
  }

  // Build the SuperOps deep link server-side: the browser has no idea what the
  // tenant's console hostname is.
  let ticketUrl: string | null = null;
  if (log.tenantId) {
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, log.tenantId)).limit(1);
    if (tenant) {
      try {
        ticketUrl = createPsaClient(tenant).ticketUrl({
          ticketId: log.ticketId,
          displayId: log.ticketDisplayId,
        });
      } catch {
        ticketUrl = null;
      }
    }
  }

  res.json({ ...log, ticketUrl });
});

// ─── Calibration review ────────────────────────────────────────────────────────

const reviewSchema = z
  .object({
    verdict: z.enum(['correct', 'incorrect']).nullable(),
    correctClassification: z.string().max(100).nullable().optional(),
    note: z.string().max(2000).nullable().optional(),
  })
  .refine(
    (value) =>
      value.verdict !== 'incorrect' ||
      (value.correctClassification ? isKnownAction(value.correctClassification) : true),
    { message: 'correctClassification must be one of the known action types', path: ['correctClassification'] },
  );

/**
 * Records a technician's verdict on one classification.
 *
 * This is the input to every accuracy number Swoop reports. Passing a null
 * verdict clears the review, so a mis-click is recoverable.
 */
router.post('/:id/review', async (req: AuthRequest, res) => {
  const parsed = reviewSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
    return;
  }

  const [log] = await db
    .select({ id: actionLogs.id, status: actionLogs.status })
    .from(actionLogs)
    .where(eq(actionLogs.id, req.params.id))
    .limit(1);
  if (!log) {
    res.status(404).json({ error: 'Action log not found' });
    return;
  }
  if (log.status === 'ai_failed') {
    res.status(400).json({
      error: 'This entry records an AI failure rather than a classification, so there is nothing to review.',
    });
    return;
  }

  const { verdict, correctClassification, note } = parsed.data;

  await db
    .update(actionLogs)
    .set({
      reviewVerdict: verdict,
      // A "correct" verdict implies the stored classification, so a corrected
      // label would only be confusing.
      reviewCorrectClassification: verdict === 'incorrect' ? correctClassification?.trim() || null : null,
      reviewNote: verdict ? note?.trim() || null : null,
      reviewedBy: verdict ? (req.user?.email ?? null) : null,
      reviewedAt: verdict ? Math.floor(Date.now() / 1000) : null,
    })
    .where(eq(actionLogs.id, req.params.id));

  const [updated] = await db.select(listColumns).from(actionLogs).where(eq(actionLogs.id, req.params.id)).limit(1);
  res.json(updated);
});

const bulkReviewSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
  verdict: z.enum(['correct', 'incorrect']).nullable(),
});

/** Bulk "these are all correct", which is most of a review session. */
router.post('/bulk-review', async (req: AuthRequest, res) => {
  const parsed = bulkReviewSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
    return;
  }

  const { ids, verdict } = parsed.data;
  const now = Math.floor(Date.now() / 1000);

  const result = await db
    .update(actionLogs)
    .set({
      reviewVerdict: verdict,
      reviewCorrectClassification: null,
      reviewedBy: verdict ? (req.user?.email ?? null) : null,
      reviewedAt: verdict ? now : null,
    })
    // `IS NOT` rather than `!=` so a row with a NULL status is still updated;
    // `!=` against NULL yields NULL, which silently excludes the row.
    .where(and(inArray(actionLogs.id, ids), sql`${actionLogs.status} IS NOT 'ai_failed'`))
    .returning({ id: actionLogs.id });

  res.json({ ok: true, updated: result.length });
});

/** Re-runs the classifier on a ticket — the prompt-tuning loop. */
router.post(
  '/:id/reclassify',
  rateLimit({ windowMs: 60_000, max: 20, keyPrefix: 'reclassify' }),
  async (req, res) => {
    const [log] = await db
      .select({ tenantId: actionLogs.tenantId, ticketId: actionLogs.ticketId })
      .from(actionLogs)
      .where(eq(actionLogs.id, req.params.id))
      .limit(1);
    if (!log?.tenantId) {
      res.status(404).json({ error: 'Action log not found' });
      return;
    }

    const postNote = req.body?.postNote === true;
    try {
      const result = await reclassifyTicket(log.tenantId, log.ticketId, { postNote });
      if (!result.ok) {
        res.status(502).json(result);
        return;
      }
      res.json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: describeError(err) });
    }
  },
);

function safeParseEntities(raw: string | null): Record<string, string | null> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string | null>) : {};
  } catch {
    return {};
  }
}

/**
 * Quotes a CSV cell.
 *
 * The leading apostrophe on formula-leading values is deliberate: ticket
 * subjects are attacker-controlled text, and a cell starting with = or + is
 * executed as a formula when the export is opened in Excel.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

export default router;
