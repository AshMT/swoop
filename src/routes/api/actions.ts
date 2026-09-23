import { Router } from 'express';
import { and, desc, eq, gte, isNull, or, sql, inArray, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { actionLogs, clients, incidentClusters, tenants } from '../../db/schema';
import { requireAuth, requireRole, type AuthRequest } from '../../middleware/auth';
import { rateLimit } from '../../middleware/security';
import { buildCalibrationReport, buildQuickStats } from '../../services/metrics';
import { reclassifyTicket } from '../../services/poller';
import { createPsaClient } from '../../services/psa/factory';
import { ACTION_IDS, ACTION_TYPES, isKnownAction } from '../../domain/classifications';
import { CATEGORIES, CATEGORY_IDS, IMPACTS, PRIORITIES, PRIORITY_LABELS, URGENCIES } from '../../domain/triage';
import { describeError } from '../../lib/logger';
import { ApprovalError, decide, expireStaleApprovals, listDecisions, REJECTION_REASONS } from '../../services/approvals/service';
import { recordAudit } from '../../services/audit';
import { investigate } from '../../services/agent/investigate';
import type { SimilarTicket } from '../../services/triage/history';
import { EXECUTABLE_ACTIONS, EXECUTION_TRAITS, needsAttestation, VERIFICATION_METHODS, type VerificationMethod } from '../../services/execution/actions';
import { readAgentSettings } from '../../services/agent/settings';
import {
  ExecutionRefused,
  executionReadiness,
  listExecutions,
  resolveUncertain,
  revealSecret,
  startExecution,
} from '../../services/execution/executor';

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
  priority: z.enum(PRIORITIES).optional(),
  category: z.string().max(40).optional(),
  queue: z.string().max(80).optional(),
  approval: z.enum(['pending', 'approved', 'rejected', 'auto_approved', 'expired', 'superseded', 'not_required']).optional(),
  crossTenant: z.enum(['true']).optional(),
  clusterId: z.string().max(64).optional(),
  /** Only the newest triage of each ticket — what the queue view wants. */
  latest: z.enum(['true']).optional(),
  sort: z.enum(['newest', 'priority']).optional(),
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
  if (query.priority) conditions.push(eq(actionLogs.priority, query.priority));
  if (query.category) conditions.push(eq(actionLogs.category, query.category));
  if (query.queue) conditions.push(eq(actionLogs.suggestedQueue, query.queue));
  if (query.approval) conditions.push(eq(actionLogs.approvalState, query.approval));
  if (query.crossTenant) conditions.push(eq(actionLogs.crossTenant, true));
  if (query.clusterId) conditions.push(eq(actionLogs.clusterId, query.clusterId));
  if (query.latest) {
    // rowid is insertion order, so "no later row for this ticket" is newest.
    conditions.push(sql`NOT EXISTS (
      SELECT 1 FROM action_logs newer
      WHERE newer.tenant_id IS action_logs.tenant_id
        AND newer.ticket_id = action_logs.ticket_id
        AND newer.rowid > action_logs.rowid)`);
  }

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
      actionLogs.summary,
      actionLogs.subcategory,
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
  reviewCorrectCategory: actionLogs.reviewCorrectCategory,
  reviewCorrectPriority: actionLogs.reviewCorrectPriority,
  category: actionLogs.category,
  subcategory: actionLogs.subcategory,
  impact: actionLogs.impact,
  urgency: actionLogs.urgency,
  priority: actionLogs.priority,
  summary: actionLogs.summary,
  sentiment: actionLogs.sentiment,
  suggestedQueue: actionLogs.suggestedQueue,
  signals: actionLogs.signals,
  matchMethod: actionLogs.matchMethod,
  requesterDomain: actionLogs.requesterDomain,
  crossTenant: actionLogs.crossTenant,
  duplicateOfLogId: actionLogs.duplicateOfLogId,
  clusterId: actionLogs.clusterId,
  approvalState: actionLogs.approvalState,
  approvalsRequired: actionLogs.approvalsRequired,
  approvalExpiresAt: actionLogs.approvalExpiresAt,
  supersededBy: actionLogs.supersededBy,
  executionState: actionLogs.executionState,
  createdAt: actionLogs.createdAt,
};

