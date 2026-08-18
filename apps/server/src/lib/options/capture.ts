import { sql } from 'drizzle-orm';
import { daysToExpiry, parseOccSymbol, yearsToExpiry } from '@org/shared';
import { marketDb } from '../../db/market/index.js';
import { captureRuns, optionContracts, optionQuotes } from '../../db/market/schema.js';
import { newId, nowIso } from '../util.js';
import { priceBatch, quantHealthy, type PriceRow } from '../quant.js';
import { evaluateLiquidity, type LiquidityThresholds, DEFAULT_LIQUIDITY } from './gate.js';
import { curveFor, interpolateRate } from './rates.js';
import type { ChainQuote, OptionsProvider } from './provider.js';

/**
 * Nightly chain capture.
 *
 * One rule governs the ordering here: **the raw quote is the irreplaceable
 * thing.** Implied vol and greeks are derived, and can be recomputed from
 * stored rows at any time; a past day's true bid and ask cannot be re-fetched
 * at any price once the day is gone. So quotes are written even when the
 * pricing sidecar is unreachable, with null vol and a reason — never dropped,
 * and never blocked on a downstream service being up.
 *
 * The same logic is why capture writes before it enriches, and why the gate
 * verdict is stored rather than recomputed at read time: the ranked board and
 * the backtest must agree about what was tradeable *on the day*, not about
 * what today's thresholds would have said.
 */

const MAX_DTE = 90;

export interface CaptureOptions {
  maxDte?: number;
  thresholds?: LiquidityThresholds;
  /**
   * Continuous dividend yield per symbol. Absent means zero, which is right
   * for most of the universe and wrong for the income names — it slightly
   * misprices their American puts. Wired as a lookup so `corp_events` can
   * supply real numbers once dividends are ingested, rather than leaving a
   * constant buried in the pricing call.
   */
  dividendYield?: (symbol: string) => number;
}

export interface CaptureOutcome {
  symbol: string;
  contracts: number;
  quotes: number;
  liquid: number;
  priced: number;
  error?: string;
}

export interface CaptureSummary {
  runId: string;
  startedAt: string;
  finishedAt: string;
  symbolsDone: number;
  contractsSeen: number;
  quotesWritten: number;
  liquidWritten: number;
  pricedWritten: number;
  quantAvailable: boolean;
  errors: string[];
}

/** Writes contracts and quotes for one chain. Pricing is applied separately. */
function persistChain(
  chain: readonly ChainQuote[],
  thresholds: LiquidityThresholds,
): { contracts: number; quotes: number; liquid: number } {
  if (chain.length === 0) return { contracts: 0, quotes: 0, liquid: 0 };
  const now = nowIso();
  let liquid = 0;

  const contractRows = chain.map((q) => ({
    occSymbol: q.occSymbol,
    underlying: q.underlying,
    expiry: q.expiry,
    type: q.type,
    strikeE4: q.strikeE4,
    multiplier: q.multiplier,
    firstSeenAt: now,
    lastSeenAt: now,
  }));

  const quoteRows = chain.map((q) => {
    const contract = parseOccSymbol(q.occSymbol);
    const verdict = contract
      ? evaluateLiquidity(
          {
            contract,
            bidE4: q.bidE4,
            askE4: q.askE4,
            openInterest: q.openInterest,
            volume: q.volume,
            spotE4: q.underlyingE4,
          },
          thresholds,
        )
      : { liquid: false, reasons: ['unparseable-symbol' as const] };
    if (verdict.liquid) liquid += 1;

    return {
      occSymbol: q.occSymbol,
      asOf: q.asOf,
      tradingDay: q.tradingDay,
      bidE4: q.bidE4,
      askE4: q.askE4,
      lastE4: q.lastE4,
      closeE4: q.closeE4,
      volume: q.volume,
      openInterest: q.openInterest,
      underlyingE4: q.underlyingE4,
      ivBps: null,
      delta: null,
      gamma: null,
      vega: null,
      theta: null,
      liquid: verdict.liquid,
      gateReasons: [...verdict.reasons],
    };
  });

  marketDb.transaction((tx) => {
    for (let i = 0; i < contractRows.length; i += 500) {
      tx.insert(optionContracts)
        .values(contractRows.slice(i, i + 500))
        .onConflictDoUpdate({
          target: optionContracts.occSymbol,
          set: { lastSeenAt: sql`excluded.last_seen_at` },
        })
        .run();
    }
    for (let i = 0; i < quoteRows.length; i += 500) {
      tx.insert(optionQuotes)
        .values(quoteRows.slice(i, i + 500))
        // Re-running a capture must not duplicate a day.
        .onConflictDoNothing({ target: [optionQuotes.occSymbol, optionQuotes.asOf] })
        .run();
    }
  });

  return { contracts: contractRows.length, quotes: quoteRows.length, liquid };
}

/**
 * Solves implied vol and greeks for the rows just written, and updates them.
 *
 * Only gate-passing contracts are priced. The rest are the ones whose quotes
 * determine no volatility anyway — a penny mid or a stale two-sided market —
 * so solving them would spend time to produce nulls.
 */
