/**
 * Bucketing incoming money by the account it actually arrived in.
 *
 * Split out of the summary route so the arithmetic — the part with real
 * consequences for what the dashboard tells you about your own money — is
 * directly testable, rather than only reachable through a live HTTP request
 * against a running database.
 */

export type AccountBucket = 'checking' | 'savings' | 'credit' | 'other';

export function accountBucket(type: string, subtype: string | null): AccountBucket {
  if (type === 'credit') return 'credit';
  if (type === 'depository') return subtype === 'savings' ? 'savings' : 'checking';
  return 'other';
}

export interface SummaryRow {
  accountId: string;
  amount: number;
  categoryId: string | null;
  categoryName: string | null;
  categoryColor: string | null;
  categoryKind: string | null;
}

export interface CategoryTotal {
  id: string | null;
  name: string;
  color: string;
  total: number;
}

export interface SummaryTiles {
  income: number | null;
  payments: number | null;
  refunds: number | null;
  interest: number | null;
  deposits: number | null;
  expense: number;
  net: number;
  byCategory: CategoryTotal[];
}

/**
 * `null` on a tile means "not applicable" — no included account of the
 * matching type exists — never "zero this month". Callers hide a `null`
 * tile rather than rendering a $0.00 box for money that structurally cannot
 * arrive there; presence is decided by account composition
 * (`bucketByAccount`), not by whether any transaction happened to land in
 * it this particular month.
 */
export function computeSummaryTiles(
  rows: readonly SummaryRow[],
  bucketByAccount: ReadonlyMap<string, AccountBucket>,
): SummaryTiles {
  const presentBuckets = new Set(bucketByAccount.values());

  let income = 0;
  let payments = 0;
  let refunds = 0;
  let interest = 0;
  let deposits = 0;
  let otherIncome = 0;
  let expense = 0;
  const byCategory = new Map<string, CategoryTotal>();

  for (const r of rows) {
    const bucket = bucketByAccount.get(r.accountId) ?? 'other';

    if (r.amount > 0) {
      switch (bucket) {
        case 'checking':
          income += r.amount;
          break;
        case 'credit':
          // The caller has already excluded kind='transfer'; every positive
          // amount reaching a credit account from here is either a payment
          // or a refund, per classifyByAccountContext in categorize.ts.
          if (r.categoryKind === 'payment') payments += r.amount;
          else refunds += r.amount;
          break;
        case 'savings':
          if (r.categoryName === 'Interest & Dividends') interest += r.amount;
          else deposits += r.amount;
          break;
        case 'other':
          otherIncome += r.amount;
          break;
      }
    } else {
      expense += -r.amount;
      const key = r.categoryId ?? 'uncategorized';
      const entry = byCategory.get(key) ?? {
        id: r.categoryId,
        name: r.categoryName ?? 'Uncategorized',
        color: r.categoryColor ?? 'slate',
        total: 0,
      };
      entry.total += -r.amount;
      byCategory.set(key, entry);
    }
  }

  // A payment is excluded here on purpose: the account it came from —
  // typically chequing — usually is not synced, so its matching outflow is
  // invisible, and counting the inflow on the card side would fabricate
  // income out of money that was simply moved. A refund has no such hidden
  // counterpart; it is genuinely money back, so it counts.
  const net = income + interest + deposits + otherIncome + refunds - expense;

  return {
    income: presentBuckets.has('checking') ? income : null,
    payments: presentBuckets.has('credit') ? payments : null,
    refunds: presentBuckets.has('credit') ? refunds : null,
    interest: presentBuckets.has('savings') ? interest : null,
    deposits: presentBuckets.has('savings') ? deposits : null,
    expense,
    net,
    byCategory: [...byCategory.values()].sort((a, b) => b.total - a.total),
  };
}