/** Columns stored as JSON text, parsed before they leave the API. */
const JSON_COLUMNS = [
  'entities',
  'signals',
  'nextSteps',
  'similar',
  'tenancy',
  'executionPlan',
  'enrichment',
  'investigation',
  'kbRefs',
] as const;

function hydrate<T extends Record<string, unknown>>(row: T): T {
  const out: Record<string, unknown> = { ...row };
  for (const key of JSON_COLUMNS) {
    const value = out[key];
    if (typeof value !== 'string') continue;
    try {
      out[key] = JSON.parse(value);
    } catch {
      out[key] = null;
    }
  }
  return out as T;
}

/** P1 first, untriaged rows last. */
const priorityOrder = sql`CASE ${actionLogs.priority} WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 WHEN 'P4' THEN 4 ELSE 5 END`;

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
  if (query.approval === 'pending') await expireStaleApprovals(query.tenantId);

  const [rows, [countRow]] = await Promise.all([
    db
      .select(listColumns)
      .from(actionLogs)
      .where(where)
      // createdAt has one-second resolution, so a reclassify lands in the same
      // second as the row it re-runs. The implicit rowid is insertion order,
      // which is what "newest first" is meant to mean — ordering by the id
      // would fall back to comparing random UUIDs.
      .orderBy(
        ...(query.sort === 'priority' ? [priorityOrder] : []),
        desc(actionLogs.createdAt),
        sql`rowid DESC`,
      )
      .limit(limit)
      .offset(offset),
    db.select({ total: sql<number>`count(*)` }).from(actionLogs).where(where),
  ]);

  const total = Number(countRow?.total ?? 0);
  res.json({ items: rows.map(hydrate), total, limit, offset, hasMore: offset + rows.length < total });
});

/**
 * The queue at a glance: open work by priority, proposals waiting on a
 * decision, and incidents in progress. Drives the navigation badges.
 */
router.get('/queue-summary', async (req, res) => {
  const tenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined;
  const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90);
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  await expireStaleApprovals(tenantId);

  const scope = tenantId ? eq(actionLogs.tenantId, tenantId) : undefined;
  const latest = sql`NOT EXISTS (SELECT 1 FROM action_logs newer
      WHERE newer.tenant_id IS action_logs.tenant_id AND newer.ticket_id = action_logs.ticket_id
        AND newer.rowid > action_logs.rowid)`;

  const [byPriority, [pending], [crossTenant], clusters] = await Promise.all([
    db
      .select({ priority: actionLogs.priority, n: sql<number>`count(*)` })
      .from(actionLogs)
      .where(and(scope, gte(actionLogs.createdAt, since), latest))
      .groupBy(actionLogs.priority),
    db
      .select({ n: sql<number>`count(*)` })
      .from(actionLogs)
      .where(and(scope, eq(actionLogs.approvalState, 'pending'))),
    db
      .select({ n: sql<number>`count(*)` })
      .from(actionLogs)
      .where(and(scope, gte(actionLogs.createdAt, since), eq(actionLogs.crossTenant, true), latest)),
    db
      .select({ n: sql<number>`count(*)` })
      .from(incidentClusters)
      .where(
        and(
          tenantId ? eq(incidentClusters.tenantId, tenantId) : undefined,
          eq(incidentClusters.status, 'open'),
        ),
      ),
  ]);

  const priorities: Record<string, number> = { P1: 0, P2: 0, P3: 0, P4: 0, untriaged: 0 };
  for (const row of byPriority) priorities[row.priority ?? 'untriaged'] = Number(row.n);
  res.json({
    days,
    priorities,
    pendingApprovals: Number(pending?.n ?? 0),
    crossTenant: Number(crossTenant?.n ?? 0),
    openIncidents: Number(clusters[0]?.n ?? 0),
  });
});

