import { and, count, desc, eq, lte, sql } from 'drizzle-orm';
import { config } from '../config.js';
import { marketDb } from '../db/market/index.js';
import { optionContracts, optionQuotes } from '../db/market/schema.js';
import { paperDb } from '../db/paper/index.js';
import { paperDecisionLog, paperEquity, paperMarks, paperOrders } from '../db/paper/schema.js';
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

/**
 * The modelled-fill haircut — see PAPER_SPREAD_HAIRCUT_PCT in config.ts.
 * A print is where two *other* people met; the price offered to us sits a
 * half-spread away, against us on both sides. Applied exactly once, at
 * the accounting boundary (open, close, reduce, mark), and only to
 * modelled prices — a real measured bid or ask is already the touchable
 * number.
 */
export function haircutE4(
  printE4: number,
  side: 'buy' | 'sell',
  pct: number = config.market.spreadHaircutPct,
  minE4: number = config.market.spreadHaircutMinE4,
): number {
  const h = Math.max(Math.round(printE4 * pct), minE4);
  return side === 'buy' ? printE4 + h : Math.max(0, printE4 - h);
}

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
  /**
   * The exit plan for an auto-managed position, written in the same insert
   * as the order itself.
   *
   * Passed here rather than `UPDATE`d in immediately afterwards on
   * purpose: a crash between the two statements used to leave a
   * `source: 'model'` order with no target, which `managedOpenOrders()`
   * then filters out forever — an open position the exit engine can never
   * see. One insert makes that state unrepresentable rather than merely
   * unlikely. Omitted for a manual order, which has no automated exit.
   */
  exitPlan?: {
    targetExitPriceE4: number;
    stopLossPriceE4: number;
    targetExitDate: string;
  };
  /**
   * The ranked signal's expected value at the moment this order opened —
   * the reference point the exit engine compares against to detect a sign
   * flip. Separate from `exitPlan` because it describes the entry, not the
   * exit: a caller can know the EV it acted on without having a
   * deterministic exit plan to go with it.
   */
  entryEv?: number;
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

  // Validates the contract exists, and captures both facts we denormalize
  // onto the order so no later caller has to re-resolve them.
  const { underlying, multiplier } = contractMultiplier(input.occSymbol);

  let entryPriceE4: number;
  let entryBasis: 'measured' | 'modelled';
  if (input.entryPriceE4 !== undefined) {
    if (!(input.entryPriceE4 > 0)) throw new PaperError('entryPriceE4 must be positive');
    // An explicit price is a print, not an offer — a real buyer pays the
    // ask side of it. See haircutE4.
    entryPriceE4 = haircutE4(input.entryPriceE4, 'buy');
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
      multiplier,
      side: 'long',
      quantity: input.quantity,
      initialQuantity: input.quantity,
      entryPriceE4,
      entryBasis,
      status: 'open',
      source: input.source ?? 'manual',
      notes: input.notes ?? null,
      targetExitPriceE4: input.exitPlan?.targetExitPriceE4 ?? null,
      stopLossPriceE4: input.exitPlan?.stopLossPriceE4 ?? null,
      targetExitDate: input.exitPlan?.targetExitDate ?? null,
      entryEv: input.entryEv ?? null,
      exitUpdatedAt: input.exitPlan ? nowIso() : null,
      openedAt: nowIso(),
    })
    .run();
  return id;
}

export interface CloseOrderInput {
  orderId: string;
  exitPriceE4?: number;
}

export interface ReduceOrderInput {
  orderId: string;
  /** Contracts to sell — must leave at least one open. */
  contracts: number;
  exitPriceE4: number;
}

/**
 * Scale-out: sells part of an open position by **splitting the order** —
 * the sold contracts become their own closed row (same entry, real exit,
 * `splitFrom` lineage) and the original keeps its id, stops, target, and
 * history with a reduced quantity. The split is what keeps every existing
 * sum honest with zero changes: realized P&L is the closed slice, open
 * exposure is the surviving row, and cash arithmetic
 * (entries out, exits in, over all rows) never sees a special case.
 */
