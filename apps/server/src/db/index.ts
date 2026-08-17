import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { config } from '../config.js';
import * as schema from './schema.js';

/**
 * The database holds bank transactions and balances, so it lives outside the
 * repo (`~/.org/org.db` by default) with permissions locked to the owner. Both
 * the directory and the file are clamped every startup, not just at creation —
 * a mode that drifts is worth correcting quietly.
 */
function openDatabase(): SqliteDatabase {
  const dir = dirname(config.dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  const db = new Database(config.dbPath);

  // WAL lets the daily sync write while the UI reads, instead of blocking it.
  db.pragma('journal_mode = WAL');
  // Without this, the ON DELETE CASCADE rules in the schema are decorative.
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  try {
    chmodSync(dir, 0o700);
    chmodSync(config.dbPath, 0o600);
  } catch {
    // Non-fatal: a filesystem that doesn't do Unix modes shouldn't stop boot.
  }

  return db;
}

/**
 * Kept module-local rather than exported: `better-sqlite3`'s types name their
 * Database through a namespace that TypeScript can't reproduce in a declaration
 * file under `composite`, so exporting the handle breaks the build. Everything
 * goes through Drizzle anyway — `rawPragma` covers the rare case that doesn't.
 */
const sqlite = openDatabase();

export const db = drizzle(sqlite, { schema });
export { schema };
export type DB = typeof db;

/** Escape hatch for pragmas and maintenance statements Drizzle doesn't model. */
export function rawPragma(statement: string): unknown {
  return sqlite.pragma(statement);
}
