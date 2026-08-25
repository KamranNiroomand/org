import Anthropic from '@anthropic-ai/sdk';
import { and, desc, eq, gte, isNull, lte, ne, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { accounts, categories, transactions } from '../db/schema.js';
import { accountBucket, computeSummaryTiles } from '../lib/financeSummary.js';
import { todayKey } from '../lib/util.js';

/**
 * Claude chat over the user's own finances.
 *
 * Same trust boundary as the Ideas assistant (routes/claude.ts): the API key
 * stays server-side and the browser only ever talks to this route. The
 * difference is the grounding — before Claude sees the question, this route
 * assembles a compact snapshot of the actual ledger (balances, this month's
 * category totals, recent transactions) so answers come from real numbers
 * rather than plausible-sounding guesses.
 */

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!config.anthropic.apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  client ??= new Anthropic({ apiKey: config.anthropic.apiKey });
  return client;
}

const SYSTEM = `You are a financial assistant inside Kamran's personal operating
system — the app he runs his life out of. He is asking about his own bank and
credit-card activity.

You are given a snapshot of his real ledger below: account balances, this
month's category totals, and recent transactions. Answer from that data. When
you cite a figure, ground it in the snapshot rather than estimating. If the
answer needs data outside the window you were given (an older month, an account
that isn't synced), say so plainly instead of guessing.

Be concrete and direct. This renders in a side panel, not a report — lead with
the number or the answer, keep it brief, and skip the preamble. Amounts are in
the base currency shown. You are not a licensed advisor; if he asks whether to
buy, sell, or invest, note that and stick to describing what his data shows.`;

/** Integer minor units → a human dollar string, e.g. -12345 → "-123.45". */
function money(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** An account the user hasn't excluded from stats. */
const included = () => eq(accounts.includeInStats, true);
const notATransfer = () =>
  and(eq(transactions.isTransfer, false), or(isNull(categories.kind), ne(categories.kind, 'transfer')));

/**
 * Builds the grounding snapshot injected into the prompt. Reuses the same
 * queries and `computeSummaryTiles` math the Finances summary route relies on,
 * so the chat and the dashboard can never quietly disagree.
 */
function buildContext(month: string): string {
  const from = `${month}-01`;
  const to = `${month}-31`;

  const accountRows = db
    .select()
    .from(accounts)
    .where(included())
    .orderBy(desc(accounts.type))
    .all();

  const accountLines = accountRows.map((a) => {
    const bal = a.currentBalance === null ? 'n/a' : `${money(a.currentBalance)} ${a.currency}`;
    return `- ${a.name}${a.mask ? ` (…${a.mask})` : ''} — ${a.type}, balance ${bal}`;
  });

  // This month's tiles, via the shared arithmetic.
  const bucketByAccount = new Map(
    accountRows.map((a) => [a.id, accountBucket(a.type, a.subtype)]),
  );
  const summaryRows = db
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
    .where(and(gte(transactions.date, from), lte(transactions.date, to), notATransfer(), included()))
    .all();
  const tiles = computeSummaryTiles(summaryRows, bucketByAccount);

  const categoryLines = tiles.byCategory
    .slice(0, 15)
    .map((c) => `- ${c.name}: ${money(c.total)}`);

  // Recent transactions — a bounded window so the prompt stays small even on a
  // busy ledger. Six months back covers the "a few months ago" questions this
  // feature exists for.
  const since = new Date(`${from}T00:00:00Z`);
  since.setUTCMonth(since.getUTCMonth() - 5);
  const sinceKey = since.toISOString().slice(0, 10);

  const txRows = db
    .select({
      date: transactions.date,
      amount: transactions.amount,
      name: transactions.name,
      merchantName: transactions.merchantName,
      categoryName: categories.name,
      accountName: accounts.name,
    })
    .from(transactions)
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .where(and(gte(transactions.date, sinceKey), eq(transactions.isTransfer, false), included()))
    .orderBy(desc(transactions.date))
    .limit(400)
    .all();

  const txLines = txRows.map(
    (t) =>
      `${t.date} | ${money(t.amount)} | ${t.merchantName ?? t.name} | ${t.categoryName ?? 'Uncategorized'} | ${t.accountName}`,
  );

  return [
    `Base currency: ${config.baseCurrency}. Amounts are signed: negative is money out, positive is money in.`,
    ``,
    `## Accounts (${accountRows.length})`,
    accountLines.join('\n') || '(none synced)',
    ``,
    `## ${month} summary`,
    `Total spending: ${money(tiles.expense)} · Net: ${money(tiles.net)}`,
    `Top spending categories:`,
    categoryLines.join('\n') || '(no spending this month)',
    ``,
    `## Recent transactions since ${sinceKey} (newest first, up to 400)`,
    `date | amount | merchant | category | account`,
    txLines.join('\n') || '(none)',
  ].join('\n');
}

export async function financeChatRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/finance/chat', async (req, reply) => {
    const parsed = z
      .object({
        month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
        messages: z
          .array(
            z.object({
              role: z.enum(['user', 'assistant']),
              content: z.string().min(1).max(20_000),
            }),
          )
          .min(1)
          .max(40),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: z.prettifyError(parsed.error) });

    if (!config.anthropic.configured) {
      return reply.code(503).send({ error: 'ANTHROPIC_API_KEY is not set in .env' });
    }

    const month = parsed.data.month ?? todayKey().slice(0, 7);
    const context = buildContext(month);

    reply.raw.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-cache',
      'x-accel-buffering': 'no',
    });

    try {
      const stream = getClient().messages.stream({
        model: config.anthropic.model,
        max_tokens: 8_000,
        system: `${SYSTEM}\n\n---\n\n# Ledger snapshot\n\n${context}`,
        thinking: { type: 'adaptive' },
        messages: parsed.data.messages,
      });

      stream.on('text', (delta) => reply.raw.write(delta));
      await stream.finalMessage();
      reply.raw.end();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      app.log.error({ err }, 'Finance chat failed');
      reply.raw.write(`\n\n[Error: ${message}]`);
      reply.raw.end();
    }
  });
}
