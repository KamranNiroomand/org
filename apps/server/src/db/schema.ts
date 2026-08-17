import { relations } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

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
    createdAt: now(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('tasks_due_idx').on(t.dueOn),
    index('tasks_status_idx').on(t.status),
    index('tasks_project_idx').on(t.projectId),
  ],
);

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
     * Whether this account feeds the summary tiles, cashflow, and category
     * breakdown. Balances and the account list always show every account —
     * this only governs the aggregates, so a joint account or a dormant
     * savings account can be kept visible without skewing the charts.
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
    kind: text('kind', { enum: ['expense', 'income', 'transfer'] })
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
