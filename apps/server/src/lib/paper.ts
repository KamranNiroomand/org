import { and, desc, eq, lte, sql } from 'drizzle-orm';
import { config } from '../config.js';
import { marketDb } from '../db/market/index.js';
import { optionContracts, optionQuotes } from '../db/market/schema.js';
import { paperDb } from '../db/paper/index.js';
import { paperEquity, paperMarks, paperOrders } from '../db/paper/schema.js';
import { newId, nowIso } from './util.js';

/**
 * Paper trading with artificial money.
 *
 * An order's `source` distinguishes one opened by hand from one opened from
 * the ranked signal board, without a schema change between the two — see
 * `OpenOrderInput.source`. Every dollar here is imaginary: nothing in this
 * module places a real order, touches a real account, or could.
 *
 * **Long only.** A short option's loss is unbounded and its margin
 * requirement is a real brokerage mechanic this module does not simulate;
 * pretending to track short P&L without tracking the capital a broker would
 * hold against it would understate risk in exactly the way this whole
 * project exists to avoid.
 */

export class PaperError extends Error {}

export function contractMultiplier(occSymbol: string): { multiplier: number; underlying: string } {
  const row = marketDb
    .select({ multiplier: optionContracts.multiplier, underlying: optionContracts.underlying })
    .from(optionContracts)
    .where(eq(optionContracts.occSymbol, occSymbol))
    .get();
  if (!row) throw new PaperError(`Unknown contract: ${occSymbol}`);
  return row;
}

/** The most recent captured quote for a contract, on or before `asOfDay`. */
function latestQuote(occSymbol: string, asOfDay: string) {
  return marketDb
    .select()
    .from(optionQuotes)
    .where(and(eq(optionQuotes.occSymbol, occSymbol), lte(optionQuotes.tradingDay, asOfDay)))
    .orderBy(desc(optionQuotes.tradingDay))
    .limit(1)
    .get();
}

export interface OpenOrderInput {
  occSymbol: string;
  quantity: number;
  side?: 'long' | 'short';
  /** Overrides the auto-fetched ask. Required until real quotes exist to fetch. */
  entryPriceE4?: number;
  notes?: string;
  /** Which UI opened this — a manual typed entry, or one click off the ranked board. */
  source?: 'manual' | 'model';
}

/**
 * Opens a paper position.
 *
 * Fills at the **ask** — what a long actually costs — either the caller's
 * explicit price (marked `modelled`, since a human typed it rather than the
 * market quoting it) or the latest captured quote's ask (marked `measured`
 * when a real one exists). Before capture has produced any quotes, or before
 * a plan with a quote entitlement exists at all, `entryPriceE4` is required —
 * there is nothing to look up yet.
 */
export function openOrder(input: OpenOrderInput): string {
  if (input.side === 'short') {
    throw new PaperError(
      'Short positions are not modelled yet — margin and collateral requirements ' +
        'are a real brokerage mechanic this system does not simulate.',
    );
  }
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    throw new PaperError(`quantity must be a positive integer, got ${input.quantity}`);
  }

  const { underlying } = contractMultiplier(input.occSymbol); // validates the contract exists

  let entryPriceE4: number;
  let entryBasis: 'measured' | 'modelled';
  if (input.entryPriceE4 !== undefined) {
    if (!(input.entryPriceE4 > 0)) throw new PaperError('entryPriceE4 must be positive');
    entryPriceE4 = input.entryPriceE4;
    entryBasis = 'modelled';
  } else {
    const today = new Date().toISOString().slice(0, 10);
    const quote = latestQuote(input.occSymbol, today);
    if (!quote || quote.askE4 === null || quote.askE4 <= 0) {
      throw new PaperError(
        `No usable ask for ${input.occSymbol} — pass entryPriceE4 explicitly ` +
          `until a real quote exists for this contract.`,
      );
    }
    entryPriceE4 = quote.askE4;
    entryBasis = 'measured';
  }

  const id = newId();
  paperDb
    .insert(paperOrders)
    .values({
      id,
      occSymbol: input.occSymbol,
      underlying,
      side: 'long',
      quantity: input.quantity,
      entryPriceE4,
      entryBasis,
      status: 'open',
      source: input.source ?? 'manual',
      notes: input.notes ?? null,
      openedAt: nowIso(),
    })
    .run();
  return id;
}

