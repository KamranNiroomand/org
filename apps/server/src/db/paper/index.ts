import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { config } from '../../config.js';
import * as paperSchema from './schema.js';

/**
 * The paper trading database, opened separately from both `org.db` and
 * `market.db` — see the doc comment atop `./schema.ts` for why.
 *
 * Small and precious, like `org.db`, not large and rebuildable like
 * `market.db`: no `synchronous = NORMAL` downgrade here, since there is no
 * vendor to re-fetch a paper trade from if a page cut a write.
 */
function openPaperDatabase(): SqliteDatabase {
  const dir = dirname(config.market.paperDbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  const db = new Database(config.market.paperDbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  try {
    chmodSync(dir, 0o700);
    chmodSync(config.market.paperDbPath, 0o600);
  } catch {
    // Non-fatal, same as the other two databases.
  }

  return db;
}

const sqlite = openPaperDatabase();

export const paperDb = drizzle(sqlite, { schema: paperSchema });
export { paperSchema };
export type PaperDB = typeof paperDb;

/** Escape hatch for pragmas and maintenance statements Drizzle doesn't model. */
export function paperPragma(statement: string): unknown {
  return sqlite.pragma(statement);
}
