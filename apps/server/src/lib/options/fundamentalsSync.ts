import { sql } from 'drizzle-orm';
import { marketDb } from '../../db/market/index.js';
import { fundamentalsSnapshots } from '../../db/market/schema.js';
import { quoteAll } from '../market.js';
import { assertRunner } from './role.js';
import { listUniverse, toVendorSymbol } from './universe.js';
import { nyToday } from './positionHealth.js';
import { nowIso } from '../util.js';

/**
 * Nightly fundamentals accrual for the tracked universe — starting the
 * clock on a dataset that does not exist anywhere else.
 *
 * Yahoo's quote snapshot carries today's valuation fields (P/E, P/B,
 * yield, cap) but never their history, so a trained fundamentals factor
 * is impossible until someone has been writing them down for a couple of
 * quarters. This is that someone. Same accrue-first pattern as the
 * option-feature panel: cheap to run from day one, earns a place in a
 * model only when the history justifies the trial.
 *
 * Runner-only and market.db-resident on purpose: the reader's market.db
 * is replaced wholesale by the nightly snapshot pull, so anything the
 * reader wrote here would live less than a day.
 */
export interface FundamentalsSyncResult {
  day: string;
  written: number;
  quoted: number;
}

export async function syncFundamentals(): Promise<FundamentalsSyncResult> {
  assertRunner('accrue fundamentals snapshots');
  const day = nyToday();
  const symbols = listUniverse({ activeOnly: true }).map((u) => toVendorSymbol(u.symbol));
  const quotes = await quoteAll(symbols);

  let written = 0;
  const at = nowIso();
  marketDb.transaction((tx) => {
    for (const q of quotes) {
      if (!q.symbol) continue;
      const num = (v: unknown): number | null =>
        typeof v === 'number' && Number.isFinite(v) ? v : null;
      tx.insert(fundamentalsSnapshots)
        .values({
          symbol: q.symbol,
          asOfDay: day,
          trailingPe: num(q.trailingPE),
          forwardPe: num(q.forwardPE),
          priceToBook: num(q.priceToBook),
          dividendYield: num(q.dividendYield),
          marketCap: num(q.marketCap),
          avgVolume: num(q.averageDailyVolume10Day),
          high52w: num(q.fiftyTwoWeekHigh),
          low52w: num(q.fiftyTwoWeekLow),
          capturedAt: at,
        })
        .onConflictDoUpdate({
          target: [fundamentalsSnapshots.symbol, fundamentalsSnapshots.asOfDay],
          // A same-day re-run refreshes the values, not just the stamp —
          // the later capture is the closer-to-close snapshot.
          set: {
            trailingPe: num(q.trailingPE),
            forwardPe: num(q.forwardPE),
            priceToBook: num(q.priceToBook),
            dividendYield: num(q.dividendYield),
            marketCap: num(q.marketCap),
            avgVolume: num(q.averageDailyVolume10Day),
            high52w: num(q.fiftyTwoWeekHigh),
            low52w: num(q.fiftyTwoWeekLow),
            capturedAt: at,
          },
        })
        .run();
      written += 1;
    }
  });
  return { day, written, quoted: quotes.length };
}

/** Days of accrued history — the "is this trainable yet" number. */
export function fundamentalsCoverageDays(): number {
  return (
    marketDb
      .select({ n: sql<number>`count(distinct ${fundamentalsSnapshots.asOfDay})` })
      .from(fundamentalsSnapshots)
      .get()?.n ?? 0
  );
}
