import { and, desc, eq, sql } from 'drizzle-orm';
import { config } from '../../config.js';
import { marketDb } from '../../db/market/index.js';
import { documents, docMentions } from '../../db/market/schema.js';
import { mapLimit, MAX_CONCURRENCY } from '../options/polygon.js';
import { nowIso } from '../util.js';

/**
 * Polygon news ingestion — one of two text sources buildable today (the
 * other is EDGAR; see edgar.ts). Reddit/StockTwits need OAuth credentials
 * this project does not have configured, and earnings transcripts need a
 * paid vendor on top of Polygon — both explicitly out of scope here, not
 * silently skipped.
 *
 * The one thing that makes this source unusually good, worth stating
 * plainly: **Polygon scores sentiment per ticker, within one article,
 * independently of every other ticker the same article mentions.** A name
 * that is the article's actual subject reads 'positive'; a name mentioned
 * only as a comparison point in the same paragraph reads 'neutral'. That is
 * real, vendor-computed signal — this module stores it as-is rather than
 * re-deriving a weaker version of it locally.
 */

const BASE = 'https://api.polygon.io';

function apiKey(): string {
  const key = config.market.polygonKey;
  if (!key) throw new Error('POLYGON_API_KEY is not set — news ingestion is disabled without it.');
  return key;
}

export interface PolygonNewsInsight {
  ticker?: string;
  sentiment?: 'positive' | 'negative' | 'neutral';
  sentiment_reasoning?: string;
}

export interface PolygonNewsArticle {
  id: string;
  title: string;
  published_utc: string;
  article_url: string;
  description?: string;
  tickers?: string[];
  insights?: PolygonNewsInsight[];
}

interface PolygonNewsEnvelope {
  results?: PolygonNewsArticle[];
}

/** One GET, no pagination walk — the `published_utc.gt` filter already
 * bounds each call to what is new since the last ingest, so a single page
 * covers it except on a symbol's very first run, where the limit caps how
 * much history one call pulls rather than pulling all of it.
 */
async function fetchNews(ticker: string, publishedAfter: string | null, limit = 50): Promise<PolygonNewsArticle[]> {
  const url = new URL(`${BASE}/v2/reference/news`);
  url.searchParams.set('ticker', ticker);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('order', 'desc');
  url.searchParams.set('sort', 'published_utc');
  if (publishedAfter) url.searchParams.set('published_utc.gt', publishedAfter);
  url.searchParams.set('apiKey', apiKey());

  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Polygon news ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 300)}` : ''}`);
  }
  const env = (await res.json()) as PolygonNewsEnvelope;
  return env.results ?? [];
}

/** The latest publishedAt already stored for this ticker's *news* mentions,
 * or null if none — the incremental-fetch cursor. Scoped to
 * source='polygon_news' specifically: without that filter, a symbol with
 * both news and EDGAR history would pick up whichever source happened to
 * have the more recent document as the cutoff for *this* source, silently
 * skipping real, unfetched news whenever an EDGAR filing landed more
 * recently than the last news article did (found live — see edgar.ts's
 * identical fix and the PR this shipped in). Bounded to a lookback window
 * on a symbol's first run (see ingestNewsForUniverse) rather than pulling a
 * ticker's entire news history the first time it is seen.
 */
function latestKnownPublishedAt(underlying: string): string | null {
  const row = marketDb
    .select({ publishedAt: documents.publishedAt })
    .from(docMentions)
    .innerJoin(documents, eq(documents.id, docMentions.documentId))
    .where(and(eq(docMentions.underlying, underlying), eq(documents.source, 'polygon_news')))
    .orderBy(desc(documents.publishedAt))
    .limit(1)
    .get();
  return row?.publishedAt ?? null;
}