async function enrichChain(
  chain: readonly ChainQuote[],
  thresholds: LiquidityThresholds,
  dividendYield: (symbol: string) => number,
): Promise<number> {
  const priceRows: PriceRow[] = [];

  for (const q of chain) {
    const contract = parseOccSymbol(q.occSymbol);
    if (!contract) continue;
    const verdict = evaluateLiquidity(
      {
        contract,
        bidE4: q.bidE4,
        askE4: q.askE4,
        openInterest: q.openInterest,
        volume: q.volume,
        spotE4: q.underlyingE4,
      },
      thresholds,
    );
    if (!verdict.liquid) continue;

    /**
     * Solve from the mid where a market exists, and from the contract's own
     * close where it does not. A close is a traded price rather than a
     * touchable one, so the implied vol it yields is slightly noisier — but it
     * is a real transaction, which is far better than nothing and far better
     * than a fabricated mid. The verdict's `basis` already records which
     * regime a row came from, so nothing downstream has to guess.
     */
    const solveFromE4 = verdict.midE4 ?? q.closeE4;
    if (solveFromE4 === null || solveFromE4 <= 0) continue;

    const dte = daysToExpiry(q.expiry, q.tradingDay);
    const rate = interpolateRate(curveFor(q.tradingDay), dte);
    // No curve means no defensible rate. Leaving vol null is better than
    // solving against a number we made up and storing the result as a feature.
    if (rate === null) continue;

    priceRows.push({
      key: `${q.occSymbol}|${q.asOf}`,
      price: solveFromE4 / 10_000,
      spot: q.underlyingE4 / 10_000,
      strike: q.strikeE4 / 10_000,
      years: yearsToExpiry(q.expiry, q.tradingDay),
      rate,
      div_yield: dividendYield(q.underlying),
      is_call: q.type === 'call',
      american: true,
    });
  }

  if (priceRows.length === 0) return 0;
  const results = await priceBatch(priceRows);

  let priced = 0;
  marketDb.transaction((tx) => {
    for (const r of results) {
      if (r.iv_bps === null) continue;
      const sep = r.key.lastIndexOf('|');
      const occSymbol = r.key.slice(0, sep);
      const asOf = r.key.slice(sep + 1);
      tx.update(optionQuotes)
        .set({
          ivBps: r.iv_bps,
          delta: r.delta,
          gamma: r.gamma,
          vega: r.vega,
          theta: r.theta,
        })
        .where(sql`${optionQuotes.occSymbol} = ${occSymbol} and ${optionQuotes.asOf} = ${asOf}`)
        .run();
      priced += 1;
    }
  });
  return priced;
}

/** Captures chains for the given underlyings, recording a resumable run. */
export async function captureChains(
  provider: OptionsProvider,
  symbols: readonly string[],
  options: CaptureOptions = {},
): Promise<CaptureSummary> {
  const maxDte = options.maxDte ?? MAX_DTE;
  const thresholds = options.thresholds ?? DEFAULT_LIQUIDITY;
  const dividendYield = options.dividendYield ?? (() => 0);

  const runId = newId();
  const startedAt = nowIso();
  marketDb.insert(captureRuns).values({ id: runId, kind: 'nightly', startedAt }).run();

  // Checked once up front so the log says plainly whether this run produced
  // implied vol, rather than leaving a silent column of nulls to explain later.
  const quantAvailable = await quantHealthy();

  const summary: CaptureSummary = {
    runId,
    startedAt,
    finishedAt: startedAt,
    symbolsDone: 0,
    contractsSeen: 0,
    quotesWritten: 0,
    liquidWritten: 0,
    pricedWritten: 0,
    quantAvailable,
    errors: [],
  };

  if (!quantAvailable) {
    summary.errors.push(
      'Quant sidecar unreachable — quotes captured without implied vol or greeks. ' +
        'They are recomputable from the stored rows; the quotes themselves are not.',
    );
  }

  for (const symbol of symbols) {
    try {
      const chain = await provider.fetchChain({ underlying: symbol, maxDte });
      const written = persistChain(chain, thresholds);
      summary.contractsSeen += written.contracts;
      summary.quotesWritten += written.quotes;
      summary.liquidWritten += written.liquid;

      if (quantAvailable) {
        summary.pricedWritten += await enrichChain(chain, thresholds, dividendYield);
      }
    } catch (err) {
      summary.errors.push(`${symbol}: ${err instanceof Error ? err.message : String(err)}`);
    }

    summary.symbolsDone += 1;
    // Checkpoint every symbol: a run interrupted at 400 of 566 should resume,
    // not restart.
    marketDb
      .update(captureRuns)
      .set({
        cursor: { symbol },
        symbolsDone: summary.symbolsDone,
        contractsSeen: summary.contractsSeen,
        quotesWritten: summary.quotesWritten,
        errors: summary.errors,
      })
      .where(sql`${captureRuns.id} = ${runId}`)
      .run();
  }

  summary.finishedAt = nowIso();
  marketDb
    .update(captureRuns)
    .set({
      status: summary.errors.length > 0 && summary.quotesWritten === 0 ? 'failed' : 'done',
      finishedAt: summary.finishedAt,
      errors: summary.errors,
    })
    .where(sql`${captureRuns.id} = ${runId}`)
    .run();

  return summary;
}
