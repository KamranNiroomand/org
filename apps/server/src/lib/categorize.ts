import { asc, eq, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { categoryRules, categories, transactions } from '../db/schema.js';
import { categoryIdByName } from '../db/categories.js';
import { newId, nowIso, normalizeDescription } from './util.js';

/**
 * Rules-based auto-categorization.
 *
 * Rules are ordered by `priority` (lower wins) and the first match sticks.
 * Ordering matters: a specific rule like "TIM HORTONS → Coffee" has to beat a
 * broad one like "contains 'restaurant' → Restaurants", so specific rules are
 * created at a lower priority number than general ones.
 *
 * A rule never overwrites a category a human set by hand. That's the whole
 * bargain — the system guesses, you correct it, and your correction is final.
 */

export interface CompiledRule {
  id: string;
  matchType: 'merchant' | 'contains' | 'regex';
  pattern: string;
  categoryId: string;
  priority: number;
  regex: RegExp | null;
}

export function loadRules(): CompiledRule[] {
  return db
    .select()
    .from(categoryRules)
    .orderBy(asc(categoryRules.priority), asc(categoryRules.createdAt))
    .all()
    .map((r) => ({
      ...r,
      regex:
        r.matchType === 'regex'
          ? (() => {
              try {
                return new RegExp(r.pattern, 'i');
              } catch {
                // A malformed pattern shouldn't take the whole sync down; the
                // rule simply never matches until it's fixed.
                return null;
              }
            })()
          : null,
    }));
}

export interface Categorizable {
  name: string;
  merchantName?: string | null;
  amount?: number;
}

/** Returns the category id for a transaction, or null when nothing matches. */
export function categorizeOne(tx: Categorizable, rules: CompiledRule[]): string | null {
  const haystack = normalizeDescription(`${tx.merchantName ?? ''} ${tx.name}`);
  const merchant = normalizeDescription(tx.merchantName ?? '');

  for (const rule of rules) {
    const needle = normalizeDescription(rule.pattern);

    switch (rule.matchType) {
      case 'merchant':
        if (merchant && needle && merchant === needle) return rule.categoryId;
        break;
      case 'contains':
        if (needle && haystack.includes(needle)) return rule.categoryId;
        break;
      case 'regex':
        if (rule.regex?.test(`${tx.merchantName ?? ''} ${tx.name}`)) return rule.categoryId;
        break;
    }
  }
  return null;
}

/**
 * Categorizes every uncategorized transaction. Returns how many were assigned.
 * Runs after each sync and after any rule change.
 */
export function categorizeUncategorized(): number {
  const rules = loadRules();
  if (rules.length === 0) return 0;

  const pending = db
    .select({
      id: transactions.id,
      name: transactions.name,
      merchantName: transactions.merchantName,
      amount: transactions.amount,
    })
    .from(transactions)
    .where(isNull(transactions.categoryId))
    .all();

  let assigned = 0;
  db.transaction((tx) => {
    for (const row of pending) {
      const categoryId = categorizeOne(row, rules);
      if (!categoryId) continue;
      tx.update(transactions)
        .set({ categoryId })
        .where(eq(transactions.id, row.id))
        .run();
      assigned++;
    }
  });

  return assigned;
}

/**
 * Creates a rule from a correction the user just made — the "always categorize
 * Loblaws as Groceries" prompt. Uses the merchant name when there is one, since
 * that's the most stable identifier a bank gives us, and falls back to the
 * cleaned description otherwise.
 */
export function learnRule(
  merchantName: string | null,
  description: string,
  categoryId: string,
): CompiledRule | null {
  const pattern = merchantName?.trim() || normalizeDescription(description);
  if (!pattern) return null;

  const existing = db
    .select()
    .from(categoryRules)
    .where(eq(categoryRules.pattern, pattern))
    .get();

  if (existing) {
    db.update(categoryRules).set({ categoryId }).where(eq(categoryRules.id, existing.id)).run();
    return { ...existing, categoryId, regex: null };
  }

  // Priority 50 puts learned rules ahead of the seeded defaults at 100 — an
  // explicit correction should always beat a shipped guess.
  const row = {
    id: newId(),
    matchType: merchantName ? ('merchant' as const) : ('contains' as const),
    pattern,
    categoryId,
    priority: 50,
    createdAt: nowIso(),
  };
  db.insert(categoryRules).values(row).run();
  return { ...row, regex: null };
}

/**
 * Default rules covering common Canadian merchants, seeded once so the very
 * first import lands somewhere sensible rather than entirely in Uncategorized.
 */
const DEFAULT_RULES: Array<[pattern: string, category: string]> = [
  ['loblaws', 'Groceries'], ['no frills', 'Groceries'], ['sobeys', 'Groceries'],
  ['metro', 'Groceries'], ['food basics', 'Groceries'], ['freshco', 'Groceries'],
  ['costco', 'Groceries'], ['walmart', 'Groceries'], ['farm boy', 'Groceries'],
  ['tim hortons', 'Coffee'], ['starbucks', 'Coffee'], ['second cup', 'Coffee'],
  ['mcdonald', 'Restaurants'], ['uber eats', 'Restaurants'], ['doordash', 'Restaurants'],
  ['skipthedishes', 'Restaurants'], ['restaurant', 'Restaurants'],
  ['presto', 'Transport'], ['ttc', 'Transport'], ['uber', 'Transport'], ['lyft', 'Transport'],
  ['petro-canada', 'Fuel'], ['esso', 'Fuel'], ['shell', 'Fuel'], ['husky', 'Fuel'],
  ['amazon', 'Shopping'], ['ikea', 'Shopping'], ['canadian tire', 'Shopping'],
  ['winners', 'Shopping'], ['best buy', 'Shopping'],
  ['rogers', 'Phone & Internet'], ['bell', 'Phone & Internet'], ['telus', 'Phone & Internet'],
  ['freedom mobile', 'Phone & Internet'], ['fido', 'Phone & Internet'],
  ['hydro', 'Utilities'], ['enbridge', 'Utilities'],
  ['netflix', 'Subscriptions'], ['spotify', 'Subscriptions'], ['apple.com/bill', 'Subscriptions'],
  ['google storage', 'Subscriptions'], ['openai', 'Subscriptions'], ['anthropic', 'Subscriptions'],
  ['shoppers drug mart', 'Health'], ['rexall', 'Health'], ['pharmacy', 'Health'],
  ['cineplex', 'Entertainment'], ['steam', 'Entertainment'],
  ['air canada', 'Travel'], ['westjet', 'Travel'], ['airbnb', 'Travel'],
  ['payroll', 'Salary'], ['direct deposit', 'Salary'], ['paye', 'Salary'],
  ['interest', 'Interest & Dividends'], ['dividend', 'Interest & Dividends'],
  ['payment - thank you', 'Credit Card Payment'], ['paiement', 'Credit Card Payment'],
  ['e-transfer', 'Transfer'], ['transfer', 'Transfer'],
  ['nsf fee', 'Fees & Charges'], ['overdraft', 'Fees & Charges'], ['annual fee', 'Fees & Charges'],
];

/** Inserts default rules if none exist. Safe to run on every startup. */
export function seedDefaultRules(): number {
  const count = db.select({ id: categoryRules.id }).from(categoryRules).all().length;
  if (count > 0) return 0;

  const rows = DEFAULT_RULES.flatMap(([pattern, categoryName]) => {
    const categoryId = categoryIdByName(categoryName);
    if (!categoryId) return [];
    return [
      {
        id: newId(),
        matchType: 'contains' as const,
        pattern,
        categoryId,
        priority: 100,
        createdAt: nowIso(),
      },
    ];
  });

  if (rows.length > 0) db.insert(categoryRules).values(rows).run();
  return rows.length;
}

/** The id transactions fall back to when no rule matches. */
export function uncategorizedId(): string | null {
  const row = db.select().from(categories).where(eq(categories.name, 'Uncategorized')).get();
  return row?.id ?? null;
}
