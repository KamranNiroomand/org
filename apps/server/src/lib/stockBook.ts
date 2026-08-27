import { and, desc, eq, sql } from 'drizzle-orm';
import { config } from '../config.js';
import { paperDb } from '../db/paper/index.js';
import { stockDecisions, stockMarks, stockOrders } from '../db/paper/schema.js';
import { newId, nowIso } from './util.js';
import { haircutE4, PaperError } from './paper.js';

/**
 * The stock paper book — open, mark, close, and value equity positions
 * for the two model horizons.
 *
 * A deliberate sibling of `paper.ts` rather than an extension of it: the
 * accounting identities are the same (cash out on entry, cash in on
 * exit, unrealized is a mark) but every mechanic differs — fractional
 * shares, no multiplier, real Yahoo quotes rather than modelled option
 * prices, and exits measured in weeks. Sharing the module would mean
 * every function branching on instrument kind; sharing the *patterns*
 * (E4 integers, measured-vs-modelled basis, marks upserted per day, a
 * decision log) costs nothing and keeps both readable.
 *
 * **Stocks are the honest half of this project's data.** Options here
 * are priced from prints because the plan carries no quote entitlement;
 * equities come from Yahoo with a real last/bid, so a stock mark is
 * measured far more often than it is modelled — and the spread haircut
 * applies only to the modelled remainder.
 */

export type StockBook = 'short' | 'long';

export interface OpenStockInput {
  symbol: string;
  book: StockBook;
  quantity: number;
  priceE4: number;
  basis: 'measured' | 'modelled';
  day: string;
  sector?: string | null;
  forecastReturn?: number | null;
  modelRunId?: string | null;
  thesisRef?: string | null;
  stopPriceE4?: number | null;
  targetPriceE4?: number | null;
  targetExitDate?: string | null;
  notes?: string | null;
}

export function openStockPosition(input: OpenStockInput): string {
  if (!(input.quantity > 0)) throw new PaperError(`quantity must be positive, got ${input.quantity}`);
  if (!(input.priceE4 > 0)) throw new PaperError('priceE4 must be positive');

  // A modelled price is a print, not an offer — same rule as the options
  // book, and the same reason: a buyer pays the ask side of it.
  const entryPriceE4 =
    input.basis === 'measured' ? input.priceE4 : haircutE4(input.priceE4, 'buy');

  const id = newId();
  paperDb
    .insert(stockOrders)
    .values({
      id,
      symbol: input.symbol,
      book: input.book,
      quantity: input.quantity,
      initialQuantity: input.quantity,
      entryPriceE4,
      entryBasis: input.basis,
      entryDay: input.day,
      entryForecastReturn: input.forecastReturn ?? null,
      modelRunId: input.modelRunId ?? null,
      thesisRef: input.thesisRef ?? null,
      sector: input.sector ?? null,
      stopPriceE4: input.stopPriceE4 ?? null,
      targetPriceE4: input.targetPriceE4 ?? null,
      targetExitDate: input.targetExitDate ?? null,
      status: 'open',
      notes: input.notes ?? null,
      openedAt: nowIso(),
    })
    .run();
  return id;
}

export function closeStockPosition(
  orderId: string,
  priceE4: number,
  basis: 'measured' | 'modelled',
  day: string,
  reason: string,
): void {
  const order = paperDb.select().from(stockOrders).where(eq(stockOrders.id, orderId)).get();
  if (!order) throw new PaperError(`Unknown stock order: ${orderId}`);
  if (order.status === 'closed') throw new PaperError(`Stock order ${orderId} is already closed`);
  if (!(priceE4 >= 0)) throw new PaperError('priceE4 must not be negative');

  const exitPriceE4 = basis === 'measured' ? priceE4 : haircutE4(priceE4, 'sell');
  paperDb
    .update(stockOrders)
    .set({
      status: 'closed',
      exitPriceE4,
      exitBasis: basis,
      exitDay: day,
      exitReason: reason,
      closedAt: nowIso(),
    })
    .where(eq(stockOrders.id, orderId))
    .run();
}

/** Scale-out: sells part of a position by splitting it, exactly as the
 * options book does — the sold slice becomes its own closed row so every
 * sum stays exact with no special cases. */
