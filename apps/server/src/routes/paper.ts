import type { FastifyInstance } from 'fastify';
import { desc } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../config.js';
import { paperDb } from '../db/paper/index.js';
import { paperEquity, paperOrders } from '../db/paper/schema.js';
import { closeOrder, computeDailyEquity, markOpenPositions, openOrder, PaperError, tradeReturnPct } from '../lib/paper.js';

/**
 * Paper trading with artificial money.
 *
 * Orders open two ways — typed by hand, or one click off the ranked signal
 * board — distinguished only by `source`; the mechanics below (fills, marks,
 * the equity curve) are identical either way.
 */

const openBody = z.object({
  occSymbol: z.string().min(1),
  quantity: z.number().int().positive(),
  entryPriceE4: z.number().positive().optional(),
  notes: z.string().max(500).optional(),
  source: z.enum(['manual', 'model']).optional(),
});

const closeBody = z.object({
  exitPriceE4: z.number().min(0).optional(),
});

export async function paperRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/paper/starting-balance', async () => ({
    startingBalanceE4: config.market.paperStartingBalanceE4,
  }));

  app.get('/api/paper/orders', async () => paperDb.select().from(paperOrders).orderBy(desc(paperOrders.openedAt)).all());

  app.post('/api/paper/orders', async (req, reply) => {
    const parsed = openBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: z.prettifyError(parsed.error) });
    try {
      const id = openOrder(parsed.data);
      return reply.code(201).send({ id });
    } catch (err) {
      if (err instanceof PaperError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>('/api/paper/orders/:id/close', async (req, reply) => {
    const parsed = closeBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: z.prettifyError(parsed.error) });
    try {
      closeOrder({ orderId: req.params.id, ...parsed.data });
      return { ok: true };
    } catch (err) {
      if (err instanceof PaperError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  /**
   * The equity curve — where the paper book's graphs actually come from.
   * Both the account-level and per-trade views live here: `equity` is the
   * account curve, and every `orders` row already carries what it needs
   * (`entryPriceE4` plus its latest mark or exit) for a caller to compute
   * `tradeReturnPct` per position without a second endpoint.
   */
  app.get('/api/paper/equity', async () => {
    const equity = paperDb.select().from(paperEquity).orderBy(paperEquity.day).all();
    const orders = paperDb.select().from(paperOrders).orderBy(desc(paperOrders.openedAt)).all();
    return { startingBalanceE4: config.market.paperStartingBalanceE4, equity, orders };
  });

  /** Manual trigger — the nightly job calls the same two functions. */
  app.post('/api/paper/mark', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const result = markOpenPositions(today);
    computeDailyEquity(today);
    return result;
  });

  app.get<{ Params: { id: string } }>('/api/paper/orders/:id/return', async (req, reply) => {
    const order = paperDb.select().from(paperOrders).all().find((o) => o.id === req.params.id);
    if (!order) return reply.code(404).send({ error: 'Unknown order' });
    const currentE4 = order.exitPriceE4 ?? order.entryPriceE4;
    return {
      orderId: order.id,
      status: order.status,
      tradeReturnPct: order.exitPriceE4 !== null ? tradeReturnPct(order.entryPriceE4, currentE4) : null,
    };
  });
}
