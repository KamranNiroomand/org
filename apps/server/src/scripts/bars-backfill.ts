import { config } from '../config.js';
import { runMarketMigrations } from '../db/market/migrate.js';
import { backfillBars, barCoverage } from '../lib/options/backfill.js';
import { PolygonProvider } from '../lib/options/polygon.js';
import { listUniverse, seedUniverse, toVendorSymbol } from '../lib/options/universe.js';

/**
 * Backfills daily bars for the whole universe.
 *
 * Safe to re-run and safe to interrupt: it checkpoints per symbol and updates
 * rows rather than duplicating them, which matters because `adjusted=true`
 * restates prior bars after a split.
 *
 *   npm run bars:backfill -w @org/server -- --years 2
 */
runMarketMigrations();

if (!config.market.configured) {
  console.error('\n  POLYGON_API_KEY is not set — nothing to backfill.\n');
  process.exit(1);
}

const yearsArg = process.argv.indexOf('--years');
const years = yearsArg >= 0 ? Number(process.argv[yearsArg + 1]) : 2;
if (!Number.isFinite(years) || years <= 0) {
  console.error('\n  --years must be a positive number.\n');
  process.exit(1);
}

seedUniverse();

// `--symbols SPY,AAPL` restricts the run, for a first look before committing
// to hundreds of requests.
const symbolsArg = process.argv.indexOf('--symbols');
const symbols =
  symbolsArg >= 0
    ? (process.argv[symbolsArg + 1] ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
    : listUniverse({ activeOnly: true }).map((u) => toVendorSymbol(u.symbol));

if (symbols.length === 0) {
  console.error('\n  No symbols to backfill.\n');
  process.exit(1);
}

const to = new Date().toISOString().slice(0, 10);
const from = new Date(Date.now() - years * 365 * 86_400_000).toISOString().slice(0, 10);

console.log(`\nBackfilling ${symbols.length} symbols, ${from} → ${to}`);
console.log(`Target: ${config.market.dbPath}\n`);

let lastLogged = 0;
const result = await backfillBars(new PolygonProvider(), symbols, from, to, (p) => {
  // Progress every 25 symbols — often enough to see it moving, rarely enough
  // not to bury the errors that matter.
  if (p.symbolsDone - lastLogged >= 25 || p.symbolsDone === p.symbolsTotal) {
    lastLogged = p.symbolsDone;
    const pct = ((p.symbolsDone / p.symbolsTotal) * 100).toFixed(0);
    console.log(
      `  ${String(p.symbolsDone).padStart(4)}/${p.symbolsTotal} (${pct}%)  ` +
        `${p.barsWritten.toLocaleString()} bars` +
        (p.errors.length ? `  ${p.errors.length} failed` : ''),
    );
  }
});

const coverage = barCoverage();
const totalDays = coverage.reduce((a, c) => a + c.days, 0);
const thin = coverage.filter((c) => c.days < years * 200);

console.log(`\n  ${result.barsWritten.toLocaleString()} bars across ${coverage.length} symbols`);
console.log(`  ${totalDays.toLocaleString()} symbol-days stored`);

if (thin.length > 0) {
  console.log(`\n  ${thin.length} symbol(s) with thin history — recent listings or dead tickers:`);
  for (const c of thin.slice(0, 8)) {
    console.log(`    ${c.symbol.padEnd(8)} ${String(c.days).padStart(4)} days  ${c.first} → ${c.last}`);
  }
  console.log('  Thin history is not an error, but a model must not treat it as a full sample.');
}

if (result.errors.length > 0) {
  console.log(`\n  ${result.errors.length} symbol(s) failed:`);
  for (const e of result.errors.slice(0, 8)) console.log(`    ${e}`);
}
console.log('');
