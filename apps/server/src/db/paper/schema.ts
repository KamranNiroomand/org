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
/**
 * The stock paper book — a separate table from `paperOrders`, not a
 * discriminated column on it.
 *
 * A stock position and an option position share almost nothing at the
 * storage layer: no OCC symbol, no contract multiplier, fractional
 * quantities rather than whole contracts, and an exit cadence measured
 * in days-to-months rather than the options engine's fifteen minutes.
 * Folding them together would make half of every row null and — worse —
 * would put stock rows in front of the options exit engine's query,
 * where a 15-minute rulebook written for decaying contracts would start
 * managing buy-and-hold equity positions. Two tables, two engines, one
 * shared equity view.
 *
 * `book` splits the two horizons: 'short' (~1 month, the stk_short
 * model) and 'long' (~6 months, stk_long). They differ in sizing, stop
 * width, and exit rules, and mixing their performance would hide which
 * horizon is actually working.
 */
export const stockOrders = sqliteTable(
  'stock_orders',
  {
    id: text('id').primaryKey(),
    symbol: text('symbol').notNull(),
    book: text('book', { enum: ['short', 'long'] }).notNull(),
    /** Fractional shares are legitimate here, unlike option contracts. */
    quantity: real('quantity').notNull(),
    initialQuantity: real('initial_quantity'),
    entryPriceE4: integer('entry_price_e4').notNull(),
    entryBasis: text('entry_basis', { enum: ['measured', 'modelled'] }).notNull(),
    entryDay: text('entry_day').notNull(),
    /** The model's own forecast at entry, for the horizon time-stop. */
    entryForecastReturn: real('entry_forecast_return'),
    modelRunId: text('model_run_id'),
    /** The panel analysis that argued for this position, if any — the
     * long book's exit rule reads its stance, so the thesis must be
     * findable years later. */
    thesisRef: text('thesis_ref'),
    sector: text('sector'),
    stopPriceE4: integer('stop_price_e4'),
    targetPriceE4: integer('target_price_e4'),
    targetExitDate: text('target_exit_date'),
    status: text('status', { enum: ['open', 'closed'] }).notNull().default('open'),
    exitPriceE4: integer('exit_price_e4'),
    exitBasis: text('exit_basis', { enum: ['measured', 'modelled'] }),
    exitDay: text('exit_day'),
    exitReason: text('exit_reason'),
    splitFrom: text('split_from'),
    notes: text('notes'),
    openedAt: text('opened_at').notNull(),
    closedAt: text('closed_at'),
    exitUpdatedAt: text('exit_updated_at'),
  },
  (t) => [index('stock_orders_status_idx').on(t.status), index('stock_orders_book_idx').on(t.book)],
);

/**
 * Every decision the stock engine reaches, kept.
 *
 * The engine already returns its rejections to whoever called it — and
 * that answer used to die with the HTTP response, which meant the
 * nightly run's reasoning existed for nobody. The questions this table
 * answers are the ones a person actually asks days later: why was that
 * name not bought, was the sector cap or the panel the binding
 * constraint, how often does the LLM veto the model, was a position sold
 * on its stop or on a broken thesis.
 *
 * `detail` carries the numbers behind the reason — the sector at its
 * cap, the forecast, the slot count — so a row explains itself without
 * a reader having to reconstruct that day's state.
 */
export const stockDecisions = sqliteTable(
  'stock_decisions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    day: text('day').notNull(),
    book: text('book', { enum: ['short', 'long'] }).notNull(),
    symbol: text('symbol').notNull(),
    decision: text('decision', {
      enum: ['opened', 'rejected', 'skipped', 'held', 'exited', 'marked', 'stop_raised'],
    }).notNull(),
    reason: text('reason').notNull(),
    detail: text('detail', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
    modelRunId: text('model_run_id'),
    panelStance: text('panel_stance'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('stock_decisions_day_idx').on(t.day),
    index('stock_decisions_symbol_idx').on(t.symbol),
    index('stock_decisions_reason_idx').on(t.day, t.reason),
  ],
);

/** Daily marks for stock positions — same shape and purpose as
 * `paperMarks`, kept separate for the same reason the orders are. */
export const stockMarks = sqliteTable(
  'stock_marks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    orderId: text('order_id').notNull(),
    asOf: text('as_of').notNull(),
    tradingDay: text('trading_day').notNull(),
    markPriceE4: integer('mark_price_e4').notNull(),
    basis: text('basis', { enum: ['measured', 'modelled'] }).notNull(),
    unrealizedPlE4: integer('unrealized_pl_e4').notNull(),
  },
  (t) => [uniqueIndex('stock_marks_order_day_uq').on(t.orderId, t.tradingDay)],
);

