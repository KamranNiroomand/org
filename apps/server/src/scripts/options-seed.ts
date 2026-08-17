import { config } from '../config.js';
import { runMarketMigrations } from '../db/market/migrate.js';
import { listUniverse, seedUniverse } from '../lib/options/universe.js';

/**
 * Populates the tracked-underlying universe.
 *
 * Safe to re-run: existing rows keep whatever tier they have, because by then
 * it may have been set from measured liquidity rather than the initial guess.
 *
 *   npm run options:seed -w @org/server
 */
runMarketMigrations();

const result = seedUniverse();
const core = listUniverse({ tier: 'core' });
const research = listUniverse({ tier: 'research' });

console.log(`\nUniverse seeded into ${config.market.dbPath}\n`);
console.log(`  ${result.total} underlyings (${result.inserted} new, ${result.reactivated} reactivated)`);
console.log(`  ${core.length} core — where contracts routinely clear the liquidity gate`);
console.log(`  ${research.length} research — breadth for cross-sectional features`);
console.log(`\n  Tier is a hypothesis until capture has run. \`retierByLiquidity\` replaces`);
console.log(`  it with the measured fraction of contracts that actually passed.\n`);
