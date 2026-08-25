import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { Products } from 'plaid';
import type { CountryCode } from 'plaid';
import { z } from 'zod';
import { config } from '../config.js';
import { encrypt, encryptionAvailable } from '../crypto.js';
import { db } from '../db/index.js';
import { accounts, plaidItems } from '../db/schema.js';
import { plaid, syncAllItems, syncItem } from '../lib/plaid.js';
import { getLastNightlyResult, getNextRun, runNightly } from '../lib/scheduler.js';
import { newId, nowIso } from '../lib/util.js';

export async function plaidRoutes(app: FastifyInstance): Promise<void> {
  /** What the Finances tab needs to decide what to render. */
  app.get('/api/plaid/status', async () => {
    const items = db.select().from(plaidItems).all();
    const accountRows = db.select({ itemId: accounts.itemId }).from(accounts).all();

    return {
      configured: config.plaid.configured,
      environment: config.plaid.env,
      encryptionAvailable: encryptionAvailable(),
      nextRun: getNextRun(),
      lastRun: getLastNightlyResult(),
      items: items.map((i) => ({
        id: i.id,
        institutionName: i.institutionName,
        status: i.status,
        error: i.error,
        lastSyncAt: i.lastSyncAt,
        accountCount: accountRows.filter((a) => a.itemId === i.id).length,
      })),
    };
  });

  /**
   * Mints a Link token. The browser hands this to Plaid Link, which runs the
   * bank's own login flow — credentials go to Plaid and the bank, never to this
   * server, which is the entire point of the handshake.
   */
  app.post('/api/plaid/link-token', async (req, reply) => {
    if (!config.plaid.configured) {
      return reply.code(503).send({ error: 'Add PLAID_CLIENT_ID and PLAID_SECRET to .env' });
    }
    if (!encryptionAvailable()) {
      return reply.code(503).send({
        error:
          'The macOS Keychain is unreachable, so the access token could not be stored ' +
          'encrypted. Connecting a bank is blocked rather than saving it in plaintext.',
      });
    }

    // Re-auth mode: an item whose login expired gets a token bound to itself,
    // so Link updates the existing connection instead of creating a duplicate.
    const body = z.object({ itemId: z.string().optional() }).safeParse(req.body ?? {});
    const itemId = body.success ? body.data.itemId : undefined;
    const existing = itemId
      ? db.select().from(plaidItems).where(eq(plaidItems.id, itemId)).get()
      : null;

    try {
      const res = await plaid().linkTokenCreate({
        user: { client_user_id: 'org-local-user' },
        client_name: 'Org',
        language: 'en',
        country_codes: config.plaid.countryCodes as CountryCode[],
        // Transactions drives the ledger; liabilities adds APR, due dates, and
        // minimum payments for credit cards.
        products: existing ? undefined : [Products.Transactions, Products.Liabilities],
        // Ask for the full history window. On a fresh connect this sets how far
        // back the first sync reaches; on an existing item (update mode) Plaid
        // honours it too, so completing Link update backfills older months that
        // the original, shorter default never pulled.
        transactions: { days_requested: config.plaid.transactionDays },
        ...(existing
          ? { access_token: (await import('../crypto.js')).decrypt(existing.accessTokenEnc) }
          : {}),
      });

      return { linkToken: res.data.link_token, mode: existing ? 'reauth' : 'connect' };
    } catch (err) {
      const detail = (err as { response?: { data?: { error_message?: string } } }).response?.data;
      app.log.error({ err }, 'link-token failed');
      return reply.code(502).send({ error: detail?.error_message ?? (err as Error).message });
    }
  });

  /**
   * Exchanges the one-time public token for a long-lived access token.
   *
   * That token can read every transaction on the account, so it is encrypted
   * before it touches the database — see crypto.ts.
   */
  app.post('/api/plaid/exchange', async (req, reply) => {
    const parsed = z
      .object({
        publicToken: z.string().min(1),
        institutionId: z.string().nullish(),
        institutionName: z.string().nullish(),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: z.prettifyError(parsed.error) });

    try {
      const exchange = await plaid().itemPublicTokenExchange({
        public_token: parsed.data.publicToken,
      });
      const accessToken = exchange.data.access_token;
      const plaidItemId = exchange.data.item_id;

      // Reconnecting the same institution should update the existing row, not
      // create a second one that then double-counts every transaction.
      const existing = db
        .select()
        .from(plaidItems)
        .where(eq(plaidItems.institutionId, plaidItemId))
        .get();

      const id = existing?.id ?? newId();
      const values = {
        institutionId: plaidItemId,
        institutionName: parsed.data.institutionName ?? 'Bank',
        accessTokenEnc: encrypt(accessToken),
        status: 'ok' as const,
        error: null,
      };

      if (existing) {
        db.update(plaidItems).set(values).where(eq(plaidItems.id, id)).run();
      } else {
        db.insert(plaidItems)
          .values({ id, cursor: null, lastSyncAt: null, createdAt: nowIso(), ...values })
          .run();
      }

      // First sync runs immediately — a freshly connected card that shows an
      // empty ledger until 6am tomorrow looks broken.
      const outcome = await syncItem(id);
      return reply.code(201).send({ itemId: id, sync: outcome });
    } catch (err) {
      const detail = (err as { response?: { data?: { error_message?: string } } }).response?.data;
      app.log.error({ err }, 'token exchange failed');
      return reply.code(502).send({ error: detail?.error_message ?? (err as Error).message });
    }
  });

  /** Manual "Sync now" — same code path as the nightly job. */
  app.post('/api/plaid/sync', async (req, reply) => {
    if (!config.plaid.configured) {
      return reply.code(503).send({ error: 'Plaid is not configured' });
    }
    const parsed = z.object({ itemId: z.string().optional() }).safeParse(req.body ?? {});
    const itemId = parsed.success ? parsed.data.itemId : undefined;

    return itemId ? [await syncItem(itemId)] : await syncAllItems();
  });

  /** Runs the full nightly job on demand — banks and prices together. */
  app.post('/api/sync/run', async () => runNightly(app.log, 'manual'));

  app.delete<{ Params: { id: string } }>('/api/plaid/items/:id', async (req, reply) => {
    const item = db.select().from(plaidItems).where(eq(plaidItems.id, req.params.id)).get();
    if (!item) return reply.code(404).send({ error: 'Item not found' });

    // Tell Plaid to release the item too, so the connection stops billing and
    // stops being listed on their side. A failure here shouldn't block local
    // removal — the user asked for it gone.
    try {
      const { decrypt } = await import('../crypto.js');
      await plaid().itemRemove({ access_token: decrypt(item.accessTokenEnc) });
    } catch (err) {
      app.log.warn({ err }, 'Plaid itemRemove failed; removing locally anyway');
    }

    // Accounts cascade, and transactions cascade from accounts.
    db.delete(plaidItems).where(eq(plaidItems.id, req.params.id)).run();
    return reply.code(204).send();
  });

  /**
   * Sandbox-only shortcut: mints a public token without the Link UI, so the
   * whole pipeline can be exercised end to end before touching a real bank.
   */
  app.post('/api/plaid/sandbox-item', async (req, reply) => {
    if (config.plaid.env !== 'sandbox') {
      return reply.code(400).send({ error: 'Only available when PLAID_ENV=sandbox' });
    }
    if (!config.plaid.configured) {
      return reply.code(503).send({ error: 'Plaid is not configured' });
    }

    const parsed = z
      .object({ institutionId: z.string().default('ins_109508') })
      .safeParse(req.body ?? {});
    const institutionId = parsed.success ? parsed.data.institutionId : 'ins_109508';

    try {
      const res = await plaid().sandboxPublicTokenCreate({
        institution_id: institutionId,
        initial_products: [Products.Transactions],
      });
      return { publicToken: res.data.public_token };
    } catch (err) {
      const detail = (err as { response?: { data?: { error_message?: string } } }).response?.data;
      return reply.code(502).send({ error: detail?.error_message ?? (err as Error).message });
    }
  });
}