export const paperOrders = sqliteTable(
  'paper_orders',
  {
    id: text('id').primaryKey(),
    /** No FK — see the module docstring. Validated at write time instead. */
    occSymbol: text('occ_symbol').notNull(),
    /**
     * Denormalized at open time from the contract's own row, rather than
     * re-derived later via a live join to `optionContracts` — a contract
     * can be pruned or expire out of that table while its order is still
     * open, and re-resolving "which underlying is this" on demand would
     * then silently fail exactly when a caller (autoEntry.ts's own
     * one-position-per-underlying guard) needs it most. Null only for
     * orders opened before this column existed.
     */
    underlying: text('underlying'),
    /**
     * Shares per contract, denormalized at open time for the same reason
     * as `underlying` above: every dollar figure for this position is
     * `price * quantity * multiplier`, so a caller that has to re-look it
     * up in `optionContracts` breaks the moment that row is pruned —
     * which is exactly when an open position still needs to be valued.
     * Null only for orders opened before this column existed.
     */
    multiplier: integer('multiplier'),
    side: text('side', { enum: ['long', 'short'] }).notNull().default('long'),
    quantity: integer('quantity').notNull(),
    /**
     * Contracts at open, before any scale-out. `quantity < initialQuantity`
     * is the durable fact "this position has already banked its milestone
     * half" — the scale-out rule keys on it, so a restart can never sell
     * the same half twice. Null on orders opened before scaling existed;
     * read as "initial equals current".
     */
    initialQuantity: integer('initial_quantity'),
    /**
     * For the closed slice a scale-out splits off: the id of the open
     * order it came from. Lineage for the audit trail; null everywhere
     * else.
     */
    splitFrom: text('split_from'),
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
    /**
     * The exit plan, present only on a `source: 'model'` order the exit
     * engine manages (see `exitEngine.ts`) — null for a manual order, which
     * has no automated exit to track. All three null together, or all set:
     * a position never carries a price target without a date or vice versa.
     * Initial values come from `services/quant/app/exit.py`'s
     * `compute_initial_exit_target`; the profit target and date can move
     * over the position's life — see `paperExitRevisions` for the history
     * of why.
     *
     * The stop moves too, in one direction only. Once price reaches the
     * target, `evaluate_exit` ratchets the stop up to trail the running
     * price rather than closing the position — capping a long option's
     * upside while leaving its downside intact inverts the payoff it was
     * bought for. The ratchet is monotone: a stop that can move down is
     * not a stop.
     */
    targetExitPriceE4: integer('target_exit_price_e4'),
    stopLossPriceE4: integer('stop_loss_price_e4'),
    targetExitDate: text('target_exit_date'),
    /**
     * The ranked signal's expected value at the moment this order opened —
     * the reference point `exitEngine.ts` compares against on every
     * recheck to detect a sign flip (see exit.py's `evaluate_exit`). Null
     * for a manual order, which has no ranking EV to record.
     */
    entryEv: real('entry_ev'),
    exitUpdatedAt: text('exit_updated_at'),
    openedAt: text('opened_at').notNull(),
    closedAt: text('closed_at'),
  },
  (t) => [
    index('paper_orders_status_idx').on(t.status),
    index('paper_orders_occ_idx').on(t.occSymbol),
  ],
);

/**
 * Why a position's exit target moved, not just its current value.
 *
 * `exitEngine.ts` runs intraday and can revise `paperOrders.targetExitPriceE4`/
 * `targetExitDate` every time it fires — a bare "current target" column with
 * no history would make it impossible to tell whether the model is behaving
 * sensibly over time or flapping. Same "show your work" instinct as the
 * multi-agent panel's per-round transcript.
 */
export const paperExitRevisions = sqliteTable(
  'paper_exit_revisions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    orderId: text('order_id')
      .notNull()
      .references(() => paperOrders.id, { onDelete: 'cascade' }),
    revisedAt: text('revised_at').notNull(),
    oldTargetExitPriceE4: integer('old_target_exit_price_e4'),
    newTargetExitPriceE4: integer('new_target_exit_price_e4'),
    oldTargetExitDate: text('old_target_exit_date'),
    newTargetExitDate: text('new_target_exit_date'),
    /** Set when a pass ratcheted the trailing stop upward. A stop that
     * moves with no audit trail is exactly what this table exists to
     * prevent, so the ratchet records both sides like the target does. */
    oldStopLossPriceE4: integer('old_stop_loss_price_e4'),
    newStopLossPriceE4: integer('new_stop_loss_price_e4'),
    reason: text('reason').notNull(),
    /** Whether a deterministic rule or an LLM escalation decided this — see exitEngine.ts. */
    triggeredBy: text('triggered_by', { enum: ['rule', 'llm'] }).notNull(),
  },
  (t) => [index('paper_exit_revisions_order_idx').on(t.orderId)],
);

