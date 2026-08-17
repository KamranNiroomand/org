/**
 * Domain types shared by the server and the browser.
 *
 * These are the wire shapes — what crosses the HTTP boundary. They deliberately
 * use `string` for instants (UTC ISO-8601) rather than `Date`, because JSON has
 * no date type and a `Date` on one side becomes a string on the other. Parsing
 * happens explicitly at the edge.
 */

import type { CurrencyCode } from './money.js';

export type ID = string;
/** UTC ISO-8601, e.g. `2026-08-17T14:30:00.000Z`. */
export type Instant = string;
/** `YYYY-MM-DD`, a civil day with no timezone. */
export type CivilKey = string;

// ---------------------------------------------------------------------------
// Tasks & projects
// ---------------------------------------------------------------------------

export type TaskStatus = 'open' | 'done' | 'dropped';
export type Priority = 'none' | 'low' | 'medium' | 'high' | 'urgent';

export const PRIORITY_ORDER: Record<Priority, number> = {
  urgent: 0, high: 1, medium: 2, low: 3, none: 4,
};

export interface Task {
  id: ID;
  title: string;
  notes: string | null;
  status: TaskStatus;
  priority: Priority;
  /** Due *day*, not instant — "Friday" has no meaningful time of day. */
  dueOn: CivilKey | null;
  completedAt: Instant | null;
  projectId: ID | null;
  tags: string[];
  sortOrder: number;
  createdAt: Instant;
  updatedAt: Instant;
}

export type ProjectStatus = 'active' | 'paused' | 'done' | 'archived';

export interface Project {
  id: ID;
  name: string;
  description: string | null;
  status: ProjectStatus;
  color: string;
  targetOn: CivilKey | null;
  createdAt: Instant;
  updatedAt: Instant;
}

export interface ProjectWithStats extends Project {
  taskCount: number;
  doneCount: number;
  overdueCount: number;
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

export interface CalendarEvent {
  id: ID;
  title: string;
  notes: string | null;
  startsAt: Instant;
  endsAt: Instant;
  allDay: boolean;
  location: string | null;
  color: string;
  createdAt: Instant;
  updatedAt: Instant;
}

// ---------------------------------------------------------------------------
// Finances
// ---------------------------------------------------------------------------

export type AccountType = 'depository' | 'credit' | 'loan' | 'investment' | 'other';
export type TransactionSource = 'plaid' | 'csv' | 'manual';
export type CategoryKind = 'expense' | 'income' | 'transfer';

export interface Account {
  id: ID;
  itemId: ID | null;
  name: string;
  officialName: string | null;
  /** Last four digits. */
  mask: string | null;
  type: AccountType;
  subtype: string | null;
  currency: CurrencyCode;
  /** Minor units. For credit accounts, positive means money owed. */
  currentBalance: number | null;
  availableBalance: number | null;
  creditLimit: number | null;
  institutionName: string | null;
  isManual: boolean;
  lastSyncedAt: Instant | null;
}

export interface Transaction {
  id: ID;
  accountId: ID;
  /** Civil day the transaction is booked on. */
  date: CivilKey;
  authorizedDate: CivilKey | null;
  /**
   * Minor units, **normalized**: negative is money leaving the account,
   * positive is money arriving. Plaid's own convention is the inverse of this
   * and is flipped once, at the sync boundary.
   */
  amount: number;
  currency: CurrencyCode;
  name: string;
  merchantName: string | null;
  categoryId: ID | null;
  pending: boolean;
  isTransfer: boolean;
  notes: string | null;
  source: TransactionSource;
  createdAt: Instant;
}

export interface Category {
  id: ID;
  name: string;
  parentId: ID | null;
  kind: CategoryKind;
  color: string;
  icon: string | null;
  isSystem: boolean;
}

export type RuleMatch = 'merchant' | 'contains' | 'regex';

export interface CategoryRule {
  id: ID;
  matchType: RuleMatch;
  pattern: string;
  categoryId: ID;
  /** Lower runs first. */
  priority: number;
  createdAt: Instant;
}

export interface Budget {
  id: ID;
  categoryId: ID;
  /** `YYYY-MM`, or null for an every-month budget. */
  period: string | null;
  amount: number;
  currency: CurrencyCode;
}

export interface BudgetProgress {
  budget: Budget;
  category: Category;
  spent: number;
  remaining: number;
  /** 0-1, uncapped so overspend is visible. */
  ratio: number;
}

export type Cadence = 'weekly' | 'biweekly' | 'semimonthly' | 'monthly' | 'irregular';

export interface Recurring {
  id: ID;
  name: string;
  kind: 'income' | 'subscription';
  amount: number;
  currency: CurrencyCode;
  cadence: Cadence;
  accountId: ID | null;
  nextExpectedOn: CivilKey | null;
  /** 0-1. Below ~0.6 the pattern is a guess worth showing but not trusting. */
  confidence: number;
  lastSeenOn: CivilKey | null;
}

// ---------------------------------------------------------------------------
// Investments
// ---------------------------------------------------------------------------

export interface Holding {
  id: ID;
  symbol: string;
  name: string | null;
  quantity: number;
  /** Minor units, per share, in `currency`. */
  avgCost: number;
  currency: CurrencyCode;
  accountId: ID | null;
  createdAt: Instant;
}

export interface HoldingValuation extends Holding {
  /** Minor units per share; null when the quote lookup failed. */
  price: number | null;
  priceAsOf: Instant | null;
  marketValue: number | null;
  costBasis: number;
  unrealizedPL: number | null;
  unrealizedPLPercent: number | null;
  dayChangePercent: number | null;
  /** Market value converted to the base currency. */
  marketValueBase: number | null;
}

// ---------------------------------------------------------------------------
// Ideas
// ---------------------------------------------------------------------------

export type IdeaStatus = 'seed' | 'growing' | 'parked' | 'shipped';

export interface Idea {
  id: ID;
  title: string;
  body: string;
  tags: string[];
  status: IdeaStatus;
  createdAt: Instant;
  updatedAt: Instant;
}

export type ClaudeAction = 'expand' | 'critique' | 'breakdown' | 'relate';

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

export interface SyncResult {
  itemId: ID;
  institutionName: string;
  added: number;
  modified: number;
  removed: number;
  categorized: number;
  error: string | null;
  finishedAt: Instant;
}

export interface PlaidItemSummary {
  id: ID;
  institutionName: string;
  status: 'ok' | 'needs_reauth' | 'error';
  accountCount: number;
  lastSyncAt: Instant | null;
  error: string | null;
}