export interface CloseOrderInput {
  orderId: string;
  exitPriceE4?: number;
}

/** Closes an open position, at the **bid** — what it would actually fetch. */
export function closeOrder(input: CloseOrderInput): void {
  const order = paperDb.select().from(paperOrders).where(eq(paperOrders.id, input.orderId)).get();
  if (!order) throw new PaperError(`Unknown order: ${input.orderId}`);
  if (order.status === 'closed') throw new PaperError(`Order ${input.orderId} is already closed`);

  let exitPriceE4: number;
  let exitBasis: 'measured' | 'modelled';
  if (input.exitPriceE4 !== undefined) {
    if (!(input.exitPriceE4 >= 0)) throw new PaperError('exitPriceE4 must not be negative');
    exitPriceE4 = input.exitPriceE4;
    exitBasis = 'modelled';
  } else {
    const today = new Date().toISOString().slice(0, 10);
    const quote = latestQuote(order.occSymbol, today);
    if (!quote || quote.bidE4 === null) {
      throw new PaperError(
        `No usable bid for ${order.occSymbol} — pass exitPriceE4 explicitly.`,
      );
    }
    exitPriceE4 = quote.bidE4; // zero is a legitimate bid: worthless at expiry.
    exitBasis = 'measured';
  }

  paperDb
    .update(paperOrders)
    .set({ status: 'closed', exitPriceE4, exitBasis, closedAt: nowIso() })
    .where(eq(paperOrders.id, input.orderId))
    .run();
}

/** `(exit-or-mark - entry) / entry` — the per-trade view of return. */
export function tradeReturnPct(entryPriceE4: number, currentPriceE4: number): number {
  if (entryPriceE4 <= 0) throw new PaperError('entryPriceE4 must be positive');
  return ((currentPriceE4 - entryPriceE4) / entryPriceE4) * 100;
}

export interface MarkResult {
  tradingDay: string;
  marked: number;
  skipped: Array<{ occSymbol: string; reason: string }>;
}

/**
 * Marks every open position to market, at the conservative side.
 *
 * Skips a position rather than guessing when no quote and no fallback price
 * exist for it — an absent mark is honest; a fabricated one is not, and
 * would silently corrupt the equity curve it feeds.
 */
export function markOpenPositions(tradingDay: string): MarkResult {
  const open = paperDb.select().from(paperOrders).where(eq(paperOrders.status, 'open')).all();
  const result: MarkResult = { tradingDay, marked: 0, skipped: [] };

  for (const order of open) {
    const quote = latestQuote(order.occSymbol, tradingDay);
    let markPriceE4: number | null = null;
    let basis: 'measured' | 'modelled' = 'modelled';

    if (quote?.bidE4 !== undefined && quote?.bidE4 !== null) {
      markPriceE4 = quote.bidE4;
      basis = 'measured';
    } else if (quote?.closeE4 !== undefined && quote?.closeE4 !== null) {
      // No quote entitlement, or a real-but-empty bid: fall back to the
      // contract's own last traded price. A traded price, not a touchable
      // one — see gate.ts — so this is recorded as modelled, not measured.
      markPriceE4 = quote.closeE4;
      basis = 'modelled';
    }

    if (markPriceE4 === null) {
      result.skipped.push({ occSymbol: order.occSymbol, reason: 'no quote or close available yet' });
      continue;
    }

    const { multiplier } = contractMultiplier(order.occSymbol);
    const unrealizedPlE4 = (markPriceE4 - order.entryPriceE4) * order.quantity * multiplier;

    paperDb
      .insert(paperMarks)
      .values({
        orderId: order.id,
        asOf: nowIso(),
        tradingDay,
        markPriceE4,
        basis,
        unrealizedPlE4,
      })
      .onConflictDoUpdate({
        target: [paperMarks.orderId, paperMarks.tradingDay],
        set: { markPriceE4: sql`excluded.mark_price_e4`, basis: sql`excluded.basis`, unrealizedPlE4: sql`excluded.unrealized_pl_e4` },
      })
      .run();
    result.marked += 1;
  }

  return result;
}