/**
 * Why the system did what it did, for every candidate it looked at — not
 * just the ones it acted on.
 *
 * Auto-entry ranks a few hundred contracts a day, opens a handful, and
 * until this table existed discarded the reasoning for every other one the
 * instant the function returned. So "why didn't it buy X?" had no answer,
 * ever. On 2026-08-24 reconstructing a single decision — a $122,440
 * position that turned out to rest on a bad price print — took an
 * afternoon of reading code and querying raw quotes by hand. That should
 * be one query.
 *
 * The same run also trimmed a position's size against a non-standard
 * multiplier and reported it only into an in-memory array neither
 * scheduler call site read, so a position opened at a fifth of its
 * intended size left no trace anywhere at all.
 *
 * `detail` is a JSON blob rather than columns because the two
 * decision-makers this table is designed to compare — the quant rules and
 * the eventual agentic path — reason in genuinely different shapes, and
 * forcing one schema onto both would flatten exactly the difference the
 * comparison exists to measure.
 */
export const paperDecisionLog = sqliteTable(
  'paper_decision_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Trading day the decision was made for, not when the row was written. */
    day: text('day').notNull(),
    source: text('source', { enum: ['quant', 'agentic'] })
      .notNull()
      .default('quant'),
    occSymbol: text('occ_symbol').notNull(),
    underlying: text('underlying'),
    decision: text('decision', {
      enum: ['opened', 'rejected', 'trimmed', 'failed', 'held', 'exited', 'reduced', 'target_moved', 'adopted'],
    }).notNull(),
    /** The fixed-vocabulary rule behind it — `ev_below_bar`, `dte_outside_band`,
     * `stop_loss`, and so on. A vocabulary rather than prose because the
     * point is to be able to *count* these: which constraint actually
     * shapes the book is a question only a GROUP BY can answer. */
    reason: text('reason').notNull(),
    detail: text('detail', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('paper_decision_log_day_idx').on(t.day),
    index('paper_decision_log_symbol_idx').on(t.occSymbol),
    index('paper_decision_log_reason_idx').on(t.day, t.reason),
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

/**
 * Nightly re-evaluation of every **open** position against today's forecast
 * and today's news — distinct from `paperMarks`, which prices a position
 * off its actual quote and never asks the model anything.
 *
 * The reason this exists at all: opening a paper position freezes the
 * model's opinion at the moment you clicked "Open", and a static freeze is
 * a bad model of how a real day actually goes. Tomorrow the model itself
 * updates (new bars, new realized vol, a new drift forecast) with zero news
 * required, and separately, real news can move the picture the model can't
 * see yet on its own. This table re-runs the *same* forecast machinery
 * `rank_day` uses (`score_held_contracts`, not a second formula) so a held
 * position's health is judged on identical terms to how it was ranked in
 * the first place.
 *
 * `current*` columns are all nullable together: a `null` row means "no
 * current view could be computed" (the contract expired, no quote today, no
 * rate for its DTE) — not "this position is fine". That distinction matters
 * because a position going quiet in a way the model can no longer price is
 * itself worth noticing, not something to paper over with a stale number.
 */
export const paperPositionHealth = sqliteTable(
  'paper_position_health',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    orderId: text('order_id')
      .notNull()
      .references(() => paperOrders.id, { onDelete: 'cascade' }),
    day: text('day').notNull(),
    currentEv: real('current_ev'),
    currentEvPerRisk: real('current_ev_per_risk'),
    currentProbProfit: real('current_prob_profit'),
    currentForecastVol: real('current_forecast_vol'),
    currentForecastDrift: real('current_forecast_drift'),
    /** Documents about the underlying published since the position opened — point-in-time correct, read from `market.db`'s `documents`/`doc_mentions`. */
    newDocumentsCount: integer('new_documents_count').notNull().default(0),
    /** The single most recent qualifying document, for a one-line surface — not a feed. Null together whenever newDocumentsCount is 0. */
    latestDocumentTitle: text('latest_document_title'),
    latestDocumentEventType: text('latest_document_event_type'),
    latestDocumentPublishedAt: text('latest_document_published_at'),
    computedAt: text('computed_at').notNull(),
  },
  (t) => [
    uniqueIndex('paper_position_health_order_day_uq').on(t.orderId, t.day),
    index('paper_position_health_day_idx').on(t.day),
  ],
);

/**
 * Every day's model forecast per symbol, written at cycle time — the
 * raw material for meta-labeling (a second model asking "when is the
 * first model right?"), which needs exactly this: what was predicted,
 * by which artifact, on which day, so it can later be joined against
 * what actually happened. Nothing reads it yet; the dataset has to
 * exist before the model that learns from it can.
 */
export const stockForecasts = sqliteTable(
  'stock_forecasts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    day: text('day').notNull(),
    target: text('target').notNull(),
    symbol: text('symbol').notNull(),
    modelRunId: text('model_run_id').notNull(),
    rank: integer('rank').notNull(),
    forecastSigmas: real('forecast_sigmas'),
    horizonReturn: real('horizon_return'),
    forecastVol: real('forecast_vol'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('stock_forecasts_day_target_symbol_uq').on(t.day, t.target, t.symbol)],
);
