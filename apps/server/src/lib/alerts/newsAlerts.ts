import { and, desc, eq, gte, inArray, isNotNull } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { alertEvents } from '../../db/schema.js';
import { marketDb } from '../../db/market/index.js';
import { documents, docMentions } from '../../db/market/schema.js';
import { toVendorSymbol } from '../options/universe.js';
import { newId, nowIso } from '../util.js';

export interface NewsAlertSummary {
  documentsSeen: number;
  created: number;
  errors: string[];
}

/** How far back to look for still-relevant classified news — old stories
 * aren't a signal anymore, and without a bound this query would grow with
 * the whole lifetime of the watchlist rather than what's actually current. */
const LOOKBACK_DAYS = 14;

/**
 * Turns classified news/EDGAR documents about watchlist symbols into
 * `alertEvents` rows. Reads `market.db` (documents/docMentions), writes
 * `org.db` (alertEvents) — the two databases this app keeps deliberately
 * separate, crossed the same read-only way `evaluatePriceAlerts` already
 * treats `instruments` as a pure input.
 *
 * Takes symbols in this app's own format (`watchlist.symbol`, e.g.
 * `BRK-B`) — the same format `evaluatePriceAlerts` already uses for
 * `alertEvents.symbol`, so the two rule families stay cross-referenceable
 * by symbol. `docMentions.underlying` is stored in the *vendor's* format
 * (`BRK.B` — see `runWatchlistTextSync`, which ingests via
 * `toVendorSymbol`, the same conversion `runTextSync` already applies for
 * the options universe), so every match against it here converts first and
 * maps back before a row is written — `alertEvents.symbol` must read
 * `BRK-B`, not `BRK.B`, or it silently stops matching `watchlist.symbol`
 * and `holdings.symbol` everywhere else in the app.
 *
 * One alert per (symbol, day), same granularity as the price rules —
 * `runWatchlistTextSync` calls `classifyUnclassifiedDocuments` first, so by
 * the time this runs, "classified today" and "worth alerting on" are the
 * same set. If a second, different story about the same symbol classifies
 * later the same day, the newest one replaces the alert's headline and
 * re-opens it for acknowledgment — mirrors `evaluatePriceAlerts`' own
 * "update if the picture changed" handling, not a second independent rule.
 */
export function createNewsAlerts(symbols: readonly string[], now: string = nowIso()): NewsAlertSummary {
  if (symbols.length === 0) return { documentsSeen: 0, created: 0, errors: [] };

  const vendorToOriginal = new Map(symbols.map((s) => [toVendorSymbol(s), s]));
  const cutoff = new Date(Date.parse(now) - LOOKBACK_DAYS * 86_400_000).toISOString();

  const rows = marketDb
    .select({
      documentId: documents.id,
      publishedAt: documents.publishedAt,
      title: documents.title,
      eventType: documents.eventType,
      underlying: docMentions.underlying,
      sentiment: docMentions.sentiment,
    })
    .from(docMentions)
    .innerJoin(documents, eq(docMentions.documentId, documents.id))
    .where(
      and(
        inArray(docMentions.underlying, [...vendorToOriginal.keys()]),
        // Unclassified documents (eventType still null) aren't skipped
        // forever — classifyUnclassifiedDocuments just hasn't reached them
        // yet, and the next sync tries again.
        isNotNull(documents.eventType),
        gte(documents.publishedAt, cutoff),
      ),
    )
    .orderBy(desc(documents.publishedAt))
    .all();

  // Newest document per (symbol, day) wins — rows are already newest-first.
  const bySymbolDay = new Map<string, { symbol: string; row: (typeof rows)[number] }>();
  for (const row of rows) {
    const symbol = vendorToOriginal.get(row.underlying);
    if (!symbol) continue; // shouldn't happen — the query itself is scoped to these symbols
    const key = `${symbol}|${row.publishedAt.slice(0, 10)}`;
    if (!bySymbolDay.has(key)) bySymbolDay.set(key, { symbol, row });
  }

  let created = 0;
  const errors: string[] = [];

  for (const [key, { symbol, row }] of bySymbolDay) {
    const tradingDay = key.slice(key.indexOf('|') + 1);
    try {
      const direction =
        row.sentiment === 'positive' ? 'bullish' : row.sentiment === 'negative' ? 'bearish' : 'neutral';
      const headline = `${symbol}: ${row.title}`;
      const detail = { documentId: row.documentId, eventType: row.eventType, sentiment: row.sentiment };

      const existing = db
        .select({ id: alertEvents.id, headline: alertEvents.headline })
        .from(alertEvents)
        .where(
          and(
            eq(alertEvents.symbol, symbol),
            eq(alertEvents.ruleKey, 'news_event'),
            eq(alertEvents.tradingDay, tradingDay),
          ),
        )
        .get();

      if (!existing) {
        db.insert(alertEvents)
          .values({
            id: newId(),
            symbol,
            ruleKey: 'news_event',
            tradingDay,
            // Always 'watchlist' — this function only ever runs over
            // watchlist symbols, never the full market (see the module
            // this is wired from for why news signals stay scoped that way).
            context: 'watchlist',
            direction,
            headline,
            detail,
            acknowledged: false,
            triggeredAt: now,
            createdAt: now,
          })
          .run();
        created += 1;
      } else if (existing.headline !== headline) {
        db.update(alertEvents)
          .set({ direction, headline, detail, acknowledged: false, triggeredAt: now })
          .where(eq(alertEvents.id, existing.id))
          .run();
        created += 1;
      }
    } catch (err) {
      errors.push(`${symbol}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { documentsSeen: rows.length, created, errors };
}
