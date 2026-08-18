import { describe, expect, it } from 'vitest';
import { accountBucket, computeSummaryTiles, type AccountBucket, type SummaryRow } from './financeSummary.js';

/**
 * The scenario that motivated this file: the real account composition this
 * project was actually running with when the bug was found — two credit
 * cards included in stats, no chequing, no savings — under which the old
 * sign-only logic counted a $500 card payment and a $35 merchant refund as
 * $535 of "income".
 */
const CREDIT_ONLY = new Map<string, AccountBucket>([
  ['visa', 'credit'],
  ['mastercard', 'credit'],
]);

describe('accountBucket', () => {
  it('routes credit accounts regardless of subtype', () => {
    expect(accountBucket('credit', 'credit card')).toBe('credit');
    expect(accountBucket('credit', null)).toBe('credit');
  });

  it('routes a savings subtype to savings, everything else depository to checking', () => {
    expect(accountBucket('depository', 'savings')).toBe('savings');
    expect(accountBucket('depository', 'checking')).toBe('checking');
    // A depository account with no distinct subtype, or one Plaid classifies
    // as something other than savings (money market, cd, hsa) — treated as
    // checking-like by default, since it can genuinely receive income and
    // the alternative (silently dropping it into "other") would be worse.
    expect(accountBucket('depository', null)).toBe('checking');
    expect(accountBucket('depository', 'money market')).toBe('checking');
  });

  it('routes loan and investment accounts to other', () => {
    expect(accountBucket('loan', 'line of credit')).toBe('other');
    expect(accountBucket('investment', null)).toBe('other');
  });
});

describe('computeSummaryTiles — the motivating bug', () => {
  it('does not count a card payment or a merchant refund as income, with only credit cards included', () => {
    const rows: SummaryRow[] = [
      // The $500 payment this session found mistagged and invisible.
      { accountId: 'visa', amount: 50000, categoryId: 'c1', categoryName: 'Credit Card Payment', categoryColor: 'slate', categoryKind: 'payment' },
      // The $35 refund this session found mistagged as income.
      { accountId: 'mastercard', amount: 3500, categoryId: 'c2', categoryName: 'Refunds', categoryColor: 'emerald', categoryKind: 'refund' },
      { accountId: 'visa', amount: -1200, categoryId: 'c3', categoryName: 'Groceries', categoryColor: 'lime', categoryKind: 'expense' },
    ];

    const result = computeSummaryTiles(rows, CREDIT_ONLY);

    // The core assertion: no checking account is included, so income must
    // not exist as a concept at all — not zero, absent.
    expect(result.income).toBeNull();
    expect(result.payments).toBe(50000);
    expect(result.refunds).toBe(3500);
    expect(result.expense).toBe(1200);
    // net excludes the payment (it is not new money — see the module
    // docstring) but includes the refund (it genuinely is).
    expect(result.net).toBe(3500 - 1200);
  });
});

describe('computeSummaryTiles — tile presence follows account composition, not transaction activity', () => {
  it('a savings-only month with zero interest still reports interest as 0, not null', () => {
    const savingsOnly = new Map<string, AccountBucket>([['tfsa', 'savings']]);
    const rows: SummaryRow[] = [
      { accountId: 'tfsa', amount: 10000, categoryId: null, categoryName: null, categoryColor: null, categoryKind: null },
    ];
    const result = computeSummaryTiles(rows, savingsOnly);
    expect(result.interest).toBe(0); // present (an account exists), just no interest posted
    expect(result.deposits).toBe(10000);
    expect(result.income).toBeNull(); // absent — no checking account exists at all
  });

  it('an included checking account with no transactions this month still reports income as 0', () => {
    const checkingOnly = new Map<string, AccountBucket>([['chequing', 'checking']]);
    const result = computeSummaryTiles([], checkingOnly);
    expect(result.income).toBe(0);
    expect(result.payments).toBeNull();
  });
});

