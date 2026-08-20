import { renameSync } from 'node:fs';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { config } from '../../config.js';
import { runMarketMigrations } from './migrate.js';
import { marketPragma, rawMarketPragma, reopenMarketDb } from './index.js';

/**
 * The bug this pins: `market:pull` (rsync) replaces `market.db` at its path
 * via a temp file + rename, exactly like this test does by hand. An
 * already-open connection keeps its file descriptor pointed at the old, now
 * -unlinked inode — real on macOS/Linux, not a test artifact — so it goes
 * on reading yesterday's snapshot forever unless something reopens it.
 * Found live: a reader's long-running server kept answering with the
 * previous day's corpus after a manual pull, silently.
 */
describe('reopenMarketDb', () => {
  it('picks up a file swapped in at the same path, exactly as rsync replaces a pulled snapshot', () => {
    try {
      marketPragma('user_version = 111');
      expect(marketPragma('user_version')).toEqual([{ user_version: 111 }]);

      // Build the replacement via VACUUM INTO, then modify and rename it
      // over the live path — the same temp-file-then-rename mechanism
      // rsync uses, and the same mechanism the real snapshot is built
      // from (see pullMarketSnapshot's own doc comment and db/market/
      // snapshot.ts), so this exercises the actual production path rather
      // than a hand-rolled equivalent. VACUUM INTO's own output is never
      // WAL, so there is no `-wal` sidecar on the copy to strip.
      const swapPath = `${config.market.dbPath}.swap`;
      rawMarketPragma(`VACUUM INTO '${swapPath}'`);
      const raw = new Database(swapPath);
      raw.pragma('user_version = 222');
      raw.close();
      renameSync(swapPath, config.market.dbPath);

      // The existing connection is still pinned to the old, now-unlinked
      // inode — this is the bug, reproduced.
      expect(marketPragma('user_version')).toEqual([{ user_version: 111 }]);

      reopenMarketDb();

      expect(marketPragma('user_version')).toEqual([{ user_version: 222 }]);
    } finally {
      // The swap above discards whatever schema this shared test-fixture
      // db (see vitest.config.ts's own comment on fileParallelism:false —
      // every apps/server test that touches db/market shares ONE physical
      // file) already had migrated in from earlier test files in the same
      // run. Found live via a reproduction that left the shared file with
      // zero tables afterward. Restoring the schema here makes this test
      // self-contained rather than depending on whichever file happens to
      // run next to defensively re-migrate before it notices.
      runMarketMigrations();
    }
  });
});
