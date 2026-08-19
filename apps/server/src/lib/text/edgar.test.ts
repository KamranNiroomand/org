import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import { marketDb } from '../../db/market/index.js';
import { runMarketMigrations } from '../../db/market/migrate.js';
import { documents, docMentions } from '../../db/market/schema.js';
import { nowIso } from '../util.js';
import { readDocumentsBefore } from './news.js';
import { ingestEdgarForUniverse } from './edgar.js';
import type { EightK, EdgarFetchers } from './edgar.js';

/**
 * Real SEC calls never run in this suite — see news.test.ts's identical
 * reasoning for why `ingestEdgarForUniverse` takes injectable fetchers.
 */

function eightK(overrides: Partial<EightK> = {}): EightK {
  return {
    accessionNumber: '0000320193-26-000018',
    acceptedAt: '2026-08-18T20:30:00.000Z',
    primaryDocument: 'aapl-20260818.htm',
    items: '2.02,9.01',
    ...overrides,
  };
}

function fetchers(filingsBySymbol: Record<string, EightK[]>, cik: Record<string, string> = { AAPL: '0000320193' }): EdgarFetchers {
  return {
    tickerToCik: async () => new Map(Object.entries(cik)),
    eightKs: async (cik10: string) => {
      const symbol = Object.entries(cik).find(([, c]) => c === cik10)?.[0];
      return symbol ? (filingsBySymbol[symbol] ?? []) : [];
    },
  };
}

beforeEach(() => {
  runMarketMigrations();
  marketDb.delete(docMentions).run();
  marketDb.delete(documents).run();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('ingestEdgarForUniverse', () => {
  it('refuses to run without SEC_EDGAR_USER_AGENT configured, before making any request', async () => {
    // The static top-level import above already cached edgar.js (and the
    // config it closed over) at file-load time, before this stub runs —
    // resetModules first forces a fresh evaluation that actually sees it.
    vi.resetModules();
    vi.stubEnv('SEC_EDGAR_USER_AGENT', '');
    const { ingestEdgarForUniverse: freshIngest } = await import('./edgar.js');
    await expect(
      freshIngest(['AAPL'], {
        tickerToCik: async () => {
          throw new Error('should not be called');
        },
        eightKs: async () => {
          throw new Error('should not be called');
        },
      }),
    ).rejects.toThrow(/SEC_EDGAR_USER_AGENT/);
  });

  it('writes one document and one mention per 8-K, with edgar item codes carried through', async () => {
    const summary = await ingestEdgarForUniverse(['AAPL'], fetchers({ AAPL: [eightK()] }));
    expect(summary.documentsWritten).toBe(1);
    expect(summary.symbolsUnresolved).toEqual([]);

    const docs = readDocumentsBefore('AAPL', '2099-01-01T00:00:00Z');
    expect(docs).toHaveLength(1);
    expect(docs[0]!.source).toBe('edgar');
    expect(docs[0]!.sentiment).toBeNull(); // EDGAR carries no sentiment — see doc_mentions' doc comment.
  });

  it('is idempotent — re-ingesting the same filing does not duplicate it', async () => {
    const f = fetchers({ AAPL: [eightK()] });
    await ingestEdgarForUniverse(['AAPL'], f);
    await ingestEdgarForUniverse(['AAPL'], f);
    expect(readDocumentsBefore('AAPL', '2099-01-01T00:00:00Z')).toHaveLength(1);
  });

  it('records an unresolved ticker without failing the whole universe', async () => {
    const summary = await ingestEdgarForUniverse(['AAPL', 'GHOST'], fetchers({ AAPL: [eightK()] }));
    expect(summary.symbolsDone).toBe(2);
    expect(summary.symbolsUnresolved).toEqual(['GHOST']);
    expect(summary.documentsWritten).toBe(1);
  });
});

describe('the cutoff bug this module was fixed for', () => {
  it('a news document with a later publishedAt must not suppress fetching real, unseen filings', async () => {
    // Mirrors news.test.ts's identical scenario in reverse: seed a NEWS
    // document dated after the real 8-K this test then tries to fetch.
    // Before the fix, latestKnownAcceptedAt was unscoped by source and
    // would have used this news document's later date as the EDGAR
    // cutoff, silently filtering out the real, unfetched 8-K below.
    marketDb
      .insert(documents)
      .values({
        id: 'polygon_news:x',
        source: 'polygon_news',
        sourceId: 'x',
        publishedAt: '2026-08-19T00:00:00Z',
        ingestedAt: nowIso(),
        title: 'Some article',
        url: 'https://example.com/a',
      })
      .run();
    marketDb.insert(docMentions).values({ documentId: 'polygon_news:x', underlying: 'AAPL' }).run();

    const realFiling = eightK({ acceptedAt: '2026-08-17T00:00:00.000Z' });
    const summary = await ingestEdgarForUniverse(['AAPL'], fetchers({ AAPL: [realFiling] }));

    expect(summary.documentsWritten).toBe(1);
    const edgarDocs = readDocumentsBefore('AAPL', '2099-01-01T00:00:00Z').filter((d) => d.source === 'edgar');
    expect(edgarDocs).toHaveLength(1);
  });
});
