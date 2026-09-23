import { v4 as uuidv4 } from 'uuid';
import type { Request } from 'express';
import { db } from '../db';
import { auditLog } from '../db/schema';
import { createLogger, describeError } from '../lib/logger';
import type { SessionUser } from '../types';

const log = createLogger('Audit');

/**
 * The audit trail: who changed what, and when.
 *
 * Every approval, rejection, review, settings change and user change lands
 * here. Detail is structured JSON and must never carry a secret — callers pass
 * field *names* for credential changes, not values.
 *
 * A failed audit write is logged loudly but does not fail the request: the
 * change has already happened, and refusing to report it helps no one.
 */
export async function recordAudit(entry: {
  user: SessionUser | null | undefined;
  action: string;
  targetType?: string;
  targetId?: string | null;
  tenantId?: string | null;
  detail?: Record<string, unknown>;
  req?: Request;
}): Promise<void> {
  try {
    await db.insert(auditLog).values({
      id: uuidv4(),
      userId: entry.user?.userId ?? null,
      userEmail: entry.user?.email ?? 'system',
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      tenantId: entry.tenantId ?? null,
      detail: entry.detail ? JSON.stringify(entry.detail) : null,
      ip: entry.req?.ip ?? null,
    });
  } catch (err) {
    log.error(`Could not record audit entry "${entry.action}": ${describeError(err)}`);
  }
}