export function reduceStockPosition(
  orderId: string,
  quantity: number,
  priceE4: number,
  basis: 'measured' | 'modelled',
  day: string,
  reason: string,
): string {
  const order = paperDb.select().from(stockOrders).where(eq(stockOrders.id, orderId)).get();
  if (!order) throw new PaperError(`Unknown stock order: ${orderId}`);
  if (order.status === 'closed') throw new PaperError(`Stock order ${orderId} is already closed`);
  if (!(quantity > 0) || quantity >= order.quantity) {
    throw new PaperError(
      `A reduction must leave the position open — selling ${quantity} of ${order.quantity} is a close.`,
    );
  }
  const exitPriceE4 = basis === 'measured' ? priceE4 : haircutE4(priceE4, 'sell');
  const sliceId = newId();
  paperDb.transaction((tx) => {
    tx.insert(stockOrders)
      .values({
        id: sliceId,
        symbol: order.symbol,
        book: order.book,
        quantity,
        initialQuantity: quantity,
        entryPriceE4: order.entryPriceE4,
        entryBasis: order.entryBasis,
        entryDay: order.entryDay,
        entryForecastReturn: order.entryForecastReturn,
        modelRunId: order.modelRunId,
        thesisRef: order.thesisRef,
        sector: order.sector,
        status: 'closed',
        exitPriceE4,
        exitBasis: basis,
        exitDay: day,
        exitReason: reason,
        splitFrom: order.id,
        notes: `Scaled out of ${order.symbol}: ${quantity} of ${order.quantity} shares.`,
        openedAt: order.openedAt,
        closedAt: nowIso(),
      })
      .run();
    tx.update(stockOrders)
      .set({ quantity: order.quantity - quantity })
      .where(eq(stockOrders.id, order.id))
      .run();
  });
  return sliceId;
}

/** One mark per (order, trading day), refreshed in place — same
 * discipline as the options book's intraday marks. */
export function markStockPosition(
  orderId: string,
  day: string,
  markPriceE4: number,
  basis: 'measured' | 'modelled',
): void {
  const order = paperDb.select().from(stockOrders).where(eq(stockOrders.id, orderId)).get();
  if (!order || order.status !== 'open') return;
  const priceE4 = basis === 'measured' ? markPriceE4 : haircutE4(markPriceE4, 'sell');
  const unrealizedPlE4 = Math.round((priceE4 - order.entryPriceE4) * order.quantity);
  const at = nowIso();
  paperDb
    .insert(stockMarks)
    .values({ orderId, asOf: at, tradingDay: day, markPriceE4: priceE4, basis, unrealizedPlE4 })
    .onConflictDoUpdate({
      target: [stockMarks.orderId, stockMarks.tradingDay],
      set: { asOf: at, markPriceE4: priceE4, basis, unrealizedPlE4 },
    })
    .run();
}

export interface StockDecisionRow {
  day: string;
  book: StockBook;
  symbol: string;
  decision: 'opened' | 'rejected' | 'skipped' | 'held' | 'exited' | 'marked' | 'stop_raised';
  reason: string;
  detail?: Record<string, unknown>;
  modelRunId?: string | null;
  panelStance?: string | null;
}

/**
 * Persist a batch of decisions. Never throws into the engine: a logging
 * failure must not cost a trading decision that already happened — the
 * options book learned this the same way, and the rule is worth
 * repeating rather than rediscovering.
 */
export function logStockDecisions(rows: StockDecisionRow[]): void {
  if (rows.length === 0) return;
  const at = nowIso();
  try {
    paperDb.transaction((tx) => {
      // Chunked for SQLite's bound-parameter ceiling — a full rejection
      // list on a wide board runs to hundreds of rows.
      for (let i = 0; i < rows.length; i += 200) {
        tx.insert(stockDecisions)
          .values(
            rows.slice(i, i + 200).map((r) => ({
              day: r.day,
              book: r.book,
              symbol: r.symbol,
              decision: r.decision,
              reason: r.reason,
              detail: r.detail ?? {},
              modelRunId: r.modelRunId ?? null,
              panelStance: r.panelStance ?? null,
              createdAt: at,
            })),
          )
          .run();
      }
    });
  } catch {
    // Deliberately swallowed — see the doc comment.
  }
}

