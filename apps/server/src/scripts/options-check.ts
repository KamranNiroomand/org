import { config } from '../config.js';
import { PolygonProvider } from '../lib/options/polygon.js';
import { evaluateLiquidity, DEFAULT_LIQUIDITY } from '../lib/options/gate.js';
import { parseOccSymbol, fromE4 } from '@org/shared';

/**
 * Preflight for the options data subscription.
 *
 * Confirms what the key actually reaches before a two-year backfill is spent
 * finding out the hard way.
 *
 * We are on **Options Starter** deliberately. Historical NBBO quotes sit on
 * the $199 Advanced tier — not Starter, and not even the $79 Developer tier —
 * so their absence here is a known, priced-in limitation rather than a fault
 * to be alarmed by. What follows from it is a split worth keeping straight:
 *
 *   forecasting          equity bars and aggregates. Fully covered, two years
 *                        of history, available immediately.
 *   forward paper trades  live snapshots carry a real bid and ask, so every
 *                        mark from tonight onward is an honest one.
 *   historical fills     the one thing that genuinely needs NBBO. Deferred
 *                        until a strategy looks good enough to be worth
 *                        measuring precisely.
 *
 * The 15-minute delay on Starter costs us nothing: capture runs after the US
 * close, by which time the delayed feed and the real-time feed agree.
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
    console.log('\n  Get one from massive.com → Dashboard → API Keys.');
    console.log('  (Polygon rebranded to Massive; polygon.io redirects there.)');
    console.log('  Options Starter ($29/mo) is the tier this build assumes.\n');
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
    ok('historical NBBO quotes available — backtest fills can use real bid/ask');
    console.log('    Better than the Starter tier promises. Historical fill simulation');
    console.log('    can be turned on.');
  } else {
    console.log('  note  historical NBBO quotes not available — expected on Starter');
    console.log('    Quotes are an Advanced-tier ($199/mo) entitlement. This is priced in,');
    console.log('    not a failure. What it means concretely:');
    console.log('');
    console.log('      works now   forecasting the underlying — equity bars, realized');
    console.log('                  vol, return distributions. This is the half of the');
    console.log('                  system most likely to fail, and it needs no quotes.');
    console.log('      modelled    every execution cost. With no spread to observe, the');
    console.log('                  gate falls back to open interest and volume, and fills');
    console.log('                  price off trades rather than a touchable market. That');
    console.log('                  overstates returns — often by more than the edge being');
    console.log('                  measured — so results stay labelled modelled, and no');
    console.log('                  paper-book mark is evidence until quotes exist.');
    console.log('');
    console.log('    Upgrade when a strategy looks good enough to be worth measuring');
    console.log('    precisely — Advanced at $199/mo, or ThetaData, which the provider');
    console.log('    adapter exists to make a one-file swap.');
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
      let unquoted = 0;
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
        if (q.bidE4 === null) unquoted += 1;
        else if (q.bidE4 <= 0) zeroBid += 1;
      }
      const pct = ((liquid / chain.length) * 100).toFixed(1);
      ok(`${chain.length} contracts within 45 DTE; ${liquid} tradeable (${pct}%)`);
      if (unquoted > 0) {
        console.log(
          `    ${unquoted} carried no quote — this plan has no bid/ask entitlement, so`,
        );
        console.log('    the gate falls back to open interest and volume, and every');
        console.log('    execution cost downstream is modelled rather than measured.');
      }
      if (zeroBid > 0) {
        console.log(`    ${zeroBid} had a real market with no bid — unsellable, excluded.`);
      }
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