/** Every vocabulary the UI needs, so it never hardcodes its own copy. */
router.get('/vocabulary', (_req, res) => {
  res.json({
    actions: ACTION_TYPES.map((a) => ({ id: a.id, label: a.label, description: a.description, sensitive: a.inherentlySensitive })),
    categories: CATEGORIES.map((c) => ({ id: c.id, label: c.label, description: c.description, defaultQueue: c.defaultQueue })),
    priorities: PRIORITIES.map((p) => ({ id: p, label: PRIORITY_LABELS[p] })),
    impacts: IMPACTS,
    urgencies: URGENCIES,
    rejectionReasons: REJECTION_REASONS,
    verificationMethods: VERIFICATION_METHODS,
    executableActions: EXECUTABLE_ACTIONS,
    attestationActions: Object.keys(EXECUTION_TRAITS).filter((id) => needsAttestation(id)),
  });
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
      priority: actionLogs.priority,
      category: actionLogs.category,
      subcategory: actionLogs.subcategory,
      impact: actionLogs.impact,
      urgency: actionLogs.urgency,
      suggestedQueue: actionLogs.suggestedQueue,
      summary: actionLogs.summary,
      crossTenant: actionLogs.crossTenant,
      approvalState: actionLogs.approvalState,
      reviewCorrectCategory: actionLogs.reviewCorrectCategory,
      reviewCorrectPriority: actionLogs.reviewCorrectPriority,
    })
    .from(actionLogs)
    .where(where)
    .orderBy(desc(actionLogs.createdAt), sql`rowid DESC`)
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
    'priority',
    'category',
    'subcategory',
    'impact',
    'urgency',
    'queue',
    'summary',
    'cross_tenant',
    'approval_state',
    'review_correct_category',
    'review_correct_priority',
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
        row.priority ?? '',
        row.category ?? '',
        row.subcategory ?? '',
        row.impact ?? '',
        row.urgency ?? '',
        row.suggestedQueue ?? '',
        row.summary ?? '',
        row.crossTenant ? 'yes' : 'no',
        row.approvalState ?? '',
        row.reviewCorrectCategory ?? '',
        row.reviewCorrectPriority ?? '',
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
  let agentEnabled = false;
  if (log.tenantId) {
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, log.tenantId)).limit(1);
    if (tenant) {
      agentEnabled = readAgentSettings(tenant.agentSettings).enabled;
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

  const [decisions, cluster] = await Promise.all([
    listDecisions(log.id),
    log.clusterId
      ? db.select().from(incidentClusters).where(eq(incidentClusters.id, log.clusterId)).limit(1)
      : Promise.resolve([]),
  ]);

  // The rest of this ticket's history — earlier triages and re-runs.
  const history = await db
    .select({
      id: actionLogs.id,
      classification: actionLogs.classification,
      priority: actionLogs.priority,
      category: actionLogs.category,
      approvalState: actionLogs.approvalState,
      createdAt: actionLogs.createdAt,
    })
    .from(actionLogs)
    .where(and(eq(actionLogs.ticketId, log.ticketId), log.tenantId ? eq(actionLogs.tenantId, log.tenantId) : undefined))
    .orderBy(desc(actionLogs.createdAt), sql`rowid DESC`)
    .limit(20);

  res.json({
    ...hydrate(log),
    ticketUrl,
    agentEnabled,
    decisions,
    cluster: cluster[0] ? { ...cluster[0], terms: safeParseArray(cluster[0].terms) } : null,
    history,
  });
});

function safeParseArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

// ─── Approvals ─────────────────────────────────────────────────────────────────

const decisionSchema = z.object({
  comment: z.string().max(2000).nullable().optional(),
  reason: z.enum(REJECTION_REASONS.map((r) => r.id) as [string, ...string[]]).nullable().optional(),
  verificationMethod: z.enum(VERIFICATION_METHODS.map((m) => m.id) as [VerificationMethod, ...VerificationMethod[]]).nullable().optional(),
  verificationNote: z.string().max(1000).nullable().optional(),
});

for (const decision of ['approve', 'reject'] as const) {
  router.post(
    `/:id/${decision}`,
    requireRole('approver'),
    rateLimit({ windowMs: 60_000, max: 60, keyPrefix: 'approval-decision' }),
    async (req: AuthRequest, res) => {
      const parsed = decisionSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
        return;
      }
      try {
        const result = await decide({
          actionLogId: req.params.id,
          user: req.user!,
          decision: decision === 'approve' ? 'approved' : 'rejected',
          reason: (parsed.data.reason ?? null) as never,
          comment: parsed.data.comment ?? null,
          verificationMethod: parsed.data.verificationMethod ?? null,
          verificationNote: parsed.data.verificationNote ?? null,
        });
        res.json({ ok: true, ...result });
      } catch (err) {
        if (err instanceof ApprovalError) {
          res.status(err.status).json({ error: err.message });
          return;
        }
        throw err;
      }
    },
  );
}

