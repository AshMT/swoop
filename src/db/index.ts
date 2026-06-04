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
}
