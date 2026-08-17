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
const DEFAULT_RULES: Array<[pattern: string, category: string, priority?: number]> = [
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

  /**
   * Outgoing e-transfers and bank bill payments, at priority 80 so they beat
   * the merchant rules below. That ordering is deliberate: `BELL MOBILITY
   * BPY/FAC` is both a Bell charge and a bill payment, and the bill-payment
   * reading is the one being asked for here. Correcting any single transaction
   * still wins, since learned rules sit at 50.
   *
   * Patterns are matched after `normalizeDescription`, which strips
   * punctuation — so 'bpy/fac' matches the 'bpy fac' the description becomes.
   * CIBC and BMO both write the abbreviated 'ETRNSFR', not 'e-transfer',
   * which is why the seeded 'e-transfer' rule above never fired on them.
   */
  ['etrnsfr sent', 'E-Transfer Sent', 80],
  ['e-transfer sent', 'E-Transfer Sent', 80],
  ['etransfer sent', 'E-Transfer Sent', 80],
  ['etrnsfr recvd', 'E-Transfer Received', 80],
  ['e-transfer received', 'E-Transfer Received', 80],
  ['bpy/fac', 'Bill Payment', 80],
  ['bill payment', 'Bill Payment', 80],
  ['bill pay', 'Bill Payment', 80],
  ['nsf fee', 'Fees & Charges'], ['overdraft', 'Fees & Charges'], ['annual fee', 'Fees & Charges'],
];

/**
 * Inserts any default rule that isn't already present, keyed by pattern. Safe
 * to run on every startup.
 *
 * Additive rather than all-or-nothing, so a rule added to the list above
 * reaches a database that was seeded before it existed. The cost is that a
 * default you delete comes back on the next restart — delete it again, or
 * point it somewhere else by correcting a transaction, which writes a
 * priority-50 rule that outranks every default here.
 */
export function seedDefaultRules(): number {
  const existing = new Set(
    db.select({ pattern: categoryRules.pattern }).from(categoryRules).all().map((r) => r.pattern),
  );

  const rows = DEFAULT_RULES.flatMap(([pattern, categoryName, priority]) => {
    if (existing.has(pattern)) return [];
    const categoryId = categoryIdByName(categoryName);
    if (!categoryId) return [];
    return [
      {
        id: newId(),
        matchType: 'contains' as const,
        pattern,
        categoryId,
        priority: priority ?? 100,
        createdAt: nowIso(),
      },
    ];
  });

  if (rows.length > 0) db.insert(categoryRules).values(rows).onConflictDoNothing().run();
  return rows.length;
}

/** The id transactions fall back to when no rule matches. */
export function uncategorizedId(): string | null {
  const row = db.select().from(categories).where(eq(categories.name, 'Uncategorized')).get();
  return row?.id ?? null;
}
