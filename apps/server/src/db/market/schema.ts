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