function persistArticles(articles: readonly PolygonNewsArticle[]): { documentsWritten: number; mentionsWritten: number } {
  if (articles.length === 0) return { documentsWritten: 0, mentionsWritten: 0 };
  const now = nowIso();
  let documentsWritten = 0;
  let mentionsWritten = 0;

  marketDb.transaction((tx) => {
    for (const article of articles) {
      const id = `polygon_news:${article.id}`;
      const inserted = tx
        .insert(documents)
        .values({
          id,
          source: 'polygon_news',
          sourceId: article.id,
          publishedAt: article.published_utc,
          ingestedAt: now,
          title: article.title,
          summary: article.description ?? null,
          url: article.article_url,
          docType: 'news',
        })
        .onConflictDoNothing({ target: [documents.source, documents.sourceId] })
        .run();
      if (inserted.changes > 0) documentsWritten += 1;

      // insights carries per-ticker sentiment; tickers not present in
      // insights (Polygon sometimes tags a ticker without scoring it) still
      // get a mention row, just with a null sentiment rather than a
      // fabricated one.
      const insightByTicker = new Map((article.insights ?? []).map((i) => [i.ticker, i]));
      const tickers = article.tickers ?? [];
      for (const ticker of tickers) {
        const insight = insightByTicker.get(ticker);
        const mention = tx
          .insert(docMentions)
          .values({
            documentId: id,
            underlying: ticker,
            sentiment: insight?.sentiment ?? null,
            sentimentReasoning: insight?.sentiment_reasoning ?? null,
          })
          .onConflictDoNothing({ target: [docMentions.documentId, docMentions.underlying] })
          .run();
        if (mention.changes > 0) mentionsWritten += 1;
      }
    }
  });

  return { documentsWritten, mentionsWritten };
}

export interface NewsIngestSummary {
  symbolsDone: number;
  articlesFetched: number;
  documentsWritten: number;
  mentionsWritten: number;
  errors: string[];
}

/** First-run lookback — how far back to reach for a symbol with no stored
 * news yet, so day one does not silently start from "nothing before now".
 */
const FIRST_RUN_LOOKBACK_DAYS = 7;

export type NewsFetcher = (ticker: string, publishedAfter: string | null) => Promise<PolygonNewsArticle[]>;

/**
 * `fetcher` defaults to the real Polygon call and is only ever overridden in
 * tests — the same dependency-injection shape `OptionsProvider` already
 * gives `captureChains` in options/capture.ts, so the persist/cutoff logic
 * (where the real bug in this module lived — see latestKnownPublishedAt's
 * doc comment) gets real, deterministic test coverage without a live call.
 */
export async function ingestNewsForUniverse(
  symbols: readonly string[],
  fetcher: NewsFetcher = fetchNews,
): Promise<NewsIngestSummary> {
  if (!config.market.configured) {
    throw new Error('POLYGON_API_KEY is not set — news ingestion is disabled without it.');
  }

  const summary: NewsIngestSummary = {
    symbolsDone: 0,
    articlesFetched: 0,
    documentsWritten: 0,
    mentionsWritten: 0,
    errors: [],
  };

  await mapLimit(symbols, MAX_CONCURRENCY, async (symbol) => {
    try {
      const known = latestKnownPublishedAt(symbol);
      const cutoff =
        known ?? new Date(Date.now() - FIRST_RUN_LOOKBACK_DAYS * 86_400_000).toISOString();
      const articles = await fetcher(symbol, cutoff);
      summary.articlesFetched += articles.length;
      const written = persistArticles(articles);
      summary.documentsWritten += written.documentsWritten;
      summary.mentionsWritten += written.mentionsWritten;
    } catch (err) {
      summary.errors.push(`${symbol}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      summary.symbolsDone += 1;
    }
  });

  return summary;
}

/** For point-in-time-correct feature reads — documents from `underlying`
 * strictly before `beforeInstant`, never on-or-after it. Exported alongside
 * the ingester since both sides of this table (write, read) share the one
 * invariant that makes it safe to train on.
 */
export function readDocumentsBefore(underlying: string, beforeInstant: string) {
  return marketDb
    .select({
      id: documents.id,
      source: documents.source,
      publishedAt: documents.publishedAt,
      title: documents.title,
      summary: documents.summary,
      docType: documents.docType,
      sentiment: docMentions.sentiment,
      sentimentReasoning: docMentions.sentimentReasoning,
    })
    .from(docMentions)
    .innerJoin(documents, eq(documents.id, docMentions.documentId))
    .where(sql`${docMentions.underlying} = ${underlying} and ${documents.publishedAt} < ${beforeInstant}`)
    .orderBy(desc(documents.publishedAt))
    .all();
}
