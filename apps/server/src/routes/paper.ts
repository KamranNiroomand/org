import type { FastifyInstance } from 'fastify';
import { desc } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../config.js';
import { paperDb } from '../db/paper/index.js';
import { paperEquity, paperOrders } from '../db/paper/schema.js';
import { closeOrder, computeDailyEquity, markOpenPositions, openOrder, PaperError, tradeReturnPct , latestMarkByOrder } from '../lib/paper.js';
import { latestStockMarkByOrder, stockCapacity, stockEquity } from '../lib/stockBook.js';
import { runStockCycle, runStockExits } from '../lib/stockEngine.js';
import { QuantRefusal, QuantUnavailable, stockRank } from '../lib/quant.js';
import { nyToday } from '../lib/options/positionHealth.js';
import { stockOrders } from '../db/paper/schema.js';
import { stancesForSymbols } from '../lib/stockEngine.js';
import { computePositionHealth, latestCapturedTradingDay, latestPositionHealth } from '../lib/options/positionHealth.js';
import { runExitEngine, revisionsByOrder } from '../lib/options/exitEngine.js';

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
   * `tradeReturnPct` per position without a second endpoint. Each open
   * order also carries its latest `health` row (null until the nightly job
   * has scored it at least once) — see `positionHealth.ts`.
   */
  /** The stock book: both horizons' positions, marks, and equity. */
  app.get('/api/stocks/book', async () => {
    const orders = paperDb.select().from(stockOrders).orderBy(desc(stockOrders.openedAt)).all();
    const marks = latestStockMarkByOrder();
    return {
      equity: stockEquity(),
      capacity: { short: stockCapacity('short'), long: stockCapacity('long') },
      orders: orders.map((o) => {
        const mark = marks.get(o.id);
        return {
          ...o,
          markPriceE4: mark?.markPriceE4 ?? null,
          markTradingDay: mark?.tradingDay ?? null,
        };
      }),
    };
  });

  /** Today's ranked picks per horizon, with the panel's stance where it
   * has one — the recommendations view, independent of what the book
   * actually bought (slots and caps mean the two differ, on purpose). */
  app.get<{ Querystring: { book?: string } }>('/api/stocks/picks', async (req, reply) => {
    const book = req.query.book === 'long' ? 'long' : 'short';
    try {
      const ranked = await stockRank(nyToday(), book === 'long' ? 'stk_long' : 'stk_short', 15);
      return { book, ...ranked, stances: stancesForSymbols(ranked.picks.map((p) => p.symbol)) };
    } catch (err) {
      if (err instanceof QuantRefusal || err instanceof QuantUnavailable) {
        return reply.code(503).send({ error: err.message });
      }
      throw err;
    }
  });

  /** Manual trigger for the whole stock cycle — the nightly job calls
   * the same function. */
  app.post('/api/stocks/cycle', async (req) => runStockCycle(req.log));

  /** The exit pass alone — mark every position and apply the books'
   * rules, with no panel run and so no LLM cost or wait. The full cycle
   * calls the same function; this exists because managing open risk
   * should never be gated on an LLM being available or fast. */
  app.post('/api/stocks/exits', async (req) => runStockExits(req.log));

  app.get('/api/paper/equity', async () => {
    const equity = paperDb.select().from(paperEquity).orderBy(paperEquity.day).all();
    const orders = paperDb.select().from(paperOrders).orderBy(desc(paperOrders.openedAt)).all();
    const healthByOrder = latestPositionHealth();
    const revisionsByOrderId = revisionsByOrder();
    const markByOrder = latestMarkByOrder();
    return {
      startingBalanceE4: config.market.paperStartingBalanceE4,
      equity,
      orders: orders.map((o) => {
        const mark = markByOrder.get(o.id);
        return {
          ...o,
          health: healthByOrder.get(o.id) ?? null,
          exitRevisions: revisionsByOrderId.get(o.id) ?? [],
          // The same rows the equity curve is built from — see
          // latestMarkByOrder. Null until the first marking after open.
          markPriceE4: mark?.markPriceE4 ?? null,
          markTradingDay: mark?.tradingDay ?? null,
          markBasis: mark?.basis ?? null,
        };
      }),
    };
  });

  /** Manual trigger — the nightly job calls the same two functions. */
  app.post('/api/paper/mark', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const result = markOpenPositions(today);
    computeDailyEquity(today);
    return result;
  });

  /**
   * Manual trigger — the nightly job calls the same function, but with
   * literal today rather than this day-picking fallback; see
   * `latestCapturedTradingDay`'s own doc comment for why the two differ.
   */
  app.post('/api/paper/health', async () => {
    const day = latestCapturedTradingDay() ?? new Date().toISOString().slice(0, 10);
    return computePositionHealth(day);
  });

  /** Manual trigger — the intraday cron (EXIT_RECHECK_CRON) calls the same function. */
  app.post('/api/paper/exit-recheck', async (req) => runExitEngine(req.log));

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
