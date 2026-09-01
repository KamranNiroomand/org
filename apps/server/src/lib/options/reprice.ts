import { sql, and, eq, isNull } from 'drizzle-orm';
import { marketDb } from '../../db/market/index.js';
import { optionContracts, optionQuotes } from '../../db/market/schema.js';
import { enrichChain } from './capture.js';
import { DEFAULT_LIQUIDITY, type LiquidityThresholds } from './gate.js';
import { assertRunner } from './role.js';
import { quantHealthy } from '../quant.js';
import type { ChainQuote } from './provider.js';

export interface RepriceOptions {
  thresholds?: LiquidityThresholds;
  dividendYield?: (symbol: string) => number;
}

export interface RepriceSummary {
  tradingDay: string;
  candidates: number;
  priced: number;
  quantAvailable: boolean;
}

/**
 * Recomputes implied vol and greeks for quotes already captured on a given
 * day whose pricing never ran — a rate-limited provider or a cold quant
 * sidecar leaves a row with a real close price but a null `iv_bps`. Nothing
 * here re-fetches from the provider: the raw quote already sits in
 * `option_quotes`, exactly the "irreplaceable thing" capture.ts's own doc
 * comment describes. Only the derived columns are being rebuilt, by running
 * the same solve `enrichChain` runs at capture time against rows read back
 * out of the database instead of freshly fetched from the vendor.
 */
export async function repriceDay(
  tradingDay: string,
  options: RepriceOptions = {},
): Promise<RepriceSummary> {
  assertRunner('reprice option quotes');
  const thresholds = options.thresholds ?? DEFAULT_LIQUIDITY;
  const dividendYield = options.dividendYield ?? (() => 0);

  const rows = marketDb
    .select({
      occSymbol: optionQuotes.occSymbol,
      asOf: optionQuotes.asOf,
      tradingDay: optionQuotes.tradingDay,
      bidE4: optionQuotes.bidE4,
      askE4: optionQuotes.askE4,
      lastE4: optionQuotes.lastE4,
      closeE4: optionQuotes.closeE4,
      volume: optionQuotes.volume,
      openInterest: optionQuotes.openInterest,
      underlyingE4: optionQuotes.underlyingE4,
      underlyingAsOfDay: optionQuotes.underlyingAsOfDay,
      underlying: optionContracts.underlying,
      expiry: optionContracts.expiry,
      type: optionContracts.type,
      strikeE4: optionContracts.strikeE4,
      multiplier: optionContracts.multiplier,
    })
    .from(optionQuotes)
    .innerJoin(optionContracts, eq(optionQuotes.occSymbol, optionContracts.occSymbol))
    .where(
      and(
        eq(optionQuotes.tradingDay, tradingDay),
        eq(optionQuotes.liquid, true),
        isNull(optionQuotes.ivBps),
        // Only the row the read path will actually surface — solving a
        // superseded duplicate burns sidecar time on rows nobody reads
        // (review finding). Correlated max keeps this index-friendly.
        sql`${optionQuotes.asOf} = (
          select max(q2.as_of) from option_quotes q2
          where q2.occ_symbol = ${optionQuotes.occSymbol} and q2.trading_day = ${optionQuotes.tradingDay}
        )`,
      ),
    )
    .all();

  const chain: ChainQuote[] = rows.map((r) => ({ ...r, vendorIv: null }));

  // Checked once up front, same as capture.ts: better to say plainly that
  // nothing was priced than to leave the caller guessing why candidates > 0
  // and priced stayed 0.
  const quantAvailable = await quantHealthy();
  if (!quantAvailable || chain.length === 0) {
    return { tradingDay, candidates: chain.length, priced: 0, quantAvailable };
  }

  const priced = await enrichChain(chain, thresholds, dividendYield);
  return { tradingDay, candidates: chain.length, priced, quantAvailable };
}
