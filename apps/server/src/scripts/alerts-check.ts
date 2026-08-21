import { evaluatePriceAlerts } from '../lib/alerts/evaluate.js';
import { config } from '../config.js';

/**
 * Runs the price/momentum alert engine once, without starting the server —
 * for checking a specific trading day (the function's own default is
 * today) or debugging a rule without waiting for the nightly job.
 *
 *   npm run alerts:check -w @org/server
 *   npm run alerts:check -w @org/server -- 2026-08-18
 */
const tradingDay = process.argv[2];
const result = tradingDay ? evaluatePriceAlerts(tradingDay) : evaluatePriceAlerts();

console.log(`\nAlerts → ${config.dbPath}`);
console.log(`  ${result.fired} fired across ${result.scanned} instruments`);
if (result.errors.length > 0) {
  console.log(`  ${result.errors.length} error(s):`);
  for (const e of result.errors.slice(0, 20)) console.log(`    ${e}`);
}
console.log('');
