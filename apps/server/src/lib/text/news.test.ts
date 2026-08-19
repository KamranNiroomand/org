import { beforeEach, describe, expect, it } from 'vitest';
import { marketDb } from '../../db/market/index.js';
import { runMarketMigrations } from '../../db/market/migrate.js';
import { documents, docMentions } from '../../db/market/schema.js';
import { nowIso } from '../util.js';
import { ingestNewsForUniverse, readDocumentsBefore, type PolygonNewsArticle } from './news.js';

/**
 * Real API calls never run in this suite — `ingestNewsForUniverse` takes an
 * injectable fetcher for exactly this reason, the same shape
 * `OptionsProvider` already gives `captureChains`.
 *
 * The point-in-time and cutoff tests here pin the real bug found live
 * while dogfooding this module: `latestKnownPublishedAt` was unscoped by
 * source, so a symbol with both EDGAR and news history picked up
 * whichever source had the more recent document as the cutoff for *this*
 * source — silently skipping real, unfetched news whenever an EDGAR filing
 * landed more recently than the last news article did.
 */

function article(overrides: Partial<PolygonNewsArticle> = {}): PolygonNewsArticle {
  return {
    id: 'art-1',
    title: 'Some headline',
    published_utc: '2026-08-18T12:00:00Z',
    article_url: 'https://example.com/a',
    description: 'A summary.',
    tickers: ['AAPL'],
    insights: [{ ticker: 'AAPL', sentiment: 'positive', sentiment_reasoning: 'reasons' }],
    ...overrides,
  };
}

beforeEach(() => {
  runMarketMigrations();
  marketDb.delete(docMentions).run();
  marketDb.delete(documents).run();
});

describe('ingestNewsForUniverse', () => {
  it('writes a document and one mention per ticker, with per-ticker sentiment', async () => {
    const summary = await ingestNewsForUniverse(['AAPL'], async () => [article()]);
    expect(summary.documentsWritten).toBe(1);
    expect(summary.mentionsWritten).toBe(1);

    const docs = readDocumentsBefore('AAPL', '2099-01-01T00:00:00Z');
    expect(docs).toHaveLength(1);
    expect(docs[0]!.sentiment).toBe('positive');
    expect(docs[0]!.sentimentReasoning).toBe('reasons');
  });

  it('is idempotent — re-ingesting the same article does not duplicate it', async () => {
    const fetcher = async () => [article()];
    await ingestNewsForUniverse(['AAPL'], fetcher);
    await ingestNewsForUniverse(['AAPL'], fetcher);

    const docs = readDocumentsBefore('AAPL', '2099-01-01T00:00:00Z');
    expect(docs).toHaveLength(1);
  });

  it('a ticker mentioned with no matching insight gets a mention row with null sentiment, not a fabricated one', async () => {
    const a = article({ tickers: ['AAPL', 'MSFT'], insights: [{ ticker: 'AAPL', sentiment: 'positive', sentiment_reasoning: 'x' }] });
    await ingestNewsForUniverse(['AAPL', 'MSFT'], async () => [a]);

    const msft = readDocumentsBefore('MSFT', '2099-01-01T00:00:00Z');
    expect(msft).toHaveLength(1);
    expect(msft[0]!.sentiment).toBeNull();
  });

  it('records a fetch failure for one symbol without losing the others', async () => {
    const fetcher = async (ticker: string) => {
      if (ticker === 'BAD') throw new Error('boom');
      return [article({ id: `art-${ticker}`, tickers: [ticker], insights: [] })];
    };
    const summary = await ingestNewsForUniverse(['AAPL', 'BAD'], fetcher);
    expect(summary.symbolsDone).toBe(2);
    expect(summary.errors.some((e) => e.startsWith('BAD:'))).toBe(true);
    expect(readDocumentsBefore('AAPL', '2099-01-01T00:00:00Z')).toHaveLength(1);
  });
});

describe('readDocumentsBefore — point-in-time correctness', () => {
  it('excludes a document published on or after the cutoff', async () => {
    await ingestNewsForUniverse(['AAPL'], async () => [
      article({ id: 'before', published_utc: '2026-08-10T00:00:00Z' }),
      article({ id: 'at-cutoff', published_utc: '2026-08-15T00:00:00Z' }),
      article({ id: 'after', published_utc: '2026-08-20T00:00:00Z' }),
    ]);

    const docs = readDocumentsBefore('AAPL', '2026-08-15T00:00:00Z');
    const ids = docs.map((d) => d.id);
    expect(ids).toEqual(['polygon_news:before']);
  });
});

describe('the cutoff bug this module was fixed for', () => {
  it('an EDGAR document with a later publishedAt must not suppress fetching real, unseen news', async () => {
    // Seed an EDGAR document dated *after* the news article this test will
    // then try to fetch — before the fix, latestKnownPublishedAt was
    // unscoped by source and would have picked this up as "the latest known
    // document for AAPL", making the news fetcher's cutoff look like it was
    // already past the real article below, silently skipping it.
    marketDb
      .insert(documents)
      .values({
        id: 'edgar:0001',
        source: 'edgar',
        sourceId: '0001',
        publishedAt: '2026-08-19T00:00:00Z',
        ingestedAt: nowIso(),
        title: '8-K — AAPL',
        url: 'https://example.com/8k',
      })
      .run();
    marketDb.insert(docMentions).values({ documentId: 'edgar:0001', underlying: 'AAPL' }).run();

    let receivedCutoff: string | null = null;
    const realNewsArticle = article({ id: 'real-news', published_utc: '2026-08-17T00:00:00Z' });
    await ingestNewsForUniverse(['AAPL'], async (_ticker, publishedAfter) => {
      receivedCutoff = publishedAfter;
      return [realNewsArticle];
    });

    // The cutoff passed to the news fetcher must come from news history
    // (none exists yet) — not from the EDGAR document's later date.
    expect(receivedCutoff).not.toBe('2026-08-19T00:00:00Z');
    const newsDocs = readDocumentsBefore('AAPL', '2099-01-01T00:00:00Z').filter((d) => d.source === 'polygon_news');
    expect(newsDocs).toHaveLength(1);
  });
});
