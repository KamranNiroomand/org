import { asc, eq, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { accounts, categoryRules, categories, transactions } from '../db/schema.js';
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

/**
 * A positive amount means money arrived, but *why* depends entirely on what
 * kind of account it arrived in, and no amount of merchant-text matching can
 * tell the difference — "AMEX" appearing in a description means one thing on
 * a chequing account (a fee, an annual charge) and something else entirely on
 * the Amex card itself (a payment or a refund). This runs first, before the
 * merchant-pattern rules, specifically for that reason: it looks at the
 * account, not the text.
 */
export interface AccountAwareCategorizable extends Categorizable {
  accountType: string;
  accountSubtype: string | null;
  personalFinanceCategory: string | null;
}

/**
 * A credit card structurally has only two sources of incoming money: you
 * paying it down, or a merchant reversing a charge. Plaid's own
 * `personal_finance_category` is checked first — its `LOAN_PAYMENTS` primary
 * category is a reliable, bank-independent signal — and falls back to
 * matching common wording only for transactions synced before that field
 * existed. Refunds get no positive pattern to match against: a refund
 * carries the same merchant text as the purchase it reverses ("AMAZON.CA"
 * either way), so "not identified as a payment" is treated as the refund
 * case by elimination rather than by a pattern that could not exist.
 */
const PAYMENT_TEXT_PATTERNS = [
  'payment thank you', 'paiement', 'autopay', 'auto payment',
  'online payment', 'web payment', 'bill payment', 'preauthorized payment',
];

/**
 * Interest postings are near-universally labelled by the bank itself — this
 * is the one case where matching on text is *more* reliable than guessing,
 * because "interest paid" or "intérêt" is standard banking language rather
 * than a merchant's own inconsistent wording. Anything else positive on a
 * savings account (an e-transfer in, a manual top-up) is a deposit by
 * elimination — there is no third case a savings account can produce.
 */
const INTEREST_TEXT_PATTERNS = ['interest', 'intérêt', 'intere'];

/**
 * Returns a category *name* (not id — resolved by the caller, which already
 * has the id lookup wired for rule-based categories) for the account-context
 * cases this function owns, or null to fall through to the merchant-pattern
 * rules. Only ever consulted for positive amounts: a purchase or a
 * withdrawal is unambiguous regardless of account type, so this has nothing
 * to add there.
 */
export function classifyByAccountContext(tx: AccountAwareCategorizable): string | null {
  if (!(tx.amount && tx.amount > 0)) return null;
  const haystack = normalizeDescription(`${tx.merchantName ?? ''} ${tx.name}`);

  if (tx.accountType === 'credit') {
    const isPayment =
      tx.personalFinanceCategory === 'LOAN_PAYMENTS' ||
      PAYMENT_TEXT_PATTERNS.some((p) => haystack.includes(p));
    return isPayment ? 'Credit Card Payment' : 'Refunds';
  }

  if (tx.accountType === 'depository' && tx.accountSubtype === 'savings') {
    const isInterest = INTEREST_TEXT_PATTERNS.some((p) => haystack.includes(p));
    return isInterest ? 'Interest & Dividends' : null; // null: see summary.ts's Deposit bucket
  }

  return null;
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

  const pending = db
    .select({
      id: transactions.id,
      name: transactions.name,
      merchantName: transactions.merchantName,
      amount: transactions.amount,
      personalFinanceCategory: transactions.personalFinanceCategory,
      accountType: accounts.type,
      accountSubtype: accounts.subtype,
    })
    .from(transactions)
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(isNull(transactions.categoryId))
    .all();

  if (pending.length === 0) return 0;

  // Resolved once, not per row: classifyByAccountContext returns a name from
  // a fixed, known set, so there is no reason to hit categoryIdByName's
  // lookup — a full table scan under the hood — inside the loop.
  const accountContextIds = new Map(
    ['Credit Card Payment', 'Refunds', 'Interest & Dividends'].map((name) => [
      name,
      categoryIdByName(name),
    ]),
  );

  let assigned = 0;
  db.transaction((tx) => {
    for (const row of pending) {
      const contextName = classifyByAccountContext(row);
      const categoryId = contextName ? accountContextIds.get(contextName) : categorizeOne(row, rules);
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
const DEFAULT_RULES: Array<
  [pattern: string, category: string, priority?: number, matchType?: 'contains' | 'regex']
> = [
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

  /**
   * BMO and CIBC label transactions with bilingual three-letter codes rather
   * than merchant names, and the largest amounts in the ledger are these — not
   * spending at all, but money moving between the account holder's own
   * accounts. Left uncategorized they dwarf every real purchase and make the
   * spending total meaningless.
   *
   * Priority 70 puts them ahead of everything except a human correction. They
   * have to outrank the merchant rules because several carry a bank or brand
   * name that would otherwise win — TANGERINE, CIBC VISA, WS INVESTMENTS.
   */
  ['cw tf', 'Transfer', 70],
  ['trsf from', 'Transfer', 70],
  ['ftd/rii', 'Transfer', 70],
  ['inv/pla', 'Transfer', 70],
  ['cibc visa', 'Credit Card Payment', 70],

  // Payroll, tax, and insurance codes.
  ['pay/pay', 'Salary', 75],
  ['txd/dim', 'Taxes', 75],
  ['paysimply', 'Taxes', 75],
  ['ins/ass', 'Insurance', 75],

  // Bank charges and their reversals. The rebates must outrank the charge
  // itself, since 'service charge discount' contains 'service charge'.
  ['service charge discount', 'Refunds', 74],
  ['full plan fee rebate', 'Refunds', 74],
  ['cash back', 'Refunds', 75],
  ['service charge', 'Fees & Charges', 75],
  ['performance plan', 'Fees & Charges', 75],
  ['annual card fee', 'Fees & Charges', 75],
  ['o/d per item', 'Fees & Charges', 75],
  // Bare '[IN]' interest postings carry no description. Matched by regex on the
  // raw text because normalization reduces the tag to 'in', and a 'contains'
  // rule for that would swallow most of the ledger.
  ['^\\s*\\[IN\\]', 'Interest & Dividends', 75, 'regex'],

  // Merchants actually present in this ledger, beyond the national chains.
  ['marshalls', 'Shopping'], ['homesens', 'Shopping'], ['winners', 'Shopping'],
  ['bureau en gros', 'Shopping'], ['staples', 'Shopping'], ['jomashop', 'Shopping'],
  ['ebay', 'Shopping'], ['on sportswear', 'Shopping'], ['coohom', 'Shopping'],
  ['dicks and company', 'Shopping'], ['cpc / scp', 'Shopping'], ['dhl', 'Shopping'],
  ['dominion', 'Groceries'], ['superstore', 'Groceries'],
  ['kelsey', 'Restaurants'], ['harvey', 'Restaurants'], ['mary brown', 'Restaurants'],
  ['pizza', 'Restaurants'], ['pizzeria', 'Restaurants'], ['poulet', 'Restaurants'],
  ['fuddruckers', 'Restaurants'], ['spaghetti', 'Restaurants'], ['grill', 'Restaurants'],
  ['deli', 'Restaurants'], ['popeyes', 'Restaurants'], ['kfc', 'Restaurants'],
  ['subway', 'Restaurants'], ['blue on water', 'Restaurants'], ['fish exchange', 'Restaurants'],
  ['smachno', 'Restaurants'], ['la buche', 'Restaurants'], ['slice and soda', 'Restaurants'],
  ['speakeatery', 'Restaurants'], ['paddy wagon', 'Restaurants'], ['sumac', 'Restaurants'],
  ['kooko', 'Restaurants'], ['meltwich', 'Restaurants'], ['tst-', 'Restaurants'],
  ['cafe', 'Coffee'],
  ['taxi', 'Transport'], ['parking', 'Transport'], ['pkg pay stn', 'Transport'],
  ['stm ', 'Transport'], ['fine motors', 'Transport'],
  ['couche tard', 'Fuel'],
  ['clinic', 'Health'], ['pharma', 'Health'], ['barber', 'Health'],
  ['hertz', 'Travel'],
  ['namecheap', 'Subscriptions'], ['upwork', 'Subscriptions'], ['hedra', 'Subscriptions'],
  // Skip+ is a recurring membership, not a meal — it must outrank the
  // 'skipthedishes' rule that sends food orders to Restaurants.
  ['skipplus', 'Subscriptions', 90],
  ['paramount', 'Restaurants'],
  ['pykd', 'Shopping'],
  ['pur simple', 'Restaurants'],

  /**
   * Branch transactions carry a branch number and no description. The one in
   * this ledger funded a same-day Wealthsimple contribution and nets to zero
   * in chequing, so the deposit is a transfer rather than income; the $10
   * beside it is the branch's fee for the service. The [NS] and [DC] tags are
   * what separate the two — the rest of the text is identical.
   */
  ['ns br', 'Transfer', 75],
  ['dc br', 'Fees & Charges', 75],

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

  const rows = DEFAULT_RULES.flatMap(([pattern, categoryName, priority, matchType]) => {
    if (existing.has(pattern)) return [];
    const categoryId = categoryIdByName(categoryName);
    if (!categoryId) return [];
    return [
      {
        id: newId(),
        matchType: matchType ?? ('contains' as const),
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