/** Everything the engine decided on a day, newest first. */
export function stockDecisionsForDay(day: string) {
  return paperDb
    .select()
    .from(stockDecisions)
    .where(eq(stockDecisions.day, day))
    .orderBy(desc(stockDecisions.id))
    .all();
}

export function openStockOrders(book?: StockBook) {
  return paperDb
    .select()
    .from(stockOrders)
    .where(book ? and(eq(stockOrders.status, 'open'), eq(stockOrders.book, book)) : eq(stockOrders.status, 'open'))
    .all();
}

export function latestStockMarkByOrder(): Map<string, typeof stockMarks.$inferSelect> {
  const rows = paperDb.select().from(stockMarks).all();
  const byOrder = new Map<string, typeof stockMarks.$inferSelect>();
  for (const row of rows) {
    const existing = byOrder.get(row.orderId);
    if (!existing || row.id > existing.id) byOrder.set(row.orderId, row);
  }
  return byOrder;
}

export interface StockCapacity {
  freeCashE4: number;
  bookCapitalE4: number;
  openCount: number;
  heldSymbols: string[];
  sectorCounts: Record<string, number>;
}

/**
 * What one book can still deploy. Cash is computed from the whole stock
 * account (both books draw on one $50k), while slots and the sector cap
 * are per book — the horizons compete for capital but not for seats.
 */
export function stockCapacity(book: StockBook): StockCapacity {
  const all = paperDb.select().from(stockOrders).all();
  let cashE4 = config.market.stockPaperStartingBalanceE4;
  for (const o of all) {
    cashE4 -= Math.round(o.entryPriceE4 * o.quantity);
    if (o.status === 'closed' && o.exitPriceE4 !== null) {
      cashE4 += Math.round(o.exitPriceE4 * o.quantity);
    }
  }
  const openInBook = all.filter((o) => o.status === 'open' && o.book === book);
  const sectorCounts: Record<string, number> = {};
  for (const o of openInBook) {
    const key = o.sector ?? 'unknown';
    sectorCounts[key] = (sectorCounts[key] ?? 0) + 1;
  }
  const pct =
    book === 'short'
      ? config.market.stockBook.shortAllocationPct
      : 1 - config.market.stockBook.shortAllocationPct;
  return {
    freeCashE4: Math.max(0, cashE4),
    bookCapitalE4: Math.round(config.market.stockPaperStartingBalanceE4 * pct),
    openCount: openInBook.length,
    heldSymbols: openInBook.map((o) => o.symbol),
    sectorCounts,
  };
}

/** Account-level equity for the stock book: cash plus marked positions. */
export function stockEquity(): {
  startingBalanceE4: number;
  cashE4: number;
  positionsValueE4: number;
  totalEquityE4: number;
  realizedPlE4: number;
} {
  const all = paperDb.select().from(stockOrders).all();
  const marks = latestStockMarkByOrder();
  let cashE4 = config.market.stockPaperStartingBalanceE4;
  let realizedPlE4 = 0;
  let positionsValueE4 = 0;
  for (const o of all) {
    cashE4 -= Math.round(o.entryPriceE4 * o.quantity);
    if (o.status === 'closed' && o.exitPriceE4 !== null) {
      cashE4 += Math.round(o.exitPriceE4 * o.quantity);
      realizedPlE4 += Math.round((o.exitPriceE4 - o.entryPriceE4) * o.quantity);
    } else {
      // An unmarked position is carried at cost, not excluded: unlike an
      // option, a share bought this morning has a known, non-decaying
      // value until its first mark, and dropping it would make the
      // account appear to lose the entire position for a day.
      const mark = marks.get(o.id);
      positionsValueE4 += Math.round((mark?.markPriceE4 ?? o.entryPriceE4) * o.quantity);
    }
  }
  return {
    startingBalanceE4: config.market.stockPaperStartingBalanceE4,
    cashE4,
    positionsValueE4,
    totalEquityE4: cashE4 + positionsValueE4,
    realizedPlE4,
  };
}

/** Model entries opened for a book on a day — the daily-cap memory that
 * the options book learned to need after a restart double-spent it. */
export function stockEntriesOpenedOn(day: string, book: StockBook): number {
  return (
    paperDb
      .select({ n: sql<number>`count(*)` })
      .from(stockOrders)
      .where(and(eq(stockOrders.entryDay, day), eq(stockOrders.book, book)))
      .get()?.n ?? 0
  );
}
