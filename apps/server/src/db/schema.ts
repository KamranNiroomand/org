import { relations } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type {
  BalancePlacement,
  ComputedFinancials,
  LocationAgentResult,
  ManagerSynthesisResult,
  PropertyInput,
  RentalAgentResult,
} from '../lib/agents/realestate/types.js';

/**
 * Schema notes that apply throughout:
 *
 * - Instants are TEXT holding UTC ISO-8601. SQLite has no date type, and ISO
 *   strings sort correctly as text, so range queries work without conversion.
 * - Civil days (due dates, transaction dates) are TEXT `YYYY-MM-DD`. They are
 *   deliberately *not* instants — a due date has no time of day, and storing
 *   one invites off-by-one-day bugs across timezones.
 * - Money is INTEGER minor units. Never REAL. The one REAL column here is
 *   `holdings.quantity`, because fractional shares are genuinely fractional.
 * - Tag lists are JSON TEXT. SQLite has no array type and a join table for
 *   free-form tags on a single-user app is more machinery than it's worth.
 */

const id = () => text('id').primaryKey();
const now = () => text('created_at').notNull();

// ---------------------------------------------------------------------------
// Tasks & projects
// ---------------------------------------------------------------------------

export const projects = sqliteTable('projects', {
  id: id(),
  name: text('name').notNull(),
  description: text('description'),
  status: text('status', { enum: ['active', 'paused', 'done', 'archived'] })
    .notNull()
    .default('active'),
  color: text('color').notNull().default('violet'),
  targetOn: text('target_on'),
  createdAt: now(),
  updatedAt: text('updated_at').notNull(),
});

export const tasks = sqliteTable(
  'tasks',
  {
    id: id(),
    title: text('title').notNull(),
    notes: text('notes'),
    status: text('status', { enum: ['open', 'done', 'dropped'] })
      .notNull()
      .default('open'),
    priority: text('priority', { enum: ['none', 'low', 'medium', 'high', 'urgent'] })
      .notNull()
      .default('none'),
    dueOn: text('due_on'),
    completedAt: text('completed_at'),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    tags: text('tags', { mode: 'json' }).$type<string[]>().notNull().default([]),
    sortOrder: integer('sort_order').notNull().default(0),
    // Estimates are whole minutes; tracked time is seconds so a timer that has
    // just started visibly moves. Null estimate means "unestimated", not zero —
    // the UI shows nothing at all rather than a misleading 0m.
    estimateMinutes: integer('estimate_minutes'),
    trackedSeconds: integer('tracked_seconds').notNull().default(0),
    // Set while a timer runs. Elapsed is always derived from this instant, so a
    // reload, a sleeping laptop, and a server restart all agree.
    timerStartedAt: text('timer_started_at'),
    createdAt: now(),
    updatedAt: text('updated_at').notNull(),
  },
  // No index on timer_started_at: at most one row holds it and the table is a
  // single person's task list. An index here would be decoration.
  (t) => [
    index('tasks_due_idx').on(t.dueOn),
    index('tasks_status_idx').on(t.status),
    index('tasks_project_idx').on(t.projectId),
  ],
);

/**
 * A sticky note on the Todo board — a scrap of text that isn't a task.
 *
 * Colour is stored as a *key* (`'yellow'`), never a hex, so the actual value
 * can differ between light and dark themes. The keys are the `STICKY_COLORS`
 * array in `@org/shared`, which the API validates against.
 *
 * Order is user-controlled but layout is not: the client drags to reorder and
 * the grid arranges itself, so there are no x/y coordinates to store.
 */
export const stickyNotes = sqliteTable('sticky_notes', {
  id: id(),
  body: text('body').notNull().default(''),
  color: text('color', {
    enum: ['yellow', 'amber', 'green', 'blue', 'violet', 'pink', 'slate'],
  })
    .notNull()
    .default('yellow'),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: now(),
  updatedAt: text('updated_at').notNull(),
});

/**
 * A subscribed calendar — the "secret address in iCal format" Google and
 * Outlook hand out.
 *
 * That URL is a bearer credential: anyone holding it can read the whole
 * calendar without logging in. So it is encrypted at rest with the same
 * Keychain-backed AES-256-GCM used for Plaid access tokens, and never returned
 * to the client once saved.
 */
