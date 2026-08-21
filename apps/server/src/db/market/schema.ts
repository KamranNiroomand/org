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
/**
 * Trained model artifacts, registered — one row per training run.
 *
 * The row is metadata only; the artifact itself (`model.txt`, `features.json`)
 * lives as files under `models/<run_id>/`, written by `train.py`. Python is
 * read-only on this database throughout the project, so it never writes this
 * row directly — a Node script (`models-register.ts`) reads the manifest
 * `train.py` produced and inserts it here, the same division of labour as
 * capture: Python computes, Node persists.
 *
 * **Registered on the runner only.** `market:pull` replaces the reader's
 * entire local `market.db` with the runner's snapshot — correct for the
 * corpus, where the runner is the single source of truth, but it means any
 * row written *only* on the reader is silently destroyed by the next pull.
 * Registering here only ever happens on the machine that trained, so the row
 * travels to the reader through the same snapshot the corpus already uses,
 * rather than risking being wiped by it.
 *
 * (Paper trading used to carry the identical risk — a trade placed on a
 * reader would be destroyed by the next pull. Fixed by moving it out of this
 * file entirely: see `../paper/schema.ts`, a physically separate database
 * `market:pull` never touches.)
 */
export const modelRuns = sqliteTable(
  'model_runs',
  {
    /** Matches train.py's own run_id, e.g. "2026-08-18-dir-h5-1e0f0b03a947". */
    runId: text('run_id').primaryKey(),
    target: text('target').notNull(),
    horizon: integer('horizon').notNull(),
    gitSha: text('git_sha'),
    trainDaysFirst: text('train_days_first').notNull(),
    trainDaysLast: text('train_days_last').notNull(),
    trainDaysCount: integer('train_days_count').notNull(),
    nSplits: integer('n_splits').notNull(),
    embargo: integer('embargo').notNull(),
    /** RMSE, baseline RMSE, beats_baseline, IC, fold/row counts — see train.py. */
    metrics: text('metrics', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    /** Directory name under modelsDir, e.g. the run_id itself. */
    artifactDir: text('artifact_dir').notNull(),
    registeredAt: text('registered_at').notNull(),
    /**
     * A run starts as a challenger. Promotion to champion is manual — see
     * the project plan's champion/shadow/promote policy — never automatic on
     * a good in-sample metric.
     */
    status: text('status', { enum: ['challenger', 'champion', 'retired'] })
      .notNull()
      .default('challenger'),
    promotedAt: text('promoted_at'),
  },
  (t) => [
    index('model_runs_target_idx').on(t.target),
    index('model_runs_status_idx').on(t.status),
  ],
);

export const captureRuns = sqliteTable(
  'capture_runs',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: ['nightly', 'backfill'] }).notNull(),
    /**
     * 'degraded' is 'done' with real gaps — some symbols wrote quotes, some
     * didn't (usually sustained rate-limiting). Kept distinct from 'done' so
     * a night that silently lost most of the universe doesn't read the same
     * as a clean run; kept distinct from 'failed' because it isn't one — the
     * run completed and most of what it wrote is real.
     */
    status: text('status', { enum: ['running', 'done', 'degraded', 'failed'] })
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
    /**
     * Of `symbolsDone`, how many wrote zero quotes — a real coverage gap,
     * not just "had an error". Tracked as its own field rather than derived
     * from `errors` at read time, because a symbol can log an error (e.g. a
     * pricing-only failure) while its quotes still wrote fine; deriving
     * "failed" from free-text error matching conflated the two.
     */
    symbolsFailed: integer('symbols_failed').notNull().default(0),
  },
  (t) => [index('capture_kind_started_idx').on(t.kind, t.startedAt)],
);

// ---------------------------------------------------------------------------
// Text — news and filings
// ---------------------------------------------------------------------------

/**
 * One row per document, from whichever source produced it.
 *
 * **Point-in-time correctness is the entire reason this table exists in
 * this shape.** `publishedAt` is when the outside world could first have
 * read this document; a feature computed for an earlier instant must never
 * join against a row whose `publishedAt` is later than that instant. This
 * table makes that check a single comparison rather than something a
 * feature-builder has to reconstruct — every read path in `text.py` filters
 * on it explicitly.
 *
 * A revision or amendment is a **new row**, never an update to an existing
 * one. An EDGAR 8-K/A amending an earlier 8-K is a distinct filing with its
 * own accession number and its own `publishedAt` — updating the original
 * row in place would let a fact only known after the amendment leak into
 * a feature computed for a time before it existed, exactly the lookahead
 * bug this schema's whole design exists to make structurally hard to write.
 *
 * `sourceId` is the vendor's own identifier (a Polygon article id, an
 * EDGAR accession number) — the natural idempotency key for ingestion, and
 * unique together with `source` since the two vendors' id spaces are
 * independent.
 */
export const documents = sqliteTable(
  'documents',
  {
    id: text('id').primaryKey(),
    source: text('source', { enum: ['polygon_news', 'edgar'] }).notNull(),
    /** The vendor's own id — a Polygon article id, an EDGAR accession number. */
    sourceId: text('source_id').notNull(),
    /** Instant this document became publicly readable. See the table doc comment. */
    publishedAt: text('published_at').notNull(),
    /** When our own ingestion first saw it — distinct from publishedAt, kept for debugging gaps. */
    ingestedAt: text('ingested_at').notNull(),
    title: text('title').notNull(),
    /** A publisher's summary or an EDGAR filing's own short description, never the full body. */
    summary: text('summary'),
    url: text('url').notNull(),
    /** 'ANNUAL_REPORT', '8-K', 'press_release', etc. — free-form per source, not yet the fixed taxonomy events.ts tags into. */
    docType: text('doc_type'),
    /** EDGAR item codes, e.g. "2.02,9.01" — null for news. A strong prior for events.ts's classifier. */
    edgarItems: text('edgar_items'),
    /** Set by agents/events.ts. Null until classified — classification runs after ingestion, not inline with it. */
    eventType: text('event_type'),
    eventConfidence: text('event_confidence', { enum: ['high', 'medium', 'low'] }),
  },
  (t) => [
    uniqueIndex('documents_source_uq').on(t.source, t.sourceId),
    index('documents_published_idx').on(t.publishedAt),
    index('documents_unclassified_idx').on(t.eventType),
  ],
);

/**
 * Which underlying(s) a document concerns, one row per document×underlying.
 *
 * A single news article routinely mentions a dozen tickers with different
 * relevance to each; collapsing that into one row per document would force
 * a single sentiment onto every mentioned name, which is simply wrong —
 * Polygon's own news API already scores sentiment per ticker, independently,
 * within one article (a name mentioned only as a comparison point reads
 * 'neutral' while the article's actual subject reads 'positive' in the same
 * response). This table preserves that granularity instead of averaging it
 * away. An EDGAR filing mentions exactly one underlying — its filer — and
 * carries no sentiment; the column stays null there rather than fabricating
 * a score EDGAR never provided.
 */
export const docMentions = sqliteTable(
  'doc_mentions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    documentId: text('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    underlying: text('underlying').notNull(),
    /** Only ever populated for source='polygon_news' — see the table doc comment. */
    sentiment: text('sentiment', { enum: ['positive', 'negative', 'neutral'] }),
    sentimentReasoning: text('sentiment_reasoning'),
  },
  (t) => [
    uniqueIndex('doc_mentions_doc_underlying_uq').on(t.documentId, t.underlying),
    index('doc_mentions_underlying_idx').on(t.underlying),
  ],
);
