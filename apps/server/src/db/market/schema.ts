import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * Market research data — option chains, bars, rates, corporate events.
 *
 * This is a **second database** (`~/.org/market.db`), separate from `org.db`.
 * The personal database is 2.3 MB of bank transactions with a backup script
 * over it; chains add one to two gigabytes a year. Keeping them apart means
 * backups stay fast, bulk inserts don't hammer the WAL that the UI reads
 * through, and market data can be dropped and re-backfilled without ever
 * putting financial records near a destructive operation.
 *
 * Conventions, following `../schema.ts` with one deliberate departure:
 *
 * - Instants are TEXT UTC ISO-8601; civil days are TEXT `YYYY-MM-DD`.
 * - **Money is integer ten-thousandths of a dollar (`E4`), not cents.** Cents
 *   are one digit too coarse for options: a contract quoted `$0.01 / $0.02`
 *   has a mid of `$0.015`, and rounding that to a cent turns a 67%-wide spread
 *   into either 0% or 100%. The `@org/shared` option helpers use the same unit.
 * - Greeks and rates are REAL — they are genuinely fractional, like
 *   `holdings.quantity` in the personal schema.
 */

const now = () => text('created_at').notNull();

// ---------------------------------------------------------------------------
// Universe
// ---------------------------------------------------------------------------

/**
 * Which underlyings we capture chains for.
 *
 * A table rather than a constant so widening the universe is a row insert, not
 * a migration and redeploy. `tier` separates the two jobs the universe does:
 * `core` names are where trades are actually considered, `research` names add
 * cross-sectional breadth for training. The model learns from both; the ranked
 * board only ever proposes contracts that also clear the per-contract
 * liquidity gate, which is a stricter and separate test.
 */
export const trackedUnderlyings = sqliteTable(
  'tracked_underlyings',
  {
    symbol: text('symbol').primaryKey(),
    name: text('name').notNull(),
    sector: text('sector'),
    tier: text('tier', { enum: ['core', 'research'] })
      .notNull()
      .default('research'),
    /** Soft delete: history stays joinable after a name leaves the universe. */
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    addedAt: now(),
  },
  (t) => [index('tracked_tier_idx').on(t.tier, t.active)],
);

// ---------------------------------------------------------------------------
// Option contracts and quotes
// ---------------------------------------------------------------------------

/**
 * Contract identity, one row per contract ever seen. Separated from quotes so
 * the 25-million-row quote table stores a symbol rather than repeating strike,
 * expiry and type on every snapshot.
 */
export const optionContracts = sqliteTable(
  'option_contracts',
  {
    /** Canonical 21-character OCC symbol, e.g. `NVDA  260819C00227500`. */
    occSymbol: text('occ_symbol').primaryKey(),
    underlying: text('underlying').notNull(),
    /** Civil expiry date. */
    expiry: text('expiry').notNull(),
    type: text('type', { enum: ['call', 'put'] }).notNull(),
    /** Strike in E4. `$227.50` is `2275000`. */
    strikeE4: integer('strike_e4').notNull(),
    /** Shares per contract. 100 except after odd corporate actions. */
    multiplier: integer('multiplier').notNull().default(100),
    firstSeenAt: text('first_seen_at').notNull(),
    lastSeenAt: text('last_seen_at').notNull(),
  },
  (t) => [
    index('contracts_underlying_idx').on(t.underlying, t.expiry),
    index('contracts_expiry_idx').on(t.expiry),
  ],
);

/**
 * The append-only core of the whole system: one row per contract per snapshot.
 *
 * Never updated, never deleted. Features are recomputable from this table at
 * any time; a past day's true bid and ask cannot be re-fetched at any price.
 * That asymmetry is why this is the one table with no retention policy.
 *
 * The primary key is an INTEGER rowid alias rather than the UUID the personal
 * schema uses. At a hundred thousand rows a night a 36-byte text key would
 * cost more in index storage than the rest of the row, and nothing outside
 * this database ever references a quote by id.
 */