export const calendarFeeds = sqliteTable('calendar_feeds', {
  id: id(),
  name: text('name').notNull(),
  urlEnc: text('url_enc').notNull(),
  color: text('color').notNull().default('blue'),
  status: text('status', { enum: ['ok', 'error'] })
    .notNull()
    .default('ok'),
  error: text('error'),
  lastSyncAt: text('last_sync_at'),
  createdAt: now(),
});

export const events = sqliteTable(
  'events',
  {
    id: id(),
    title: text('title').notNull(),
    notes: text('notes'),
    startsAt: text('starts_at').notNull(),
    endsAt: text('ends_at').notNull(),
    allDay: integer('all_day', { mode: 'boolean' }).notNull().default(false),
    location: text('location'),
    color: text('color').notNull().default('blue'),
    /**
     * Null for events created by hand in Org; set for subscribed ones.
     *
     * Deliberately *not* declared ON DELETE CASCADE. This column was added by
     * ALTER TABLE, and SQLite cannot attach a cascading action that way — the
     * constraint lands as NO ACTION whatever the declaration says. Rather than
     * carry a schema that lies about the database, removing a feed deletes its
     * events explicitly in the route.
     */
    feedId: text('feed_id').references(() => calendarFeeds.id),
    /**
     * The iCalendar UID, suffixed with the occurrence start for expanded
     * recurrences. Unique per feed, which is what makes a re-sync an update
     * rather than a duplicate — the same property `transactions` relies on.
     */
    externalUid: text('external_uid'),
    createdAt: now(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('events_start_idx').on(t.startsAt),
    index('events_feed_idx').on(t.feedId),
    uniqueIndex('events_feed_uid_uq').on(t.feedId, t.externalUid),
  ],
);

// ---------------------------------------------------------------------------
// Banking
// ---------------------------------------------------------------------------

export const plaidItems = sqliteTable('plaid_items', {
  id: id(),
  institutionId: text('institution_id'),
  institutionName: text('institution_name').notNull(),
  /**
   * AES-256-GCM ciphertext. The plaintext access token never touches disk —
   * the key lives in the macOS Keychain. See `crypto.ts`.
   */
  accessTokenEnc: text('access_token_enc').notNull(),
  /** Opaque Plaid pagination cursor; advanced only after a batch commits. */
  cursor: text('cursor'),
  status: text('status', { enum: ['ok', 'needs_reauth', 'error'] })
    .notNull()
    .default('ok'),
  error: text('error'),
  lastSyncAt: text('last_sync_at'),
  createdAt: now(),
});

export const accounts = sqliteTable(
  'accounts',
  {
    id: id(),
    itemId: text('item_id').references(() => plaidItems.id, { onDelete: 'cascade' }),
    plaidAccountId: text('plaid_account_id'),
    name: text('name').notNull(),
    officialName: text('official_name'),
    mask: text('mask'),
    type: text('type', {
      enum: ['depository', 'credit', 'loan', 'investment', 'other'],
    })
      .notNull()
      .default('depository'),
    subtype: text('subtype'),
    currency: text('currency').notNull().default('CAD'),
    currentBalance: integer('current_balance'),
    availableBalance: integer('available_balance'),
    creditLimit: integer('credit_limit'),
    institutionName: text('institution_name'),
    isManual: integer('is_manual', { mode: 'boolean' }).notNull().default(false),
    /**
     * Whether this account feeds the summary tiles, cashflow, category
     * breakdown, and the transaction list. The account list and balances
     * always show every account regardless — this only governs whether an
     * account's activity shows up elsewhere, so a joint account can be
     * excluded from your own spending picture without deleting it.
     */
    includeInStats: integer('include_in_stats', { mode: 'boolean' })
      .notNull()
      .default(true),
    lastSyncedAt: text('last_synced_at'),
    createdAt: now(),
  },
  (t) => [uniqueIndex('accounts_plaid_uq').on(t.plaidAccountId)],
);

export const categories = sqliteTable(
  'categories',
  {
    id: id(),
    name: text('name').notNull(),
    parentId: text('parent_id'),
    /**
     * 'payment' and 'refund' exist alongside income/expense/transfer because
     * neither behaves like the other three. A card payment is not spending
     * (the spend was already counted when the purchase happened) and it is
     * not a transfer in the excluded-from-everything sense either — the
     * counterparty account usually is not synced, so there is nothing to net
     * it against, and it deserves to be visible as its own figure rather than
     * silently discarded. A refund is real money back, but crediting it as
     * income would overstate what you earned, and netting it against the
     * original purchase's category was deliberately rejected in favour of a
     * separate, visible total — see the finance summary endpoint.
     */
    kind: text('kind', { enum: ['expense', 'income', 'transfer', 'payment', 'refund'] })
      .notNull()
      .default('expense'),
    color: text('color').notNull().default('slate'),
    icon: text('icon'),
    isSystem: integer('is_system', { mode: 'boolean' }).notNull().default(false),
  },
  /**
   * Names are the identity here: the seeder looks categories up by name, and
   * so does `categoryIdByName`. Without this constraint two seed runs racing
   * each other — which is exactly what a dev-server restart does — both see a
   * category missing and both insert it.
   */
  (t) => [uniqueIndex('categories_name_uq').on(t.name)],
);

export const transactions = sqliteTable(
  'transactions',
  {
    id: id(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    plaidTransactionId: text('plaid_transaction_id'),
    date: text('date').notNull(),
    authorizedDate: text('authorized_date'),
    /** Minor units, normalized: negative = money out, positive = money in. */
    amount: integer('amount').notNull(),
    currency: text('currency').notNull().default('CAD'),
    /**
     * Plaid's own classification (the `primary` field of
     * `personal_finance_category`, e.g. "LOAN_PAYMENTS", "INCOME",
     * "TRANSFER_IN"). Far more reliable than guessing from merchant text —
     * a bank's own wording for "you paid your card" varies, Plaid's category
     * for it does not. Only present on transactions synced after this field
     * was added; older rows fall back to a text-pattern heuristic. See
     * classifyByAccountContext in categorize.ts.
     */
    personalFinanceCategory: text('personal_finance_category'),
    name: text('name').notNull(),
    merchantName: text('merchant_name'),
    categoryId: text('category_id').references(() => categories.id, { onDelete: 'set null' }),
    pending: integer('pending', { mode: 'boolean' }).notNull().default(false),
    pendingTransactionId: text('pending_transaction_id'),
    isTransfer: integer('is_transfer', { mode: 'boolean' }).notNull().default(false),
    notes: text('notes'),
    source: text('source', { enum: ['plaid', 'csv', 'manual'] })
      .notNull()
      .default('manual'),
    /**
     * Hash of (account, date, amount, normalized description). The uniqueness
     * constraint on this column is what makes re-importing an overlapping
     * statement a no-op instead of a pile of duplicates.
     */
    importHash: text('import_hash'),
    createdAt: now(),
  },
  (t) => [
    uniqueIndex('tx_plaid_uq').on(t.plaidTransactionId),
    uniqueIndex('tx_import_hash_uq').on(t.importHash),
    index('tx_date_idx').on(t.date),
    index('tx_account_idx').on(t.accountId),
    index('tx_category_idx').on(t.categoryId),
  ],
);

export const categoryRules = sqliteTable(
  'category_rules',
  {
    id: id(),
    matchType: text('match_type', { enum: ['merchant', 'contains', 'regex'] })
      .notNull()
      .default('contains'),
    pattern: text('pattern').notNull(),
    categoryId: text('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    priority: integer('priority').notNull().default(100),
    createdAt: now(),
  },
  /**
   * `learnRule` already treats a pattern as unique — it updates the existing
   * row rather than adding a second one. The constraint makes that assumption
   * true rather than merely intended.
   */
  (t) => [index('rules_priority_idx').on(t.priority), uniqueIndex('rules_pattern_uq').on(t.pattern)],
);

export const budgets = sqliteTable(
  'budgets',
  {
    id: id(),
    categoryId: text('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    /** `YYYY-MM` for a one-off, or NULL meaning "every month". */
    period: text('period'),
    amount: integer('amount').notNull(),
    currency: text('currency').notNull().default('CAD'),
  },
  (t) => [uniqueIndex('budgets_cat_period_uq').on(t.categoryId, t.period)],
);

export const recurring = sqliteTable('recurring', {
  id: id(),
  name: text('name').notNull(),
  kind: text('kind', { enum: ['income', 'subscription'] }).notNull(),
  amount: integer('amount').notNull(),
  currency: text('currency').notNull().default('CAD'),
  cadence: text('cadence', {
    enum: ['weekly', 'biweekly', 'semimonthly', 'monthly', 'irregular'],
  }).notNull(),
  accountId: text('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
  nextExpectedOn: text('next_expected_on'),
  lastSeenOn: text('last_seen_on'),
  confidence: real('confidence').notNull().default(0),
});

// ---------------------------------------------------------------------------
// Investments
// ---------------------------------------------------------------------------

export const holdings = sqliteTable('holdings', {
  id: id(),
  symbol: text('symbol').notNull(),
  name: text('name'),
  /** REAL on purpose — fractional shares are real. */
  quantity: real('quantity').notNull(),
  /** Minor units per share. */
  avgCost: integer('avg_cost').notNull(),
  currency: text('currency').notNull().default('CAD'),
  accountId: text('account_id').references(() => accounts.id, { onDelete: 'set null' }),
  createdAt: now(),
});

/**
 * The tradeable universe: every US and Canadian common stock, with whatever
 * the last sweep learned about each.
 *
 * Kept in SQLite rather than memory because it is roughly seven thousand rows
 * and a full refresh takes minutes — the page has to render instantly from
 * what was last known, with live prices layered over only the handful of
 * symbols actually on screen.
 *
 * Fundamentals and quotes share a row because they arrive from the same call.
 * `quotedAt` being null means the symbol is listed but no sweep has reached it
 * yet, which is different from a symbol that returned no data.
 */
export const instruments = sqliteTable(
  'instruments',
  {
    /** Yahoo's symbol, including any `.TO` suffix. */
    symbol: text('symbol').primaryKey(),
    name: text('name').notNull(),
    exchange: text('exchange').notNull(),
    country: text('country', { enum: ['US', 'CA'] }).notNull(),
    sector: text('sector'),
    /** Whole units of the listing currency, not minor units — these reach $10^12. */
    marketCap: real('market_cap'),
    price: real('price'),
    currency: text('currency'),
    dayChangePercent: real('day_change_percent'),
    trailingPe: real('trailing_pe'),
    forwardPe: real('forward_pe'),
    priceToBook: real('price_to_book'),
    dividendYield: real('dividend_yield'),
    /**
     * From the same Yahoo quote() call the nightly sweep already makes — no
     * extra request budget spent. What makes a price/momentum alert (new
     * 52-week low, volume spike) computable across the full universe instead
     * of only the handful of symbols with a real time series in priceSnapshots.
     */
    fiftyTwoWeekHigh: real('fifty_two_week_high'),
    fiftyTwoWeekLow: real('fifty_two_week_low'),
    volume: integer('volume'),
    avgVolume10Day: integer('avg_volume_10_day'),
    /** Epoch millis of the first trade — how long the company has been listed. */
    firstTradeMs: integer('first_trade_ms'),
    quotedAt: text('quoted_at'),
    listedAt: now(),
  },
  (t) => [
    index('instruments_cap_idx').on(t.marketCap),
    index('instruments_country_idx').on(t.country),
    index('instruments_exchange_idx').on(t.exchange),
  ],
);

export const priceSnapshots = sqliteTable(
  'price_snapshots',
  {
    id: id(),
    symbol: text('symbol').notNull(),
    price: integer('price').notNull(),
    currency: text('currency').notNull(),
    dayChangePercent: real('day_change_percent'),
    asOf: text('as_of').notNull(),
  },
  (t) => [index('prices_symbol_idx').on(t.symbol, t.asOf)],
);

/**
 * Symbols followed without a position — what makes an alert about a symbol
 * read differently depending on whether you own it, are watching it, or
 * have never looked at it.
 *
 * Not FK'd to `instruments`: that table is a nightly-refreshed cache of the
 * sweep universe and can, in principle, be missing a symbol (a same-day
 * IPO, a security outside the US/CA sweep). `name` is captured at add-time
 * as a denormalized display fallback, same shape `holdings.name` already
 * uses — every *live* figure (price, day change) is read from `instruments`
 * at request time, never stored here.
 */
export const watchlist = sqliteTable('watchlist', {
  symbol: text('symbol').primaryKey(),
  name: text('name'),
  note: text('note'),
  createdAt: now(),
});

/**
 * One fired price/momentum or news alert. The unique index on (symbol,
 * ruleKey, tradingDay) is what makes evaluation idempotent — the same 9%
 * drop does not re-alert every time the page is opened, because the insert
 * that already happened today conflicts and is dropped rather than
 * duplicated.
 *
 * `context` is captured at fire time, not derived live from `holdings`/
 * `watchlist` at read time — a position can be sold five minutes after an
 * alert fires, and "you owned this when it dropped 9%" should stay true in
 * the feed even after the sale.
 */
export const alertEvents = sqliteTable(
  'alert_events',
  {
    id: id(),
    symbol: text('symbol').notNull(),
    ruleKey: text('rule_key', {
      enum: ['day_change_up', 'day_change_down', 'new_52w_high', 'new_52w_low', 'volume_spike', 'news_event'],
    }).notNull(),
    /** Civil day the underlying move/document happened on — the dedup key. */
    tradingDay: text('trading_day').notNull(),
    context: text('context', { enum: ['holding', 'watchlist', 'unwatched'] }).notNull(),
    direction: text('direction', { enum: ['bullish', 'bearish', 'neutral'] }).notNull(),
    headline: text('headline').notNull(),
    /** The rule's own numbers — threshold, actual value, etc. Shape varies by ruleKey. */
    detail: text('detail', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
    acknowledged: integer('acknowledged', { mode: 'boolean' }).notNull().default(false),
    triggeredAt: text('triggered_at').notNull(),
    createdAt: now(),
  },
  (t) => [
    uniqueIndex('alert_events_dedup_uq').on(t.symbol, t.ruleKey, t.tradingDay),
    index('alert_events_day_idx').on(t.tradingDay),
    index('alert_events_context_idx').on(t.context, t.acknowledged),
  ],
);

/**
 * One row per nightly radar scoring run — `capture_runs`' bookkeeping
 * pattern from the options side, reused here for the same reason: a
 * numeric scan of the full market is cheap enough to run every night, but
 * still worth knowing when it last actually completed.
 */
export const radarRuns = sqliteTable('radar_runs', {
  id: id(),
  startedAt: text('started_at').notNull(),
  finishedAt: text('finished_at'),
  status: text('status', { enum: ['running', 'done', 'failed'] })
    .notNull()
    .default('running'),
  tradingDay: text('trading_day').notNull(),
  universeScored: integer('universe_scored').notNull().default(0),
  shortlisted: integer('shortlisted').notNull().default(0),
  errors: text('errors', { mode: 'json' }).$type<string[]>().notNull().default([]),
});

/**
 * The nightly shortlist only, not a row per symbol per night for the whole
 * ~7,000-symbol universe — persisting every score every night would grow
 * this table by the size of `instruments` daily for no reader anyone has;
 * only the names that actually cleared the shortlist cut are kept, so this
 * stays small and every row here is something a person might actually look
 * at. See `RADAR_DISCLAIMER` in `lib/radar/score.ts` for the "unvalidated
 * heuristic" framing every API response returning these rows must carry.
 */
export const radarScores = sqliteTable(
  'radar_scores',
  {
    id: id(),
    runId: text('run_id')
      .notNull()
      .references(() => radarRuns.id, { onDelete: 'cascade' }),
    tradingDay: text('trading_day').notNull(),
    symbol: text('symbol').notNull(),
    rank: integer('rank').notNull(),
    score: real('score').notNull(),
    momentumZ: real('momentum_z'),
    trendPct: real('trend_pct'),
    newHigh: integer('new_high', { mode: 'boolean' }).notNull().default(false),
    volumeRatio: real('volume_ratio'),
    volumeZ: real('volume_z'),
    sentimentZ: real('sentiment_z'),
    sentimentDocCount: integer('sentiment_doc_count').notNull().default(0),
    inputsUsed: text('inputs_used', { mode: 'json' }).$type<string[]>().notNull().default([]),
    createdAt: now(),
  },
  (t) => [
    uniqueIndex('radar_scores_day_symbol_uq').on(t.tradingDay, t.symbol),
    index('radar_scores_day_rank_idx').on(t.tradingDay, t.rank),
  ],
);

/**
 * One row per panel run — either the nightly pass over the radar's shortlist,
 * or an on-demand box query. `symbols` is the resolved, bounded candidate
 * list (never the full market); `callsMade` is written incrementally as
 * calls happen, not just at the end, so a crash mid-run still leaves an
 * honest count — the same reasoning as `capture_runs`' own incremental
 * `symbolsDone` writes.
 */
export const panelRuns = sqliteTable(
  'panel_runs',
  {
    id: id(),
    trigger: text('trigger', { enum: ['nightly_radar', 'box_query'] }).notNull(),
    /** Null for a radar-triggered run — there is no free-text question. */
    query: text('query'),
    resolutionMethod: text('resolution_method', {
      enum: ['ticker_match', 'thematic_match', 'radar_shortlist'],
    }).notNull(),
    symbols: text('symbols', { mode: 'json' }).$type<string[]>().notNull().default([]),
    status: text('status', { enum: ['running', 'done', 'partial', 'failed'] })
      .notNull()
      .default('running'),
    startedAt: text('started_at').notNull(),
    finishedAt: text('finished_at'),
    model: text('model').notNull(),
    callsMade: integer('calls_made').notNull().default(0),
    errors: text('errors', { mode: 'json' }).$type<string[]>().notNull().default([]),
  },
  (t) => [index('panel_runs_started_idx').on(t.startedAt)],
);

/**
 * The panel's verdict for one symbol within one run — never `bullish`/
 * `bearish`: `stance` stays off that axis entirely (see `synthesize.ts`) so
 * the top-line result can never be read as a trade signal, only as "the
 * panel found something concrete" or not.
 */
export const panelSymbolAnalyses = sqliteTable(
  'panel_symbol_analyses',
  {
    id: id(),
    runId: text('run_id')
      .notNull()
      .references(() => panelRuns.id, { onDelete: 'cascade' }),
    symbol: text('symbol').notNull(),
    stance: text('stance', { enum: ['notable', 'mixed', 'not_notable'] }).notNull(),
    summary: text('summary').notNull(),
    agreements: text('agreements', { mode: 'json' }).$type<string[]>().notNull().default([]),
    disagreements: text('disagreements', { mode: 'json' }).$type<string[]>().notNull().default([]),
    openQuestions: text('open_questions', { mode: 'json' }).$type<string[]>().notNull().default([]),
    /** False from insert until the real synthesis lands. Without this, a run
     * that crashes between the placeholder insert and the final update
     * (budget exhaustion, a network failure) leaves a row with
     * `stance: 'not_notable', summary: ''` that is bit-for-bit identical to
     * a symbol the panel genuinely finished and found unremarkable — this
     * column is the only thing that tells the two cases apart. */
    synthesisComplete: integer('synthesis_complete', { mode: 'boolean' }).notNull().default(false),
    createdAt: now(),
  },
  (t) => [uniqueIndex('panel_symbol_run_uq').on(t.runId, t.symbol)],
);

/**
 * The literal thought process — one row per specialist, per round, per
 * symbol. `respondingTo`/`revisedPosition` are null in round 1 (nothing to
 * respond to yet) and set in round 2, which is conditioned on round 1's
 * real transcript — see `specialists.ts`'s own doc comment for why that
 * transcript, not a summary of it, is what round 2 actually reads.
 */
export const panelAgentTurns = sqliteTable(
  'panel_agent_turns',
  {
    id: id(),
    analysisId: text('analysis_id')
      .notNull()
      .references(() => panelSymbolAnalyses.id, { onDelete: 'cascade' }),
    round: integer('round').notNull(),
    agent: text('agent', { enum: ['momentum', 'fundamentals', 'news_sentiment', 'skeptic'] }).notNull(),
    stance: text('stance', { enum: ['bullish', 'bearish', 'neutral'] }).notNull(),
    confidence: text('confidence', { enum: ['low', 'medium', 'high'] }).notNull(),
    reasoning: text('reasoning').notNull(),
    citedInputs: text('cited_inputs', { mode: 'json' }).$type<string[]>().notNull().default([]),
    /** Round 1 only ever has null here — there is nothing to respond to yet. */
    respondingTo: text('responding_to', { mode: 'json' }).$type<string[]>(),
    revisedPosition: integer('revised_position', { mode: 'boolean' }),
    createdAt: now(),
  },
  (t) => [index('panel_turns_analysis_round_idx').on(t.analysisId, t.round)],
);

/**
 * One row per real-estate analysis run. Unlike the stock panel (one run
 * covers many symbols, a genuine one-to-many fan-out), one run here is
 * always exactly one property analyzed by exactly two agents over two
 * rounds plus one manager synthesis — a fixed shape, so each agent
 * round's structured output gets its own nullable JSON column instead of
 * a child `*_turns` table. `computedFinancials` is written at insert time
 * (the sidecar call that produces it happens before this row exists at
 * all — see `run.ts`), so a client polling mid-run already sees real
 * numbers, not a placeholder.
 */
export const realEstateRuns = sqliteTable(
  're_runs',
  {
    id: id(),
    status: text('status', { enum: ['running', 'done', 'partial', 'failed'] })
      .notNull()
      .default('running'),
    startedAt: text('started_at').notNull(),
    finishedAt: text('finished_at'),
    model: text('model').notNull(),
    callsMade: integer('calls_made').notNull().default(0),
    /** Visibility only — see `budget.ts`'s own comment on why this isn't
     * enforced against the call budget. */
    webSearchesUsed: integer('web_searches_used').notNull().default(0),
    errors: text('errors', { mode: 'json' }).$type<string[]>().notNull().default([]),
    propertyInput: text('property_input', { mode: 'json' }).$type<PropertyInput>().notNull(),
    computedFinancials: text('computed_financials', { mode: 'json' }).$type<ComputedFinancials>().notNull(),
    locationRound1: text('location_round1', { mode: 'json' }).$type<LocationAgentResult>(),
    locationRound2: text('location_round2', { mode: 'json' }).$type<LocationAgentResult>(),
    rentalRound1: text('rental_round1', { mode: 'json' }).$type<RentalAgentResult>(),
    rentalRound2: text('rental_round2', { mode: 'json' }).$type<RentalAgentResult>(),
    managerResult: text('manager_result', { mode: 'json' }).$type<ManagerSynthesisResult>(),
    balancePlacement: text('balance_placement', { mode: 'json' }).$type<BalancePlacement>(),
    /** Same role as `panelSymbolAnalyses.synthesisComplete` — false until
     * the manager's real result lands, so a run interrupted after the
     * insert is never mistaken for one that finished. */
    synthesisComplete: integer('synthesis_complete', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [index('re_runs_started_idx').on(t.startedAt)],
);

export const fxRates = sqliteTable(
  'fx_rates',
  {
    id: id(),
    base: text('base').notNull(),
    quote: text('quote').notNull(),
    rate: real('rate').notNull(),
    asOf: text('as_of').notNull(),
  },
  (t) => [uniqueIndex('fx_pair_date_uq').on(t.base, t.quote, t.asOf)],
);

// ---------------------------------------------------------------------------
// Ideas
// ---------------------------------------------------------------------------

export const ideas = sqliteTable('ideas', {
  id: id(),
  title: text('title').notNull(),
  body: text('body').notNull().default(''),
  tags: text('tags', { mode: 'json' }).$type<string[]>().notNull().default([]),
  status: text('status', { enum: ['seed', 'growing', 'parked', 'shipped'] })
    .notNull()
    .default('seed'),
  createdAt: now(),
  updatedAt: text('updated_at').notNull(),
});

export const ideaLinks = sqliteTable(
  'idea_links',
  {
    id: id(),
    ideaId: text('idea_id')
      .notNull()
      .references(() => ideas.id, { onDelete: 'cascade' }),
    targetType: text('target_type', { enum: ['idea', 'project', 'task'] }).notNull(),
    targetId: text('target_id').notNull(),
  },
  (t) => [uniqueIndex('idea_link_uq').on(t.ideaId, t.targetType, t.targetId)],
);

/** Single-row key/value store for app settings. */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const projectRelations = relations(projects, ({ many }) => ({
  tasks: many(tasks),
}));

export const taskRelations = relations(tasks, ({ one }) => ({
  project: one(projects, { fields: [tasks.projectId], references: [projects.id] }),
}));

export const itemRelations = relations(plaidItems, ({ many }) => ({
  accounts: many(accounts),
}));

export const accountRelations = relations(accounts, ({ one, many }) => ({
  item: one(plaidItems, { fields: [accounts.itemId], references: [plaidItems.id] }),
  transactions: many(transactions),
}));

export const transactionRelations = relations(transactions, ({ one }) => ({
  account: one(accounts, { fields: [transactions.accountId], references: [accounts.id] }),
  category: one(categories, { fields: [transactions.categoryId], references: [categories.id] }),
}));

export const categoryRelations = relations(categories, ({ many }) => ({
  transactions: many(transactions),
  rules: many(categoryRules),
  budgets: many(budgets),
}));

export const ideaRelations = relations(ideas, ({ many }) => ({
  links: many(ideaLinks),
}));
