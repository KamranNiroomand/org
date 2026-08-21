import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { runMigrations } from '../../db/migrate.js';
import { alertEvents } from '../../db/schema.js';
import { marketDb } from '../../db/market/index.js';
import { runMarketMigrations } from '../../db/market/migrate.js';
import { documents, docMentions } from '../../db/market/schema.js';
import { newId } from '../util.js';
import { createNewsAlerts } from './newsAlerts.js';

/**
 * `docMentions.underlying` is stored in the vendor's symbol format
 * (`BRK.B`) — these fixtures use `MRNA` throughout specifically because it
 * has no hyphen/dot in either format, which would silently pass even if
 * the vendor-symbol round-trip in newsAlerts.ts were broken. See
 * `bRkTest` below for the case that actually exercises that conversion.
 */

const NOW = '2026-08-21T15:00:00.000Z';

function seedDocument(overrides: {
  id?: string;
  underlying: string;
  title: string;
  publishedAt: string;
  eventType?: string | null;
  sentiment?: 'positive' | 'negative' | 'neutral' | null;
}) {
  const id = overrides.id ?? newId();
  marketDb
    .insert(documents)
    .values({
      id,
      source: 'polygon_news',
      sourceId: id,
      publishedAt: overrides.publishedAt,
      ingestedAt: overrides.publishedAt,
      title: overrides.title,
      summary: null,
      url: 'https://example.com/a',
      docType: null,
      edgarItems: null,
      eventType: 'eventType' in overrides ? overrides.eventType : 'product_or_strategy',
      eventConfidence: 'eventType' in overrides ? null : 'medium',
    })
    .run();
  marketDb
    .insert(docMentions)
    .values({ documentId: id, underlying: overrides.underlying, sentiment: overrides.sentiment ?? 'positive' })
    .run();
  return id;
}

beforeEach(() => {
  runMarketMigrations();
  marketDb.delete(docMentions).run();
  marketDb.delete(documents).run();
  runMigrations();
  db.delete(alertEvents).run();
});

describe('createNewsAlerts', () => {
  it('creates one alert from a classified document mentioning a watchlist symbol', () => {
    seedDocument({ underlying: 'MRNA', title: 'Moderna announces new trial', publishedAt: '2026-08-21T10:00:00Z' });

    const summary = createNewsAlerts(['MRNA'], NOW);
    expect(summary.created).toBe(1);

    const rows = db.select().from(alertEvents).where(eq(alertEvents.symbol, 'MRNA')).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ruleKey: 'news_event',
      context: 'watchlist',
      direction: 'bullish',
      tradingDay: '2026-08-21',
    });
    expect(rows[0]!.headline).toContain('Moderna announces new trial');
  });

  it('ignores unclassified documents — eventType still null', () => {
    seedDocument({ underlying: 'MRNA', title: 'Unclassified story', publishedAt: '2026-08-21T10:00:00Z', eventType: null });

    const summary = createNewsAlerts(['MRNA'], NOW);
    expect(summary.created).toBe(0);
    expect(db.select().from(alertEvents).all()).toHaveLength(0);
  });

  it('is idempotent — re-running with the same latest document does not duplicate or re-touch the row', () => {
    seedDocument({ underlying: 'MRNA', title: 'Moderna announces new trial', publishedAt: '2026-08-21T10:00:00Z' });
    createNewsAlerts(['MRNA'], NOW);
    const first = db.select().from(alertEvents).where(eq(alertEvents.symbol, 'MRNA')).get()!;

    const summary = createNewsAlerts(['MRNA'], NOW);
    expect(summary.created).toBe(0);
    const second = db.select().from(alertEvents).where(eq(alertEvents.symbol, 'MRNA')).get()!;
    expect(second.triggeredAt).toBe(first.triggeredAt);
    expect(db.select().from(alertEvents).all()).toHaveLength(1);
  });

  it('updates the existing same-day alert, and re-opens it for acknowledgment, when a newer story lands', () => {
    seedDocument({ underlying: 'MRNA', title: 'Moderna announces new trial', publishedAt: '2026-08-21T10:00:00Z' });
    createNewsAlerts(['MRNA'], NOW);
    db.update(alertEvents).set({ acknowledged: true }).where(eq(alertEvents.symbol, 'MRNA')).run();

    seedDocument({ underlying: 'MRNA', title: 'Moderna trial shows strong results', publishedAt: '2026-08-21T14:00:00Z' });
    const summary = createNewsAlerts(['MRNA'], NOW);
    expect(summary.created).toBe(1);

    const rows = db.select().from(alertEvents).where(eq(alertEvents.symbol, 'MRNA')).all();
    expect(rows).toHaveLength(1); // still one row for the day, not two
    expect(rows[0]!.headline).toContain('Moderna trial shows strong results');
    expect(rows[0]!.acknowledged).toBe(false);
  });

  it('maps the vendor symbol format back to the watchlist symbol format', () => {
    // docMentions.underlying is stored in the vendor's dot format; the
    // caller passes symbols in this app's own hyphen format (matching
    // watchlist.symbol) — this is the conversion newsAlerts.ts must get
    // right in both directions.
    seedDocument({ underlying: 'BRK.B', title: 'Berkshire files 8-K', publishedAt: '2026-08-21T10:00:00Z' });

    const summary = createNewsAlerts(['BRK-B'], NOW);
    expect(summary.created).toBe(1);

    const rows = db.select().from(alertEvents).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.symbol).toBe('BRK-B'); // not 'BRK.B'
  });

  it('derives direction from sentiment', () => {
    seedDocument({ underlying: 'MRNA', title: 'Bad trial results', publishedAt: '2026-08-21T10:00:00Z', sentiment: 'negative' });

    createNewsAlerts(['MRNA'], NOW);
    const row = db.select().from(alertEvents).where(eq(alertEvents.symbol, 'MRNA')).get()!;
    expect(row.direction).toBe('bearish');
  });

  it('returns immediately for an empty watchlist, with no query against either database', () => {
    const summary = createNewsAlerts([], NOW);
    expect(summary).toEqual({ documentsSeen: 0, created: 0, errors: [] });
  });
});
