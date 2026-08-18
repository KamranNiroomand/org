import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { accounts, categories, transactions } from '../db/schema.js';
import { newId, nowIso } from './util.js';
import { categorizeUncategorized, classifyByAccountContext } from './categorize.js';

/**
 * classifyByAccountContext is the piece that fixes a real, live bug: with
 * only credit-card accounts included in stats, every positive amount on
 * them — a payment or a refund — was being counted as income, because the
 * summary previously decided "income" from the sign of the amount alone,
 * never the account it came from. These tests pin the account-context rule
 * directly; categorizeUncategorized below proves it end to end against the
 * database, using the same two categories (Credit Card Payment, Refunds)
 * this session found already sitting in production data — 8 and 6
 * transactions respectively — mistagged as transfer and income.
 */
describe('classifyByAccountContext', () => {
  it('routes a credit-card payment to Credit Card Payment via the Plaid category', () => {
    const result = classifyByAccountContext({
      name: 'PAYMENT RECEIVED - THANK YOU',
      merchantName: null,
      amount: 50000,
      accountType: 'credit',
      accountSubtype: 'credit card',
      personalFinanceCategory: 'LOAN_PAYMENTS',
    });
    expect(result).toBe('Credit Card Payment');
  });

  it('routes a credit-card payment via text pattern when no Plaid category exists', () => {
    // Real-world case: a transaction synced before personalFinanceCategory
    // was captured, or a bank Plaid does not classify finely.
    const result = classifyByAccountContext({
      name: 'PAIEMENT RECU MERCI',
      merchantName: null,
      amount: 20000,
      accountType: 'credit',
      accountSubtype: 'credit card',
      personalFinanceCategory: null,
    });
    expect(result).toBe('Credit Card Payment');
  });

  it('treats a positive credit-card amount that is not a payment as a refund', () => {
    // The real, motivating case: a merchant refund carries the exact same
    // merchant text as the original purchase — there is no positive pattern
    // to match, only the absence of a payment signal.
    const result = classifyByAccountContext({
      name: 'AMAZON.CA',
      merchantName: 'Amazon',
      amount: 3499,
      accountType: 'credit',
      accountSubtype: 'credit card',
      personalFinanceCategory: 'GENERAL_MERCHANDISE',
    });
    expect(result).toBe('Refunds');
  });

  it('routes savings interest to Interest & Dividends', () => {
    const result = classifyByAccountContext({
      name: 'INTEREST PAID',
      merchantName: null,
      amount: 412,
      accountType: 'depository',
      accountSubtype: 'savings',
      personalFinanceCategory: null,
    });
    expect(result).toBe('Interest & Dividends');
  });

  it('leaves a non-interest savings deposit unclassified, for the summary endpoint to bucket', () => {
    const result = classifyByAccountContext({
      name: 'E-TRANSFER RECEIVED',
      merchantName: null,
      amount: 10000,
      accountType: 'depository',
      accountSubtype: 'savings',
      personalFinanceCategory: null,
    });
    expect(result).toBeNull();
  });

  it('does not classify a negative amount on any account type', () => {
    // A purchase or a withdrawal is unambiguous regardless of account —
    // this function has nothing to add there.
    expect(
      classifyByAccountContext({
        name: 'STARBUCKS',
        merchantName: 'Starbucks',
        amount: -650,
        accountType: 'credit',
        accountSubtype: 'credit card',
        personalFinanceCategory: null,
      }),
    ).toBeNull();
  });

  it('falls through on a chequing account — merchant-pattern rules own that case', () => {
    expect(
      classifyByAccountContext({
        name: 'PAYROLL DEPOSIT',
        merchantName: null,
        amount: 250000,
        accountType: 'depository',
        accountSubtype: 'checking',
        personalFinanceCategory: null,
      }),
    ).toBeNull();
  });
});

