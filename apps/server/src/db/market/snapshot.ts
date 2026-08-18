import { renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../../config.js';
import { rawMarketPragma } from './index.js';

/**
 * A consistent, transferable copy of the market database.
 *
 * The live file is unsafe to copy directly. It runs in WAL mode, which means
 * committed data can live in a separate `-wal` file rather than the main
 * database file, and a plain file copy taken mid-write — by rsync, by a sync
 * client, by anything — can capture the main file and the WAL at
 * inconsistent points and produce a copy that is silently missing recent
 * transactions or, worse, structurally torn.
 *
 * `VACUUM INTO` is SQLite's own answer to this: it holds a read transaction
 * and writes a fresh, fully consistent single-file copy, independent of
 * whatever the WAL currently holds. That copy is then what gets moved
 * elsewhere — never the live file.
 *
 * Written to a temporary name and **renamed** into place rather than written
 * directly to `snapshot.db`. `VACUUM INTO` refuses to overwrite an existing
 * file, but more importantly, a rename on the same filesystem is atomic: a
 * reader on another machine mid-transfer sees either the complete previous
 * snapshot or the complete new one, never a half-written file caught between
 * the two.
 */
export function snapshotMarketDb(): string {
  const finalPath = join(config.market.dataDir, 'snapshot.db');
  const tmpPath = join(config.market.dataDir, `snapshot.db.tmp-${process.pid}`);

  try {
    unlinkSync(tmpPath);
  } catch {
    // Fine if it never existed — only a problem if a stale one is left
    // behind from a crashed prior run, which this clears before VACUUM INTO
    // refuses to write over it.
  }

  rawMarketPragma(`VACUUM INTO '${tmpPath.replace(/'/g, "''")}'`);
  renameSync(tmpPath, finalPath);
  return finalPath;
}
