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
  kind: 'expense' | 'income' | 'transfer' | 'payment' | 'refund';
  color: string;
  icon: string;
}> = [
  // Income
  { name: 'Salary', kind: 'income', color: 'emerald', icon: 'banknote' },
  { name: 'Interest & Dividends', kind: 'income', color: 'emerald', icon: 'trending-up' },
  // Real money back, but not earnings — crediting it as income would
  // overstate what came in. Kept separate from every other bucket so it
  // is visible without inflating any of them; see the summary endpoint.
  { name: 'Refunds', kind: 'refund', color: 'emerald', icon: 'undo-2' },
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
  // Not a transfer in the excluded-from-everything sense: the paying
  // account usually is not synced, so there is nothing to net this
  // against, and hiding it the way an ordinary transfer is hidden would
  // make real money disappear from every dashboard total silently.
  { name: 'Credit Card Payment', kind: 'payment', color: 'slate', icon: 'credit-card' },
];

/**
 * Inserts any missing system category, and reconciles `kind` on ones that
 * already exist. Safe to run on every startup.
 *
 * Only `kind` is reconciled, never name/color/icon — those are cosmetic and
 * fair game for a user to change by hand, but `kind` decides which dashboard
 * total a transaction lands in, and a category defined here as `payment`
 * that was seeded before that value existed (as `transfer`) would otherwise
 * stay wrong forever. Existing transactions already tagged with that
 * category are unaffected by name — only the category row's own `kind`
 * changes, and every transaction pointing at it is reclassified for free.
 */
export function seedCategories(): number {
  const existing = new Map(
    db.select({ name: categories.name, kind: categories.kind }).from(categories).all().map((c) => [c.name, c.kind]),
  );

  const missing = SYSTEM_CATEGORIES.filter((c) => !existing.has(c.name));
  if (missing.length > 0) {
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
  }

  let reconciled = 0;
  for (const c of SYSTEM_CATEGORIES) {
    const currentKind = existing.get(c.name);
    if (currentKind !== undefined && currentKind !== c.kind) {
      db.update(categories).set({ kind: c.kind }).where(sql`${categories.name} = ${c.name}`).run();
      reconciled++;
    }
  }

  return missing.length + reconciled;
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
