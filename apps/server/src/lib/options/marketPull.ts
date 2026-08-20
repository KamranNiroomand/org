import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { config } from '../../config.js';

export interface PullResult {
  ok: boolean;
  message: string;
}

/**
 * Pulls the runner's latest snapshot over SSH into this reader's local
 * `market.db`. Deliberately not `rsync`-ing `market.db` itself — that file
 * runs in WAL mode on the runner and can be mid-write at any moment;
 * `snapshot.db` is the point-in-time copy `VACUUM INTO` produces
 * specifically to be safe to copy. See `db/market/snapshot.ts`.
 *
 * Never throws — a reader with no network path to the runner right now
 * (asleep, off-network, SSH not enabled) is a normal night, not a crash;
 * the caller decides how to log or surface `ok: false`.
 *
 * No caller-imposed timeout on the transfer, on purpose: rsync writes to a
 * temp file in the destination directory and renames into place only on
 * its own natural completion, which is what makes "a reader reading
 * mid-transfer sees the previous complete database, never a partial one"
 * actually hold. A timeout that kills rsync mid-flight can leave a
 * truncated file at the destination — found live, the hard way, debugging
 * this exact function's manual precursor.
 */
export function pullMarketSnapshot(): PullResult {
  if (config.market.isRunner) {
    return { ok: false, message: 'This machine is MARKET_ROLE=runner — nothing to pull.' };
  }
  if (!config.market.runnerSshHost) {
    return { ok: false, message: 'RUNNER_SSH_HOST is not set.' };
  }

  const remoteDir = config.market.runnerDataDir ?? config.market.dataDir;
  const remoteSnapshot = `${config.market.runnerSshHost}:${remoteDir}/snapshot.db`;

  if (!existsSync(config.market.dataDir)) mkdirSync(config.market.dataDir, { recursive: true, mode: 0o700 });

  const result = spawnSync('rsync', ['-az', remoteSnapshot, config.market.dbPath], { encoding: 'utf8' });

  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.error?.message || `exit ${result.status ?? 'unknown'}`;
    return { ok: false, message: `rsync failed: ${detail}` };
  }
  return { ok: true, message: `Pulled ${remoteSnapshot} → ${config.market.dbPath}` };
}
