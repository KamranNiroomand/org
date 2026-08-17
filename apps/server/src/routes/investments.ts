import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { holdings } from '../db/schema.js';
import { fetchQuotes, fetchUsdCad, lastKnownPrice, saveQuotes } from '../lib/quotes.js';
import { getMarket, refreshSymbols, sweepMarket } from '../lib/market.js';
import { refreshUniverse } from '../lib/universe.js';
import { newId, nowIso } from '../lib/util.js';

const body = z.object({
  symbol: z.string().min(1).max(20),
  name: z.string().max(200).nullish(),
  quantity: z.number().positive(),
  /** Minor units per share. */
  avgCost: z.number().int().min(0),
  currency: z.string().length(3).default(config.baseCurrency),
  accountId: z.string().nullish(),
});

export async function investmentRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/holdings', async () =>
    db.select().from(holdings).orderBy(asc(holdings.symbol)).all(),
  );

  app.post('/api/holdings', async (req, reply) => {
    const parsed = body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: z.prettifyError(parsed.error) });

    const row = {
      id: newId(),
      symbol: parsed.data.symbol.toUpperCase(),
      name: parsed.data.name ?? null,
      quantity: parsed.data.quantity,
      avgCost: parsed.data.avgCost,
      currency: parsed.data.currency,
      accountId: parsed.data.accountId ?? null,
      createdAt: nowIso(),
    };
    db.insert(holdings).values(row).run();
    return reply.code(201).send(row);
  });

  app.patch<{ Params: { id: string } }>('/api/holdings/:id', async (req, reply) => {
    const parsed = body.partial().safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: z.prettifyError(parsed.error) });

    const d = parsed.data;
    db.update(holdings)
      .set({
        ...(d.symbol !== undefined && { symbol: d.symbol.toUpperCase() }),
        ...(d.name !== undefined && { name: d.name ?? null }),
        ...(d.quantity !== undefined && { quantity: d.quantity }),
        ...(d.avgCost !== undefined && { avgCost: d.avgCost }),
        ...(d.currency !== undefined && { currency: d.currency }),
        ...(d.accountId !== undefined && { accountId: d.accountId ?? null }),
      })
      .where(eq(holdings.id, req.params.id))
      .run();

    const row = db.select().from(holdings).where(eq(holdings.id, req.params.id)).get();
    return row ?? reply.code(404).send({ error: 'Holding not found' });
  });

  app.delete<{ Params: { id: string } }>('/api/holdings/:id', async (req, reply) => {
    db.delete(holdings).where(eq(holdings.id, req.params.id)).run();
    return reply.code(204).send();
  });

  /**
   * The portfolio, valued.
   *
   * Live quotes are attempted first; anything that fails falls back to the last
   * stored price, and anything with no price at all reports `price: null` so
   * the UI can show cost basis and flag the gap rather than inventing a number.
   */
  app.get('/api/portfolio', async () => {
    const rows = db.select().from(holdings).orderBy(asc(holdings.symbol)).all();
    if (rows.length === 0) {
      return {
        holdings: [],
        totals: { marketValue: 0, costBasis: 0, unrealizedPL: 0, unrealizedPLPercent: 0 },
        baseCurrency: config.baseCurrency,
        usdCad: null,
        stale: [],
      };
    }

    const symbols = [...new Set(rows.map((r) => r.symbol))];
    const [quotes, usdCad] = await Promise.all([fetchQuotes(symbols), fetchUsdCad()]);
    if (quotes.size > 0) saveQuotes(quotes.values());

    const stale: string[] = [];

    /**
     * Converts an amount into the app's base currency, or returns null when the
     * rate needed isn't available. Returning null rather than falling back to
     * 1.0 is deliberate: an unconverted USD figure silently added to a CAD total
     * overstates it by ~39%, and a missing number is far easier to notice than
     * a plausible wrong one.
     */
    const toBase = (amount: number, currency: string): number | null => {
      if (currency === config.baseCurrency) return amount;
      if (currency === 'USD' && config.baseCurrency === 'CAD' && usdCad) {
        return Math.round(amount * usdCad);
      }
      return null;
    };

    const valued = rows.map((h) => {
      let quote = quotes.get(h.symbol) ?? null;
      if (!quote) {
        quote = lastKnownPrice(h.symbol);
        if (quote) stale.push(h.symbol);
      }

      // Per-holding figures stay in the holding's own currency — that's the
      // frame the position was actually bought and held in, and the one its
      // return means something in.
      const costBasis = Math.round(h.avgCost * h.quantity);
      const marketValue = quote ? Math.round(quote.price * h.quantity) : null;
      const unrealizedPL = marketValue === null ? null : marketValue - costBasis;

      // A quote arrives in the *listing's* currency, which need not match the
      // currency the position was recorded in. Both sides of the comparison get
      // converted from their own currency, never assumed to already agree.
      const quoteCurrency = quote?.currency ?? h.currency;
      const marketValueBase = marketValue === null ? null : toBase(marketValue, quoteCurrency);
      const costBasisBase = toBase(costBasis, h.currency);

      return {
        ...h,
        price: quote?.price ?? null,
        priceCurrency: quote?.currency ?? null,
        priceAsOf: quote?.asOf ?? null,
        dayChangePercent: quote?.dayChangePercent ?? null,
        costBasis,
        costBasisBase,
        marketValue,
        marketValueBase,
        unrealizedPL,
        unrealizedPLPercent:
          unrealizedPL === null || costBasis === 0 ? null : (unrealizedPL / costBasis) * 100,
      };
    });

    // A position counts toward the totals only when *both* its market value and
    // its cost basis reached the base currency. Including one without the other
    // is what produced a portfolio showing +45% when the true figure was +32%.
    const priced = valued.filter((v) => v.marketValueBase !== null && v.costBasisBase !== null);
    const marketValue = priced.reduce((s, v) => s + v.marketValueBase!, 0);
    const costBasis = priced.reduce((s, v) => s + v.costBasisBase!, 0);
    const unrealizedPL = marketValue - costBasis;

    return {
      holdings: valued,
      totals: {
        marketValue,
        costBasis,
        unrealizedPL,
        unrealizedPLPercent: costBasis === 0 ? 0 : (unrealizedPL / costBasis) * 100,
        pricedCount: priced.length,
        totalCount: valued.length,
      },
      baseCurrency: config.baseCurrency,
      usdCad,
      stale,
    };
  });

  // -------------------------------------------------------------------------
  // Market map
  // -------------------------------------------------------------------------

  /**
   * The S&P 500 with live quotes. `?force=true` bypasses the 60s cache for the
   * refresh button; ordinary page loads share whatever sweep is current.
   */
  app.get<{
    Querystring: {
      index?: string;
      exchange?: string;
      sector?: string;
      cap?: string;
      age?: string;
      pe?: string;
      search?: string;
    };
  }>('/api/investments/market', async (req) => {
    const oneOf = <T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T =>
      allowed.includes((value ?? '') as T) ? ((value ?? '') as T) : fallback;

    return getMarket({
      index: oneOf(req.query.index, ['all', 'sp500', 'nasdaq100', 'us', 'ca'] as const, 'all'),
      exchange: req.query.exchange,
      sector: req.query.sector,
      cap: oneOf(req.query.cap, ['all', 'mega', 'large', 'mid'] as const, 'all'),
      age: oneOf(req.query.age, ['all', 'recent', 'mature', 'old'] as const, 'all'),
      pe: oneOf(req.query.pe, ['all', 'value', 'fair', 'growth', 'rich', 'none'] as const, 'all'),
      search: req.query.search,
    });
  });

  /**
   * Re-quotes just the symbols a client is displaying. The whole universe is
   * swept nightly; this is what makes the visible boxes live without asking
   * Yahoo for seven thousand quotes every time someone opens the tab.
   */
  app.post('/api/investments/market/refresh', async (req, reply) => {
    const parsed = z.object({ symbols: z.array(z.string()).max(250) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: z.prettifyError(parsed.error) });
    return { refreshed: await refreshSymbols(parsed.data.symbols) };
  });

  /** Rebuilds the universe and re-quotes it. Minutes; normally the nightly job. */
  app.post('/api/investments/market/sweep', async () => {
    const universe = await refreshUniverse();
    const sweep = await sweepMarket();
    return { universe, sweep };
  });
}
