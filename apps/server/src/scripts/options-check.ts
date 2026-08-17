import { config } from '../config.js';
import { PolygonProvider } from '../lib/options/polygon.js';
import { evaluateLiquidity, DEFAULT_LIQUIDITY } from '../lib/options/gate.js';
import { parseOccSymbol, fromE4 } from '@org/shared';

/**
 * Preflight for the options data subscription.
 *
 * Answers the question that decides the shape of the whole backtest before
 * two years of backfill are spent finding out the hard way: does this tier
 * serve historical bid and ask, or only historical trades? Without quotes a
 * backtest can only fill at last-traded prices, and on instruments whose
 * spreads routinely run to several percent that difference is not a detail —
 * it is usually the entire measured edge.
 *
 *   npm run options:check -w @org/server
 */

const ok = (m: string) => console.log(`  ok    ${m}`);
const bad = (m: string) => console.log(`  FAIL  ${m}`);
const warn = (m: string) => console.log(`  warn  ${m}`);

async function main(): Promise<void> {
  console.log('\nOptions data preflight\n');

  if (!config.market.configured) {
    bad('POLYGON_API_KEY is not set in .env');
    console.log('\n  Get one from polygon.io → Dashboard → API Keys.');
    console.log('  Options Starter (~$29/mo) is the tier this build assumes.\n');
    process.exit(1);
  }
  ok('API key is present');

  const provider = new PolygonProvider();
  const caps = await provider.probe();

  console.log('\n  Endpoint probe:');
  for (const note of caps.notes) console.log(`    ${note}`);
  console.log('');

  if (!caps.liveChain) {
    bad('No live chain access — nightly capture cannot run at all');
    process.exit(1);
  }
  ok('live chain snapshots available (nightly capture will work)');

  if (caps.equityBars) ok('equity daily bars available (realized vol, labels)');
  else bad('no equity bars — realized volatility and every label depend on these');

  if (caps.historicalChain) ok('historical contract reference available (backfill can enumerate)');
  else warn('no historical contract reference — backfill would be limited to live capture forward');

  if (caps.news) ok('news available (feeds the text pipeline in M4)');
  else warn('no news endpoint on this tier');

  console.log('');
  if (caps.historicalQuotes) {
    ok('HISTORICAL NBBO QUOTES AVAILABLE');
    console.log('    Backtest fills can use the real bid and ask. This is the good case;');
    console.log('    proceed with the full backfill.');
  } else {
    bad('HISTORICAL NBBO QUOTES NOT AVAILABLE ON THIS TIER');
    console.log('    This is the constraint worth knowing before backfilling. Without');
    console.log('    historical bid/ask, a backtest can only fill at last-traded prices,');
    console.log('    which systematically overstates returns — on wide options markets,');
    console.log('    usually by more than the edge being measured.');
    console.log('');
    console.log('    Options, in the order I would consider them:');
    console.log('      1. Upgrade the Polygon plan until this probe passes.');
    console.log('      2. Switch to ThetaData (~$80/mo), which serves historical NBBO');
    console.log('         explicitly. The provider adapter exists so this costs one file.');
    console.log('      3. Proceed anyway, capturing live quotes forward from today and');
    console.log('         backtesting only on what we captured ourselves. Honest, but it');
    console.log('         means months before there is enough history to train on.');
  }

  // A live sample, so the gate is exercised against real vendor data rather
  // than only against the recorded fixture.
  console.log('\n  Live sample — SPY chain through the liquidity gate:');
  try {
    const chain = await provider.fetchChain({ underlying: 'SPY', maxDte: 45 });
    if (chain.length === 0) {
      warn('chain came back empty (market may be closed and the vendor serving no snapshot)');
    } else {
      let liquid = 0;
      let zeroBid = 0;
      for (const q of chain) {
        const contract = parseOccSymbol(q.occSymbol);
        if (!contract) continue;
        const verdict = evaluateLiquidity({
          contract,
          bidE4: q.bidE4,
          askE4: q.askE4,
          openInterest: q.openInterest,
          volume: q.volume,
          spotE4: q.underlyingE4,
        });
        if (verdict.liquid) liquid += 1;
        if (q.bidE4 <= 0) zeroBid += 1;
      }
      const pct = ((liquid / chain.length) * 100).toFixed(1);
      ok(`${chain.length} contracts within 45 DTE; ${liquid} tradeable (${pct}%)`);
      console.log(`    ${zeroBid} had no bid at all — unsellable, and excluded.`);
      console.log(
        `    Gate: mid >= $${fromE4(DEFAULT_LIQUIDITY.minMidE4).toFixed(2)}, ` +
          `spread <= ${(DEFAULT_LIQUIDITY.maxSpreadFraction * 100).toFixed(0)}% of mid, ` +
          `OI >= ${DEFAULT_LIQUIDITY.minOpenInterest}, vol >= ${DEFAULT_LIQUIDITY.minVolume}.`,
      );
      if (liquid === 0) {
        warn('nothing passed the gate — if the market is open, the thresholds need review');
      }
    }
  } catch (err) {
    warn(`live sample failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log('');
}

main().catch((err) => {
  console.error(`\n  FAIL  ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
