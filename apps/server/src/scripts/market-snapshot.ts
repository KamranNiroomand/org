import { config } from '../config.js';
import { runMarketMigrations } from '../db/market/migrate.js';
import { snapshotMarketDb } from '../db/market/snapshot.js';
import { isRunner } from '../lib/options/role.js';

/**
 * Writes a consistent, transferable copy of market.db. Runs automatically
 * after every nightly capture; this is for a manual snapshot in between —
 * before a first pull, or to check something sooner than the next capture.
 *
 *   npm run market:snapshot -w @org/server
 */
if (!isRunner()) {
  console.error('\n  This machine is MARKET_ROLE=reader — nothing to snapshot here.\n');
  process.exit(1);
}

runMarketMigrations();
const path = snapshotMarketDb();
console.log(`\n  Snapshot written: ${path}`);
console.log(`  (${config.market.dataDir})\n`);
