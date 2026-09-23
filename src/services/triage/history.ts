import { and, desc, eq, gte, isNotNull, sql } from 'drizzle-orm';
import { db } from '../../db';
import { actionLogs } from '../../db/schema';
import type { ReferenceTicket } from '../../prompts/system';
import { rankSimilar } from './similarity';

/**
 * What Swoop can learn from the tickets it has already seen: near-duplicates,
 * related tickets, and reviewed examples to show the model.
 */

export interface SimilarTicket {
  logId: string;
  ticketId: string;
  displayId: string | null;
  subject: string;
  clientId: string | null;
  category: string | null;
  classification: string | null;
  priority: string | null;
  createdAt: number | null;
  similarity: number;
  sameRequester: boolean;
  sharedTerms: string[];
}

export interface HistoryContext {
  similar: SimilarTicket[];
  duplicateOf: SimilarTicket | null;
  references: ReferenceTicket[];
  recentFromRequester: number;
}

interface HistoryRow {
  id: string;
  ticketId: string;
  ticketDisplayId: string | null;
  subject: string;
  body: string | null;
  clientId: string | null;
  requesterEmail: string | null;
  category: string | null;
  classification: string | null;
  priority: string | null;
  createdAt: number | null;
  reviewVerdict: string | null;
  reviewCorrectClassification: string | null;
  reviewCorrectCategory: string | null;
  reviewCorrectPriority: string | null;
}

const LOOKBACK_DAYS = 30;
const MAX_CANDIDATES = 600;
const DUPLICATE_THRESHOLD = 0.6;
const SIMILAR_THRESHOLD = 0.3;
const REFERENCE_THRESHOLD = 0.25;

export async function loadHistoryContext(input: {
  tenantId: string;
  clientId: string;
  ticketId: string;
  subject: string;
  body: string;
  requesterEmail: string | null;
  duplicateWindowHours: number;
  useReviewedExamples: boolean;
  now?: number;
}): Promise<HistoryContext> {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const since = now - LOOKBACK_DAYS * 86400;

  const rows = (await db
    .select({
      id: actionLogs.id,
      ticketId: actionLogs.ticketId,
      ticketDisplayId: actionLogs.ticketDisplayId,
      subject: sql<string>`coalesce(${actionLogs.ticketSubject}, '')`,
      body: actionLogs.ticketBody,
      clientId: actionLogs.clientId,
      requesterEmail: actionLogs.requesterEmail,
      category: actionLogs.category,
      classification: actionLogs.classification,
      priority: actionLogs.priority,
      createdAt: actionLogs.createdAt,
      reviewVerdict: actionLogs.reviewVerdict,
      reviewCorrectClassification: actionLogs.reviewCorrectClassification,
      reviewCorrectCategory: actionLogs.reviewCorrectCategory,
      reviewCorrectPriority: actionLogs.reviewCorrectPriority,
    })
    .from(actionLogs)
    .where(
      and(
        eq(actionLogs.tenantId, input.tenantId),
        gte(actionLogs.createdAt, since),
        isNotNull(actionLogs.classification),
      ),
    )
    .orderBy(desc(actionLogs.createdAt))
    .limit(MAX_CANDIDATES)) as HistoryRow[];

  // One entry per ticket — a reclassified ticket has several rows, and the
  // newest is the one that counts. Never compare a ticket with itself.
  const seen = new Set<string>([input.ticketId]);
  const latest = rows.filter((row) => {
    if (seen.has(row.ticketId)) return false;
    seen.add(row.ticketId);
    return true;
  });

  const requester = input.requesterEmail?.toLowerCase() ?? null;
  const recentFromRequester = requester
    ? latest.filter((r) => r.requesterEmail?.toLowerCase() === requester && (r.createdAt ?? 0) >= now - 7 * 86400)
        .length
    : 0;

  const ranked = rankSimilar(
    { subject: input.subject, body: input.body },
    latest.map((r) => ({ ...r, id: r.id })),
    { minScore: Math.min(SIMILAR_THRESHOLD, REFERENCE_THRESHOLD) },
  );

  const toSimilar = (entry: (typeof ranked)[number]): SimilarTicket => ({
    logId: entry.doc.id,
    ticketId: entry.doc.ticketId,
    displayId: entry.doc.ticketDisplayId,
    subject: entry.doc.subject,
    clientId: entry.doc.clientId,
    category: entry.doc.category,
    classification: entry.doc.classification,
    priority: entry.doc.priority,
    createdAt: entry.doc.createdAt,
    similarity: Math.round(entry.score * 100) / 100,
    sameRequester: Boolean(requester && entry.doc.requesterEmail?.toLowerCase() === requester),
    sharedTerms: entry.sharedTerms,
  });

  const similar = ranked.filter((r) => r.score >= SIMILAR_THRESHOLD).slice(0, 5).map(toSimilar);

  // A duplicate is the same person asking the same thing again, recently.
  const duplicateCutoff = now - input.duplicateWindowHours * 3600;
  const duplicate = ranked.find(
    (r) =>
      r.score >= DUPLICATE_THRESHOLD &&
      requester !== null &&
      r.doc.requesterEmail?.toLowerCase() === requester &&
      (r.doc.createdAt ?? 0) >= duplicateCutoff,
  );

  const references: ReferenceTicket[] = [];
  if (input.useReviewedExamples) {
    // Reviewed tickets are ground truth. Prefer the same client's, since its
    // conventions are the ones that apply, but fall back to any.
    const reviewed = ranked
      .filter((r) => r.doc.reviewVerdict && r.score >= REFERENCE_THRESHOLD)
      .map((r) => ({ r, score: r.score + (r.doc.clientId === input.clientId ? 0.05 : 0) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    for (const { r } of reviewed) {
      const corrected = r.doc.reviewVerdict === 'incorrect';
      references.push({
        subject: r.doc.subject,
        category: (corrected && r.doc.reviewCorrectCategory) || r.doc.category,
        classification: (corrected && r.doc.reviewCorrectClassification) || r.doc.classification,
        priority: (corrected && r.doc.reviewCorrectPriority) || r.doc.priority,
      });
    }
  }

  return {
    similar,
    duplicateOf: duplicate ? toSimilar(duplicate) : null,
    references,
    recentFromRequester,
  };
}