describe('computeSummaryTiles — multiple account types produce multiple boxes', () => {
  it('checking and credit together surface both income and payments/refunds, not one blended figure', () => {
    const mixed = new Map<string, AccountBucket>([
      ['chequing', 'checking'],
      ['visa', 'credit'],
    ]);
    const rows: SummaryRow[] = [
      { accountId: 'chequing', amount: 250000, categoryId: null, categoryName: 'Salary', categoryColor: 'emerald', categoryKind: 'income' },
      { accountId: 'visa', amount: 50000, categoryId: null, categoryName: 'Credit Card Payment', categoryColor: 'slate', categoryKind: 'payment' },
    ];
    const result = computeSummaryTiles(rows, mixed);
    expect(result.income).toBe(250000);
    expect(result.payments).toBe(50000);
    // The $500 payment came out of chequing (visible on that side as a
    // negative), so it must not also inflate income on the checking side —
    // this row set has no negative chequing row, proving the two are
    // independent aggregates rather than one number derived from the other.
    expect(result.refunds).toBe(0);
  });

  it('all three types present at once produce five independent, correctly-scoped tiles', () => {
    const all = new Map<string, AccountBucket>([
      ['chequing', 'checking'],
      ['tfsa', 'savings'],
      ['visa', 'credit'],
    ]);
    const rows: SummaryRow[] = [
      { accountId: 'chequing', amount: 250000, categoryId: null, categoryName: null, categoryKind: null, categoryColor: null },
      { accountId: 'tfsa', amount: 412, categoryId: null, categoryName: 'Interest & Dividends', categoryKind: 'income', categoryColor: null },
      { accountId: 'tfsa', amount: 10000, categoryId: null, categoryName: null, categoryKind: null, categoryColor: null },
      { accountId: 'visa', amount: 50000, categoryId: null, categoryName: 'Credit Card Payment', categoryKind: 'payment', categoryColor: null },
      { accountId: 'visa', amount: 3500, categoryId: null, categoryName: 'Refunds', categoryKind: 'refund', categoryColor: null },
    ];
    const result = computeSummaryTiles(rows, all);
    expect(result.income).toBe(250000);
    expect(result.interest).toBe(412);
    expect(result.deposits).toBe(10000);
    expect(result.payments).toBe(50000);
    expect(result.refunds).toBe(3500);
  });
});

describe('computeSummaryTiles — expense and byCategory are unaffected by the new logic', () => {
  it('still aggregates negative amounts by category exactly as before', () => {
    const rows: SummaryRow[] = [
      { accountId: 'visa', amount: -1500, categoryId: 'c1', categoryName: 'Restaurants', categoryColor: 'orange', categoryKind: 'expense' },
      { accountId: 'visa', amount: -500, categoryId: 'c1', categoryName: 'Restaurants', categoryColor: 'orange', categoryKind: 'expense' },
      { accountId: 'visa', amount: -1000, categoryId: 'c2', categoryName: 'Groceries', categoryColor: 'lime', categoryKind: 'expense' },
    ];
    const result = computeSummaryTiles(rows, CREDIT_ONLY);
    expect(result.expense).toBe(3000);
    expect(result.byCategory).toEqual([
      { id: 'c1', name: 'Restaurants', color: 'orange', total: 2000 },
      { id: 'c2', name: 'Groceries', color: 'lime', total: 1000 },
    ]);
  });

  it('an uncategorized expense falls back to the Uncategorized bucket by id', () => {
    const rows: SummaryRow[] = [
      { accountId: 'visa', amount: -750, categoryId: null, categoryName: null, categoryColor: null, categoryKind: null },
    ];
    const result = computeSummaryTiles(rows, CREDIT_ONLY);
    expect(result.byCategory).toEqual([{ id: null, name: 'Uncategorized', color: 'slate', total: 750 }]);
  });
});

describe('computeSummaryTiles — an account not in the bucket map defaults to other', () => {
  it('does not crash and does not inflate income for an unmapped account', () => {
    const rows: SummaryRow[] = [
      { accountId: 'unknown-account', amount: 5000, categoryId: null, categoryName: null, categoryColor: null, categoryKind: null },
    ];
    const result = computeSummaryTiles(rows, CREDIT_ONLY);
    expect(result.income).toBeNull();
    expect(result.payments).toBe(0);
    expect(result.refunds).toBe(0);
    // Folded into net via otherIncome without a dedicated tile.
    expect(result.net).toBe(5000);
  });
});
