import { config } from '../config.js';
import { pullMarketSnapshot } from '../lib/options/marketPull.js';

/**
 * CLI wrapper around `pullMarketSnapshot` — see that function's own doc
 * comment for the transfer logic and the atomicity/timeout reasoning. This
 * file adds only human-facing output and a process exit code; the nightly
 * scheduler calls `pullMarketSnapshot` directly instead, since it needs a
 * result to log, not console output and a process exit.
 *
 *   npm run market:pull -w @org/server
 */
console.log(`\nPulling from the runner (${config.market.runnerSshHost ?? 'RUNNER_SSH_HOST not set'})...\n`);

const result = await pullMarketSnapshot();

if (!result.ok) {
  console.error(`\n  ${result.message}\n`);
  console.error('  Checklist:');
  console.error("    - Is the runner's server actually running and has it captured anything?");
  console.error('    - Is Remote Login enabled on the runner (System Settings → Sharing)?');
  console.error('    - Does snapshot.db exist yet at the runner? (npm run market:snapshot -w @org/server, run there once manually)\n');
  process.exit(1);
}

console.log(`\n  ${result.message}\n  Done. This machine's local copy now reflects the runner's last snapshot.\n`);