export const optionQuotes = sqliteTable(
  'option_quotes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    occSymbol: text('occ_symbol')
      .notNull()
      .references(() => optionContracts.occSymbol, { onDelete: 'cascade' }),
    /** Instant the snapshot was taken. */
    asOf: text('as_of').notNull(),
    /**
     * Civil trading day, denormalized from `asOf`. Every join to bars, labels
     * and corporate events is by day, and deriving it in SQL on 25 million
     * rows is the difference between an index scan and a table scan.
     */
    tradingDay: text('trading_day').notNull(),

    /**
     * Bid and ask, **nullable on purpose**.
     *
     * Null means "we were not entitled to see a quote"; zero means "there was
     * no bid" — nobody willing to buy at any price. Those are entirely
     * different facts and collapsing them would be the exact class of silent
     * error this schema exists to prevent: a null stored as zero makes every
     * contract look unsellable, and a zero stored as null makes an untradeable
     * contract look merely unobserved.
     *
     * The current data plan (Massive Options Starter) serves no quotes at all,
     * so these are null throughout until a quote source is added. Everything
     * downstream must treat null as "execution cost is modelled, not
     * measured", and say so wherever a result is reported.
     */
    bidE4: integer('bid_e4'),
    askE4: integer('ask_e4'),
    lastE4: integer('last_e4'),
    /**
     * The contract's own daily close, from trade aggregates. This is what we
     * actually have without a quote entitlement — a traded price rather than a
     * touchable one, and never a substitute for a mid.
     */
    closeE4: integer('close_e4'),
    volume: integer('volume').notNull().default(0),
    openInterest: integer('open_interest').notNull().default(0),
    /** Underlying price at the same instant — needed to reprice historically. */
    underlyingE4: integer('underlying_e4').notNull(),

    /**
     * Implied vol in basis points (3160 = 31.60%), computed by us rather than
     * taken from the vendor, so historical and live rows are produced by one
     * model and stay comparable.
     *
     * Null means the solver found no solution — which is the honest answer for
     * a contract quoted `$0.00 / $0.01`, where any vol between 100% and 900%
     * reprices to a penny. A vendor would have printed 435.84% here; storing
     * null keeps that non-information out of the features.
     */
    ivBps: integer('iv_bps'),
    delta: real('delta'),
    gamma: real('gamma'),
    vega: real('vega'),
    theta: real('theta'),

    /**
     * The liquidity gate's verdict, computed once at capture so the ranked
     * board and the backtest cannot disagree about what was tradeable.
     * `gateReasons` keeps the failing rules for diagnostics and for the UI to
     * explain an absence.
     */
    liquid: integer('liquid', { mode: 'boolean' }).notNull().default(false),
    gateReasons: text('gate_reasons', { mode: 'json' }).$type<string[]>().notNull().default([]),
  },
  (t) => [
    // Makes re-running a capture idempotent rather than duplicating a day.
    uniqueIndex('quotes_contract_asof_uq').on(t.occSymbol, t.asOf),
    index('quotes_day_idx').on(t.tradingDay),
    // The feature builder's hot path: every liquid row for one day.
    index('quotes_day_liquid_idx').on(t.tradingDay, t.liquid),
  ],
);

// ---------------------------------------------------------------------------
// Underlying time series
// ---------------------------------------------------------------------------

/**
 * Daily OHLCV for every tracked underlying. Required for realized volatility
 * and for every label — close-to-close alone discards the overnight gap, which
 * is most of the move around earnings, so the high and low are not optional.
 */
export const equityBars = sqliteTable(
  'equity_bars',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    symbol: text('symbol').notNull(),
    day: text('day').notNull(),
    openE4: integer('open_e4').notNull(),
    highE4: integer('high_e4').notNull(),
    lowE4: integer('low_e4').notNull(),
    closeE4: integer('close_e4').notNull(),
    /** Split- and dividend-adjusted close, for return calculations. */
    adjCloseE4: integer('adj_close_e4'),
    volume: integer('volume').notNull().default(0),
  },
  (t) => [uniqueIndex('bars_symbol_day_uq').on(t.symbol, t.day)],
);

