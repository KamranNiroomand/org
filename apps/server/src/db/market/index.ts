import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
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

// `let`, not `const` — `connect()` reassigns both on every `reopenMarketDb()`
// call, and every importer's `import { marketDb }` binding picks up the
// reassignment automatically (ES module named imports are live bindings, not
// snapshots).
let sqlite: SqliteDatabase;
export let marketDb: ReturnType<typeof drizzle<typeof marketSchema>>;

/** The only place `sqlite`/`marketDb` are assigned — module init and
 * `reopenMarketDb()` both call this rather than repeating the two-line
 * open-and-wrap sequence, so the pair can't drift apart on a future edit. */
function connect(): void {
  sqlite = openMarketDatabase();
  marketDb = drizzle(sqlite, { schema: marketSchema });
}
connect();

export { marketSchema };
export type MarketDB = typeof marketDb;

/**
 * Closes and reopens the connection at the same path — for a reader right
 * after `market:pull` replaces the file underneath it.
 *
 * `rsync` (the transport `pullMarketSnapshot` uses) writes to a temp file
 * and renames it into place, which is what makes an in-flight read safe —
 * but it also means an *already-open* connection keeps its file descriptor
 * pointed at the old, now-unlinked inode. Every subsequent query on that
 * connection would keep reading yesterday's snapshot forever, correctly and
 * silently, with nothing to indicate the wrong day's data was ever
 * returned. `marketDb` is a live export (`let`, not `const`), so every
 * importer's `import { marketDb }` binding picks up the reopened instance
 * automatically — no restart, no process boundary crossed. Safe against
 * concurrent readers, too: better-sqlite3 is fully synchronous, so there is
 * no way for another handler's query to be mid-flight on the same event
 * loop tick while this closes and reassigns.
 *
 * Closing the old connection alone is not enough — found by writing this
 * function's own test. WAL mode leaves `-wal`/`-shm` sidecar files sitting
 * next to the path after close; they belong to the *old* file's now-
 * unlinked inode, but a fresh connection at the same path finds them next
 * to the *new* file and tries to recover through them anyway, reading
 * stale pre-swap data straight back — the same corruption this project hit
 * once already from a stale sidecar left by a killed process. The rsync'd
 * file itself is a `VACUUM INTO` snapshot and never has a legitimate WAL of
 * its own, so it is always correct to clear these before reopening here.
 *
 * Opens the replacement before closing the old connection, not the other
 * way around — found by a review of this function: the naive close-then-
 * open order leaves the module-level `sqlite`/`marketDb` pointed at an
 * already-closed connection for every caller in the process if
 * `openMarketDatabase()` throws (the just-rsync'd file momentarily locked,
 * truncated, or the disk full) — every route touching `marketDb` would then
 * throw "database connection is not open" until someone restarts the
 * process, which is a far worse outcome than the stale-data bug this
 * function exists to fix. With this order, `sqlite`/`marketDb` are only
 * ever reassigned once the replacement is proven to open successfully; on
 * failure they are left exactly as they were, still serving the previous
 * (stale but *working*) snapshot. Closing the old connection is done last
 * and best-effort — its own sidecars were just unlinked out from under it,
 * so a failure to close cleanly is logged and ignored rather than allowed
 * to undo the already-correct reassignment above it.
 */
export function reopenMarketDb(): void {
  const previous = sqlite;
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${config.market.dbPath}${suffix}`;
    if (existsSync(sidecar)) unlinkSync(sidecar);
  }
  connect();
  try {
    previous.close();
  } catch {
    // Best-effort — see the doc comment above.
  }
}

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
