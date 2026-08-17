import { Products } from 'plaid';
import { eq } from 'drizzle-orm';
import { config } from '../config.js';
import { encrypt, encryptionAvailable } from '../crypto.js';
import { db } from '../db/index.js';
import { accounts, plaidItems, transactions } from '../db/schema.js';
import { plaid, syncItem } from '../lib/plaid.js';
import { newId, nowIso } from '../lib/util.js';

/**
 * Preflight for the Plaid setup: proves the credentials work and, in sandbox,
 * drives the entire pipeline — mint, exchange, sync, write — against a fake
 * bank before a real account is ever involved.
 *
 * Sandbox runs create a real item in the local database and then remove it, so
 * a successful check leaves no residue in the ledger.
 *
 *   npm run plaid:check -w @org/server
 */

const ok = (m: string) => console.log(`  ok    ${m}`);
const bad = (m: string) => console.log(`  FAIL  ${m}`);

async function main(): Promise<void> {
  console.log(`\nPlaid preflight — environment: ${config.plaid.env}\n`);

  if (!config.plaid.configured) {
    bad('PLAID_CLIENT_ID / PLAID_SECRET are not set in .env');
    console.log('\n  Get them from dashboard.plaid.com → Team Settings → Keys.\n');
    process.exit(1);
  }
  ok('client id and secret are present');

  if (encryptionAvailable()) {
    ok('Keychain reachable — access tokens will be encrypted at rest');
  } else {
    bad('Keychain unreachable; connecting a bank will be blocked');
    process.exit(1);
  }

  // Cheapest authenticated call that proves the key pair is valid for this env.
  try {
    const res = await plaid().institutionsGet({
      count: 5,
      offset: 0,
      country_codes: config.plaid.countryCodes as never,
    });
    ok(`credentials accepted (${res.data.total} institutions visible)`);
  } catch (err) {
    const detail = (err as { response?: { data?: { error_code?: string; error_message?: string } } })
      .response?.data;
    bad(detail?.error_message ?? (err as Error).message);
    if (detail?.error_code === 'INVALID_API_KEYS') {
      console.log(`\n  Those keys are not valid for PLAID_ENV=${config.plaid.env}.`);
      console.log('  Sandbox and production have separate secrets — check you pasted the right one.\n');
    }
    process.exit(1);
  }

  if (config.plaid.env !== 'sandbox') {
    console.log('\n  Production keys look good. Connect your banks from Finances → Connect.\n');
    return;
  }

  // Full round trip against a fake bank.
  let itemId: string | null = null;
  try {
    const minted = await plaid().sandboxPublicTokenCreate({
      institution_id: 'ins_109508',
      initial_products: [Products.Transactions],
    });
    ok('minted a sandbox public token');

    const exchange = await plaid().itemPublicTokenExchange({
      public_token: minted.data.public_token,
    });
    ok('exchanged it for an access token');

    itemId = newId();
    db.insert(plaidItems)
      .values({
        id: itemId,
        institutionId: exchange.data.item_id,
        institutionName: 'Sandbox Preflight',
        accessTokenEnc: encrypt(exchange.data.access_token),
        cursor: null,
        status: 'ok',
        error: null,
        lastSyncAt: null,
        createdAt: nowIso(),
      })
      .run();

    /**
     * A freshly created sandbox item generates its transactions asynchronously,
     * so the first sync usually lands before there is anything to fetch. In
     * production the nightly job never sees this — the item is hours old by
     * then — but a check that accepts zero transactions proves nothing about
     * the ingest path, which is the whole reason this script exists.
     */
    let outcome = await syncItem(itemId);
    for (let attempt = 1; attempt <= 8 && !outcome.error && outcome.added === 0; attempt++) {
      console.log(`  ...   waiting for sandbox transactions (attempt ${attempt}/8)`);
      await new Promise((r) => setTimeout(r, 3000));
      outcome = await syncItem(itemId);
    }

    if (outcome.error) {
      bad(`sync failed: ${outcome.error}`);
      process.exitCode = 1;
    } else if (outcome.added === 0) {
      bad('synced accounts but zero transactions — the ingest path is unproven');
      console.log('\n  Accounts and auth work, but no transaction ever reached the ledger.');
      console.log('  Do not switch to production on this result.\n');
      process.exitCode = 1;
    } else {
      const accountCount = db
        .select()
        .from(accounts)
        .where(eq(accounts.itemId, itemId))
        .all().length;
      ok(`synced ${accountCount} accounts and ${outcome.added} transactions`);
      ok(`categorizer labelled ${outcome.categorized} of them`);
      console.log('\n  The pipeline works end to end.');
      console.log('  Swap in your production secret, set PLAID_ENV=production, and connect for real.\n');
    }
  } finally {
    // Leave the ledger exactly as it was found.
    if (itemId) {
      const accountIds = db
        .select({ id: accounts.id })
        .from(accounts)
        .where(eq(accounts.itemId, itemId))
        .all()
        .map((a) => a.id);
      for (const id of accountIds) {
        db.delete(transactions).where(eq(transactions.accountId, id)).run();
        db.delete(accounts).where(eq(accounts.id, id)).run();
      }
      db.delete(plaidItems).where(eq(plaidItems.id, itemId)).run();
      ok('cleaned up the sandbox item');
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
