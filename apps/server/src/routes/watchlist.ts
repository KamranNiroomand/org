import { and, desc, eq, sql } from 'drizzle-orm';
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

    const symbol = parsed.data.symbol.toUpperCase();
    const result = db
      .insert(watchlist)
      .values({
        symbol,
        name: parsed.data.name ?? null,
        note: parsed.data.note ?? null,
        createdAt: nowIso(),
      })
      .onConflictDoNothing({ target: watchlist.symbol })
      .run();

    // Re-adding an already-watched symbol is a no-op, not a creation — the
    // response must reflect the row actually stored (its real name/note),
    // never echo back what was just submitted, which onConflictDoNothing
    // silently leaves untouched.
    const stored = db.select().from(watchlist).where(eq(watchlist.symbol, symbol)).get();
    return reply.code(result.changes > 0 ? 201 : 200).send(stored);
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

    // Context ranked in SQL, not after the fact: capping to 200 rows on
    // triggeredAt alone, then sorting by context afterward, would let a
    // holding-context alert be excluded by the LIMIT before the sort ever
    // saw it — the exact scenario a big market day produces, since unwatched
    // alerts vastly outnumber holdings on any real evaluation run. Ranking
    // first means the 200-row cap always keeps holdings, then watchlist,
    // before it starts dropping unwatched rows.
    return db
      .select()
      .from(alertEvents)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(
        sql`case ${alertEvents.context} when 'holding' then 0 when 'watchlist' then 1 else 2 end`,
        desc(alertEvents.triggeredAt),
      )
      .limit(200)
      .all();
  });

  app.post<{ Params: { id: string } }>('/api/signals/:id/ack', async (req, reply) => {
    db.update(alertEvents).set({ acknowledged: true }).where(eq(alertEvents.id, req.params.id)).run();
    return reply.code(204).send();
  });

  /** Manual trigger, matching the existing /api/investments/market/sweep pattern. */
  app.post('/api/signals/evaluate', async () => evaluatePriceAlerts());
}
