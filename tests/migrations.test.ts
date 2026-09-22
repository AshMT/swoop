import './setup-env';
import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { migrations, runMigrations } from '../src/db/migrations';

function columns(db: Database.Database, table: string): string[] {
  return (db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[]).map(
    (r) => r.name,
  );
}

describe('runMigrations', () => {
  it('creates the full schema on an empty database', () => {
    const db = new Database(':memory:');
    const { applied } = runMigrations(db);

    expect(applied).toEqual(migrations.map((m) => m.id));
    expect(columns(db, 'tenants')).toContain('confidence_threshold');
    expect(columns(db, 'action_logs')).toContain('review_verdict');
    expect(columns(db, 'processed_tickets')).toContain('attempts');
    expect(columns(db, 'action_logs')).toContain('note_attempts');
  });

  it('backfills the note attempt count so historical rows are not retried forever', () => {
    const db = new Database(':memory:');
    // Rewind to the pre-005 shape, then migrate forward again. The index has
    // to go first — SQLite will not drop a column an index still references.
    runMigrations(db);
    db.exec(`DELETE FROM schema_migrations WHERE id = '005_note_delivery_retries'`);
    db.exec(`DROP INDEX IF EXISTS action_logs_note_retry_idx`);
    db.exec(`ALTER TABLE action_logs DROP COLUMN note_attempts`);
    db.prepare(
      `INSERT INTO action_logs (id, ticket_id, status, note_posted) VALUES ('a1', 'T-1', 'classified', 1)`,
    ).run();

    runMigrations(db);

    const row = db.prepare(`SELECT note_attempts FROM action_logs WHERE id = 'a1'`).get() as {
      note_attempts: number;
    };
    expect(row.note_attempts).toBe(1);
  });

  it('is idempotent — a second run applies nothing', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    expect(runMigrations(db).applied).toEqual([]);
  });

  /**
   * The upgrade path that matters: an install created by the pre-migration
   * version, whose processed_tickets table keys only on ticket_id.
   */
  it('upgrades a legacy database without losing the dedup ledger', () => {
    const db = new Database(':memory:');

    db.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER);
      CREATE TABLE tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
        superops_subdomain TEXT NOT NULL, superops_api_key TEXT NOT NULL, superops_region TEXT,
        ai_base_url TEXT, ai_api_key TEXT, ai_model TEXT, last_polled_at INTEGER, created_at INTEGER);
      CREATE TABLE clients (id TEXT PRIMARY KEY, tenant_id TEXT, name TEXT NOT NULL,
        superops_company_id TEXT, automation_enabled INTEGER, created_at INTEGER);
      CREATE TABLE action_logs (id TEXT PRIMARY KEY, tenant_id TEXT, client_id TEXT, ticket_id TEXT NOT NULL,
        ticket_subject TEXT, ticket_body TEXT, requester_email TEXT, classification TEXT, confidence REAL,
        sensitivity TEXT, entities TEXT, reasoning TEXT, follow_up_question TEXT, proposed_psa_note TEXT,
        raw_ai_response TEXT, status TEXT DEFAULT 'pending', created_at INTEGER);
      CREATE TABLE processed_tickets (ticket_id TEXT PRIMARY KEY, tenant_id TEXT,
        last_comment_id TEXT, processed_at INTEGER);

      INSERT INTO tenants (id, name, slug, superops_subdomain, superops_api_key)
        VALUES ('t1', 'MightyIT', 'mightyit', 'mightyit', 'encrypted');
      INSERT INTO action_logs (id, tenant_id, ticket_id, classification, status)
        VALUES ('a1', 't1', 'T-1', 'password_reset', 'pending');
      INSERT INTO processed_tickets (ticket_id, tenant_id, processed_at)
        VALUES ('T-1', 't1', 1700000000), ('T-2', 't1', 1700000001);
    `);

    runMigrations(db);

    // The ledger survived, now keyed per tenant.
    const ledger = db.prepare(`SELECT tenant_id, ticket_id, status FROM processed_tickets ORDER BY ticket_id`).all();
    expect(ledger).toEqual([
      { tenant_id: 't1', ticket_id: 'T-1', status: 'done' },
      { tenant_id: 't1', ticket_id: 'T-2', status: 'done' },
    ]);

    // Two tenants may now hold the same ticket number.
    db.prepare(`INSERT INTO processed_tickets (tenant_id, ticket_id) VALUES ('t2', 'T-1')`).run();
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM processed_tickets WHERE ticket_id = 'T-1'`).get() as { n: number }).n,
    ).toBe(2);

    // The ambiguous 'pending' status was relabelled.
    const log = db.prepare(`SELECT status FROM action_logs WHERE id = 'a1'`).get() as { status: string };
    expect(log.status).toBe('classified');

    // The existing tenant row gained the new operator controls.
    expect(columns(db, 'tenants')).toEqual(expect.arrayContaining(['dry_run', 'automation_paused', 'psa_capabilities']));
  });

  it('rejects a duplicate ticket per tenant, preserving deduplication', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    db.prepare(`INSERT INTO processed_tickets (tenant_id, ticket_id) VALUES ('t1', 'T-1')`).run();
    expect(() =>
      db.prepare(`INSERT INTO processed_tickets (tenant_id, ticket_id) VALUES ('t1', 'T-1')`).run(),
    ).toThrow();
  });

  it('leaves the database untouched when a migration throws', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const before = db.prepare(`SELECT COUNT(*) AS n FROM schema_migrations`).get() as { n: number };

    const broken = { id: '999_broken', up: () => { throw new Error('boom'); } };
    migrations.push(broken);
    // The migration runner logs the failure on purpose; silence it so the
    // expected error does not look like a real one in the test output.
    const silenced = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => runMigrations(db)).toThrow(/boom/);
      const after = db.prepare(`SELECT COUNT(*) AS n FROM schema_migrations`).get() as { n: number };
      expect(after.n).toBe(before.n);
    } finally {
      silenced.mockRestore();
      migrations.pop();
    }
  });
});
