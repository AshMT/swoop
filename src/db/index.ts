import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import { runMigrations } from './migrations';
import { config } from '../config';
import { createLogger } from '../lib/logger';
import path from 'path';
import fs from 'fs';

const log = createLogger('DB');

let sqlite: Database.Database | null = null;
let drizzleDb: ReturnType<typeof drizzle> | null = null;

function connect(): { sqlite: Database.Database; db: ReturnType<typeof drizzle> } {
  if (sqlite && drizzleDb) return { sqlite, db: drizzleDb };

  const dbPath = config().sqlitePath;
  if (dbPath !== ':memory:') {
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
  }

  sqlite = new Database(dbPath);
  // WAL lets the HTTP handlers read while the poller writes.
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  // Wait rather than throw SQLITE_BUSY if the poller holds a write lock.
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('synchronous = NORMAL');

  drizzleDb = drizzle(sqlite, { schema });
  return { sqlite, db: drizzleDb };
}

/**
 * Proxy so `import { db } from './db'` keeps working while the real connection
 * is opened lazily — importing a module must not touch the filesystem or throw
 * on a missing config, which matters for unit tests.
 */
export const db = new Proxy({} as ReturnType<typeof drizzle>, {
  get(_target, prop) {
    const value = connect().db[prop as keyof ReturnType<typeof drizzle>];
    return typeof value === 'function' ? value.bind(connect().db) : value;
  },
}) as ReturnType<typeof drizzle>;

export function getSqlite(): Database.Database {
  return connect().sqlite;
}

export function initializeDatabase(): void {
  const { sqlite: raw } = connect();
  const { applied, skipped } = runMigrations(raw);
  if (applied.length === 0) {
    log.info(`Schema up to date (${skipped} migration(s) already applied)`);
  } else {
    log.info(`Applied ${applied.length} migration(s): ${applied.join(', ')}`);
  }
}

export function closeDatabase(): void {
  if (!sqlite) return;
  try {
    // Fold the WAL back into the main file so a plain file copy is a valid backup.
    sqlite.pragma('wal_checkpoint(TRUNCATE)');
    sqlite.close();
  } catch (err) {
    log.warn('Error while closing the database', err);
  } finally {
    sqlite = null;
    drizzleDb = null;
  }
}

/** Test seam — drops the cached connection so the next call reconnects. */
export function resetDatabaseForTesting(): void {
  sqlite = null;
  drizzleDb = null;
}
