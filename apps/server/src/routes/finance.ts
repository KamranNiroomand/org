import { and, asc, desc, eq, gt, gte, isNull, like, lte, ne, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { accounts, budgets, categories, categoryRules, transactions } from '../db/schema.js';
import { categorizeUncategorized, learnRule } from '../lib/categorize.js';
import { accountBucket, computeSummaryTiles } from '../lib/financeSummary.js';
import { newId, nowIso, todayKey } from '../lib/util.js';

/**
 * Keeps transfers out of income and spending totals.
 *
 * Two separate things mean "transfer" and both have to be honoured: the
 * per-transaction `is_transfer` flag, and a category whose kind is 'transfer'.
 * Only the flag was ever checked, which left the transfer *categories* purely
 * decorative — a credit-card payment landed in spending on the chequing side
 * and in income on the card side, double-counting the very dollars it settles.
 * An uncategorized row has a null kind and must still be counted.
 */
const notATransfer = () =>
  and(
    eq(transactions.isTransfer, false),
    or(isNull(categories.kind), ne(categories.kind, 'transfer')),
  );

/** An account the user hasn't excluded — see the doc comment on `accounts.includeInStats`. */
const accountIncluded = () => eq(accounts.includeInStats, true);

const civilKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const monthKeySchema = z.string().regex(/^\d{4}-\d{2}$/);

export async function financeRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // Accounts
  // -------------------------------------------------------------------------

  app.get('/api/accounts', async () =>
    db.select().from(accounts).orderBy(asc(accounts.type), asc(accounts.name)).all(),
  );

  app.post('/api/accounts', async (req, reply) => {
    const parsed = z
      .object({
        name: z.string().min(1).max(200),
        type: z.enum(['depository', 'credit', 'loan', 'investment', 'other']).default('depository'),
        currency: z.string().length(3).default(config.baseCurrency),
        currentBalance: z.number().int().nullish(),
        creditLimit: z.number().int().nullish(),
        mask: z.string().max(8).nullish(),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: z.prettifyError(parsed.error) });

    const row = {
      id: newId(),
      itemId: null,
      plaidAccountId: null,
      name: parsed.data.name,
      officialName: null,
      mask: parsed.data.mask ?? null,
      type: parsed.data.type,
      subtype: null,
      currency: parsed.data.currency,
      currentBalance: parsed.data.currentBalance ?? null,
      availableBalance: null,
      creditLimit: parsed.data.creditLimit ?? null,
      institutionName: null,
      isManual: true,
      lastSyncedAt: null,
      createdAt: nowIso(),
    };
    db.insert(accounts).values(row).run();
    return reply.code(201).send(row);
  });

  /**
   * Toggles whether an account feeds the aggregates and the transaction
   * list. Deliberately separate from deleting it — excluding an account
   * keeps its balance and its transactions in place, it just stops them
   * appearing anywhere else in the app.
   */
  app.patch<{ Params: { id: string } }>('/api/accounts/:id', async (req, reply) => {
    const parsed = z.object({ includeInStats: z.boolean() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: z.prettifyError(parsed.error) });

    const existing = db.select().from(accounts).where(eq(accounts.id, req.params.id)).get();
    if (!existing) return reply.code(404).send({ error: 'Account not found' });

    db.update(accounts)
      .set({ includeInStats: parsed.data.includeInStats })
      .where(eq(accounts.id, req.params.id))
      .run();

    return db.select().from(accounts).where(eq(accounts.id, req.params.id)).get();
  });

  app.delete<{ Params: { id: string } }>('/api/accounts/:id', async (req, reply) => {
    db.delete(accounts).where(eq(accounts.id, req.params.id)).run();
    return reply.code(204).send();
  });

  // -------------------------------------------------------------------------
  // Transactions
  // -------------------------------------------------------------------------

  app.get<{
    Querystring: {
      from?: string; to?: string; accountId?: string; categoryId?: string;
      q?: string; limit?: string; includeTransfers?: string;
    };
  }>('/api/transactions', async (req) => {
    const q = req.query;
    const filters = [];

    if (q.from) filters.push(gte(transactions.date, q.from));
    if (q.to) filters.push(lte(transactions.date, q.to));
    if (q.accountId) filters.push(eq(transactions.accountId, q.accountId));
    if (q.categoryId) filters.push(eq(transactions.categoryId, q.categoryId));
    if (q.q) {
      filters.push(
        or(like(transactions.name, `%${q.q}%`), like(transactions.merchantName, `%${q.q}%`))!,
      );
    }
    if (q.includeTransfers !== 'true') filters.push(eq(transactions.isTransfer, false));
    // Matches the aggregate queries below (summary, cashflow): an excluded
    // account's transactions stay out of the list entirely, not just the
    // totals derived from it. Applies even when `accountId` is given
    // explicitly — excluding an account hides it everywhere, including a
    // direct link to it.
    filters.push(accountIncluded());

    return db
      .select({
        transaction: transactions,
        account: { id: accounts.id, name: accounts.name, mask: accounts.mask, type: accounts.type },
        category: { id: categories.id, name: categories.name, color: categories.color, kind: categories.kind },
      })
      .from(transactions)
      .leftJoin(accounts, eq(transactions.accountId, accounts.id))
      .leftJoin(categories, eq(transactions.categoryId, categories.id))
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(transactions.date), desc(transactions.createdAt))
      .limit(Math.min(Number(q.limit ?? 200), 1000))
      .all();
  });

  app.post('/api/transactions', async (req, reply) => {
    const parsed = z
      .object({
        accountId: z.string(),
        date: civilKey,
        amount: z.number().int(),
        name: z.string().min(1).max(500),
        merchantName: z.string().max(500).nullish(),
        categoryId: z.string().nullish(),
        notes: z.string().max(20_000).nullish(),
        isTransfer: z.boolean().default(false),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: z.prettifyError(parsed.error) });

    const account = db.select().from(accounts).where(eq(accounts.id, parsed.data.accountId)).get();
    if (!account) return reply.code(400).send({ error: 'No such account' });

    const row = {
      id: newId(),
      accountId: parsed.data.accountId,
      plaidTransactionId: null,
      date: parsed.data.date,
      authorizedDate: null,
      amount: parsed.data.amount,
      currency: account.currency,
      name: parsed.data.name,
      merchantName: parsed.data.merchantName ?? null,
      categoryId: parsed.data.categoryId ?? null,
      pending: false,
      pendingTransactionId: null,
      isTransfer: parsed.data.isTransfer,
      notes: parsed.data.notes ?? null,
      source: 'manual' as const,
      importHash: null,
      createdAt: nowIso(),
    };
    db.insert(transactions).values(row).run();
    return reply.code(201).send(row);
  });

  app.patch<{ Params: { id: string } }>('/api/transactions/:id', async (req, reply) => {
    const parsed = z
      .object({
        categoryId: z.string().nullish(),
        notes: z.string().max(20_000).nullish(),
        isTransfer: z.boolean().optional(),
        merchantName: z.string().max(500).nullish(),
        /** Turn this correction into a standing rule for the same merchant. */
        learn: z.boolean().default(false),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: z.prettifyError(parsed.error) });

    const existing = db.select().from(transactions).where(eq(transactions.id, req.params.id)).get();
    if (!existing) return reply.code(404).send({ error: 'Transaction not found' });

    const d = parsed.data;
    db.update(transactions)
      .set({
        ...(d.categoryId !== undefined && { categoryId: d.categoryId ?? null }),
        ...(d.notes !== undefined && { notes: d.notes ?? null }),
        ...(d.isTransfer !== undefined && { isTransfer: d.isTransfer }),
        ...(d.merchantName !== undefined && { merchantName: d.merchantName ?? null }),
      })
      .where(eq(transactions.id, req.params.id))
      .run();

    let learned: unknown = null;
    let applied = 0;
    if (d.learn && d.categoryId) {
      learned = learnRule(existing.merchantName, existing.name, d.categoryId);
      applied = categorizeUncategorized();
    }

    return {
      transaction: db.select().from(transactions).where(eq(transactions.id, req.params.id)).get(),
      learned,
      alsoCategorized: applied,
    };
  });

  app.delete<{ Params: { id: string } }>('/api/transactions/:id', async (req, reply) => {
    db.delete(transactions).where(eq(transactions.id, req.params.id)).run();
    return reply.code(204).send();
  });

  // -------------------------------------------------------------------------
  // Categories & rules
  // -------------------------------------------------------------------------

  app.get('/api/categories', async () =>
    db.select().from(categories).orderBy(asc(categories.kind), asc(categories.name)).all(),
  );

  app.post('/api/categories', async (req, reply) => {
    const parsed = z
      .object({
        name: z.string().min(1).max(100),
        kind: z.enum(['expense', 'income', 'transfer']).default('expense'),
        color: z.string().default('slate'),
        icon: z.string().nullish(),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: z.prettifyError(parsed.error) });

    const row = {
      id: newId(),
      name: parsed.data.name,
      parentId: null,
      kind: parsed.data.kind,
      color: parsed.data.color,
      icon: parsed.data.icon ?? null,
      isSystem: false,
    };
    db.insert(categories).values(row).run();
    return reply.code(201).send(row);
  });

  app.get('/api/rules', async () =>
    db
      .select({ rule: categoryRules, category: categories })
      .from(categoryRules)
      .leftJoin(categories, eq(categoryRules.categoryId, categories.id))
      .orderBy(asc(categoryRules.priority))
      .all(),
  );

  app.delete<{ Params: { id: string } }>('/api/rules/:id', async (req, reply) => {
    db.delete(categoryRules).where(eq(categoryRules.id, req.params.id)).run();
    return reply.code(204).send();
  });

  app.post('/api/rules/apply', async () => ({ categorized: categorizeUncategorized() }));

  // -------------------------------------------------------------------------
  // Budgets
  // -------------------------------------------------------------------------

  app.get<{ Querystring: { month?: string } }>('/api/budgets', async (req) => {
    const month = req.query.month ?? todayKey().slice(0, 7);

    const rows = db
      .select({ budget: budgets, category: categories })
      .from(budgets)
      .leftJoin(categories, eq(budgets.categoryId, categories.id))
      .all()
      // A NULL period means "every month"; a set period is a one-off override
      // for that month, and should win over the recurring one.
      .filter((r) => r.budget.period === null || r.budget.period === month);

    const byCategory = new Map<string, (typeof rows)[number]>();
    for (const r of rows) {
      const current = byCategory.get(r.budget.categoryId);
      if (!current || (current.budget.period === null && r.budget.period !== null)) {
        byCategory.set(r.budget.categoryId, r);
      }
    }

    const spendRows = db
      .select({
        categoryId: transactions.categoryId,
        total: sql<number>`sum(${transactions.amount})`,
      })
      .from(transactions)
      .innerJoin(accounts, eq(transactions.accountId, accounts.id))
      .where(
        and(
          gte(transactions.date, `${month}-01`),
          lte(transactions.date, `${month}-31`),
          eq(transactions.isTransfer, false),
          accountIncluded(),
        ),
      )
      .groupBy(transactions.categoryId)
      .all();

    const spendByCategory = new Map(spendRows.map((r) => [r.categoryId, r.total]));

    return [...byCategory.values()].map((r) => {
      // Spending is stored negative; a budget is a positive allowance.
      const spent = Math.abs(spendByCategory.get(r.budget.categoryId) ?? 0);
      return {
        budget: r.budget,
        category: r.category,
        spent,
        remaining: r.budget.amount - spent,
        ratio: r.budget.amount === 0 ? 0 : spent / r.budget.amount,
      };
    });
  });

  app.put('/api/budgets', async (req, reply) => {
    const parsed = z
      .object({
        categoryId: z.string(),
        period: monthKeySchema.nullish(),
        amount: z.number().int().min(0),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: z.prettifyError(parsed.error) });

    const { categoryId, period = null, amount } = parsed.data;
    const existing = db
      .select()
      .from(budgets)
      .where(
        and(
          eq(budgets.categoryId, categoryId),
          period === null ? sql`${budgets.period} is null` : eq(budgets.period, period),
        ),
      )
      .get();

    if (existing) {
      db.update(budgets).set({ amount }).where(eq(budgets.id, existing.id)).run();
      return { ...existing, amount };
    }

    const row = {
      id: newId(),
      categoryId,
      period: period ?? null,
      amount,
      currency: config.baseCurrency,
    };
    db.insert(budgets).values(row).run();
    return reply.code(201).send(row);
  });

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------

  /**
   * Income, spending, and category breakdown for a month.
   *
   * The four incoming-money tiles are each present only when an included
   * account of the matching type actually exists — see computeSummaryTiles
   * for why `null` and `0` mean different things here, and why a chequing
   * account and a credit card selected together surface separate tiles
   * rather than one blended figure.
   */
  app.get<{ Querystring: { month?: string } }>('/api/finance/summary', async (req) => {
    const month = req.query.month ?? todayKey().slice(0, 7);
    const from = `${month}-01`;
    const to = `${month}-31`;

    const includedAccounts = db
      .select({ id: accounts.id, type: accounts.type, subtype: accounts.subtype })
      .from(accounts)
      .where(accountIncluded())
      .all();
    const bucketByAccount = new Map(includedAccounts.map((a) => [a.id, accountBucket(a.type, a.subtype)]));

    const rows = db
      .select({
        accountId: transactions.accountId,
        amount: transactions.amount,
        categoryId: transactions.categoryId,
        categoryName: categories.name,
        categoryColor: categories.color,
        categoryKind: categories.kind,
      })
      .from(transactions)
      .leftJoin(categories, eq(transactions.categoryId, categories.id))
      .innerJoin(accounts, eq(transactions.accountId, accounts.id))
      .where(
        and(
          gte(transactions.date, from),
          lte(transactions.date, to),
          notATransfer(),
          accountIncluded(),
        ),
      )
      .all();

    const tiles = computeSummaryTiles(rows, bucketByAccount);

    return { month, ...tiles, transactionCount: rows.length };
  });

  /**
   * The individual transactions behind one month's `refunds` tile —
   * clicking that number wants to see what it's actually made of.
   *
   * Same row shape `/api/transactions` returns, so the web side can reuse
   * its existing transaction-row rendering rather than inventing a second
   * one. The credit-account/not-a-payment predicate mirrors
   * `computeSummaryTiles`'s own refund branch — restated directly in SQL
   * here rather than shared, since `accountBucket` reduces to a plain type
   * check for the 'credit' case and pulling it in would cost a second
   * query (and a JS-side filter) for no benefit.
   */
  app.get<{ Querystring: { month?: string; limit?: string } }>('/api/finance/refunds', async (req) => {
    const month = req.query.month ?? todayKey().slice(0, 7);
    const from = `${month}-01`;
    const to = `${month}-31`;

    return db
      .select({
        transaction: transactions,
        account: { id: accounts.id, name: accounts.name, mask: accounts.mask, type: accounts.type },
        category: { id: categories.id, name: categories.name, color: categories.color, kind: categories.kind },
      })
      .from(transactions)
      .innerJoin(accounts, eq(transactions.accountId, accounts.id))
      .leftJoin(categories, eq(transactions.categoryId, categories.id))
      .where(
        and(
          gte(transactions.date, from),
          lte(transactions.date, to),
          notATransfer(),
          accountIncluded(),
          eq(accounts.type, 'credit'),
          gt(transactions.amount, 0),
          or(isNull(categories.kind), ne(categories.kind, 'payment')),
        ),
      )
      .orderBy(desc(transactions.date), desc(transactions.createdAt))
      .limit(Math.min(Number(req.query.limit ?? 200), 1000))
      .all();
  });

  /** Income vs. expense per month, for the cashflow chart. */
  app.get<{ Querystring: { months?: string } }>('/api/finance/cashflow', async (req) => {
    const months = Math.min(Number(req.query.months ?? 12), 36);

    const rows = db
      .select({
        month: sql<string>`substr(${transactions.date}, 1, 7)`,
        income: sql<number>`sum(case when ${transactions.amount} > 0 then ${transactions.amount} else 0 end)`,
        expense: sql<number>`sum(case when ${transactions.amount} < 0 then -${transactions.amount} else 0 end)`,
      })
      .from(transactions)
      .innerJoin(accounts, eq(transactions.accountId, accounts.id))
      .leftJoin(categories, eq(transactions.categoryId, categories.id))
      .where(and(notATransfer(), accountIncluded()))
      .groupBy(sql`substr(${transactions.date}, 1, 7)`)
      .orderBy(desc(sql`substr(${transactions.date}, 1, 7)`))
      .limit(months)
      .all();

    return rows.reverse();
  });
}
