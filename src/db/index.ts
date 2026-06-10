import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import path from 'path';
import fs from 'fs';

const dbPath = process.env.SQLITE_PATH || './data/swoop.db';
const dbDir = path.dirname(dbPath);

if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const sqlite = new Database(dbPath);

// Enable WAL mode for better concurrent read performance
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

export const db = drizzle(sqlite, { schema });

export function initializeDatabase(): void {
  sqlite.exec(`
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
      cipp_base_url TEXT,
      cipp_client_id TEXT,
      cipp_client_secret TEXT,
      cipp_oauth_tenant_id TEXT,
      cipp_api_scope TEXT,
      last_polled_at INTEGER,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,
      tenant_id TEXT REFERENCES tenants(id),
      name TEXT NOT NULL,
      superops_company_id TEXT,
      cipp_tenant_id TEXT,
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
      status TEXT DEFAULT 'awaiting_approval',
      approved_by TEXT,
      approved_at INTEGER,
      rejection_reason TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS execution_logs (
      id TEXT PRIMARY KEY,
      action_log_id TEXT REFERENCES action_logs(id),
      executed_at INTEGER DEFAULT (unixepoch()),
      result TEXT,
      response TEXT,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS processed_tickets (
      ticket_id TEXT PRIMARY KEY,
      tenant_id TEXT,
      last_comment_id TEXT,
      processed_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS action_policies (
      id TEXT PRIMARY KEY,
      tenant_id TEXT REFERENCES tenants(id),
      action_type TEXT NOT NULL,
      permission TEXT NOT NULL DEFAULT 'approval',
      require_verification INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER DEFAULT (unixepoch()),
      UNIQUE(tenant_id, action_type)
    );
  `);

  // Migrations for existing databases — ALTER TABLE ADD COLUMN fails if column exists,
  // so we ignore the error and treat it as a no-op.
  const migrations = [
    `ALTER TABLE tenants ADD COLUMN superops_region TEXT DEFAULT 'us'`,
    `ALTER TABLE tenants ADD COLUMN cipp_base_url TEXT`,
    `ALTER TABLE tenants ADD COLUMN cipp_api_key TEXT`,
    `ALTER TABLE tenants ADD COLUMN cipp_client_id TEXT`,
    `ALTER TABLE tenants ADD COLUMN cipp_client_secret TEXT`,
    `ALTER TABLE tenants ADD COLUMN cipp_oauth_tenant_id TEXT`,
    `ALTER TABLE tenants ADD COLUMN cipp_api_scope TEXT`,
    `ALTER TABLE tenants ADD COLUMN auto_confidence_min REAL DEFAULT 0.9`,
    `ALTER TABLE clients ADD COLUMN cipp_tenant_id TEXT`,
    `ALTER TABLE action_logs ADD COLUMN verification_method TEXT`,
    `ALTER TABLE action_logs ADD COLUMN verified_by TEXT`,
    `ALTER TABLE action_logs ADD COLUMN verified_at INTEGER`,
    `ALTER TABLE action_logs ADD COLUMN approved_by TEXT`,
    `ALTER TABLE action_logs ADD COLUMN approved_at INTEGER`,
    `ALTER TABLE action_logs ADD COLUMN rejection_reason TEXT`,
    `ALTER TABLE action_logs ADD COLUMN customer_question TEXT`,
    `ALTER TABLE action_logs ADD COLUMN question_posted_at INTEGER`,
    `ALTER TABLE action_logs ADD COLUMN customer_reply TEXT`,
    `ALTER TABLE action_logs ADD COLUMN ask_attempts INTEGER DEFAULT 0`,
    `ALTER TABLE tenants ADD COLUMN escalation_contact TEXT`,
    `CREATE TABLE IF NOT EXISTS execution_logs (
      id TEXT PRIMARY KEY,
      action_log_id TEXT REFERENCES action_logs(id),
      executed_at INTEGER DEFAULT (unixepoch()),
      result TEXT,
      response TEXT,
      error TEXT
    )`,
  ];
  for (const sql of migrations) {
    try { sqlite.exec(sql); } catch { /* already exists */ }
  }
}
