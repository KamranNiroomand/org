import { runMarketMigrations } from '../db/market/migrate.js';
import { registerModelRun } from '../lib/options/modelRegistry.js';

/**
 * Registers a training run's manifest.json as a queryable row.
 *
 *   npm run models:register -w @org/server -- ~/.org/market/models/<run_id>/manifest.json
 *
 * Run on the runner right after training — see the `model_runs` table
 * comment in schema.ts for why this is not meant to run on a reader.
 */
const manifestPath = process.argv[2];
if (!manifestPath) {
  console.error('\n  Usage: npm run models:register -w @org/server -- <path-to-manifest.json>\n');
  process.exit(1);
}

runMarketMigrations();
const result = registerModelRun(manifestPath);
console.log(`\n  ${result.created ? 'Registered' : 'Updated'}: ${result.runId}\n`);