/**
 * The risk-free curve, by tenor. Black-Scholes needs a rate matched to the
 * option's maturity; using a single overnight rate for a 90-day contract
 * misprices it, and the error lands squarely in the implied vol we then feed
 * to the model as a feature.
 */
export const riskFreeRates = sqliteTable(
  'risk_free_rates',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    day: text('day').notNull(),
    tenorDays: integer('tenor_days').notNull(),
    /** Annualized, in basis points. 425 = 4.25%. */
    rateBps: integer('rate_bps').notNull(),
  },
  (t) => [uniqueIndex('rates_day_tenor_uq').on(t.day, t.tenorDays)],
);

/**
 * Dividends, splits and earnings dates.
 *
 * Not optional detail: a dividend changes the early-exercise calculus for
 * American calls, a split silently corrupts every historical price comparison
 * that ignores it, and days-to-earnings is one of the strongest features in
 * any options model. Earnings also need `timing` — a report before the open
 * and one after the close land the move on different trading days, and getting
 * that backwards is a one-day lookahead leak.
 */
export const corpEvents = sqliteTable(
  'corp_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    symbol: text('symbol').notNull(),
    day: text('day').notNull(),
    kind: text('kind', { enum: ['earnings', 'dividend', 'split'] }).notNull(),
    /** Dividend amount in E4, split ratio as a factor, null for earnings. */
    value: real('value'),
    timing: text('timing', { enum: ['bmo', 'amc', 'unknown'] }).notNull().default('unknown'),
    /**
     * When we learned of it. An earnings date announced after the fact must
     * not become a feature on days before it was knowable.
     */
    knownAt: text('known_at').notNull(),
  },
  (t) => [
    uniqueIndex('events_symbol_day_kind_uq').on(t.symbol, t.day, t.kind),
    index('events_symbol_idx').on(t.symbol, t.day),
  ],
);

// ---------------------------------------------------------------------------
// Capture bookkeeping
// ---------------------------------------------------------------------------

/**
 * One row per capture or backfill attempt.
 *
 * `cursor` is what makes a two-year, four-hundred-symbol backfill survivable:
 * the job checkpoints after each symbol-day, so an interrupted run resumes
 * where it stopped instead of restarting or, worse, silently skipping.
 */
// ---------------------------------------------------------------------------
// Paper trading
// ---------------------------------------------------------------------------

/**
 * Simulated positions traded with artificial money.
 *
 * No signal-generating model exists yet — `rank.py` and the signal board are
 * still ahead of this in the build order — so for now an order is placed by
 * calling the API directly rather than by a ranked recommendation. That is a
 * deliberate simplification, not a placeholder architecture: this table
 * looks identical whether a human or a future ranking model opened the
 * trade, distinguished only by `source`, so the ranked board plugs in later
 * without a schema change.
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
    occSymbol: text('occ_symbol')
      .notNull()
      .references(() => optionContracts.occSymbol, { onDelete: 'cascade' }),
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

export const captureRuns = sqliteTable(
  'capture_runs',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: ['nightly', 'backfill'] }).notNull(),
    status: text('status', { enum: ['running', 'done', 'failed'] })
      .notNull()
      .default('running'),
    startedAt: text('started_at').notNull(),
    finishedAt: text('finished_at'),
    /** Opaque resume point, e.g. `{"symbol":"NVDA","day":"2025-03-14"}`. */
    cursor: text('cursor', { mode: 'json' }).$type<Record<string, string> | null>(),
    symbolsDone: integer('symbols_done').notNull().default(0),
    contractsSeen: integer('contracts_seen').notNull().default(0),
    quotesWritten: integer('quotes_written').notNull().default(0),
    errors: text('errors', { mode: 'json' }).$type<string[]>().notNull().default([]),
  },
  (t) => [index('capture_kind_started_idx').on(t.kind, t.startedAt)],
);
