import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { formatOccSymbol, toE4 } from '@org/shared';
import { marketDb } from '../../db/market/index.js';
import { runMarketMigrations } from '../../db/market/migrate.js';
import { documents, docMentions, optionContracts } from '../../db/market/schema.js';
import { paperDb } from '../../db/paper/index.js';
import { runPaperMigrations } from '../../db/paper/migrate.js';
import { paperOrders, paperPositionHealth } from '../../db/paper/schema.js';
import { newId, nowIso } from '../util.js';
import { openOrder } from '../paper.js';
import { computePositionHealth, latestPositionHealth } from './positionHealth.js';

/**
 * The test suite never runs the Python sidecar (QUANT_URL points nowhere —
 * see vitest.config.ts), so every scenario here exercises the honest
 * "quant unavailable" path for scoring. That is deliberately not treated as
 * a reason to skip the whole run: the news check is independent of the
 * model, and a quant outage is exactly the kind of night someone would
 * still want to know real news broke — see positionHealth.ts's own comment
 * on why scoring failure doesn't short-circuit before the news check.
 */

const CONTRACT = {
  underlying: 'NVDA',
  expiry: '2026-08-19',
  type: 'call' as const,
  strikeE4: toE4(227.5),
};
const OCC = formatOccSymbol(CONTRACT);
const ASK_E4 = toE4(1.14);
const OPENED_AT = '2026-08-15T12:00:00.000Z';

function seedContract() {
  marketDb
    .insert(optionContracts)
    .values({
      occSymbol: OCC,
      underlying: CONTRACT.underlying,
      expiry: CONTRACT.expiry,
      type: CONTRACT.type,
      strikeE4: CONTRACT.strikeE4,
      multiplier: 100,
      firstSeenAt: nowIso(),
      lastSeenAt: nowIso(),
    })
    .run();
}

function seedDocument(id: string, publishedAt: string, underlying = CONTRACT.underlying) {
  marketDb
    .insert(documents)
    .values({
      id,
      source: 'polygon_news',
      sourceId: id,
      publishedAt,
      ingestedAt: nowIso(),
      title: `News about ${underlying} — ${id}`,
      url: `https://example.com/${id}`,
    })
    .run();
  marketDb.insert(docMentions).values({ documentId: id, underlying }).run();
}

function openPosition(openedAt = OPENED_AT) {
  const id = openOrder({ occSymbol: OCC, quantity: 1, entryPriceE4: ASK_E4 });
  // openOrder always stamps "now" — backdate it directly so the news-cutoff
  // scenarios below have a real gap to test against.
  paperDb.update(paperOrders).set({ openedAt }).where(eq(paperOrders.id, id)).run();
  return id;
}

beforeEach(() => {
  runMarketMigrations();
  runPaperMigrations();
  paperDb.delete(paperPositionHealth).run();
  paperDb.delete(paperOrders).run();
  marketDb.delete(docMentions).run();
  marketDb.delete(documents).run();
  marketDb.delete(optionContracts).run();
  seedContract();
});

describe('computePositionHealth', () => {
  it('does nothing when there are no open positions', async () => {
    const result = await computePositionHealth('2026-08-18');
    expect(result.scored).toBe(0);
    expect(result.skipped).toHaveLength(0);
    expect(paperDb.select().from(paperPositionHealth).all()).toHaveLength(0);
  });

  it('still writes a health row and records news even when the model cannot be scored', async () => {
    const id = openPosition();
    seedDocument('after', '2026-08-16T00:00:00.000Z'); // after openedAt

    const result = await computePositionHealth('2026-08-18');

    expect(result.scored).toBe(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.occSymbol).toBe(OCC);

    const row = paperDb.select().from(paperPositionHealth).all().find((h) => h.orderId === id)!;
    expect(row.currentEv).toBeNull();
    expect(row.newDocumentsCount).toBe(1);
    expect(row.latestDocumentTitle).toContain('after');
  });

  it('only counts documents published strictly after the position was opened', async () => {
    openPosition();
    seedDocument('before', '2026-08-14T00:00:00.000Z'); // before openedAt
    seedDocument('after', '2026-08-16T00:00:00.000Z'); // after openedAt

    await computePositionHealth('2026-08-18');
    const row = paperDb.select().from(paperPositionHealth).all()[0]!;
    expect(row.newDocumentsCount).toBe(1);
    expect(row.latestDocumentTitle).toContain('after');
  });

  it('ignores documents about a different underlying', async () => {
    openPosition();
    seedDocument('other', '2026-08-16T00:00:00.000Z', 'AAPL');

    await computePositionHealth('2026-08-18');
    const row = paperDb.select().from(paperPositionHealth).all()[0]!;
    expect(row.newDocumentsCount).toBe(0);
    expect(row.latestDocumentTitle).toBeNull();
  });

  it('an unknown contract is skipped and never gets a health row', async () => {
    // openOrder itself refuses an unknown contract, so this simulates the
    // real scenario this branch guards against instead: a contract that
    // existed when the position opened and has since disappeared from
    // option_contracts (e.g. a data cleanup), by inserting the order row
    // directly rather than going through openOrder's own validation.
    const id = newId();
    paperDb
      .insert(paperOrders)
      .values({
        id,
        occSymbol: 'GHOST 260101C00001000',
        quantity: 1,
        entryPriceE4: ASK_E4,
        entryBasis: 'modelled',
        status: 'open',
        source: 'manual',
        openedAt: OPENED_AT,
      })
      .run();

    const result = await computePositionHealth('2026-08-18');
    expect(result.skipped.some((s) => s.occSymbol === 'GHOST 260101C00001000')).toBe(true);
    expect(paperDb.select().from(paperPositionHealth).all().find((h) => h.orderId === id)).toBeUndefined();
  });

  it('re-running the same day updates the row in place rather than duplicating', async () => {
    const id = openPosition();
    await computePositionHealth('2026-08-18');
    seedDocument('later', '2026-08-17T00:00:00.000Z');
    await computePositionHealth('2026-08-18');

    const rows = paperDb.select().from(paperPositionHealth).all().filter((h) => h.orderId === id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.newDocumentsCount).toBe(1);
  });

  it('a closed position is never scored', async () => {
    openPosition();
    paperDb.update(paperOrders).set({ status: 'closed' }).run();
    const result = await computePositionHealth('2026-08-18');
    expect(result.scored).toBe(0);
  });
});

describe('latestPositionHealth', () => {
  it('returns only the most recently computed row per order', async () => {
    const id = openPosition();
    await computePositionHealth('2026-08-17');
    await computePositionHealth('2026-08-18');

    const byOrder = latestPositionHealth();
    expect(byOrder.get(id)?.day).toBe('2026-08-18');
  });

  it('a more recently computed check wins even against a chronologically later trading day', async () => {
    // Regression case: found live when a stray manual check ran against
    // literal today (which had no captured quotes yet) before the fixed
    // default (the corpus's actual latest day) was in place. A naive
    // "greatest `day` wins" comparison picked that earlier, null-filled
    // row back up as "latest" forever, since its `day` string sorted
    // higher — real recency has to be judged by `computedAt`, not `day`.
    const id = openPosition();
    await computePositionHealth('2026-08-19');
    await computePositionHealth('2026-08-18');

    const byOrder = latestPositionHealth();
    expect(byOrder.get(id)?.day).toBe('2026-08-18');
  });
});