/**
 * Rolls marks and closed trades into one day's account-level equity.
 *
 * `totalEquity` satisfies `startingBalance + realizedPl + unrealizedPl` by
 * construction — cash falls by an entry cost the moment a position opens and
 * rises by an exit proceed the moment it closes, regardless of when that
 * happened relative to `day`, so the identity holds on every day this is
 * called for, not only at inception. Tested directly rather than assumed.
 */
export function computeDailyEquity(day: string): void {
  const allOrders = paperDb.select().from(paperOrders).where(lte(paperOrders.openedAt, `${day}T23:59:59.999Z`)).all();

  let cashE4 = config.market.paperStartingBalanceE4;
  let realizedPlToDateE4 = 0;
  for (const o of allOrders) {
    const { multiplier } = contractMultiplier(o.occSymbol);
    cashE4 -= o.entryPriceE4 * o.quantity * multiplier;
    if (o.status === 'closed' && o.exitPriceE4 !== null && (!o.closedAt || o.closedAt <= `${day}T23:59:59.999Z`)) {
      cashE4 += o.exitPriceE4 * o.quantity * multiplier;
      realizedPlToDateE4 += (o.exitPriceE4 - o.entryPriceE4) * o.quantity * multiplier;
    }
  }

  const openOnDay = allOrders.filter(
    (o) => o.status === 'open' || !o.closedAt || o.closedAt > `${day}T23:59:59.999Z`,
  );
  let openPositionsValueE4 = 0;
  for (const o of openOnDay) {
    const mark = paperDb
      .select()
      .from(paperMarks)
      .where(and(eq(paperMarks.orderId, o.id), lte(paperMarks.tradingDay, day)))
      .orderBy(desc(paperMarks.tradingDay))
      .limit(1)
      .get();
    if (!mark) continue; // unmarked yet — excluded rather than valued at cost, which would hide P&L.
    const { multiplier } = contractMultiplier(o.occSymbol);
    openPositionsValueE4 += mark.markPriceE4 * o.quantity * multiplier;
  }

  const totalEquityE4 = cashE4 + openPositionsValueE4;
  const cumulativeReturnPct =
    ((totalEquityE4 - config.market.paperStartingBalanceE4) / config.market.paperStartingBalanceE4) * 100;

  const prior = paperDb
    .select({ totalEquityE4: paperEquity.totalEquityE4 })
    .from(paperEquity)
    .where(sql`${paperEquity.day} < ${day}`)
    .orderBy(desc(paperEquity.day))
    .limit(1)
    .get();
  const dayReturnPct = prior ? ((totalEquityE4 - prior.totalEquityE4) / prior.totalEquityE4) * 100 : null;

  paperDb
    .insert(paperEquity)
    .values({ day, cashE4, openPositionsValueE4, totalEquityE4, realizedPlToDateE4, dayReturnPct, cumulativeReturnPct })
    .onConflictDoUpdate({
      target: paperEquity.day,
      set: {
        cashE4: sql`excluded.cash_e4`,
        openPositionsValueE4: sql`excluded.open_positions_value_e4`,
        totalEquityE4: sql`excluded.total_equity_e4`,
        realizedPlToDateE4: sql`excluded.realized_pl_to_date_e4`,
        dayReturnPct: sql`excluded.day_return_pct`,
        cumulativeReturnPct: sql`excluded.cumulative_return_pct`,
      },
    })
    .run();
}
