import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { toE4 } from '@org/shared';
import { paperDb } from '../db/paper/index.js';
import { runPaperMigrations } from '../db/paper/migrate.js';
import { stockDecisions, stockMarks, stockOrders } from '../db/paper/schema.js';
import { markStockPosition, openStockPosition, openStockOrders } from './stockBook.js';
import { attemptRotation } from './stockEngine.js';
import type { StockRankResult } from './quant.js';

const log = pino({ level: 'silent' });
const DAY = '2026-09-09';

function seedHolding(symbol: string, openedDaysAgo: number): string {
  const id = openStockPosition({
    symbol,
    book: 'short',
    quantity: 10,
    priceE4: toE4(100),
    basis: 'measured',
    day: DAY,
  });
  // Backdate the open so the min-hold hysteresis sees real age, and give
  // the position a mark to close at.
  paperDb
    .update(stockOrders)
    .set({ openedAt: new Date(Date.now() - openedDaysAgo * 86_400_000).toISOString() })
    .where(eq(stockOrders.id, id))
    .run();
  markStockPosition(id, DAY, toE4(101), 'measured');
  return id;
}

function board(entries: Array<[string, number | null]>): typeof rankStub {
  return async () =>
    ({
      modelRunId: 'test-run',
      target: 'stk_short',
      horizonDays: 21,
      picks: entries.map(([symbol, sigma], i) => ({
        symbol,
        rank: i + 1,
        horizonReturn: 0.01,
        forecastSigmas: sigma,
        annualDrift: 0.1,
        forecastVol: 0.3,
      })),
    }) satisfies StockRankResult;
}
const rankStub = async (): Promise<StockRankResult> => ({ modelRunId: 't', target: 'stk_short', horizonDays: 21, picks: [] });

beforeEach(() => {
  runPaperMigrations();
  paperDb.delete(stockMarks).run();
  paperDb.delete(stockDecisions).run();
  paperDb.delete(stockOrders).run();
});

describe('attemptRotation', () => {
  it('evicts the weakest eligible holding when a candidate clears the edge', async () => {
    const weak = seedHolding('WEAK', 10);
    seedHolding('FINE', 10);
    const rotated = await attemptRotation(
      log, DAY, 'short', 'stk_short', 21,
      board([
        ['CAND', 1.2],   // strong outsider
        ['FINE', 0.6],
        ['WEAK', 0.1],
      ]),
    );
    expect(rotated).toBe(true);
    const closed = paperDb.select().from(stockOrders).where(eq(stockOrders.id, weak)).get()!;
    expect(closed.status).toBe('closed');
    expect(closed.exitReason).toBe('rotated_for_stronger_candidate');
    expect(openStockOrders('short').map((o) => o.symbol)).toEqual(['FINE']);
    const logged = paperDb.select().from(stockDecisions).all();
    expect(logged.some((d) => d.reason === 'rotated_out' && d.symbol === 'WEAK')).toBe(true);
  });

  it('does nothing when the edge is below the threshold, and says why', async () => {
    seedHolding('WEAK', 10);
    const rotated = await attemptRotation(
      log, DAY, 'short', 'stk_short', 21,
      board([
        ['CAND', 0.3], // above WEAK's 0.1, but under the 0.4 edge
        ['WEAK', 0.1],
      ]),
    );
    expect(rotated).toBe(false);
    expect(openStockOrders('short')).toHaveLength(1);
    const logged = paperDb.select().from(stockDecisions).all();
    expect(logged.some((d) => d.reason === 'rotation_no_edge')).toBe(true);
  });

  it('never touches a position younger than the minimum hold', async () => {
    seedHolding('YOUNG', 1);
    const rotated = await attemptRotation(
      log, DAY, 'short', 'stk_short', 21,
      board([['CAND', 5.0], ['YOUNG', -1.0]]),
    );
    expect(rotated).toBe(false);
    expect(openStockOrders('short')).toHaveLength(1);
  });

  it('treats an off-board holding as neutral, not as automatically evictable', async () => {
    seedHolding('GHOST', 10); // absent from the board entirely
    const rotated = await attemptRotation(
      log, DAY, 'short', 'stk_short', 21,
      board([['CAND', 0.3]]), // positive but under 0 + 0.4 edge
    );
    expect(rotated).toBe(false);
    const strong = await attemptRotation(
      log, DAY, 'short', 'stk_short', 21,
      board([['CAND2', 0.9]]), // clears neutral + edge
    );
    expect(strong).toBe(true);
    expect(openStockOrders('short')).toHaveLength(0);
  });
});
