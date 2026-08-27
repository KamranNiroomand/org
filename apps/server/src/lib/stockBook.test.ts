import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { paperDb } from '../db/paper/index.js';
import { runPaperMigrations } from '../db/paper/migrate.js';
import { stockMarks, stockOrders } from '../db/paper/schema.js';
import {
  closeStockPosition,
  markStockPosition,
  openStockPosition,
  reduceStockPosition,
  stockCapacity,
  stockEntriesOpenedOn,
  stockEquity,
} from './stockBook.js';

const DAY = '2026-08-26';

function open(overrides: Partial<Parameters<typeof openStockPosition>[0]> = {}): string {
  return openStockPosition({
    symbol: 'AAPL',
    book: 'short',
    quantity: 10,
    priceE4: 1_000_000, // $100.00
    basis: 'measured',
    day: DAY,
    sector: 'Information Technology',
    ...overrides,
  });
}

describe('stock paper book', () => {
  runPaperMigrations();

  beforeEach(() => {
    paperDb.delete(stockMarks).run();
    paperDb.delete(stockOrders).run();
  });

  it('opens at the measured price and draws the cost from cash', () => {
    const before = stockEquity();
    const id = open();
    const after = stockEquity();
    const order = paperDb.select().from(stockOrders).where(eq(stockOrders.id, id)).get()!;
    expect(order.entryPriceE4).toBe(1_000_000);
    expect(order.entryBasis).toBe('measured');
    // 10 shares x $100 leaves cash down $1,000 but equity unchanged: the
    // money became a position, it did not evaporate.
    expect(before.cashE4 - after.cashE4).toBe(10_000_000);
    expect(after.totalEquityE4).toBe(before.totalEquityE4);
  });

  it('fractional shares are legitimate, unlike option contracts', () => {
    const id = open({ quantity: 2.5 });
    const order = paperDb.select().from(stockOrders).where(eq(stockOrders.id, id)).get()!;
    expect(order.quantity).toBe(2.5);
  });

  it('marks move equity and never duplicate the day row', () => {
    const id = open();
    markStockPosition(id, DAY, 1_100_000, 'measured');
    markStockPosition(id, DAY, 1_200_000, 'measured');
    const marks = paperDb.select().from(stockMarks).all();
    expect(marks).toHaveLength(1);
    expect(marks[0]!.markPriceE4).toBe(1_200_000);
    // 10 shares x $20 gain.
    expect(marks[0]!.unrealizedPlE4).toBe(2_000_000);
    expect(stockEquity().totalEquityE4).toBe(stockEquity().startingBalanceE4 + 2_000_000);
  });

  it('banks realized P&L on close and returns the proceeds to cash', () => {
    const id = open();
    closeStockPosition(id, 1_200_000, 'measured', DAY, 'target_reached');
    const eq2 = stockEquity();
    expect(eq2.realizedPlE4).toBe(2_000_000);
    expect(eq2.totalEquityE4).toBe(eq2.startingBalanceE4 + 2_000_000);
    expect(eq2.positionsValueE4).toBe(0);
  });

  it('scaling out splits the position and keeps the arithmetic exact', () => {
    const id = open({ quantity: 10 });
    const sliceId = reduceStockPosition(id, 4, 1_500_000, 'measured', DAY, 'scale_out');
    const survivor = paperDb.select().from(stockOrders).where(eq(stockOrders.id, id)).get()!;
    const slice = paperDb.select().from(stockOrders).where(eq(stockOrders.id, sliceId)).get()!;
    expect(survivor.quantity).toBe(6);
    expect(survivor.initialQuantity).toBe(10); // the durable already-scaled fact
    expect(slice.status).toBe('closed');
    expect(slice.splitFrom).toBe(id);
    // 4 shares x $50 gain banked; 6 shares still deployed at cost.
    expect(stockEquity().realizedPlE4).toBe(2_000_000);
  });

  it('a modelled price pays the spread, a measured one does not', () => {
    const measured = open({ basis: 'measured', priceE4: 1_000_000 });
    const modelled = open({ basis: 'modelled', priceE4: 1_000_000, symbol: 'MSFT' });
    const a = paperDb.select().from(stockOrders).where(eq(stockOrders.id, measured)).get()!;
    const b = paperDb.select().from(stockOrders).where(eq(stockOrders.id, modelled)).get()!;
    expect(a.entryPriceE4).toBe(1_000_000);
    expect(b.entryPriceE4).toBeGreaterThanOrEqual(1_000_000);
  });

  it('capacity reports slots, held symbols and sector counts per book', () => {
    open({ symbol: 'AAPL', sector: 'Information Technology' });
    open({ symbol: 'MSFT', sector: 'Information Technology' });
    open({ symbol: 'XOM', book: 'long', sector: 'Energy' });
    const short = stockCapacity('short');
    expect(short.openCount).toBe(2);
    expect(short.heldSymbols.sort()).toEqual(['AAPL', 'MSFT']);
    expect(short.sectorCounts['Information Technology']).toBe(2);
    // The long book's seats are its own; only cash is shared.
    expect(stockCapacity('long').openCount).toBe(1);
    expect(stockCapacity('long').freeCashE4).toBe(short.freeCashE4);
  });

  it('counts the day’s entries per book so a rerun cannot double-spend', () => {
    open({ book: 'short' });
    open({ book: 'short', symbol: 'MSFT' });
    open({ book: 'long', symbol: 'XOM' });
    expect(stockEntriesOpenedOn(DAY, 'short')).toBe(2);
    expect(stockEntriesOpenedOn(DAY, 'long')).toBe(1);
    expect(stockEntriesOpenedOn('2026-08-25', 'short')).toBe(0);
  });

  it('refuses a reduction that would empty the position', () => {
    const id = open({ quantity: 3 });
    expect(() => reduceStockPosition(id, 3, 1_000_000, 'measured', DAY, 'x')).toThrow(/must leave/);
  });
});
