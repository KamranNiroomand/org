import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { config } from '../config.js';

/**
 * Pulls trained model artifacts from the runner over SSH.
 *
 * Training runs on the runner Mac — it holds the corpus with zero lag and is
 * the machine meant to stay on for a training job that takes a while. This
 * is the other half of that split: how a trained model's files (`model.txt`,
 * `manifest.json`, `features.json` — see `services/quant/app/train.py`) get
 * from there to wherever the UI actually reads them from.
 *
 * A whole-directory `rsync`, not a single-file copy like `market-pull.ts`.
 * A model run directory is only ever written once and never modified after
 * — `train.py` writes into a fresh timestamped directory each run rather
 * than updating one in place — so there is no live-write hazard here the
 * way there is for `market.db`'s WAL file. `--update` skips artifacts the
 * reader already holds at the same or newer mtime, which matters once
 * there are dozens of runs, while still replacing one the runner has
 * genuinely retrained — see the comment on the rsync call.
 *
 *   npm run models:pull -w @org/server
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
const remoteModels = `${config.market.runnerSshHost}:${remoteDir}/models/`;

if (!existsSync(config.market.modelsDir)) mkdirSync(config.market.modelsDir, { recursive: true, mode: 0o700 });

console.log(`\nPulling ${remoteModels}\n  → ${config.market.modelsDir}\n`);

// `--update` rather than `--ignore-existing`, which this used to pass on
// the reasoning quoted above — that a run directory is written once and
// never modified. That invariant does not actually hold. `_config_hash`
// in train.py covers the target, the horizon and the feature *names*, so
// changing a feature's implementation retrains into the *same* run_id
// with a different model; that happened twice on 2026-08-24 alone. Under
// `--ignore-existing` a reader that already held the earlier copy kept
// its stale `model.txt` and `manifest.json` while any genuinely new file
// (`history.json`) still arrived — leaving a directory half old and half
// new, which is worse than either.
//
// `--update` keeps the cheap skip for the common case (an untouched run
// transfers nothing, since mtimes match) while letting a genuinely newer
// artifact through. The receiver is a reader that never writes here, so
// "the remote copy is newer" is always the right answer.
const result = spawnSync(
  'rsync',
  ['-az', '--update', '--progress', remoteModels, `${config.market.modelsDir}/`],
  { stdio: 'inherit' },
);

if (result.status !== 0) {
  console.error(`\n  rsync failed (exit ${result.status}). Checklist:`);
  console.error('    - Has anything been trained on the runner yet?');
  console.error('      (cd services/quant && uv run python -m app.train --target dir --horizon 5)');
  console.error('    - Is Remote Login enabled on the runner (System Settings → Sharing)?\n');
  process.exit(1);
}

console.log('\n  Done.\n');
