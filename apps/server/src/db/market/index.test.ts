import { copyFileSync, renameSync } from 'node:fs';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { config } from '../../config.js';
import { marketPragma, reopenMarketDb } from './index.js';

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
    marketPragma('user_version = 111');
    expect(marketPragma('user_version')).toEqual([{ user_version: 111 }]);

    // Build a modified copy elsewhere, then rename it over the live path —
    // the same temp-file-then-rename mechanism rsync uses. Forced out of
    // WAL mode on the copy so the write lands in the single main file, the
    // way `VACUUM INTO` (what the real snapshot is built from — see
    // pullMarketSnapshot's own doc comment) always produces, rather than
    // leaving it in a `-wal` sidecar this rename never carries over.
    const swapPath = `${config.market.dbPath}.swap`;
    copyFileSync(config.market.dbPath, swapPath);
    const raw = new Database(swapPath);
    raw.pragma('journal_mode = DELETE');
    raw.pragma('user_version = 222');
    raw.close();
    renameSync(swapPath, config.market.dbPath);

    // The existing connection is still pinned to the old, now-unlinked
    // inode — this is the bug, reproduced.
    expect(marketPragma('user_version')).toEqual([{ user_version: 111 }]);

    reopenMarketDb();

    expect(marketPragma('user_version')).toEqual([{ user_version: 222 }]);
  });
});
