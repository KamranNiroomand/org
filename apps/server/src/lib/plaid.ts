import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';
import type { AccountBase, Transaction as PlaidTransaction, RemovedTransaction } from 'plaid';
import { eq, inArray } from 'drizzle-orm';
import { config } from '../config.js';
import { decrypt } from '../crypto.js';
import { db } from '../db/index.js';
import { accounts, plaidItems, transactions } from '../db/schema.js';
import { categorizeUncategorized } from './categorize.js';
import { newId, nowIso } from './util.js';

/**
 * Plaid ingestion.
 *
 * Uses `/transactions/sync`, the cursor-based endpoint — not the older
 * `/transactions/get` date-range one. Sync returns explicit added / modified /
 * removed sets and a cursor, which makes it idempotent: re-running a sync that
 * already completed is a no-op rather than a pile of duplicates. That property
 * is what lets the nightly job be careless about whether it already ran.
 */

let api: PlaidApi | null = null;

export function plaid(): PlaidApi {
  if (!config.plaid.configured) {
    throw new Error('Plaid is not configured — add PLAID_CLIENT_ID and PLAID_SECRET to .env');
  }
  api ??= new PlaidApi(
    new Configuration({
      basePath: PlaidEnvironments[config.plaid.env],
      baseOptions: {
        headers: {
          'PLAID-CLIENT-ID': config.plaid.clientId!,
          'PLAID-SECRET': config.plaid.secret!,
        },
      },
    }),
  );
  return api;
}

/**
 * Plaid's sign convention is the inverse of intuition: a **positive** amount
 * means money moving *out* of the account, negative means money coming in.
 * Flipping it once here means nothing downstream — budgets, summaries, charts —
 * has to remember the quirk.
 *
 * Also converts to integer minor units, since Plaid sends a float.
 */
function normalizeAmount(plaidAmount: number): number {
  return -Math.round(plaidAmount * 100);
}

/** Plaid account types map onto ours with only `brokerage` needing a nudge. */
function mapAccountType(type: string): 'depository' | 'credit' | 'loan' | 'investment' | 'other' {
  switch (type) {
    case 'depository':
      return 'depository';
    case 'credit':
      return 'credit';
    case 'loan':
      return 'loan';
    case 'investment':
    case 'brokerage':
      return 'investment';
    default:
      return 'other';
  }
}

/** Balances are floats from Plaid; store them as integer cents like everything else. */
const toCents = (v: number | null | undefined): number | null =>
  typeof v === 'number' ? Math.round(v * 100) : null;

function upsertAccounts(itemId: string, institutionName: string, rows: AccountBase[]): void {
  for (const a of rows) {
    const existing = db
      .select()
      .from(accounts)
      .where(eq(accounts.plaidAccountId, a.account_id))
      .get();

    const shared = {
      name: a.name,
      officialName: a.official_name ?? null,
      mask: a.mask ?? null,
      type: mapAccountType(a.type),
      subtype: a.subtype ?? null,
      currency: a.balances.iso_currency_code ?? config.baseCurrency,
      // For a credit card Plaid reports the outstanding balance as a positive
      // number. Negating it makes "what you owe" read as negative money, which
      // is the same sign convention the rest of the app uses.
      currentBalance:
        a.type === 'credit'
          ? toCents(a.balances.current) !== null
            ? -toCents(a.balances.current)!
            : null
          : toCents(a.balances.current),
      availableBalance: toCents(a.balances.available),
      creditLimit: toCents(a.balances.limit),
      institutionName,
      lastSyncedAt: nowIso(),
    };

    if (existing) {
      db.update(accounts).set(shared).where(eq(accounts.id, existing.id)).run();
    } else {
      db.insert(accounts)
        .values({
          id: newId(),
          itemId,
          plaidAccountId: a.account_id,
          isManual: false,
          createdAt: nowIso(),
          ...shared,
        })
        .run();
    }
  }
}

/** Maps a Plaid account id to our own row id. */
function localAccountId(plaidAccountId: string): string | null {
  const row = db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.plaidAccountId, plaidAccountId))
    .get();
  return row?.id ?? null;
}

