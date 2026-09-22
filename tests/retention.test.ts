import './setup-env';
import { beforeEach, describe, expect, it } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { eq } from 'drizzle-orm';
import { db, initializeDatabase, getSqlite } from '../src/db';
import { actionLogs, processedTickets, tenants } from '../src/db/schema';
import { describeLogStorage, pruneTenantLogs } from '../src/services/retention';
import type { Tenant } from '../src/types';

const TENANT_ID = uuidv4();
const DAY = 86_400;

function daysAgo(days: number): number {
  return Math.floor(Date.now() / 1000) - days * DAY;
}

async function seedLog(ageDays: number, overrides: Record<string, unknown> = {}) {
  const id = uuidv4();
  await db.insert(actionLogs).values({
    id,
    tenantId: TENANT_ID,
    ticketId: `T-${id.slice(0, 6)}`,
    ticketSubject: 'Password reset',
    ticketBody: 'Please reset the password for sarah@acme.com, she is locked out.',
    rawAiResponse: '{"classification":"password_reset","confidence":0.94}',
    classification: 'password_reset',
    confidence: 0.94,
    reviewVerdict: 'correct',
    status: 'classified',
    createdAt: daysAgo(ageDays),
    ...overrides,
  });
  return id;
}

function tenantWith(retentionDays: number): Tenant {
  return { id: TENANT_ID, name: 'MightyIT', logRetentionDays: retentionDays } as Tenant;
}

beforeEach(async () => {
  initializeDatabase();
  getSqlite().exec('DELETE FROM action_logs; DELETE FROM processed_tickets; DELETE FROM tenants;');
  await db.insert(tenants).values({
    id: TENANT_ID,
    name: 'MightyIT',
    slug: `mightyit-${TENANT_ID.slice(0, 8)}`,
    superopsSubdomain: 'mightyit',
    superopsApiKey: 'x',
  });
});

describe('pruneTenantLogs', () => {
  it('does nothing when retention is off — an audit trail is not discarded by default', async () => {
    await seedLog(400);
    const result = await pruneTenantLogs(tenantWith(0));
    expect(result).toEqual({ bodiesCleared: 0, rowsDeleted: 0, ledgerRowsDeleted: 0 });
    expect((await db.select().from(actionLogs)).length).toBe(1);
  });

  it('leaves recent rows completely alone', async () => {
    await seedLog(1);
    const result = await pruneTenantLogs(tenantWith(90));
    expect(result.bodiesCleared).toBe(0);
    expect(result.rowsDeleted).toBe(0);
    const [row] = await db.select().from(actionLogs);
    expect(row.ticketBody).toBeTruthy();
  });

  /**
   * The first stage is the one that matters: it reclaims most of the storage
   * while keeping everything the accuracy figures are computed from.
   */
  it('clears the bulky text at a third of the window but keeps the row', async () => {
    await seedLog(40); // a third of 90 is 30 days
    const result = await pruneTenantLogs(tenantWith(90));

    expect(result.bodiesCleared).toBe(1);
    expect(result.rowsDeleted).toBe(0);

    const [row] = await db.select().from(actionLogs);
    expect(row.ticketBody).toBeNull();
    expect(row.rawAiResponse).toBeNull();
    // The parts the calibration report reads are untouched.
    expect(row.classification).toBe('password_reset');
    expect(row.confidence).toBe(0.94);
    expect(row.reviewVerdict).toBe('correct');
    expect(row.ticketSubject).toBe('Password reset');
  });

  it('deletes the row past the full window', async () => {
    await seedLog(120);
    const result = await pruneTenantLogs(tenantWith(90));
    expect(result.rowsDeleted).toBe(1);
    expect((await db.select().from(actionLogs)).length).toBe(0);
  });

  it('is idempotent — a second pass clears nothing further', async () => {
    await seedLog(40);
    await pruneTenantLogs(tenantWith(90));
    const second = await pruneTenantLogs(tenantWith(90));
    expect(second.bodiesCleared).toBe(0);
  });

  it("never touches another tenant's rows", async () => {
    const otherId = uuidv4();
    await db.insert(tenants).values({
      id: otherId,
      name: 'Other MSP',
      slug: `other-${otherId.slice(0, 8)}`,
      superopsSubdomain: 'other',
      superopsApiKey: 'x',
    });
    await db.insert(actionLogs).values({
      id: uuidv4(),
      tenantId: otherId,
      ticketId: 'T-OTHER',
      ticketBody: 'should survive',
      createdAt: daysAgo(400),
    });

    await pruneTenantLogs(tenantWith(90));

    const survivors = await db.select().from(actionLogs).where(eq(actionLogs.tenantId, otherId));
    expect(survivors).toHaveLength(1);
    expect(survivors[0].ticketBody).toBe('should survive');
  });

  /**
   * Deleting a ledger entry makes the ticket eligible for reprocessing, so the
   * ledger must outlive any window in which the PSA could still return it.
   */
  it('keeps the dedup ledger for twice the log window', async () => {
    await db.insert(processedTickets).values([
      { tenantId: TENANT_ID, ticketId: 'T-RECENT', status: 'done', processedAt: daysAgo(100) },
      { tenantId: TENANT_ID, ticketId: 'T-ANCIENT', status: 'done', processedAt: daysAgo(400) },
    ]);

    const result = await pruneTenantLogs(tenantWith(90));

    expect(result.ledgerRowsDeleted).toBe(1);
    const remaining = await db.select().from(processedTickets);
    expect(remaining.map((r) => r.ticketId)).toEqual(['T-RECENT']);
  });

  it('never prunes a ledger entry still queued for retry', async () => {
    await db.insert(processedTickets).values({
      tenantId: TENANT_ID,
      ticketId: 'T-FAILED',
      status: 'failed',
      processedAt: daysAgo(400),
    });
    const result = await pruneTenantLogs(tenantWith(90));
    expect(result.ledgerRowsDeleted).toBe(0);
  });
});

describe('describeLogStorage', () => {
  it('reports zero for an empty log', async () => {
    const storage = await describeLogStorage(TENANT_ID);
    expect(storage).toMatchObject({ rows: 0, oldestAt: null, bodyBytes: 0, totalBytes: 0 });
  });

  it('counts rows, the oldest entry and the stored text', async () => {
    await seedLog(10);
    await seedLog(50);
    const storage = await describeLogStorage(TENANT_ID);

    expect(storage.rows).toBe(2);
    expect(storage.oldestAt).toBeLessThanOrEqual(daysAgo(49));
    expect(storage.bodyBytes).toBeGreaterThan(0);
    // Total includes the subject and note columns as well as the body.
    expect(storage.totalBytes).toBeGreaterThanOrEqual(storage.bodyBytes);
  });

  it('reports a smaller footprint after the bodies are cleared', async () => {
    await seedLog(40);
    const before = await describeLogStorage(TENANT_ID);
    await pruneTenantLogs(tenantWith(90));
    const after = await describeLogStorage(TENANT_ID);

    expect(after.rows).toBe(before.rows);
    expect(after.bodyBytes).toBe(0);
    expect(after.totalBytes).toBeLessThan(before.totalBytes);
  });
});
