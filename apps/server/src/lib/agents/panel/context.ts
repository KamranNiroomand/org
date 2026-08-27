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

  // toVendorSymbol only ever replaces a hyphen with a dot (BRK-B -> BRK.B),
  // correct for a US share class. A Canadian symbol that ALSO carries a
  // hyphen before its exchange suffix (BBD-B.TO, AP-UN.TO) already has a
  // dot — the blind replace mangles it into a symbol that doesn't exist
  // (BBD.B.TO), which would silently return zero rows and read as "no
  // coverage" rather than "looked up wrong". No US symbol legitimately
  // carries both a hyphen and a dot, so that combination is the safe,
  // precise signal to skip the lookup entirely rather than risk a wrong
  // conversion — this vendor has no real Canadian news coverage to find
  // anyway, so an empty recentDocuments here isn't a real loss.
  const isUnsafeToConvert = symbol.includes('-') && symbol.includes('.');
  const recentDocuments = isUnsafeToConvert
    ? []
    : marketDb
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
        .where(eq(docMentions.underlying, toVendorSymbol(symbol)))
        .orderBy(desc(documents.publishedAt))
        .limit(MAX_RECENT_DOCUMENTS)
        .all();

  // The sector's largest peers, self excluded. Capped at 40 by market
  // cap: the IT sector alone holds ~2,000 instruments and an average
  // over illiquid micro-caps would bury the signal the field exists to
  // carry — what the names that *set* the sector's tone did today.
  let sectorPulse: SymbolContext['sectorPulse'] = null;
  if (row.sector) {
    const peers = db
      .select({
        symbol: instruments.symbol,
        dayChangePercent: instruments.dayChangePercent,
        marketCap: instruments.marketCap,
      })
      .from(instruments)
      .where(sql`${instruments.sector} = ${row.sector} and ${instruments.symbol} != ${symbol} and ${instruments.marketCap} is not null`)
      .orderBy(desc(instruments.marketCap))
      .limit(40)
      .all();
    const moved = peers.filter((p) => p.dayChangePercent !== null);
    if (moved.length > 0) {
      const avg = moved.reduce((a, p) => a + p.dayChangePercent!, 0) / moved.length;
      const biggest = moved.reduce((a, p) =>
        Math.abs(p.dayChangePercent!) > Math.abs(a.dayChangePercent!) ? p : a,
      );
      const cutoff = new Date(Date.now() - 48 * 3_600_000).toISOString();
      const peerVendor = moved.slice(0, 40).map((p) => toVendorSymbol(p.symbol));
      const events = marketDb
        .select({
          symbol: docMentions.underlying,
          title: documents.title,
          eventType: documents.eventType,
        })
        .from(docMentions)
        .innerJoin(documents, eq(docMentions.documentId, documents.id))
        .where(
          sql`${docMentions.underlying} in ${peerVendor} and ${documents.publishedAt} >= ${cutoff} and ${documents.eventType} is not null and ${documents.eventType} != 'other'`,
        )
        .orderBy(desc(documents.publishedAt))
        .limit(3)
        .all();
      sectorPulse = {
        sector: row.sector,
        peerCount: moved.length,
        avgDayChangePercent: avg,
        biggestMover: { symbol: biggest.symbol, dayChangePercent: biggest.dayChangePercent! },
        recentSectorEvents: events,
      };
    }
  }

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
    sectorPulse,
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