export function reduceOrder(input: ReduceOrderInput): string {
  const order = paperDb.select().from(paperOrders).where(eq(paperOrders.id, input.orderId)).get();
  if (!order) throw new PaperError(`Unknown order: ${input.orderId}`);
  if (order.status === 'closed') throw new PaperError(`Order ${input.orderId} is already closed`);
  if (!Number.isInteger(input.contracts) || input.contracts <= 0) {
    throw new PaperError(`contracts must be a positive integer, got ${input.contracts}`);
  }
  if (input.contracts >= order.quantity) {
    throw new PaperError(
      `A reduction must leave the position open — selling ${input.contracts} of ` +
        `${order.quantity} is a close; use closeOrder.`,
    );
  }
  if (!(input.exitPriceE4 >= 0)) throw new PaperError('exitPriceE4 must not be negative');
  // Same sell-side haircut as closeOrder — a scale-out is a sale.
  const exitPriceE4 = haircutE4(input.exitPriceE4, 'sell');

  const sliceId = newId();
  paperDb.transaction((tx) => {
    tx.insert(paperOrders)
      .values({
        id: sliceId,
        occSymbol: order.occSymbol,
        underlying: order.underlying,
        multiplier: order.multiplier,
        side: order.side,
        quantity: input.contracts,
        initialQuantity: input.contracts,
        splitFrom: order.id,
        entryPriceE4: order.entryPriceE4,
        entryBasis: order.entryBasis,
        status: 'closed',
        exitPriceE4,
        exitBasis: 'modelled',
        source: order.source,
        notes: `Scaled out of ${order.occSymbol}: ${input.contracts} of ${order.quantity} sold at the milestone.`,
        openedAt: order.openedAt,
        closedAt: nowIso(),
      })
      .run();
    tx.update(paperOrders)
      .set({ quantity: order.quantity - input.contracts })
      .where(eq(paperOrders.id, order.id))
      .run();
  });
  return sliceId;
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
    // A seller fetches the bid side of the print — see haircutE4.
    exitPriceE4 = haircutE4(input.exitPriceE4, 'sell');
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

export interface AccountCapacity {
  /** Uncommitted cash, E4 — the same figure `computeDailyEquity` calls cash. */
  freeCashE4: number;
  openPositionCount: number;
  heldUnderlyings: string[];
}

/**
 * Shares per contract for an order, without depending on the contract row
 * still existing.
 *
 * Prefers the value denormalized onto the order at open time; falls back
 * to a live lookup only for rows written before that column existed, and
 * to the standard 100 if even that is gone. A pruned or expired contract
 * must never make an *open* position unvaluable — that is precisely when
 * its cost still matters. Same reasoning as `paperOrders.underlying`.
 */
function orderMultiplier(order: typeof paperOrders.$inferSelect): number {
  if (order.multiplier !== null) return order.multiplier;
  try {
    return contractMultiplier(order.occSymbol).multiplier;
  } catch {
    return 100;
  }
}

/**
 * The underlying an order is exposure to — resolved, never skipped.
 *
 * This exists because the obvious version of it caused a real duplicate.
 * `heldUnderlyings` was built with `if (o.underlying)`, so a row whose
 * denormalized column was null — every order written before that column
 * existed — silently vanished from the held set, and auto-entry read the
 * absence as "not held". On 2026-08-24 it opened a second SNDK position
 * on top of an Aug-19 one that was still open, doubling exposure to a
 * single forecast. The comment on that code called the null case "a
 * one-time gap that closes as those orders close"; those orders never
 * closed, so the gap stayed open until it fired.
 *
 * A null must therefore never mean "no underlying". Falling back to the
 * live contract row recovers the real symbol (including dotted ones like
 * BRK.B, which the OCC root spells BRKB and cannot be inverted back). If
 * even that is gone — pruned or expired — the OCC root is still a better
 * answer than nothing: it will miss a dotted name, but it cannot invent
 * an absence of exposure that isn't real.
 */
function orderUnderlying(order: typeof paperOrders.$inferSelect): string {
  if (order.underlying !== null) return order.underlying;
  try {
    return contractMultiplier(order.occSymbol).underlying;
  } catch {
    return occRoot(order.occSymbol);
  }
}

/** The 6-character, space-padded root an OCC symbol starts with. */
function occRoot(occSymbol: string): string {
  return occSymbol.slice(0, 6).trim();
}

/**
 * What the account can actually still deploy right now — the input
 * auto-entry's capital constraint is computed from.
 *
 * Cash follows `computeDailyEquity`'s definition exactly: every order's
 * entry cost leaves the account, and a closed order's exit proceeds come
 * back. Both halves matter — counting only open positions would ignore
 * realized losses entirely and report a full balance for an account that
 * has actually spent half of it, which is the one direction this number
 * must never be wrong in.
 *
 * Positions are valued at **entry cost**, not current mark: an open
 * position's unrealized gain isn't spendable until it closes. Conservative
 * in the same direction as the rest of this module (marks use the bid,
 * fills use the ask).
 */
export function accountCapacity(): AccountCapacity {
  const all = paperDb.select().from(paperOrders).all();
  let cashE4 = config.market.paperStartingBalanceE4;
  let openPositionCount = 0;
  const heldUnderlyings = new Set<string>();

  for (const o of all) {
    const multiplier = orderMultiplier(o);
    cashE4 -= o.entryPriceE4 * o.quantity * multiplier;
    if (o.status === 'closed' && o.exitPriceE4 !== null) {
      cashE4 += o.exitPriceE4 * o.quantity * multiplier;
    } else {
      openPositionCount += 1;
      heldUnderlyings.add(orderUnderlying(o));
    }
  }

  return {
    freeCashE4: Math.max(0, cashE4),
    openPositionCount,
    heldUnderlyings: [...heldUnderlyings],
  };
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
/**
 * One mark row from the exit engine's recheck price — the same fields the
 * nightly job writes, at intraday cadence. Exists because the book's
 * numbers otherwise stand still all session: the engine fetches a fresh
 * price for every open position every 15 minutes, evaluated it, and threw
 * it away, while the cards and equity showed last night's close until the
 * next morning. Skips the write when the price hasn't moved since the
 * last mark, and refreshes the day's single row in place (the table is
 * unique per order and day), so intraday marking adds no rows at all —
 * the day's row just stays current.
 */
export function recordIntradayMark(
  orderId: string,
  tradingDay: string,
  markPriceE4: number,
  basis: 'measured' | 'modelled',
): void {
  const order = paperDb.select().from(paperOrders).where(eq(paperOrders.id, orderId)).get();
  if (!order || order.status !== 'open') return;
  if (basis === 'modelled') markPriceE4 = haircutE4(markPriceE4, 'sell');
  const last = paperDb
    .select()
    .from(paperMarks)
    .where(eq(paperMarks.orderId, orderId))
    .orderBy(desc(paperMarks.id))
    .limit(1)
    .get();
  if (last && last.markPriceE4 === markPriceE4) return;

  const { multiplier } = contractMultiplier(order.occSymbol);
  const unrealizedPlE4 = (markPriceE4 - order.entryPriceE4) * order.quantity * multiplier;
  // One row per (order, day) — the table's own uniqueness. Intraday
  // passes refresh the day's row in place; the day's final update is the
  // session close, which is exactly what a daily mark should settle at.
  paperDb
    .insert(paperMarks)
    .values({ orderId, asOf: nowIso(), tradingDay, markPriceE4, basis, unrealizedPlE4 })
    .onConflictDoUpdate({
      target: [paperMarks.orderId, paperMarks.tradingDay],
      set: { asOf: nowIso(), markPriceE4, basis, unrealizedPlE4 },
    })
    .run();
}

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
      // Valued at what a sale would fetch, not at the print — see
      // haircutE4. The measured-bid branch above needs no adjustment: a
      // bid IS the touchable number.
      markPriceE4 = haircutE4(quote.closeE4, 'sell');
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
      // id as the tiebreak: the intraday engine now appends marks during
      // the session, so one trading day can hold several rows per order
      // and "the latest write" must be deterministic, not whichever row
      // the storage engine surfaces first.
      .orderBy(desc(paperMarks.tradingDay), desc(paperMarks.id))
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


/**
 * Append decisions to `paper_decision_log`.
 *
 * Batched in one statement because auto-entry produces one row per
 * candidate considered — a few hundred a day — and a per-row insert on a
 * cron path is a needless few hundred round trips.
 *
 * Deliberately never throws. A decision log that can take down the run it
 * is describing is worse than no decision log: the whole point is to make
 * a failed or surprising run explicable, and a logger that turns a partial
 * failure into a total one destroys exactly the evidence it exists to
 * keep. Callers get `false` and carry on.
 */
export function logDecisions(rows: Array<Omit<typeof paperDecisionLog.$inferInsert, 'createdAt'>>): boolean {
  if (rows.length === 0) return true;
  const createdAt = nowIso();
  let ok = true;
  // Chunked, because a multi-row INSERT binds 8 parameters per row and
  // SQLite caps a statement at 32,766 of them — 4,096 rows throws `too
  // many SQL variables` (verified against this project's SQLite 3.53.4).
  // Auto-entry logs at most `top` candidates, currently 400, so today it
  // is nowhere near; but `top` is a tunable request field and the universe
  // is meant to grow, and crossing the limit with a single statement would
  // lose the *whole* run's decisions rather than some of them — hardest to
  // notice on exactly the biggest and most interesting day.
  for (let i = 0; i < rows.length; i += DECISION_BATCH_SIZE) {
    const chunk = rows.slice(i, i + DECISION_BATCH_SIZE);
    try {
      paperDb.insert(paperDecisionLog).values(chunk.map((r) => ({ ...r, createdAt }))).run();
    } catch {
      // One bad chunk must not cost the rest: a partial log beats none.
      ok = false;
    }
  }
  return ok;
}

/** Rows per INSERT. 8 bound columns against SQLite's 32,766-parameter
 * ceiling leaves 4,095; 1,000 keeps a wide margin and still batches. */
const DECISION_BATCH_SIZE = 1_000;

/** Decisions for one trading day, newest first — what the UI and any
 * "why didn't it buy X" question read. */
/**
 * How many model entries this trading day has already opened, across every
 * invocation. Counted from the decision log — the audit trail every entry
 * run writes — rather than from order `openedAt` timestamps, because the
 * operating trading day and the wall-clock date routinely differ (a reader
 * opens day N's positions at 04:30 on day N+1). Exists because a server
 * restart re-fired the entry job for a day that had already spent its
 * slots, and the per-invocation cap happily allocated a second full risk
 * budget — see `select_entries` in rank.py, which subtracts this.
 */
export function modelEntriesOpenedOn(day: string): number {
  const row = paperDb
    .select({ n: count() })
    .from(paperDecisionLog)
    .where(and(eq(paperDecisionLog.day, day), eq(paperDecisionLog.decision, 'opened')))
    .get();
  return row?.n ?? 0;
}

/**
 * The latest stored mark per order. The account-level equity curve is
 * built from these rows nightly, but until this existed nothing handed
 * them back per position — the UI's per-trade return fell back to
 * "exit price, or entry" and every open position read +0.00% while the
 * account showed thousands of unrealized P&L from the very same marks.
 */
export function latestMarkByOrder(): Map<string, typeof paperMarks.$inferSelect> {
  const rows = paperDb.select().from(paperMarks).all();
  const byOrder = new Map<string, typeof paperMarks.$inferSelect>();
  for (const row of rows) {
    const existing = byOrder.get(row.orderId);
    if (!existing || row.id > existing.id) byOrder.set(row.orderId, row);
  }
  return byOrder;
}

export function decisionsForDay(day: string): Array<typeof paperDecisionLog.$inferSelect> {
  return paperDb
    .select()
    .from(paperDecisionLog)
    .where(eq(paperDecisionLog.day, day))
    .orderBy(desc(paperDecisionLog.id))
    .all();
}
