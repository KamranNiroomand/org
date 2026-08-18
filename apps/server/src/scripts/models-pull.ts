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
 * way there is for `market.db`'s WAL file. `--ignore-existing` skips run
 * directories already pulled rather than re-copying every artifact on every
 * call, which matters once there are dozens of runs.
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

const result = spawnSync(
  'rsync',
  ['-az', '--ignore-existing', '--progress', remoteModels, `${config.market.modelsDir}/`],
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
