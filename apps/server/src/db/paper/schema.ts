import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * Paper trading — a **third** database (`~/.org/market/paper.db`), separate
 * from both `org.db` and `market.db`.
 *
 * The reason is `market:pull`, not tidiness. That script replaces a reader's
 * entire local `market.db` with the runner's latest snapshot — correct for
 * the research corpus, where the runner is the single source of truth, but
 * wrong for a paper trade: a person places one from whichever machine they
 * are looking at the UI on, which is a reader as often as the runner, and a
 * table living inside `market.db` would be silently destroyed by the very
 * next pull. Splitting it into its own file, in the same directory but never
 * touched by that single-file rsync, makes the destruction structurally
 * impossible rather than a rule to remember. `model_runs` in
 * `../market/schema.ts` carries a note explaining why this fix was owed and
 * a pointer back here.
 *
 * One real consequence: `paperOrders.occSymbol` no longer has a
 * database-enforced foreign key into `optionContracts` — SQLite foreign keys
 * only hold within a single file/connection, and the two now live in
 * different ones. Referential integrity here is an application-level
 * guarantee (`paper.ts` looks the contract up and throws if it does not
 * exist) rather than a schema-level one. Same conventions as
 * `../market/schema.ts` otherwise: instants are TEXT UTC ISO-8601, civil
 * days are TEXT `YYYY-MM-DD`, money is E4 (ten-thousandths of a dollar).
 */

/**
 * Simulated positions traded with artificial money.
 *
 * No signal-generating model exists yet — `rank.py` exists but does not yet
 * beat its own baseline (see its module docstring) — so for now an order is
 * placed by calling the API directly rather than by a ranked recommendation.
 * That is a deliberate simplification, not a placeholder architecture: this
 * table looks identical whether a human or a future ranking model opened
 * the trade, distinguished only by `source`, so the ranked board plugs in
 * later without a schema change.
 *
 * **Long only, single leg, for now.** A short option's loss is unbounded and
 * its margin/collateral requirement is a real brokerage mechanic this system
 * does not model — simulating a short paper "P&L" without simulating the
 * capital a broker would actually hold against it would understate risk in
 * exactly the way this whole project exists to avoid. `side` is modelled
 * for the column to extend cleanly later; the API rejects `short` until that
 * modelling exists.
 *
 * An order **is** the position record — there is no separate positions
 * table. Paper trading has no partial fills and no order book; a row here
 * moves directly from `open` to `closed`, and that lifecycle is the entire
 * state that matters.
 */
export const paperOrders = sqliteTable(
  'paper_orders',
  {
    id: text('id').primaryKey(),
    /** No FK — see the module docstring. Validated at write time instead. */
    occSymbol: text('occ_symbol').notNull(),
    side: text('side', { enum: ['long', 'short'] }).notNull().default('long'),
    quantity: integer('quantity').notNull(),
    /** Per-contract entry price, E4. The ask for a long — what it actually cost. */
    entryPriceE4: integer('entry_price_e4').notNull(),
    /** Whether entryPriceE4 came from a real quote or was estimated. */
    entryBasis: text('entry_basis', { enum: ['measured', 'modelled'] }).notNull(),
    status: text('status', { enum: ['open', 'closed'] }).notNull().default('open'),
    /** Per-contract exit price, E4. The bid for a long — what it would actually fetch. */
    exitPriceE4: integer('exit_price_e4'),
    exitBasis: text('exit_basis', { enum: ['measured', 'modelled'] }),
    /** 'manual' today; 'model' once a ranked signal can place its own orders. */
    source: text('source', { enum: ['manual', 'model'] }).notNull().default('manual'),
    notes: text('notes'),
    openedAt: text('opened_at').notNull(),
    closedAt: text('closed_at'),
  },
  (t) => [
    index('paper_orders_status_idx').on(t.status),
    index('paper_orders_occ_idx').on(t.occSymbol),
  ],
);

/**
 * Nightly mark-to-market for every open order.
 *
 * Marked at the **conservative** side — bid for a long, ask for a short —
 * because that is the price actually available if the position were closed
 * right now, not the mid a broker's ticket screen likes to show. `basis`
 * carries forward the same honesty the liquidity gate enforces elsewhere:
 * with no bid/ask entitlement on the current data plan, a mark falls back to
 * the contract's last trade or close, and that fact travels with the number
 * rather than being silently forgotten once it is stored.
 */
export const paperMarks = sqliteTable(
  'paper_marks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    orderId: text('order_id')
      .notNull()
      .references(() => paperOrders.id, { onDelete: 'cascade' }),
    asOf: text('as_of').notNull(),
    tradingDay: text('trading_day').notNull(),
    markPriceE4: integer('mark_price_e4').notNull(),
    basis: text('basis', { enum: ['measured', 'modelled'] }).notNull(),
    unrealizedPlE4: integer('unrealized_pl_e4').notNull(),
  },
  (t) => [
    uniqueIndex('paper_marks_order_day_uq').on(t.orderId, t.tradingDay),
    index('paper_marks_day_idx').on(t.tradingDay),
  ],
);

/**
 * One row per trading day: the account-level equity curve.
 *
 * Carries **both** a per-trade and an account-level view of return, because
 * they answer different questions and "5% a day" was ambiguous about which
 * one was meant. A trade risking 2% of the account that returns 5% on its
 * own capital is a 0.1% day for the account — reporting only one of these
 * numbers would hide that distinction rather than resolve it.
 */
export const paperEquity = sqliteTable(
  'paper_equity',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    day: text('day').notNull(),
    cashE4: integer('cash_e4').notNull(),
    openPositionsValueE4: integer('open_positions_value_e4').notNull(),
    totalEquityE4: integer('total_equity_e4').notNull(),
    realizedPlToDateE4: integer('realized_pl_to_date_e4').notNull(),
    /** Account-level: total equity change since the prior trading day. */
    dayReturnPct: real('day_return_pct'),
    cumulativeReturnPct: real('cumulative_return_pct').notNull(),
  },
  (t) => [uniqueIndex('paper_equity_day_uq').on(t.day)],
);
