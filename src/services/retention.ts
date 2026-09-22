import { and, eq, isNotNull, lt, or, sql } from 'drizzle-orm';
import { db } from '../db';
import { actionLogs, processedTickets, tenants } from '../db/schema';
import { createLogger, describeError } from '../lib/logger';
import type { Tenant } from '../types';

const log = createLogger('Retention');

/**
 * Prunes old action log rows.
 *
 * Each row stores the full ticket body and the raw model response, which is
 * what makes the log useful for debugging a classification and also what makes
 * it grow without bound. Left alone, a busy desk fills the volume with text
 * nobody will read again.
 *
 * Two stages, because the value of a row decays unevenly:
 *
 *  1. At a third of the window, the bulky text is cleared but the row stays.
 *     The classification, the verdict and the review survive, so the accuracy
 *     figures are unaffected — only the ability to re-read the original ticket
 *     is lost, and by then it is in the PSA anyway.
 *  2. At the full window, the row is deleted.
 *
 * A retention of 0 keeps everything, which is the default: silently discarding
 * an MSP's audit trail is not a reasonable default.
 */

/** Ledger entries are pruned on a longer window than the logs they guard. */
const LEDGER_RETENTION_MULTIPLIER = 2;

export interface PruneResult {
  bodiesCleared: number;
  rowsDeleted: number;
  ledgerRowsDeleted: number;
}

export async function pruneTenantLogs(tenant: Tenant): Promise<PruneResult> {
  const result: PruneResult = { bodiesCleared: 0, rowsDeleted: 0, ledgerRowsDeleted: 0 };

  const retentionDays = tenant.logRetentionDays ?? 0;
  if (retentionDays <= 0) return result;

  const now = Math.floor(Date.now() / 1000);
  const deleteBefore = now - retentionDays * 86_400;
  const stripBefore = now - Math.max(1, Math.floor(retentionDays / 3)) * 86_400;

  try {
    // Stage 1: drop the bulky text from rows past a third of the window.
    const stripped = await db
      .update(actionLogs)
      .set({ ticketBody: null, rawAiResponse: null })
      .where(
        and(
          eq(actionLogs.tenantId, tenant.id),
          lt(actionLogs.createdAt, stripBefore),
          or(isNotNull(actionLogs.ticketBody), isNotNull(actionLogs.rawAiResponse)),
        ),
      )
      .returning({ id: actionLogs.id });
    result.bodiesCleared = stripped.length;

    // Stage 2: delete rows past the full window.
    const deleted = await db
      .delete(actionLogs)
      .where(and(eq(actionLogs.tenantId, tenant.id), lt(actionLogs.createdAt, deleteBefore)))
      .returning({ id: actionLogs.id });
    result.rowsDeleted = deleted.length;

    // The dedup ledger is kept longer than the logs: deleting an entry makes
    // the ticket eligible for reprocessing, so it must outlive any window in
    // which the PSA could still return that ticket.
    const ledgerBefore = now - retentionDays * LEDGER_RETENTION_MULTIPLIER * 86_400;
    const ledgerDeleted = await db
      .delete(processedTickets)
      .where(
        and(
          eq(processedTickets.tenantId, tenant.id),
          eq(processedTickets.status, 'done'),
          lt(processedTickets.processedAt, ledgerBefore),
        ),
      )
      .returning({ ticketId: processedTickets.ticketId });
    result.ledgerRowsDeleted = ledgerDeleted.length;

    if (result.bodiesCleared > 0 || result.rowsDeleted > 0 || result.ledgerRowsDeleted > 0) {
      log.info(
        `Tenant ${tenant.name}: cleared ${result.bodiesCleared} ticket bodies, ` +
          `deleted ${result.rowsDeleted} log row(s) and ${result.ledgerRowsDeleted} ledger row(s)`,
      );
    }
  } catch (err) {
    // Retention is housekeeping; never let it break a poll cycle.
    log.warn(`Tenant ${tenant.name}: log pruning failed — ${describeError(err)}`);
  }

  return result;
}

/** Storage figures for the Diagnostics panel. */
export async function describeLogStorage(tenantId: string): Promise<{
  rows: number;
  oldestAt: number | null;
  bodyBytes: number;
  totalBytes: number;
}> {
  const [row] = await db
    .select({
      rows: sql<number>`count(*)`,
      oldestAt: sql<number | null>`min(${actionLogs.createdAt})`,
      bodyBytes: sql<number>`coalesce(sum(length(coalesce(${actionLogs.ticketBody}, '')) + length(coalesce(${actionLogs.rawAiResponse}, ''))), 0)`,
      totalBytes: sql<number>`coalesce(sum(
        length(coalesce(${actionLogs.ticketBody}, '')) +
        length(coalesce(${actionLogs.rawAiResponse}, '')) +
        length(coalesce(${actionLogs.proposedPsaNote}, '')) +
        length(coalesce(${actionLogs.reasoning}, '')) +
        length(coalesce(${actionLogs.ticketSubject}, ''))
      ), 0)`,
    })
    .from(actionLogs)
    .where(eq(actionLogs.tenantId, tenantId));

  return {
    rows: Number(row?.rows ?? 0),
    oldestAt: row?.oldestAt ?? null,
    bodyBytes: Number(row?.bodyBytes ?? 0),
    totalBytes: Number(row?.totalBytes ?? 0),
  };
}

/** Runs retention for every tenant. Called on a slow timer by the poller. */
export async function pruneAllTenants(): Promise<void> {
  const rows = await db.select().from(tenants);
  for (const tenant of rows) {
    await pruneTenantLogs(tenant);
  }
}
