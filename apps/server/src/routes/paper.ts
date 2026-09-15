import type { FastifyInstance } from 'fastify';
import { eq, desc } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../config.js';
import { paperDb } from '../db/paper/index.js';
import { paperEquity, paperOrders } from '../db/paper/schema.js';
import { closeOrder, computeDailyEquity, markOpenPositions, openOrder, PaperError, tradeReturnPct , latestMarkByOrder } from '../lib/paper.js';
import { latestStockMarkByOrder, stockCapacity, stockDecisionsForDay, stockEquity } from '../lib/stockBook.js';
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

  /** Specialist calibration — every probUp the panel has committed,
   * Brier-scored in the quant sidecar against sector-relative outcomes.
   * Mostly "pending" until late September; wired now so maturation is
   * automatic. */
  /**
   * Performance attribution — the answer to "is it improving?" as
   * evidence instead of a feeling. Every CLOSED stock trade grouped
   * three ways: which exit rule ended it, which book it lived in, and
   * how convinced the model was at entry (forecast tercile). Per group:
   * count, win rate, average return, total dollars. Winners and losers
   * both attributed, so the group that quietly dilutes the book has
   * nowhere to hide. Computed on the machine that owns the book; the
   * reader reaches it through the ordinary proxy.
   */
  app.get('/api/stocks/attribution', async () => {
    const closed = paperDb
      .select()
      .from(stockOrders)
      .where(eq(stockOrders.status, 'closed'))
      .all()
      .filter((o) => o.exitPriceE4 !== null);

    interface Bucket { count: number; wins: number; retSum: number; plE4: number }
    const mk = (): Bucket => ({ count: 0, wins: 0, retSum: 0, plE4: 0 });
    const add = (m: Map<string, Bucket>, key: string, ret: number, plE4: number) => {
      const b = m.get(key) ?? mk();
      b.count += 1;
      if (ret > 0) b.wins += 1;
      b.retSum += ret;
      b.plE4 += plE4;
      m.set(key, b);
    };

    const byExit = new Map<string, Bucket>();
    const byBook = new Map<string, Bucket>();
    const byConviction = new Map<string, Bucket>();
    // Conviction terciles from the closed set itself — a fixed absolute
    // threshold would silently drift as label/config changes rescale the
    // forecast; terciles always split "the model's most vs least
    // convinced picks of this era".
    const forecasts = closed
      .map((o) => o.entryForecastReturn)
      .filter((f): f is number => f !== null)
      .sort((a, b) => a - b);
    const q = (p: number) => forecasts[Math.min(forecasts.length - 1, Math.floor(p * forecasts.length))] ?? 0;
    const [t1, t2] = [q(1 / 3), q(2 / 3)];
    const conviction = (f: number | null): string =>
      f === null ? 'unknown' : f <= t1 ? 'low third' : f <= t2 ? 'middle third' : 'high third';

    for (const o of closed) {
      const ret = (o.exitPriceE4! / o.entryPriceE4 - 1) * 100;
      const plE4 = (o.exitPriceE4! - o.entryPriceE4) * o.quantity;
      add(byExit, o.exitReason ?? 'unknown', ret, plE4);
      add(byBook, o.book, ret, plE4);
      add(byConviction, conviction(o.entryForecastReturn), ret, plE4);
    }

    const rows = (m: Map<string, Bucket>) =>
      [...m.entries()]
        .map(([key, b]) => ({
          key,
          count: b.count,
          winRate: b.count > 0 ? b.wins / b.count : 0,
          avgReturnPct: b.count > 0 ? b.retSum / b.count : 0,
          totalPlE4: Math.round(b.plE4),
        }))
        .sort((a, b) => b.totalPlE4 - a.totalPlE4);

    return {
      closedTrades: closed.length,
      byExitReason: rows(byExit),
      byBook: rows(byBook),
      byConviction: rows(byConviction),
    };
  });

  app.get('/api/stocks/calibration', async (_req, reply) => {
    const { db } = await import('../db/index.js');
    const { panelAgentTurns, panelRuns, panelSymbolAnalyses } = await import('../db/schema.js');
    const { eq, isNotNull } = await import('drizzle-orm');
    const turns = db
      .select({
        specialist: panelAgentTurns.agent,
        probUp: panelAgentTurns.probUp,
        symbol: panelSymbolAnalyses.symbol,
        startedAt: panelRuns.startedAt,
      })
      .from(panelAgentTurns)
      .innerJoin(panelSymbolAnalyses, eq(panelAgentTurns.analysisId, panelSymbolAnalyses.id))
      .innerJoin(panelRuns, eq(panelSymbolAnalyses.runId, panelRuns.id))
      .where(isNotNull(panelAgentTurns.probUp))
      .all();
    try {
      const res = await fetch(`${config.market.quantUrl}/stock/calibration`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          turns: turns.map((t) => ({
            specialist: t.specialist,
            symbol: t.symbol,
            day: t.startedAt.slice(0, 10),
            prob_up: t.probUp,
          })),
        }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) return reply.code(503).send({ error: `quant ${res.status}` });
      return await res.json();
    } catch (err) {
      return reply.code(503).send({ error: err instanceof Error ? err.message : String(err) });
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

  /** The engine's own record of a day: what it bought, what it refused,
   * and which rule was binding — see stockDecisions. */
  app.get<{ Querystring: { day?: string } }>('/api/stocks/decisions', async (req) => ({
    day: req.query.day ?? nyToday(),
    decisions: stockDecisionsForDay(req.query.day ?? nyToday()),
  }));

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
