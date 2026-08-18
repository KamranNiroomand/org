import { config } from '../config.js';
import { runMarketMigrations } from '../db/market/migrate.js';
import { curveFor, rateFor, syncRates } from '../lib/options/rates.js';

/**
 * Pulls the US Treasury par yield curve into the market database.
 *
 * Free and keyless, so it can run before any vendor subscription exists.
 *
 *   npm run rates:sync -w @org/server
 */
runMarketMigrations();

const thisYear = new Date().getUTCFullYear();
// Two years back covers the backfill window with room for the curve to be
// available on any day a chain was captured.
const years = [thisYear - 2, thisYear - 1, thisYear];

const result = await syncRates(years);
console.log(`\nTreasury yield curve → ${config.market.dbPath}`);
console.log(`  ${result.rows} rows across ${result.years.join(', ')}\n`);

const today = new Date().toISOString().slice(0, 10);
const curve = curveFor(today);
if (curve.length === 0) {
  console.log('  No curve available — check the Treasury feed.\n');
} else {
  console.log('  Latest published curve:');
  for (const p of curve) {
    console.log(`    ${String(p.tenorDays).padStart(6)}d  ${(p.rate * 100).toFixed(2)}%`);
  }
  console.log('\n  Interpolated across the capture window (0-90 DTE):');
  for (const d of [2, 7, 30, 45, 90]) {
    const r = rateFor(today, d);
    console.log(`    ${String(d).padStart(3)} DTE  ${r === null ? 'unavailable' : `${(r * 100).toFixed(3)}%`}`);
  }
  console.log('');
}