// ─── Calibration review ────────────────────────────────────────────────────────

const reviewSchema = z
  .object({
    verdict: z.enum(['correct', 'incorrect']).nullable(),
    correctClassification: z.string().max(100).nullable().optional(),
    correctCategory: z.string().max(40).nullable().optional(),
    correctPriority: z.enum(PRIORITIES).nullable().optional(),
    note: z.string().max(2000).nullable().optional(),
  })
  .refine((value) => !value.correctCategory || CATEGORY_IDS.includes(value.correctCategory), {
    message: 'correctCategory must be one of the known categories',
    path: ['correctCategory'],
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
router.post('/:id/review', requireRole('reviewer'), async (req: AuthRequest, res) => {
  const parsed = reviewSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
    return;
  }

  const [log] = await db
    .select({ id: actionLogs.id, status: actionLogs.status, tenantId: actionLogs.tenantId, ticketId: actionLogs.ticketId })
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

  const { verdict, correctClassification, correctCategory, correctPriority, note } = parsed.data;

  await db
    .update(actionLogs)
    .set({
      reviewVerdict: verdict,
      // A "correct" verdict implies the stored classification, so a corrected
      // label would only be confusing.
      reviewCorrectClassification: verdict === 'incorrect' ? correctClassification?.trim() || null : null,
      // Each dimension is corrected independently: the action can be right
      // while the priority is wrong. Only an "incorrect" review carries them.
      reviewCorrectCategory: verdict === 'incorrect' ? correctCategory || null : null,
      reviewCorrectPriority: verdict === 'incorrect' ? correctPriority || null : null,
      reviewNote: verdict ? note?.trim() || null : null,
      reviewedBy: verdict ? (req.user?.email ?? null) : null,
      reviewedAt: verdict ? Math.floor(Date.now() / 1000) : null,
    })
    .where(eq(actionLogs.id, req.params.id));

  await recordAudit({
    user: req.user,
    action: verdict ? 'review.record' : 'review.clear',
    targetType: 'action_log',
    targetId: log.id,
    tenantId: log.tenantId,
    detail: { ticketId: log.ticketId, verdict, correctClassification, correctCategory, correctPriority },
    req,
  });

  const [updated] = await db.select(listColumns).from(actionLogs).where(eq(actionLogs.id, req.params.id)).limit(1);
  res.json(hydrate(updated!));
});

const bulkReviewSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
  verdict: z.enum(['correct', 'incorrect']).nullable(),
});

/** Bulk "these are all correct", which is most of a review session. */
router.post('/bulk-review', requireRole('reviewer'), async (req: AuthRequest, res) => {
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
      reviewCorrectCategory: null,
      reviewCorrectPriority: null,
      reviewedBy: verdict ? (req.user?.email ?? null) : null,
      reviewedAt: verdict ? now : null,
    })
    // `IS NOT` rather than `!=` so a row with a NULL status is still updated;
    // `!=` against NULL yields NULL, which silently excludes the row.
    .where(and(inArray(actionLogs.id, ids), sql`${actionLogs.status} IS NOT 'ai_failed'`))
    .returning({ id: actionLogs.id });

  await recordAudit({ user: req.user, action: 'review.bulk', targetType: 'action_log', detail: { count: result.length, verdict }, req });
  res.json({ ok: true, updated: result.length });
});