describe('categorizeUncategorized — account-context integration', () => {
  let creditAccountId: string;
  let checkingAccountId: string;

  beforeEach(() => {
    runMigrations();
    db.delete(transactions).run();
    db.delete(accounts).run();
    creditAccountId = newId();
    checkingAccountId = newId();
    db.insert(accounts)
      .values([
        { id: creditAccountId, name: 'Visa', type: 'credit', subtype: 'credit card', currency: 'CAD', createdAt: nowIso() },
        { id: checkingAccountId, name: 'Chequing', type: 'depository', subtype: 'checking', currency: 'CAD', createdAt: nowIso() },
      ])
      .run();
  });

  it('assigns a real credit-card payment to Credit Card Payment, not income', () => {
    const txId = newId();
    db.insert(transactions)
      .values({
        id: txId,
        accountId: creditAccountId,
        date: '2026-08-01',
        amount: 50000,
        currency: 'CAD',
        name: 'PAYMENT THANK YOU',
        merchantName: null,
        categoryId: null,
        isTransfer: false,
        notes: null,
        importHash: null,
        createdAt: nowIso(),
      })
      .run();

    const assigned = categorizeUncategorized();
    expect(assigned).toBe(1);

    const row = db
      .select({ name: categories.name, kind: categories.kind })
      .from(transactions)
      .innerJoin(categories, eq(transactions.categoryId, categories.id))
      .where(eq(transactions.id, txId))
      .get()!;
    expect(row.name).toBe('Credit Card Payment');
    expect(row.kind).toBe('payment');
  });

  it('assigns a credit-card refund to Refunds, not income', () => {
    const txId = newId();
    db.insert(transactions)
      .values({
        id: txId,
        accountId: creditAccountId,
        date: '2026-08-02',
        amount: 3499,
        currency: 'CAD',
        name: 'AMAZON.CA',
        merchantName: 'Amazon',
        categoryId: null,
        isTransfer: false,
        notes: null,
        importHash: null,
        createdAt: nowIso(),
      })
      .run();

    categorizeUncategorized();
    const row = db
      .select({ name: categories.name, kind: categories.kind })
      .from(transactions)
      .innerJoin(categories, eq(transactions.categoryId, categories.id))
      .where(eq(transactions.id, txId))
      .get()!;
    expect(row.name).toBe('Refunds');
    expect(row.kind).toBe('refund');
  });

  it('leaves chequing-account categorization to the merchant-pattern rules', () => {
    const txId = newId();
    db.insert(transactions)
      .values({
        id: txId,
        accountId: checkingAccountId,
        date: '2026-08-03',
        amount: -1250,
        currency: 'CAD',
        name: 'ZUPERMARKET GROCERIES',
        merchantName: null,
        categoryId: null,
        isTransfer: false,
        notes: null,
        importHash: null,
        createdAt: nowIso(),
      })
      .run();

    // No rule exists for this made-up merchant, so this proves the
    // account-context path stays out of the way rather than mis-assigning
    // it to Refunds/Payment by falling through incorrectly.
    categorizeUncategorized();
    const row = db.select({ categoryId: transactions.categoryId }).from(transactions).where(eq(transactions.id, txId)).get()!;
    expect(row.categoryId).toBeNull();
  });

  it('never overwrites a category a human already set', () => {
    const existingCategoryId = db.select({ id: categories.id }).from(categories).where(eq(categories.name, 'Shopping')).get()!.id;
    const txId = newId();
    db.insert(transactions)
      .values({
        id: txId,
        accountId: creditAccountId,
        date: '2026-08-04',
        amount: 3499,
        currency: 'CAD',
        name: 'AMAZON.CA',
        merchantName: 'Amazon',
        categoryId: existingCategoryId, // a human already categorized this refund as Shopping
        isTransfer: false,
        notes: null,
        importHash: null,
        createdAt: nowIso(),
      })
      .run();

    const assigned = categorizeUncategorized();
    expect(assigned).toBe(0);
    const row = db.select({ categoryId: transactions.categoryId }).from(transactions).where(eq(transactions.id, txId)).get()!;
    expect(row.categoryId).toBe(existingCategoryId);
  });
});
