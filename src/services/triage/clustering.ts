import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../../db';
import { actionLogs, incidentClusters } from '../../db/schema';
import { rankSimilar } from './similarity';

/**
 * Incident clustering: noticing that five tickets in twenty minutes are one
 * problem.
 *
 * Treated one at a time, "Outlook won't connect" from five people at the same
 * client is five P4s in five technicians' queues. Together it is a P2 outage
 * with one owner. And the same complaint from several *different* clients at
 * once is almost always upstream — Microsoft 365, an ISP, a vendor — which is
 * worth knowing before anyone starts rebooting routers.
 */

const SIMILAR_ENOUGH = 0.35;
const PROBLEM_CLASSIFICATIONS = ['ESCALATE', 'FOLLOW_UP'];
/** Same client and same category need less textual overlap to be related. */
const SIMILAR_SAME_CATEGORY = 0.15;

export interface ClusterAssessment {
  clusterId: string;
  isNew: boolean;
  /** Tickets in the cluster including this one. */
  size: number;
  clientCount: number;
  label: string;
  crossClient: boolean;
}

interface Neighbour {
  id: string;
  ticketId: string;
  clientId: string | null;
  clusterId: string | null;
  subject: string;
  createdAt: number | null;
}

/**
 * Finds the cluster this ticket belongs to, creating or growing it, and tags
 * its neighbours. Returns null when the ticket is not part of a burst.
 */
export async function clusterTicket(input: {
  tenantId: string;
  clientId: string;
  ticketId: string;
  subject: string;
  body: string;
  category: string;
  /** The ticket's classification — only problems cluster, see below. */
  classification: string;
  windowMinutes: number;
  threshold: number;
  now?: number;
}): Promise<ClusterAssessment | null> {
  // Three password resets for three different people in an hour are three
  // requests, not an incident. Only tickets that need a technician — faults,
  // outages, security reports — can be symptoms of one underlying problem.
  if (!PROBLEM_CLASSIFICATIONS.includes(input.classification)) return null;

  const now = input.now ?? Math.floor(Date.now() / 1000);
  const since = now - input.windowMinutes * 60;

  const rows = await db
    .select({
      id: actionLogs.id,
      ticketId: actionLogs.ticketId,
      clientId: actionLogs.clientId,
      clusterId: actionLogs.clusterId,
      subject: sql<string>`coalesce(${actionLogs.ticketSubject}, '')`,
      body: actionLogs.ticketBody,
      category: actionLogs.category,
      createdAt: actionLogs.createdAt,
    })
    .from(actionLogs)
    .where(
      and(
        eq(actionLogs.tenantId, input.tenantId),
        gte(actionLogs.createdAt, since),
        inArray(actionLogs.classification, PROBLEM_CLASSIFICATIONS),
      ),
    )
    .orderBy(desc(actionLogs.createdAt))
    .limit(300);

  const seen = new Set<string>([input.ticketId]);
  const candidates = rows.filter((row) => {
    if (seen.has(row.ticketId)) return false;
    seen.add(row.ticketId);
    return true;
  });
  if (candidates.length + 1 < input.threshold) return null;

  const ranked = rankSimilar({ subject: input.subject, body: input.body }, candidates);
  const neighbours: Neighbour[] = ranked
    .filter(
      (r) =>
        r.score >= SIMILAR_ENOUGH ||
        (r.score >= SIMILAR_SAME_CATEGORY &&
          input.category !== 'other' &&
          r.doc.category === input.category &&
          r.doc.clientId === input.clientId),
    )
    .map((r) => r.doc);

  if (neighbours.length + 1 < input.threshold) return null;

  const existingId = neighbours.find((n) => n.clusterId)?.clusterId ?? null;
  const clientIds = new Set([input.clientId, ...neighbours.map((n) => n.clientId).filter(Boolean)]);
  const crossClient = clientIds.size > 1;
  const earliest = neighbours.reduce(
    (min, n) => Math.min(min, n.createdAt ?? now),
    now,
  );

  if (existingId) {
    // Tag any neighbours that joined without a cluster, then recount from the
    // rows so concurrent tickets cannot leave the counter drifting.
    const untagged = neighbours.filter((n) => !n.clusterId).map((n) => n.id);
    if (untagged.length > 0) {
      await db.update(actionLogs).set({ clusterId: existingId }).where(inArray(actionLogs.id, untagged));
    }
    const [counts] = await db
      .select({
        tickets: sql<number>`count(distinct ${actionLogs.ticketId})`,
        clients: sql<number>`count(distinct ${actionLogs.clientId})`,
      })
      .from(actionLogs)
      .where(eq(actionLogs.clusterId, existingId));
    // +1 for this ticket, not inserted yet; its client may be new to the cluster.
    const [cluster] = await db
      .select()
      .from(incidentClusters)
      .where(eq(incidentClusters.id, existingId))
      .limit(1);
    const clientsInCluster = await db
      .selectDistinct({ clientId: actionLogs.clientId })
      .from(actionLogs)
      .where(eq(actionLogs.clusterId, existingId));
    const isNewClient = !clientsInCluster.some((c) => c.clientId === input.clientId);
    const size = Number(counts?.tickets ?? 0) + 1;
    const clientCount = Number(counts?.clients ?? 0) + (isNewClient ? 1 : 0);

    await db
      .update(incidentClusters)
      .set({
        ticketCount: size,
        clientCount,
        clientId: clientCount > 1 ? null : (cluster?.clientId ?? input.clientId),
        lastSeenAt: now,
        // A resolved incident that is still generating tickets is not resolved.
        status: cluster?.status === 'resolved' ? 'open' : (cluster?.status ?? 'open'),
      })
      .where(eq(incidentClusters.id, existingId));

    return {
      clusterId: existingId,
      isNew: false,
      size,
      clientCount,
      label: cluster?.label ?? input.subject,
      crossClient: clientCount > 1,
    };
  }

  const clusterId = uuidv4();
  const firstSubject = [...neighbours].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))[0]?.subject;
  const label = (firstSubject || input.subject || 'Related tickets').slice(0, 160);
  const shared = ranked
    .filter((r) => neighbours.some((n) => n.id === r.doc.id))
    .flatMap((r) => r.sharedTerms);
  const terms = [...new Set(shared)].slice(0, 6);

  await db.insert(incidentClusters).values({
    id: clusterId,
    tenantId: input.tenantId,
    clientId: crossClient ? null : input.clientId,
    label,
    category: input.category,
    terms: JSON.stringify(terms),
    ticketCount: neighbours.length + 1,
    clientCount: clientIds.size,
    status: 'open',
    firstSeenAt: earliest,
    lastSeenAt: now,
  });
  await db
    .update(actionLogs)
    .set({ clusterId })
    .where(inArray(actionLogs.id, neighbours.map((n) => n.id)));

  return {
    clusterId,
    isNew: true,
    size: neighbours.length + 1,
    clientCount: clientIds.size,
    label,
    crossClient,
  };
}
