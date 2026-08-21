import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/index.js';
import { alertEvents, instruments, watchlist } from '../db/schema.js';
import { evaluatePriceAlerts } from '../lib/alerts/evaluate.js';
import { nowIso } from '../lib/util.js';
import { patchOf } from './_shared.js';

const body = z.object({
  symbol: z.string().min(1).max(20),
  name: z.string().max(200).nullish(),
  note: z.string().max(500).nullish(),
});

export async function watchlistRoutes(app: FastifyInstance): Promise<void> {
  // Live price/day-change joined from instruments — watchlist itself only
  // ever stores "which symbol", never a value that could go stale.
  app.get('/api/watchlist', async () =>
    db
      .select({
        symbol: watchlist.symbol,
        name: watchlist.name,
        note: watchlist.note,
        createdAt: watchlist.createdAt,
        price: instruments.price,
        currency: instruments.currency,
        dayChangePercent: instruments.dayChangePercent,
      })
      .from(watchlist)
      .leftJoin(instruments, eq(watchlist.symbol, instruments.symbol))
      .orderBy(watchlist.symbol)
      .all(),
  );

  app.post('/api/watchlist', async (req, reply) => {
    const parsed = body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: z.prettifyError(parsed.error) });

    const row = {
      symbol: parsed.data.symbol.toUpperCase(),
      name: parsed.data.name ?? null,
      note: parsed.data.note ?? null,
      createdAt: nowIso(),
    };
    db.insert(watchlist).values(row).onConflictDoNothing({ target: watchlist.symbol }).run();
    return reply.code(201).send(row);
  });

  app.patch<{ Params: { symbol: string } }>('/api/watchlist/:symbol', async (req, reply) => {
    const parsed = patchOf(body).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: z.prettifyError(parsed.error) });

    const d = parsed.data;
    const symbol = req.params.symbol.toUpperCase();
    db.update(watchlist)
      .set({
        ...(d.name !== undefined && { name: d.name ?? null }),
        ...(d.note !== undefined && { note: d.note ?? null }),
      })
      .where(eq(watchlist.symbol, symbol))
      .run();

    const row = db.select().from(watchlist).where(eq(watchlist.symbol, symbol)).get();
    return row ?? reply.code(404).send({ error: 'Not on the watchlist' });
  });

  app.delete<{ Params: { symbol: string } }>('/api/watchlist/:symbol', async (req, reply) => {
    db.delete(watchlist).where(eq(watchlist.symbol, req.params.symbol.toUpperCase())).run();
    return reply.code(204).send();
  });

  /**
   * The fired-alert feed. Holdings first, then watchlist, then everything
   * else, newest first within each group — a move on something you own
   * outranks the same move on a name you've never looked at.
   */
  app.get<{ Querystring: { context?: string; unacknowledged?: string } }>('/api/signals', async (req) => {
    const q = req.query;
    const filters = [];
    if (q.context === 'holding' || q.context === 'watchlist' || q.context === 'unwatched') {
      filters.push(eq(alertEvents.context, q.context));
    }
    if (q.unacknowledged === 'true') filters.push(eq(alertEvents.acknowledged, false));

    const rows = db
      .select()
      .from(alertEvents)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(alertEvents.triggeredAt))
      .limit(200)
      .all();

    const rank = { holding: 0, watchlist: 1, unwatched: 2 } as const;
    return rows.sort((a, b) => rank[a.context] - rank[b.context]);
  });

  app.post<{ Params: { id: string } }>('/api/signals/:id/ack', async (req, reply) => {
    db.update(alertEvents).set({ acknowledged: true }).where(eq(alertEvents.id, req.params.id)).run();
    return reply.code(204).send();
  });

  /** Manual trigger, matching the existing /api/investments/market/sweep pattern. */
  app.post('/api/signals/evaluate', async () => evaluatePriceAlerts());
}
