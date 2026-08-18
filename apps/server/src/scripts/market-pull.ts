import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { config } from '../config.js';

/**
 * Pulls the runner's latest snapshot over SSH.
 *
 * Only ever a *pull*, run from the reader. The runner never pushes and never
 * needs to know this machine exists — the one-writer-many-readers rule from
 * `role.ts` extends to the transport, not just the database.
 *
 * Deliberately not `rsync`-ing `market.db` itself. That file runs in WAL mode
 * on the runner and can be mid-write at any moment; `snapshot.db` is the
 * point-in-time copy `VACUUM INTO` produces specifically to be safe to copy.
 * See `db/market/snapshot.ts`.
 *
 *   npm run market:pull -w @org/server
 */
if (config.market.isRunner) {
  console.error('\n  This machine is MARKET_ROLE=runner — nothing to pull. A runner is\n  the source, not a destination.\n');
  process.exit(1);
}
if (!config.market.runnerSshHost) {
  console.error('\n  RUNNER_SSH_HOST is not set — see .env.example.\n');
  process.exit(1);
}

const remoteDir = config.market.runnerDataDir ?? config.market.dataDir;
const remoteSnapshot = `${config.market.runnerSshHost}:${remoteDir}/snapshot.db`;

if (!existsSync(config.market.dataDir)) mkdirSync(config.market.dataDir, { recursive: true, mode: 0o700 });

console.log(`\nPulling ${remoteSnapshot}\n  → ${config.market.dbPath}\n`);

// rsync writes to a temp file in the destination directory and renames into
// place on completion (its default behaviour, not a flag here) — the same
// atomicity guarantee the snapshot itself relies on, so a reader that reads
// mid-transfer sees the previous complete database, never a partial one.
const result = spawnSync(
  'rsync',
  ['-az', '--progress', remoteSnapshot, config.market.dbPath],
  { stdio: 'inherit' },
);

if (result.status !== 0) {
  console.error(`\n  rsync failed (exit ${result.status}). Checklist:`);
  console.error('    - Is the runner\'s server actually running and has it captured anything?');
  console.error('    - Is Remote Login enabled on the runner (System Settings → Sharing)?');
  console.error(`    - Does snapshot.db exist yet at ${remoteDir} on the runner?`);
  console.error('      (npm run market:snapshot -w @org/server, run there once manually)\n');
  process.exit(1);
}

console.log('\n  Done. This machine\'s local copy now reflects the runner\'s last snapshot.\n');