function writeTransactions(added: PlaidTransaction[], modified: PlaidTransaction[]): number {
  let written = 0;

  for (const t of [...added, ...modified]) {
    const accountId = localAccountId(t.account_id);
    if (!accountId) continue; // account not synced yet; the next run will catch it

    const row = {
      accountId,
      plaidTransactionId: t.transaction_id,
      date: t.date,
      authorizedDate: t.authorized_date ?? null,
      amount: normalizeAmount(t.amount),
      currency: t.iso_currency_code ?? config.baseCurrency,
      name: t.name,
      merchantName: t.merchant_name ?? null,
      pending: t.pending,
      pendingTransactionId: t.pending_transaction_id ?? null,
      source: 'plaid' as const,
    };

    const existing = db
      .select()
      .from(transactions)
      .where(eq(transactions.plaidTransactionId, t.transaction_id))
      .get();

    if (existing) {
      // Never clobber a category a human set by hand — that correction is the
      // whole bargain of the categorizer.
      db.update(transactions).set(row).where(eq(transactions.id, existing.id)).run();
    } else {
      db.insert(transactions)
        .values({ id: newId(), ...row, categoryId: null, isTransfer: false, notes: null, importHash: null, createdAt: nowIso() })
        .run();
      written++;
    }

    /**
     * When a pending charge settles, Plaid issues a *new* transaction id and
     * points it at the old one. Without this the ledger shows the coffee twice
     * — once pending, once posted.
     */
    if (t.pending_transaction_id) {
      db.delete(transactions)
        .where(eq(transactions.plaidTransactionId, t.pending_transaction_id))
        .run();
    }
  }

  return written;
}

export interface SyncOutcome {
  itemId: string;
  institutionName: string;
  added: number;
  modified: number;
  removed: number;
  categorized: number;
  error: string | null;
  finishedAt: string;
}

/**
 * Syncs one item to completion.
 *
 * The cursor is advanced **only after** the batch has been written, inside the
 * same transaction. If the process dies mid-page, the next run re-fetches from
 * the last committed cursor and the idempotent writes above absorb the overlap.
 */
export async function syncItem(itemId: string): Promise<SyncOutcome> {
  const item = db.select().from(plaidItems).where(eq(plaidItems.id, itemId)).get();
  if (!item) throw new Error(`No such Plaid item: ${itemId}`);

  const outcome: SyncOutcome = {
    itemId,
    institutionName: item.institutionName,
    added: 0,
    modified: 0,
    removed: 0,
    categorized: 0,
    error: null,
    finishedAt: nowIso(),
  };

  let accessToken: string;
  try {
    accessToken = decrypt(item.accessTokenEnc);
  } catch {
    outcome.error = 'Could not decrypt the access token — is the Keychain reachable?';
    db.update(plaidItems)
      .set({ status: 'error', error: outcome.error })
      .where(eq(plaidItems.id, itemId))
      .run();
    return outcome;
  }

  const client = plaid();

  try {
    // Refresh balances and pick up any newly opened account on the item.
    const accountsResponse = await client.accountsGet({ access_token: accessToken });
    upsertAccounts(itemId, item.institutionName, accountsResponse.data.accounts);

    let cursor = item.cursor ?? undefined;
    let hasMore = true;

    while (hasMore) {
      const res = await client.transactionsSync({
        access_token: accessToken,
        cursor,
        count: 500,
      });

      const { added, modified, removed, next_cursor, has_more } = res.data;

      db.transaction((tx) => {
        outcome.added += writeTransactions(added, modified);
        outcome.modified += modified.length;

        const removedIds = removed.map((r: RemovedTransaction) => r.transaction_id);
        if (removedIds.length > 0) {
          tx.delete(transactions)
            .where(inArray(transactions.plaidTransactionId, removedIds))
            .run();
          outcome.removed += removedIds.length;
        }

        // Commit the cursor with the data it corresponds to, never before.
        tx.update(plaidItems)
          .set({ cursor: next_cursor, status: 'ok', error: null, lastSyncAt: nowIso() })
          .where(eq(plaidItems.id, itemId))
          .run();
      });

      cursor = next_cursor;
      hasMore = has_more;
    }

    outcome.categorized = categorizeUncategorized();
  } catch (err) {
    const plaidError = (err as { response?: { data?: { error_code?: string; error_message?: string } } })
      .response?.data;
    const code = plaidError?.error_code ?? '';
    outcome.error = plaidError?.error_message ?? (err as Error).message;

    // A revoked or expired login needs the user to re-authenticate through
    // Link; everything else is worth retrying on the next run.
    const needsReauth = code === 'ITEM_LOGIN_REQUIRED' || code === 'ITEM_LOCKED';
    db.update(plaidItems)
      .set({ status: needsReauth ? 'needs_reauth' : 'error', error: outcome.error })
      .where(eq(plaidItems.id, itemId))
      .run();
  }

  outcome.finishedAt = nowIso();
  return outcome;
}

/** Syncs every connected item. Errors are collected, never thrown. */
export async function syncAllItems(): Promise<SyncOutcome[]> {
  const items = db.select({ id: plaidItems.id }).from(plaidItems).all();
  const results: SyncOutcome[] = [];
  for (const item of items) {
    results.push(await syncItem(item.id));
  }
  return results;
}

/** True when no item has synced in the last `hours` — used for catch-up. */
export function syncIsStale(hours = 20): boolean {
  const items = db.select({ lastSyncAt: plaidItems.lastSyncAt }).from(plaidItems).all();
  if (items.length === 0) return false;

  const cutoff = Date.now() - hours * 3_600_000;
  return items.some((i) => !i.lastSyncAt || new Date(i.lastSyncAt).getTime() < cutoff);
}
