import type { Database } from 'better-sqlite3';
import { createLogger } from '../lib/logger';

const log = createLogger('DB');

export interface Migration {
  id: string;
  up: (db: Database) => void;
}

/**
 * Forward-only migrations, applied in array order and recorded in
 * `schema_migrations`. Each runs inside a transaction, so a failure leaves the
 * database on the previous version rather than half-migrated.
 *
 * Migrations must be idempotent-safe to *add* but never edited once released —
 * an installed database has already recorded the old id.
 */
export const migrations: Migration[] = [
  {
    // Baseline. Matches the pre-migration-runner schema so existing installs
    // (whose tables were created by the old CREATE TABLE IF NOT EXISTS block)
    // land here cleanly and only run the later migrations.
    id: '001_baseline',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          email TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          created_at INTEGER DEFAULT (unixepoch())
        );

        CREATE TABLE IF NOT EXISTS tenants (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          slug TEXT UNIQUE NOT NULL,
          superops_subdomain TEXT NOT NULL,
          superops_api_key TEXT NOT NULL,
          superops_region TEXT DEFAULT 'us',
          ai_base_url TEXT,
          ai_api_key TEXT,
          ai_model TEXT,
          last_polled_at INTEGER,
          created_at INTEGER DEFAULT (unixepoch())
        );

        CREATE TABLE IF NOT EXISTS clients (
          id TEXT PRIMARY KEY,
          tenant_id TEXT REFERENCES tenants(id),
          name TEXT NOT NULL,
          superops_company_id TEXT,
          automation_enabled INTEGER DEFAULT 0,
          created_at INTEGER DEFAULT (unixepoch())
        );

        CREATE TABLE IF NOT EXISTS action_logs (
          id TEXT PRIMARY KEY,
          tenant_id TEXT REFERENCES tenants(id),
          client_id TEXT REFERENCES clients(id),
          ticket_id TEXT NOT NULL,
          ticket_subject TEXT,
          ticket_body TEXT,
          requester_email TEXT,
          classification TEXT,
          confidence REAL,
          sensitivity TEXT,
          entities TEXT,
          reasoning TEXT,
          follow_up_question TEXT,
          proposed_psa_note TEXT,
          raw_ai_response TEXT,
          status TEXT DEFAULT 'pending',
          created_at INTEGER DEFAULT (unixepoch())
        );

        CREATE TABLE IF NOT EXISTS processed_tickets (
          ticket_id TEXT PRIMARY KEY,
          tenant_id TEXT,
          last_comment_id TEXT,
          processed_at INTEGER DEFAULT (unixepoch())
        );
      `);
      // Present on installs that ran the old ad-hoc ALTER list.
      addColumnIfMissing(db, 'tenants', 'superops_region', `TEXT DEFAULT 'us'`);
    },
  },

  {
    id: '002_operator_controls_and_poll_health',
    up: (db) => {
      addColumnIfMissing(db, 'tenants', 'poll_interval_seconds', 'INTEGER DEFAULT 60');
      addColumnIfMissing(db, 'tenants', 'confidence_threshold', 'REAL DEFAULT 0.75');
      addColumnIfMissing(db, 'tenants', 'automation_paused', 'INTEGER DEFAULT 0');
      addColumnIfMissing(db, 'tenants', 'dry_run', 'INTEGER DEFAULT 0');
      addColumnIfMissing(db, 'tenants', 'system_prompt_override', 'TEXT');
      addColumnIfMissing(db, 'tenants', 'psa_capabilities', 'TEXT');
      addColumnIfMissing(db, 'tenants', 'psa_capabilities_probed_at', 'INTEGER');
      addColumnIfMissing(db, 'tenants', 'last_poll_status', 'TEXT');
      addColumnIfMissing(db, 'tenants', 'last_poll_error', 'TEXT');
      addColumnIfMissing(db, 'tenants', 'last_poll_finished_at', 'INTEGER');
      addColumnIfMissing(db, 'tenants', 'last_poll_duration_ms', 'INTEGER');
      addColumnIfMissing(db, 'tenants', 'last_poll_ticket_count', 'INTEGER');
      addColumnIfMissing(db, 'clients', 'context_notes', 'TEXT');
      addColumnIfMissing(db, 'users', 'role', `TEXT DEFAULT 'admin'`);
      addColumnIfMissing(db, 'users', 'last_login_at', 'INTEGER');
    },
  },

  {
    id: '003_action_log_telemetry_and_review',
    up: (db) => {
      addColumnIfMissing(db, 'action_logs', 'ticket_display_id', 'TEXT');
      addColumnIfMissing(db, 'action_logs', 'escalation_reason', 'TEXT');
      addColumnIfMissing(db, 'action_logs', 'error_message', 'TEXT');
      addColumnIfMissing(db, 'action_logs', 'ai_model', 'TEXT');
      addColumnIfMissing(db, 'action_logs', 'ai_latency_ms', 'INTEGER');
      addColumnIfMissing(db, 'action_logs', 'prompt_tokens', 'INTEGER');
      addColumnIfMissing(db, 'action_logs', 'completion_tokens', 'INTEGER');
      addColumnIfMissing(db, 'action_logs', 'note_posted', 'INTEGER DEFAULT 0');
      addColumnIfMissing(db, 'action_logs', 'note_error', 'TEXT');
      addColumnIfMissing(db, 'action_logs', 'review_verdict', 'TEXT');
      addColumnIfMissing(db, 'action_logs', 'review_correct_classification', 'TEXT');
      addColumnIfMissing(db, 'action_logs', 'review_note', 'TEXT');
      addColumnIfMissing(db, 'action_logs', 'reviewed_by', 'TEXT');
      addColumnIfMissing(db, 'action_logs', 'reviewed_at', 'INTEGER');

      db.exec(`
        CREATE INDEX IF NOT EXISTS action_logs_tenant_created_idx
          ON action_logs (tenant_id, created_at);
        CREATE INDEX IF NOT EXISTS action_logs_ticket_idx
          ON action_logs (ticket_id);
        CREATE INDEX IF NOT EXISTS action_logs_review_idx
          ON action_logs (review_verdict);
      `);

      // Rows written by the old poller used status='pending' to mean "classified,
      // awaiting nothing in particular". Re-label so the status column can carry
      // real meaning (classified / ai_failed / note_failed).
      db.exec(`UPDATE action_logs SET status = 'classified' WHERE status = 'pending' OR status IS NULL`);
    },
  },

  {
    // processed_tickets had `ticket_id` as its sole primary key, so two tenants
    // with overlapping ticket numbering would mask each other's tickets.
    // SQLite cannot alter a primary key, so rebuild and copy.
    id: '004_processed_tickets_tenant_scoped_pk',
    up: (db) => {
      const alreadyMigrated = db
        .prepare(`SELECT COUNT(*) AS n FROM pragma_table_info('processed_tickets') WHERE name = 'attempts'`)
        .get() as { n: number };
      if (alreadyMigrated.n > 0) return;

      db.exec(`
        CREATE TABLE processed_tickets_new (
          tenant_id TEXT NOT NULL,
          ticket_id TEXT NOT NULL,
          status TEXT DEFAULT 'done',
          attempts INTEGER DEFAULT 1,
          last_error TEXT,
          next_attempt_at INTEGER,
          last_comment_id TEXT,
          processed_at INTEGER DEFAULT (unixepoch()),
          PRIMARY KEY (tenant_id, ticket_id)
        );

        INSERT OR IGNORE INTO processed_tickets_new
          (tenant_id, ticket_id, status, attempts, last_comment_id, processed_at)
        SELECT COALESCE(tenant_id, ''), ticket_id, 'done', 1, last_comment_id, processed_at
        FROM processed_tickets;

        DROP TABLE processed_tickets;
        ALTER TABLE processed_tickets_new RENAME TO processed_tickets;

        CREATE INDEX IF NOT EXISTS processed_tickets_retry_idx
          ON processed_tickets (status, next_attempt_at);
      `);
    },
  },

  {
    id: '005_note_delivery_retries',
    up: (db) => {
      addColumnIfMissing(db, 'action_logs', 'note_attempts', 'INTEGER DEFAULT 0');
      // A row whose note landed had one successful attempt; one that failed had
      // one failed attempt. Either way the historical count is 1.
      db.exec(`UPDATE action_logs SET note_attempts = 1 WHERE note_attempts IS NULL OR note_attempts = 0`);
      db.exec(`
        CREATE INDEX IF NOT EXISTS action_logs_note_retry_idx
          ON action_logs (status, note_attempts);
      `);
    },
  },

  {
    id: '006_log_retention',
    up: (db) => {
      addColumnIfMissing(db, 'tenants', 'log_retention_days', 'INTEGER DEFAULT 0');
    },
  },

  {
    id: '007_prompt_fingerprint',
    up: (db) => {
      addColumnIfMissing(db, 'action_logs', 'prompt_fingerprint', 'TEXT');
      db.exec(`
        CREATE INDEX IF NOT EXISTS action_logs_prompt_idx
          ON action_logs (prompt_fingerprint);
      `);
      // Existing rows predate the stamp. Leaving them NULL is honest — they
      // are from an unknown prompt version, and the UI says so.
    },
  },

  {
    id: '008_classify_concurrency',
    up: (db) => {
      // Defaults to 1 so an upgrade does not change how hard an existing
      // install hits its AI provider without the operator asking for it.
      addColumnIfMissing(db, 'tenants', 'classify_concurrency', 'INTEGER DEFAULT 1');
    },
  },

  {
    id: '009_note_format',
    up: (db) => {
      // Defaults to plain: a note full of raw Markdown asterisks reads worse
      // than plain text, and it is visible on every ticket.
      addColumnIfMissing(db, 'tenants', 'note_format', `TEXT DEFAULT 'plain'`);
    },
  },

  {
    id: '010_client_prompt_override',
    up: (db) => {
      addColumnIfMissing(db, 'clients', 'system_prompt_override', 'TEXT');
    },
  },

  {
    // The full triage verdict: what kind of ticket this is, how urgent, who
    // should take it, and what to say to the requester — not just which of
    // nine identity actions it resembles.
    id: '011_triage_verdict',
    up: (db) => {
      const cols: Array<[string, string]> = [
        ['category', 'TEXT'],
        ['subcategory', 'TEXT'],
        ['impact', 'TEXT'],
        ['urgency', 'TEXT'],
        ['priority', 'TEXT'],
        ['summary', 'TEXT'],
        ['sentiment', 'TEXT'],
        ['suggested_queue', 'TEXT'],
        ['first_response', 'TEXT'],
        ['next_steps', 'TEXT'],
        ['signals', 'TEXT'],
        ['triage_version', 'INTEGER'],
        ['review_correct_category', 'TEXT'],
        ['review_correct_priority', 'TEXT'],
      ];
      for (const [name, def] of cols) addColumnIfMissing(db, 'action_logs', name, def);
      db.exec(`
        CREATE INDEX IF NOT EXISTS action_logs_priority_idx ON action_logs (tenant_id, priority);
        CREATE INDEX IF NOT EXISTS action_logs_category_idx ON action_logs (tenant_id, category);
      `);
      // Per-tenant triage settings (business hours, queue routing, thresholds)
      // as one JSON document, validated with defaults on read.
      addColumnIfMissing(db, 'tenants', 'triage_settings', 'TEXT');
    },
  },

  {
    // Tenant recognition: which email domains and which Microsoft 365 tenant
    // belong to each client, so a ticket can be matched on who sent it and a
    // request that reaches across clients can be caught.
    id: '012_tenancy_recognition',
    up: (db) => {
      addColumnIfMissing(db, 'clients', 'email_domains', 'TEXT');
      addColumnIfMissing(db, 'clients', 'm365_tenant_id', 'TEXT');
      addColumnIfMissing(db, 'clients', 'm365_default_domain', 'TEXT');
      addColumnIfMissing(db, 'clients', 'vip_emails', 'TEXT');
      addColumnIfMissing(db, 'action_logs', 'match_method', 'TEXT');
      addColumnIfMissing(db, 'action_logs', 'requester_domain', 'TEXT');
      addColumnIfMissing(db, 'action_logs', 'cross_tenant', 'INTEGER DEFAULT 0');
      addColumnIfMissing(db, 'action_logs', 'tenancy', 'TEXT');
    },
  },

  {
    // Similar tickets, duplicates and incident clusters.
    id: '013_similarity_and_clusters',
    up: (db) => {
      addColumnIfMissing(db, 'action_logs', 'duplicate_of_log_id', 'TEXT');
      addColumnIfMissing(db, 'action_logs', 'similar', 'TEXT');
      addColumnIfMissing(db, 'action_logs', 'cluster_id', 'TEXT');
      db.exec(`
        CREATE TABLE IF NOT EXISTS incident_clusters (
          id TEXT PRIMARY KEY,
          tenant_id TEXT REFERENCES tenants(id),
          client_id TEXT,
          label TEXT NOT NULL,
          category TEXT,
          terms TEXT,
          ticket_count INTEGER DEFAULT 0,
          client_count INTEGER DEFAULT 0,
          status TEXT DEFAULT 'open',
          first_seen_at INTEGER,
          last_seen_at INTEGER,
          acknowledged_by TEXT,
          acknowledged_at INTEGER,
          created_at INTEGER DEFAULT (unixepoch())
        );
        CREATE INDEX IF NOT EXISTS incident_clusters_tenant_idx
          ON incident_clusters (tenant_id, status, last_seen_at);
        CREATE INDEX IF NOT EXISTS action_logs_cluster_idx ON action_logs (cluster_id);
      `);
    },
  },

  {
    // Multiple people, each with a role, and a record of who did what.
    id: '014_users_roles_audit',
    up: (db) => {
      addColumnIfMissing(db, 'users', 'display_name', 'TEXT');
      addColumnIfMissing(db, 'users', 'disabled', 'INTEGER DEFAULT 0');
      // Bumped on password change or disable, which revokes every token
      // issued before — stateless tokens are otherwise unrevocable.
      addColumnIfMissing(db, 'users', 'token_version', 'INTEGER DEFAULT 0');
      addColumnIfMissing(db, 'users', 'invited_by', 'TEXT');
      // Anyone who existed before roles did was, in effect, an admin.
      db.exec(`UPDATE users SET role = 'admin' WHERE role IS NULL OR role = ''`);
      db.exec(`
        CREATE TABLE IF NOT EXISTS invites (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL,
          role TEXT NOT NULL,
          token_hash TEXT NOT NULL UNIQUE,
          created_by TEXT,
          expires_at INTEGER NOT NULL,
          accepted_at INTEGER,
          revoked_at INTEGER,
          created_at INTEGER DEFAULT (unixepoch())
        );

        CREATE TABLE IF NOT EXISTS audit_log (
          id TEXT PRIMARY KEY,
          user_id TEXT,
          user_email TEXT,
          action TEXT NOT NULL,
          target_type TEXT,
          target_id TEXT,
          tenant_id TEXT,
          detail TEXT,
          ip TEXT,
          created_at INTEGER DEFAULT (unixepoch())
        );
        CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log (created_at);
        CREATE INDEX IF NOT EXISTS audit_log_target_idx ON audit_log (target_type, target_id);
      `);
    },
  },

  {
    // Approvals: a proposed action waits for one or two people to sign it off.
    // Approval produces an execution plan; it does not execute anything.
    id: '015_approvals',
    up: (db) => {
      addColumnIfMissing(db, 'tenants', 'approval_policy', 'TEXT');
      addColumnIfMissing(db, 'action_logs', 'approval_state', 'TEXT');
      addColumnIfMissing(db, 'action_logs', 'approvals_required', 'INTEGER DEFAULT 0');
      addColumnIfMissing(db, 'action_logs', 'approval_reason', 'TEXT');
      addColumnIfMissing(db, 'action_logs', 'approval_expires_at', 'INTEGER');
      addColumnIfMissing(db, 'action_logs', 'execution_plan', 'TEXT');
      addColumnIfMissing(db, 'action_logs', 'superseded_by', 'TEXT');
      db.exec(`
        CREATE TABLE IF NOT EXISTS approvals (
          id TEXT PRIMARY KEY,
          action_log_id TEXT NOT NULL REFERENCES action_logs(id) ON DELETE CASCADE,
          user_id TEXT,
          user_email TEXT,
          decision TEXT NOT NULL,
          reason TEXT,
          comment TEXT,
          created_at INTEGER DEFAULT (unixepoch())
        );
        CREATE INDEX IF NOT EXISTS approvals_log_idx ON approvals (action_log_id);
        CREATE INDEX IF NOT EXISTS action_logs_approval_idx ON action_logs (tenant_id, approval_state);
      `);
    },
  },

  {
    // Read-only CIPP lookups of the user a ticket is about.
    id: '016_cipp_enrichment',
    up: (db) => {
      addColumnIfMissing(db, 'tenants', 'cipp_api_url', 'TEXT');
      addColumnIfMissing(db, 'tenants', 'cipp_tenant_id', 'TEXT');
      addColumnIfMissing(db, 'tenants', 'cipp_client_id', 'TEXT');
      addColumnIfMissing(db, 'tenants', 'cipp_client_secret', 'TEXT');
      addColumnIfMissing(db, 'tenants', 'cipp_enabled', 'INTEGER DEFAULT 0');
      addColumnIfMissing(db, 'action_logs', 'enrichment', 'TEXT');
    },
  },
];

/**
 * `ALTER TABLE ... ADD COLUMN` throws when the column exists. Checking
 * pragma_table_info first keeps failures meaningful instead of swallowing every
 * error the way the previous try/catch approach did.
 */
function addColumnIfMissing(db: Database, table: string, column: string, definition: string): void {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM pragma_table_info(?) WHERE name = ?`)
    .get(table, column) as { n: number };
  if (row.n > 0) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function runMigrations(db: Database): { applied: string[]; skipped: number } {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at INTEGER DEFAULT (unixepoch())
    );
  `);

  const done = new Set(
    (db.prepare(`SELECT id FROM schema_migrations`).all() as { id: string }[]).map((r) => r.id),
  );

  const applied: string[] = [];
  const record = db.prepare(`INSERT INTO schema_migrations (id) VALUES (?)`);

  for (const migration of migrations) {
    if (done.has(migration.id)) continue;
    const run = db.transaction(() => {
      migration.up(db);
      record.run(migration.id);
    });
    try {
      run();
      applied.push(migration.id);
      log.info(`Applied migration ${migration.id}`);
    } catch (err) {
      log.error(`Migration ${migration.id} failed — database left unchanged`, err);
      throw err;
    }
  }

  return { applied, skipped: done.size };
}
