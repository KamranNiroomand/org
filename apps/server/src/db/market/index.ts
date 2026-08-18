import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { config } from '../../config.js';
import * as marketSchema from './schema.js';

/**
 * The market research database, opened separately from `org.db`.
 *
 * Same shape as `../index.ts`, with two differences that follow from this file
 * being written in hundred-thousand-row batches rather than a few dozen bank
 * transactions a day:
 *
 *   - `synchronous = NORMAL` instead of the default FULL. Under WAL this is
 *     durable across process crashes and only risks the last transaction on a
 *     power cut. For data that can be re-fetched from the vendor that is the
 *     right trade; the personal database keeps FULL, where it is not.
 *   - A larger page cache, because the feature builder scans a day of quotes
 *     at a time.
 */
function openMarketDatabase(): SqliteDatabase {
  const dir = dirname(config.market.dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  const db = new Database(config.market.dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  // Negative means KiB rather than pages: 64 MB.
  db.pragma('cache_size = -64000');

  try {
    chmodSync(dir, 0o700);
    chmodSync(config.market.dbPath, 0o600);
  } catch {
    // Non-fatal, same as the personal database.
  }

  return db;
}

const sqlite = openMarketDatabase();

export const marketDb = drizzle(sqlite, { schema: marketSchema });
export { marketSchema };
export type MarketDB = typeof marketDb;

/** Escape hatch for pragmas and maintenance statements Drizzle doesn't model. */
export function marketPragma(statement: string): unknown {
  return sqlite.pragma(statement);
}

/**
 * Raw `.exec()`, for statements `pragma()` cannot run — `VACUUM INTO` is a
 * full statement with a string literal argument, not a pragma.
 */
export function rawMarketPragma(sql: string): void {
  sqlite.exec(sql);
}

/**
 * Reclaims space after a retention prune. Not run automatically: VACUUM
 * rewrites the whole file and needs room for a second copy, which on a
 * multi-gigabyte database is a decision, not a housekeeping detail.
 */
export function vacuumMarket(): void {
  sqlite.exec('VACUUM');
}
