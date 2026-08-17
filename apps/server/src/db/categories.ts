import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from './index.js';
import { categories } from './schema.js';

/**
 * The starting category set, chosen to line up with how Plaid's Personal
 * Finance Category taxonomy carves up spending — so imported transactions map
 * onto something sensible without the user configuring anything first.
 *
 * These are marked `isSystem` so the UI can stop them being deleted out from
 * under existing transactions, while still allowing a rename or recolour.
 */
const SYSTEM_CATEGORIES: Array<{
  name: string;
  kind: 'expense' | 'income' | 'transfer';
  color: string;
  icon: string;
}> = [
  // Income
  { name: 'Salary', kind: 'income', color: 'emerald', icon: 'banknote' },
  { name: 'Interest & Dividends', kind: 'income', color: 'emerald', icon: 'trending-up' },
  { name: 'Refunds', kind: 'income', color: 'emerald', icon: 'undo-2' },
  { name: 'Other Income', kind: 'income', color: 'emerald', icon: 'plus-circle' },

  // Everyday
  { name: 'Groceries', kind: 'expense', color: 'lime', icon: 'shopping-cart' },
  { name: 'Restaurants', kind: 'expense', color: 'orange', icon: 'utensils' },
  { name: 'Coffee', kind: 'expense', color: 'amber', icon: 'coffee' },
  { name: 'Transport', kind: 'expense', color: 'sky', icon: 'train-front' },
  { name: 'Fuel', kind: 'expense', color: 'sky', icon: 'fuel' },
  { name: 'Shopping', kind: 'expense', color: 'pink', icon: 'shopping-bag' },

  // Fixed
  { name: 'Rent & Mortgage', kind: 'expense', color: 'indigo', icon: 'home' },
  { name: 'Utilities', kind: 'expense', color: 'cyan', icon: 'zap' },
  { name: 'Phone & Internet', kind: 'expense', color: 'cyan', icon: 'wifi' },
  { name: 'Insurance', kind: 'expense', color: 'blue', icon: 'shield' },
  { name: 'Subscriptions', kind: 'expense', color: 'violet', icon: 'repeat' },

  // Life
  { name: 'Health', kind: 'expense', color: 'rose', icon: 'heart-pulse' },
  { name: 'Entertainment', kind: 'expense', color: 'fuchsia', icon: 'clapperboard' },
  { name: 'Travel', kind: 'expense', color: 'teal', icon: 'plane' },
  { name: 'Education', kind: 'expense', color: 'blue', icon: 'graduation-cap' },
  { name: 'Gifts & Donations', kind: 'expense', color: 'red', icon: 'gift' },
  { name: 'Fees & Charges', kind: 'expense', color: 'stone', icon: 'receipt' },

  // Money leaving that isn't a purchase. From this account's point of view an
  // e-transfer to a person and a bill paid through the bank are both genuine
  // spending, so they are expenses rather than transfers — which is what puts
  // them in "Where it went" instead of being excluded from it.
  { name: 'E-Transfer Sent', kind: 'expense', color: 'violet', icon: 'send' },
  { name: 'Bill Payment', kind: 'expense', color: 'amber', icon: 'file-text' },
  { name: 'Taxes', kind: 'expense', color: 'stone', icon: 'landmark' },
  { name: 'Uncategorized', kind: 'expense', color: 'slate', icon: 'circle-help' },

  // Transfers are neither income nor spending — excluding them is what stops a
  // credit-card payment being counted as an expense on top of the purchases it
  // settles, which would double-count every dollar.
  { name: 'Transfer', kind: 'transfer', color: 'slate', icon: 'arrow-left-right' },
  // Money arriving from a person rather than earned. Transfer-kind, so it is
  // visible in the ledger without inflating income.
  { name: 'E-Transfer Received', kind: 'transfer', color: 'slate', icon: 'move-down-left' },
  { name: 'Credit Card Payment', kind: 'transfer', color: 'slate', icon: 'credit-card' },
];

/** Inserts any missing system categories. Safe to run on every startup. */
export function seedCategories(): number {
  const existing = new Set(
    db.select({ name: categories.name }).from(categories).all().map((c) => c.name),
  );

  const missing = SYSTEM_CATEGORIES.filter((c) => !existing.has(c.name));
  if (missing.length === 0) return 0;

  db.insert(categories)
    .values(
      missing.map((c) => ({
        id: randomUUID(),
        name: c.name,
        parentId: null,
        kind: c.kind,
        color: c.color,
        icon: c.icon,
        isSystem: true,
      })),
    )
    // The unique index on name is the real guard; this keeps a concurrent
    // seed — two server processes overlapping on restart — from throwing.
    .onConflictDoNothing()
    .run();

  return missing.length;
}

/** Looks up a category id by name — used by the importer and rule engine. */
export function categoryIdByName(name: string): string | null {
  const row = db
    .select({ id: categories.id })
    .from(categories)
    .where(sql`lower(${categories.name}) = lower(${name})`)
    .get();
  return row?.id ?? null;
}

export { SYSTEM_CATEGORIES };