/** Re-runs the classifier on a ticket — the prompt-tuning loop. */
router.post(
  '/:id/reclassify',
  requireRole('reviewer'),
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
      await recordAudit({
        user: (req as AuthRequest).user,
        action: 'ticket.rerun',
        targetType: 'action_log',
        targetId: req.params.id,
        tenantId: log.tenantId,
        detail: { ticketId: log.ticketId, postNote, ok: result.ok },
        req,
      });
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

// ─── Investigation ─────────────────────────────────────────────────────────────

/** Runs (or re-runs) the investigation on a logged ticket, on demand. */
router.post(
  '/:id/investigate',
  requireRole('reviewer'),
  rateLimit({ windowMs: 60_000, max: 10, keyPrefix: 'investigate' }),
  async (req: AuthRequest, res) => {
    const [row] = await db.select().from(actionLogs).where(eq(actionLogs.id, req.params.id)).limit(1);
    if (!row?.tenantId || !row.clientId) {
      res.status(404).json({ error: 'Action log not found' });
      return;
    }
    if (row.crossTenant) {
      res.status(400).json({ error: 'This request crosses clients, so Swoop does not investigate it.' });
      return;
    }
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, row.tenantId)).limit(1);
    const [client] = await db.select().from(clients).where(eq(clients.id, row.clientId)).limit(1);
    if (!tenant || !client) {
      res.status(404).json({ error: 'Tenant or client not found' });
      return;
    }
    if (!readAgentSettings(tenant.agentSettings).enabled) {
      res.status(400).json({ error: 'The investigation agent is off for this tenant. An admin can turn it on under Settings → Agent.' });
      return;
    }
    const entities = safeParseEntities(typeof row.entities === 'string' ? row.entities : null);
    const similar = (() => {
      try {
        return row.similar ? (JSON.parse(row.similar) as SimilarTicket[]) : [];
      } catch {
        return [];
      }
    })();
    const result = await investigate({
      tenant,
      client,
      ticket: { subject: row.ticketSubject ?? '', body: row.ticketBody ?? '', requesterEmail: row.requesterEmail },
      triage: {
        classification: row.classification ?? 'ESCALATE',
        category: row.category ?? 'other',
        priority: row.priority ?? 'P4',
        summary: row.summary ?? '',
        targetUserEmail: entities.target_user_email ?? null,
      },
      similar,
    });
    await db.update(actionLogs).set({ investigation: JSON.stringify(result) }).where(eq(actionLogs.id, row.id));
    await recordAudit({
      user: req.user,
      action: 'ticket.investigate',
      targetType: 'action_log',
      targetId: row.id,
      tenantId: row.tenantId,
      detail: { ticketId: row.ticketId, status: result.status, steps: result.steps.length },
      req,
    });
    res.json(result);
  },
);

// ─── Execution ─────────────────────────────────────────────────────────────────

/** The runs of a proposal, and whether another can start — for the ticket page. */
router.get('/:id/executions', async (req: AuthRequest, res) => {
  try {
    const [runs, readiness] = await Promise.all([listExecutions(req.params.id), executionReadiness(req.params.id, req.user ?? null)]);
    res.json({ runs, readiness });
  } catch (err) {
    if (err instanceof ExecutionRefused) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
});

const executeSchema = z.object({ mode: z.enum(['dry_run', 'live']) });

router.post(
  '/:id/execute',
  requireRole('approver'),
  rateLimit({ windowMs: 60_000, max: 20, keyPrefix: 'execute' }),
  async (req: AuthRequest, res) => {
    const parsed = executeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'mode must be dry_run or live' });
      return;
    }
    try {
      const { executionId } = await startExecution(req.params.id, parsed.data.mode, req.user!);
      res.status(202).json({ ok: true, executionId });
    } catch (err) {
      if (err instanceof ExecutionRefused) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
  },
);

router.post(
  '/executions/:executionId/reveal',
  requireRole('approver'),
  rateLimit({ windowMs: 60_000, max: 10, keyPrefix: 'reveal' }),
  async (req: AuthRequest, res) => {
    try {
      const secret = await revealSecret(req.params.executionId, req.user!);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ secret });
    } catch (err) {
      if (err instanceof ExecutionRefused) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
  },
);

const resolveSchema = z.object({ outcome: z.enum(['succeeded', 'failed']), note: z.string().max(1000).nullable().optional() });

router.post('/executions/:executionId/resolve', requireRole('approver'), async (req: AuthRequest, res) => {
  const parsed = resolveSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'outcome must be succeeded or failed' });
    return;
  }
  try {
    await resolveUncertain(req.params.executionId, parsed.data.outcome, parsed.data.note ?? null, req.user!);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof ExecutionRefused) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
});

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
