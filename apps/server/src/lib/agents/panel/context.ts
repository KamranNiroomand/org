import { desc, eq, sql } from 'drizzle-orm';
import { db } from '../../../db/index.js';
import { holdings, instruments, radarScores } from '../../../db/schema.js';
import { marketDb } from '../../../db/market/index.js';
import { documents, docMentions } from '../../../db/market/schema.js';
import { toVendorSymbol } from '../../options/universe.js';
import type { SymbolContext } from './types.js';

/** How many recent documents ride along with a symbol's context — enough
 * for a specialist to notice a pattern across several stories, not so many
 * that news_sentiment ends up re-reading the same event three different
 * ways from three different wire pickups. */
const MAX_RECENT_DOCUMENTS = 10;

/**
 * Builds the one shared picture of a symbol every specialist reasons from.
 * Reads `instruments` (org.db, swept nightly regardless of role), `holdings`
 * (org.db), today's `radarScores` if the symbol cleared it (org.db), and a
 * bounded, newest-first slice of `market.db`'s `documents`/`docMentions`
 * (read-only — see the radar's own `run.ts` for why a read here needs no
 * runner/reader role check).
 *
 * Returns `null` when the symbol isn't in `instruments` at all — a box query
 * against a ticker that doesn't exist (typo, delisted, not a US/CA common
 * stock) has nothing to build a context from, and the caller should treat
 * that as "couldn't resolve", not silently panel a blank row.
 */
export function buildSymbolContext(symbol: string): SymbolContext | null {
  const row = db.select().from(instruments).where(eq(instruments.symbol, symbol)).get();
  if (!row) return null;

  const held = db.select().from(holdings).where(eq(holdings.symbol, symbol)).get();

  const latestDay = db
    .select({ tradingDay: radarScores.tradingDay })
    .from(radarScores)
    .orderBy(desc(radarScores.tradingDay))
    .limit(1)
    .get();
  const radarRow = latestDay
    ? db
        .select()
        .from(radarScores)
        .where(sql`${radarScores.tradingDay} = ${latestDay.tradingDay} and ${radarScores.symbol} = ${symbol}`)
        .get()
    : undefined;

  const vendorSymbol = toVendorSymbol(symbol);
  const recentDocuments = marketDb
    .select({
      title: documents.title,
      summary: documents.summary,
      publishedAt: documents.publishedAt,
      source: documents.source,
      sentiment: docMentions.sentiment,
      eventType: documents.eventType,
    })
    .from(docMentions)
    .innerJoin(documents, eq(docMentions.documentId, documents.id))
    .where(eq(docMentions.underlying, vendorSymbol))
    .orderBy(desc(documents.publishedAt))
    .limit(MAX_RECENT_DOCUMENTS)
    .all();

  return {
    symbol: row.symbol,
    name: row.name,
    price: row.price,
    dayChangePercent: row.dayChangePercent,
    marketCap: row.marketCap,
    sector: row.sector,
    trailingPe: row.trailingPe,
    forwardPe: row.forwardPe,
    priceToBook: row.priceToBook,
    dividendYield: row.dividendYield,
    fiftyTwoWeekHigh: row.fiftyTwoWeekHigh,
    fiftyTwoWeekLow: row.fiftyTwoWeekLow,
    volume: row.volume,
    avgVolume10Day: row.avgVolume10Day,
    holding: held ? { quantity: held.quantity, avgCost: held.avgCost, currency: held.currency } : null,
    radar: radarRow
      ? {
          score: radarRow.score,
          rank: radarRow.rank,
          momentumZ: radarRow.momentumZ,
          trendPct: radarRow.trendPct,
          newHigh: radarRow.newHigh,
          volumeRatio: radarRow.volumeRatio,
          volumeZ: radarRow.volumeZ,
          sentimentZ: radarRow.sentimentZ,
          inputsUsed: radarRow.inputsUsed,
        }
      : null,
    recentDocuments,
  };
}
